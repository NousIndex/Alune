const UPSTREAM = "https://lyrics.lewdhutao.my.eu.org";

async function tryFetch(path) {
  const r = await fetch(`${UPSTREAM}${path}`);
  const json = await r.json().catch(() => null);
  return { ok: r.ok && Boolean(json?.data?.lyrics), status: r.status, json };
}

export default async function handler(req, res) {
  const title = (req.query.title || "").trim();
  const artist = (req.query.artist || "").trim();
  if (!title) {
    res.status(400).json({ error: "title is required" });
    return;
  }

  const q = new URLSearchParams({ title });
  if (artist) q.set("artist", artist);

  let result = await tryFetch(`/v2/musixmatch/lyrics?${q}`);
  if (!result.ok && result.status !== 429) {
    result = await tryFetch(`/v2/youtube/lyrics?${q}`);
  }

  res
    .status(result.ok ? 200 : result.status || 502)
    .json(result.json ?? { error: "upstream returned no body" });
}
