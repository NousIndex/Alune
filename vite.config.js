import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import fs from "node:fs";
import path from "node:path";
import { resolveAlias, normalizeName, formatPair } from "./api/_aliasing.js";
import { fetchPlaylist } from "./api/_playlist.js";

const UPSTREAM = "https://lyrics.lewdhutao.my.eu.org";

// File-backed mock of the alias overrides + MB cache. Mirrors the Upstash
// HASH + KV shape used by the production resolver, so the same resolveAlias()
// runs in both environments.
const DEV_ALIAS_DB = path.resolve(".dev-aliases.local.json");
function readAliasDb() {
  try {
    return JSON.parse(fs.readFileSync(DEV_ALIAS_DB, "utf8"));
  } catch {
    return { hash: {}, kv: {} };
  }
}
function writeAliasDb(db) {
  fs.writeFileSync(DEV_ALIAS_DB, JSON.stringify(db, null, 2));
}
function devRedis() {
  // Mock the subset of Redis methods that resolveAlias / aliases / backfill
  // actually use. Field/key strings match the production layout 1-to-1.
  return {
    async hget(key, field) {
      const db = readAliasDb();
      const raw = db.hash?.[key]?.[field];
      return raw === undefined ? null : raw;
    },
    async hset(key, obj) {
      const db = readAliasDb();
      db.hash = db.hash || {};
      db.hash[key] = { ...(db.hash[key] || {}), ...obj };
      writeAliasDb(db);
      return Object.keys(obj).length;
    },
    async hdel(key, field) {
      const db = readAliasDb();
      if (db.hash?.[key]) {
        delete db.hash[key][field];
        writeAliasDb(db);
        return 1;
      }
      return 0;
    },
    async hgetall(key) {
      const db = readAliasDb();
      return db.hash?.[key] || {};
    },
    async get(key) {
      const db = readAliasDb();
      const raw = db.kv?.[key];
      return raw === undefined ? null : raw;
    },
    async set(key, value /* opts unused in dev */) {
      const db = readAliasDb();
      db.kv = db.kv || {};
      db.kv[key] = value;
      writeAliasDb(db);
      return "OK";
    },
    async del(key) {
      const db = readAliasDb();
      if (db.kv && key in db.kv) {
        delete db.kv[key];
        writeAliasDb(db);
        return 1;
      }
      return 0;
    },
  };
}

// Retry knobs mirror api/lyrics.js — see the rationale there.
const LYRICS_ATTEMPTS = 3;
const LYRICS_RETRY_DELAY_MS = 400;
const lyricsSleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchOnce(reqPath) {
  try {
    const r = await fetch(`${UPSTREAM}${reqPath}`);
    const json = await r.json().catch(() => null);
    return { ok: r.ok && Boolean(json?.data?.lyrics), status: r.status, json };
  } catch {
    return { ok: false, status: 0, json: null };
  }
}

const isTransient = (r) => r.status === 0 || r.status >= 500;

async function tryFetch(reqPath) {
  let result;
  for (let i = 0; i < LYRICS_ATTEMPTS; i++) {
    result = await fetchOnce(reqPath);
    if (!isTransient(result)) return result;
    if (i < LYRICS_ATTEMPTS - 1) await lyricsSleep(LYRICS_RETRY_DELAY_MS * (i + 1));
  }
  return result;
}

