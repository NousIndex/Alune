import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import fs from "node:fs";
import path from "node:path";

const UPSTREAM = "https://lyrics.lewdhutao.my.eu.org";

async function tryFetch(reqPath) {
  const r = await fetch(`${UPSTREAM}${reqPath}`);
  const json = await r.json().catch(() => null);
  return { ok: r.ok && Boolean(json?.data?.lyrics), status: r.status, json };
}

function devLyricsProxy() {
  return {
    name: "dev-lyrics-proxy",
    configureServer(server) {
      server.middlewares.use("/api/lyrics", async (req, res) => {
        try {
          const url = new URL(req.url, "http://localhost");
          const title = (url.searchParams.get("title") || "").trim();
          const artist = (url.searchParams.get("artist") || "").trim();
          if (!title) {
            res.statusCode = 400;
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ error: "title is required" }));
            return;
          }
          const q = new URLSearchParams({ title });
          if (artist) q.set("artist", artist);

          let result = await tryFetch(`/v2/musixmatch/lyrics?${q}`);
          if (!result.ok && result.status !== 429) {
            result = await tryFetch(`/v2/youtube/lyrics?${q}`);
          }
          res.statusCode = result.ok ? 200 : result.status || 502;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify(result.json ?? { error: "upstream returned no body" }));
        } catch (e) {
          res.statusCode = 500;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ error: e.message }));
        }
      });
    },
  };
}

// File-backed mock of api/library.js for `vite dev` so contributors can
// run the app without provisioning Vercel KV. Production uses real KV.
const DEV_DB = path.resolve(".dev-library.local.json");
const uid = () =>
  Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

function readDb() {
  try {
    return JSON.parse(fs.readFileSync(DEV_DB, "utf8"));
  } catch {
    return { ids: [], songs: {} };
  }
}
function writeDb(db) {
  fs.writeFileSync(DEV_DB, JSON.stringify(db, null, 2));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        const s = Buffer.concat(chunks).toString("utf8");
        resolve(s ? JSON.parse(s) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function devLibraryProxy() {
  return {
    name: "dev-library-proxy",
    configureServer(server) {
      server.middlewares.use("/api/library", async (req, res) => {
        const send = (status, body) => {
          res.statusCode = status;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify(body));
        };
        try {
          if (req.method === "GET") {
            const db = readDb();
            const songs = db.ids.map((id) => db.songs[id]).filter(Boolean);
            return send(200, { songs });
          }
          if (req.method === "POST") {
            const body = await readBody(req);
            const title = (body.title || "").trim() || "Untitled";
            const artist = (body.artist || "").trim();
            const norm = (s) =>
              (s || "").toLowerCase().trim().replace(/\s+/g, " ").normalize("NFC");
            const key = `${norm(title)}|${norm(artist)}`;
            const db = readDb();
            const existing = db.ids
              .map((id) => db.songs[id])
              .find((s) => s && `${norm(s.title)}|${norm(s.artist)}` === key);
            if (existing) return send(200, { song: existing, existed: true });

            const song = {
              id: uid(),
              title,
              artist,
              lang: body.lang || "auto",
              lyrics: body.lyrics || "",
              createdAt: Date.now(),
            };
            db.songs[song.id] = song;
            db.ids.unshift(song.id);
            writeDb(db);
            return send(201, { song, existed: false });
          }
          res.setHeader("Allow", "GET, POST");
          return send(405, { error: "Method not allowed" });
        } catch (e) {
          return send(500, { error: e.message });
        }
      });
    },
  };
}

// Vite's static handler (sirv) sees `.gz` files and adds `Content-Encoding: gzip`,
// causing the browser to auto-decompress them. kuromoji then tries to gunzip the
// already-decompressed bytes and throws "invalid file signature". Intercept and
// serve as raw application/octet-stream so the browser hands them off untouched.
function rawGzDictFiles() {
  return {
    name: "raw-gz-dict-files",
    configureServer(server) {
      server.middlewares.use("/dict/", (req, res, next) => {
        const url = new URL(req.url || "", "http://localhost");
        const filename = path.basename(url.pathname);
        const filePath = path.resolve("public", "dict", filename);
        if (!filename.endsWith(".gz") || !fs.existsSync(filePath)) return next();
        const stat = fs.statSync(filePath);
        res.setHeader("Content-Type", "application/octet-stream");
        res.setHeader("Content-Length", stat.size);
        res.setHeader("Cache-Control", "public, max-age=3600");
        fs.createReadStream(filePath).pipe(res);
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), rawGzDictFiles(), devLyricsProxy(), devLibraryProxy()],
});
