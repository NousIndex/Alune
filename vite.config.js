import { defineConfig, loadEnv } from "vite";
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

function devLibraryProxy(adminToken) {
  const norm = (s) =>
    (s || "").toLowerCase().trim().replace(/\s+/g, " ").normalize("NFC");
  const dedupKey = (t, a) => `${norm(t)}|${norm(a)}`;
  const isAdmin = (req) => req.headers["x-admin-token"] === adminToken;

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
            const key = dedupKey(title, artist);
            const db = readDb();
            const existing = db.ids
              .map((id) => db.songs[id])
              .find((s) => s && dedupKey(s.title, s.artist) === key);
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
          if (req.method === "PATCH") {
            if (!isAdmin(req)) return send(401, { error: "Admin token required" });
            const body = await readBody(req);
            const id = (body.id || "").trim();
            const db = readDb();
            const current = db.songs[id];
            if (!current) return send(404, { error: "Song not found" });
            const next = { ...current };
            if (typeof body.title === "string") next.title = body.title.trim() || "Untitled";
            if (typeof body.artist === "string") next.artist = body.artist.trim();
            if (typeof body.lang === "string") next.lang = body.lang;
            if (typeof body.lyrics === "string") next.lyrics = body.lyrics;
            next.updatedAt = Date.now();
            const newKey = dedupKey(next.title, next.artist);
            const collision = db.ids
              .map((sid) => db.songs[sid])
              .find((s) => s && s.id !== id && dedupKey(s.title, s.artist) === newKey);
            if (collision) return send(409, { error: "Another song already uses this title + artist" });
            db.songs[id] = next;
            writeDb(db);
            return send(200, { song: next });
          }
          if (req.method === "DELETE") {
            if (!isAdmin(req)) return send(401, { error: "Admin token required" });
            const url = new URL(req.url, "http://localhost");
            let id = url.searchParams.get("id");
            if (!id) {
              const body = await readBody(req);
              id = body.id;
            }
            if (!id) return send(400, { error: "id is required" });
            const db = readDb();
            delete db.songs[id];
            db.ids = db.ids.filter((x) => x !== id);
            writeDb(db);
            return send(200, { ok: true, id });
          }
          res.setHeader("Allow", "GET, POST, PATCH, DELETE");
          return send(405, { error: "Method not allowed" });
        } catch (e) {
          return send(500, { error: e.message });
        }
      });
    },
  };
}

function devAdminProxy(adminToken) {
  return {
    name: "dev-admin-proxy",
    configureServer(server) {
      server.middlewares.use("/api/admin", (req, res) => {
        const send = (status, body) => {
          res.statusCode = status;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify(body));
        };
        if (req.method !== "POST") {
          res.setHeader("Allow", "POST");
          return send(405, { error: "Method not allowed" });
        }
        if (req.headers["x-admin-token"] !== adminToken) {
          return send(401, { error: "Invalid admin token" });
        }
        return send(200, { ok: true });
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

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  // Dev-only fallback so the admin flow can be tested locally without setting
  // up a real token. In production Vercel injects ADMIN_TOKEN from its env vars.
  const adminToken = env.ADMIN_TOKEN || "dev";
  return {
    plugins: [
      react(),
      rawGzDictFiles(),
      devLyricsProxy(),
      devLibraryProxy(adminToken),
      devAdminProxy(adminToken),
    ],
  };
});