// Mirror of api/lyrics.js failureMessage so dev surfaces the same hints.
function lyricsFailureMessage(result) {
  if (result.json?.data?.message) return result.json.data.message;
  if (result.status === 429)
    return "Lyrics service is rate-limiting requests — wait a moment and retry, or paste lyrics manually.";
  if (result.status === 0)
    return "Couldn't reach the lyrics service. Check your connection, or paste lyrics manually.";
  if (result.status >= 500)
    return `Lyrics service error (HTTP ${result.status}). Try again shortly, or paste lyrics manually.`;
  if (result.status === 404) return "No lyrics found for this title / artist.";
  return `Lyrics request failed (HTTP ${result.status || "unknown"}).`;
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
          res.end(
            JSON.stringify(
              result.ok || result.json
                ? result.json
                : { error: lyricsFailureMessage(result) }
            )
          );
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

function devAliasProxy() {
  return {
    name: "dev-alias-proxy",
    configureServer(server) {
      server.middlewares.use("/api/alias", async (req, res) => {
        const send = (status, body) => {
          res.statusCode = status;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify(body));
        };
        try {
          if (req.method !== "GET") {
            res.setHeader("Allow", "GET");
            return send(405, { error: "Method not allowed" });
          }
          const url = new URL(req.url, "http://localhost");
          const name = (url.searchParams.get("name") || "").trim();
          if (!name) return send(400, { error: "name is required" });
          const result = await resolveAlias(name, devRedis());
          return send(200, result);
        } catch (e) {
          return send(e.status || 500, { error: e.message });
        }
      });
    },
  };
}

function devAliasesProxy(adminToken) {
  return {
    name: "dev-aliases-proxy",
    configureServer(server) {
      server.middlewares.use("/api/aliases", async (req, res) => {
        const send = (status, body) => {
          res.statusCode = status;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify(body));
        };
        const isAdmin = () => req.headers["x-admin-token"] === adminToken;
        const redis = devRedis();
        try {
          if (req.method === "GET") {
            const all = await redis.hgetall("alias:overrides");
            const entries = Object.entries(all || {})
              .map(([k, v]) => {
                const entry = typeof v === "string" ? JSON.parse(v) : v;
                if (!entry) return null;
                return {
                  key: k,
                  original: entry.original || k,
                  alias: entry.alias || "",
                  formatted: formatPair(entry.original || k, entry.alias || ""),
                };
              })
              .filter(Boolean)
              .sort((a, b) => a.original.localeCompare(b.original));
            return send(200, { overrides: entries });
          }
          if (req.method === "POST") {
            if (!isAdmin()) return send(401, { error: "Admin token required" });
            const body = await readBody(req);
            const original = (body.original || "").trim();
            const alias = (body.alias || "").trim();
            if (!original || !alias) {
              return send(400, { error: "Both 'original' and 'alias' are required" });
            }
            const norm = normalizeName(original);
            await redis.hset("alias:overrides", {
              [norm]: JSON.stringify({ original, alias }),
            });
            await redis.del(`alias:cache:${norm}`);
            const revNorm = normalizeName(alias);
            if (revNorm && revNorm !== norm) {
              await redis.hset("alias:overrides", {
                [revNorm]: JSON.stringify({ original: alias, alias: original }),
              });
              await redis.del(`alias:cache:${revNorm}`);
            }
            return send(200, {
              ok: true,
              entry: { original, alias, formatted: formatPair(original, alias) },
            });
          }
          if (req.method === "DELETE") {
            if (!isAdmin()) return send(401, { error: "Admin token required" });
            const url = new URL(req.url, "http://localhost");
            let original = url.searchParams.get("original");
            if (!original) {
              const body = await readBody(req);
              original = body.original;
            }
            if (!original) return send(400, { error: "original is required" });
            const norm = normalizeName(original);
            const raw = await redis.hget("alias:overrides", norm);
            const entry = typeof raw === "string" ? JSON.parse(raw) : raw;
            await redis.hdel("alias:overrides", norm);
            await redis.del(`alias:cache:${norm}`);
            if (entry?.alias) {
              const revNorm = normalizeName(entry.alias);
              if (revNorm && revNorm !== norm) {
                await redis.hdel("alias:overrides", revNorm);
                await redis.del(`alias:cache:${revNorm}`);
              }
            }
            return send(200, { ok: true });
          }
          res.setHeader("Allow", "GET, POST, DELETE");
          return send(405, { error: "Method not allowed" });
        } catch (e) {
          return send(e.status || 500, { error: e.message });
        }
      });
    },
  };
}

