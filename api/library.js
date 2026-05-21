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

async function addSong(redis, body) {
  const title = (body?.title || "").trim() || "Untitled";
  const artist = (body?.artist || "").trim();
  const key = dedupKey(title, artist);

  // Reject duplicates by normalized title+artist. With ~hundreds of songs the
  // scan is cheap enough that a dedicated secondary index isn't worth the
  // schema overhead.
  const existing = await listAll(redis);
  const dup = existing.find((s) => dedupKey(s.title, s.artist) === key);
  if (dup) return { song: dup, existed: true };

  const song = {
    id: uid(),
    title,
    artist,
    lang: body?.lang || "auto",
    lyrics: body?.lyrics || "",
    createdAt: Date.now(),
  };
  await redis.set(songKey(song.id), JSON.stringify(song));
  await redis.lpush(INDEX_KEY, song.id);
  return { song, existed: false };
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
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
