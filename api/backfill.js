// Admin-triggered sweep: for every saved song, resolve the artist alias and
// (when applying) PATCH the song so the artist field becomes the combined
// "<CJK> <Latin>" form. Honors manual overrides + MusicBrainz lookups via
// resolveAlias.
//
// Flow: the UI calls this twice — once with { dryRun: true } to preview the
// list of proposed changes, once with { dryRun: false } to commit them.

import { Redis } from "@upstash/redis";
import { resolveAlias, normalizeName } from "./_aliasing.js";

const INDEX_KEY = "library:ids";
const songKey = (id) => `song:${id}`;
const dedupRedisKey = (key) => `dedup:${key}`;
const dedupKey = (t, a) => `${normalizeName(t)}|${normalizeName(a)}`;

function client() {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) {
    const err = new Error("Vercel KV is not configured");
    err.status = 500;
    throw err;
  }
  return new Redis({ url, token });
}

function requireAdmin(req) {
  const want = process.env.ADMIN_TOKEN;
  if (!want) {
    const err = new Error("ADMIN_TOKEN is not configured on the server");
    err.status = 500;
    throw err;
  }
  if (req.headers["x-admin-token"] !== want) {
    const err = new Error("Admin token required");
    err.status = 401;
    throw err;
  }
}

async function listAll(redis) {
  const ids = await redis.lrange(INDEX_KEY, 0, -1);
  if (!ids.length) return [];
  const raw = await redis.mget(...ids.map(songKey));
  return raw
    .map((v, i) => {
      if (!v) return null;
      const s = typeof v === "string" ? JSON.parse(v) : v;
      return { ...s, id: ids[i] };
    })
    .filter(Boolean);
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return res.status(405).json({ error: "Method not allowed" });
    }
    requireAdmin(req);
    const redis = client();
    const dryRun = req.body?.dryRun !== false; // default to safe preview

    const songs = await listAll(redis);
    const changes = [];
    const skipped = [];

    for (const s of songs) {
      if (!s.artist) continue;
      const resolved = await resolveAlias(s.artist, redis);
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
      return res.status(200).json({
        dryRun: true,
        scanned: songs.length,
        proposed: changes.length,
        changes,
      });
    }

    // Apply phase. Re-fetch each song's current state to avoid stale writes if
    // anyone edited concurrently — backfills are rare and small, so a per-song
    // read is cheap.
    let updated = 0;
    for (const c of changes) {
      const fresh = await redis.get(songKey(c.id));
      if (!fresh) {
        skipped.push({ ...c, reason: "song missing" });
        continue;
      }
      const current = typeof fresh === "string" ? JSON.parse(fresh) : fresh;
      // Re-verify our planned change is still relevant.
      if (current.artist === c.to) continue;
      const oldKey = dedupKey(current.title, current.artist);
      const newKey = dedupKey(current.title, c.to);
      if (oldKey !== newKey) {
        const owner = await redis.get(dedupRedisKey(newKey));
        if (owner && owner !== c.id) {
          skipped.push({ ...c, reason: "dedup collision with another song" });
          continue;
        }
        await redis.set(dedupRedisKey(newKey), c.id);
        await redis.del(dedupRedisKey(oldKey));
      }
      const next = { ...current, artist: c.to, updatedAt: Date.now() };
      await redis.set(songKey(c.id), JSON.stringify(next));
      updated++;
    }

    return res.status(200).json({
      dryRun: false,
      scanned: songs.length,
      proposed: changes.length,
      updated,
      skipped,
      changes,
    });
  } catch (e) {
    return res.status(e.status || 500).json({ error: e.message });
  }
}