function devPlaylistProxy(adminToken) {
  return {
    name: "dev-playlist-proxy",
    configureServer(server) {
      server.middlewares.use("/api/playlist", async (req, res) => {
        const send = (status, body) => {
          res.statusCode = status;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify(body));
        };
        try {
          if (req.method !== "POST") {
            res.setHeader("Allow", "POST");
            return send(405, { error: "Method not allowed" });
          }
          if (req.headers["x-admin-token"] !== adminToken) {
            return send(401, { error: "Admin token required" });
          }
          const body = await readBody(req);
          const url = (body.url || "").trim();
          if (!url) return send(400, { error: "url is required" });
          const result = await fetchPlaylist(url);
          return send(200, result);
        } catch (e) {
          return send(e.status || 500, { error: e.message });
        }
      });
    },
  };
}

function devBackfillProxy(adminToken) {
  return {
    name: "dev-backfill-proxy",
    configureServer(server) {
      server.middlewares.use("/api/backfill", async (req, res) => {
        const send = (status, body) => {
          res.statusCode = status;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify(body));
        };
        try {
          if (req.method !== "POST") {
            res.setHeader("Allow", "POST");
            return send(405, { error: "Method not allowed" });
          }
          if (req.headers["x-admin-token"] !== adminToken) {
            return send(401, { error: "Admin token required" });
          }
          const body = await readBody(req);
          const dryRun = body.dryRun !== false;
          const aliasRedis = devRedis();

          const db = readDb();
          const songs = db.ids.map((id) => db.songs[id]).filter(Boolean);
          const norm = normalizeName;
          const dedupKey = (t, a) => `${norm(t)}|${norm(a)}`;

          const changes = [];
          for (const s of songs) {
            if (!s.artist) continue;
            const resolved = await resolveAlias(s.artist, aliasRedis);
            if (resolved.formatted && resolved.formatted !== s.artist) {
              changes.push({
                id: s.id,
                title: s.title,
                from: s.artist,
                to: resolved.formatted,
                source: resolved.source,
              });
            }
          }

          if (dryRun) {
            return send(200, {
              dryRun: true,
              scanned: songs.length,
              proposed: changes.length,
              changes,
            });
          }

          // Apply
          const fresh = readDb();
          let updated = 0;
          const skipped = [];
          for (const c of changes) {
            const current = fresh.songs[c.id];
            if (!current) {
              skipped.push({ ...c, reason: "song missing" });
              continue;
            }
            if (current.artist === c.to) continue;
            const newKey = dedupKey(current.title, c.to);
            const collision = fresh.ids
              .map((sid) => fresh.songs[sid])
              .find((s) => s && s.id !== c.id && dedupKey(s.title, s.artist) === newKey);
            if (collision) {
              skipped.push({ ...c, reason: "dedup collision with another song" });
              continue;
            }
            fresh.songs[c.id] = { ...current, artist: c.to, updatedAt: Date.now() };
            updated++;
          }
          writeDb(fresh);
          return send(200, {
            dryRun: false,
            scanned: songs.length,
            proposed: changes.length,
            updated,
            skipped,
            changes,
          });
        } catch (e) {
          return send(e.status || 500, { error: e.message });
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
  // The dev playlist proxy calls fetchPlaylist() which reads Spotify/YouTube
  // creds from process.env. Vite's loadEnv() doesn't propagate to process.env
  // by default, so copy the keys we need.
  for (const k of [
    "SPOTIFY_CLIENT_ID",
    "SPOTIFY_CLIENT_SECRET",
    "YOUTUBE_API_KEY",
  ]) {
    if (env[k] && !process.env[k]) process.env[k] = env[k];
  }
  return {
    plugins: [
      react(),
      rawGzDictFiles(),
      devLyricsProxy(),
      devLibraryProxy(adminToken),
      devAdminProxy(adminToken),
      devAliasProxy(),
      devAliasesProxy(adminToken),
      devPlaylistProxy(adminToken),
      devBackfillProxy(adminToken),
    ],
  };
});
