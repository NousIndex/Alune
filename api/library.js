import { Redis } from "@upstash/redis";

const INDEX_KEY = "library:ids";
const songKey = (id) => `song:${id}`;
const uid = () =>
  Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

function client() {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) {
    throw new Error(
      "Vercel KV is not configured. Create a KV store in the Vercel dashboard and link it to this project."
    );
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

async function loadSong(redis, id) {
  const raw = await redis.get(songKey(id));
  if (!raw) return null;
  const song = typeof raw === "string" ? JSON.parse(raw) : raw;
  return { ...song, id };
}

async function listAll(redis) {
  const ids = await redis.lrange(INDEX_KEY, 0, -1);
  if (!ids.length) return [];
  const keys = ids.map(songKey);
  const raw = await redis.mget(...keys);
  return raw
    .map((v, i) => {
      if (!v) return null;
      const song = typeof v === "string" ? JSON.parse(v) : v;
      return { ...song, id: ids[i] };
    })
    .filter(Boolean);
}

const norm = (s) =>
  (s || "").toLowerCase().trim().replace(/\s+/g, " ").normalize("NFC");
const dedupKey = (title, artist) => `${norm(title)}|${norm(artist)}`;

const dedupRedisKey = (key) => `dedup:${key}`;

async function addSong(redis, body) {
  const title = (body?.title || "").trim() || "Untitled";
  const artist = (body?.artist || "").trim();
  const key = dedupKey(title, artist);

  // 1) Catch duplicates that pre-date the dedup-key scheme by scanning existing
  //    songs. With ~hundreds of songs this is cheap enough.
  const existing = await listAll(redis);
  const dup = existing.find((s) => dedupKey(s.title, s.artist) === key);
  if (dup) return { song: dup, existed: true };

  // 2) Atomic claim via SET NX. Two concurrent requests for the same song
  //    (e.g. double-click before the first response returns) both pass step
  //    1, but only one wins this step. The loser fetches the winner's record.
  const song = {
    id: uid(),
    title,
    artist,
    lang: body?.lang || "auto",
    lyrics: body?.lyrics || "",
    createdAt: Date.now(),
  };
  const claimed = await redis.set(dedupRedisKey(key), song.id, { nx: true });
  if (!claimed) {
    const winnerId = await redis.get(dedupRedisKey(key));
    if (winnerId) {
      const raw = await redis.get(songKey(winnerId));
      if (raw) {
        const winner = typeof raw === "string" ? JSON.parse(raw) : raw;
        return { song: { ...winner, id: winnerId }, existed: true };
      }
    }
    // Stale dedup key with no song — extremely rare; treat as fresh write.
  }

  await redis.set(songKey(song.id), JSON.stringify(song));
  await redis.lpush(INDEX_KEY, song.id);
  return { song, existed: false };
}

async function updateSong(redis, body) {
  const id = (body?.id || "").trim();
  if (!id) {
    const err = new Error("id is required");
    err.status = 400;
    throw err;
  }
  const current = await loadSong(redis, id);
  if (!current) {
    const err = new Error("Song not found");
    err.status = 404;
    throw err;
  }

  // Only allow these fields to be patched.
  const next = { ...current };
  if (typeof body.title === "string") next.title = body.title.trim() || "Untitled";
  if (typeof body.artist === "string") next.artist = body.artist.trim();
  if (typeof body.lang === "string") next.lang = body.lang;
  if (typeof body.lyrics === "string") next.lyrics = body.lyrics;
  next.id = id;
  next.updatedAt = Date.now();

  const oldKey = dedupKey(current.title, current.artist);
  const newKey = dedupKey(next.title, next.artist);

  if (oldKey !== newKey) {
    // Refuse if the new (title, artist) combo collides with another song.
    const owner = await redis.get(dedupRedisKey(newKey));
    if (owner && owner !== id) {
      const err = new Error("Another song already uses this title + artist");
      err.status = 409;
      throw err;
    }
    // Claim the new key for this id and release the old one. (Not atomic with
    // a concurrent edit of the same song, but single-admin so the race window
    // is fine.)
    await redis.set(dedupRedisKey(newKey), id);
    await redis.del(dedupRedisKey(oldKey));
  }

  await redis.set(songKey(id), JSON.stringify(next));
  return { song: next };
}

async function deleteSong(redis, id) {
  if (!id) {
    const err = new Error("id is required");
    err.status = 400;
    throw err;
  }
  const current = await loadSong(redis, id);
  // Always clean up the list + song record even if the song record was already
  // gone, so we don't leave dangling ids in the index.
  await redis.lrem(INDEX_KEY, 0, id);
  await redis.del(songKey(id));
  if (current) {
    await redis.del(dedupRedisKey(dedupKey(current.title, current.artist)));
  }
  return { ok: true, id };
}

export default async function handler(req, res) {
  try {
    const redis = client();
    if (req.method === "GET") {
      const songs = await listAll(redis);
      return res.status(200).json({ songs });
    }
    if (req.method === "POST") {
      const { song, existed } = await addSong(redis, req.body);
      return res.status(existed ? 200 : 201).json({ song, existed });
    }
    if (req.method === "PATCH") {
      requireAdmin(req);
      const { song } = await updateSong(redis, req.body);
      return res.status(200).json({ song });
    }
    if (req.method === "DELETE") {
      requireAdmin(req);
      const id =
        (req.body && req.body.id) ||
        new URL(req.url, "http://localhost").searchParams.get("id");
      const result = await deleteSong(redis, id);
      return res.status(200).json(result);
    }
    res.setHeader("Allow", "GET, POST, PATCH, DELETE");
    return res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    return res.status(e.status || 500).json({ error: e.message });
  }
}
