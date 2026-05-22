const UPSTREAM = "https://lyrics.lewdhutao.my.eu.org";

async function tryFetch(path) {
  const r = await fetch(`${UPSTREAM}${path}`);
  const json = await r.json().catch(() => null);
  return { ok: r.ok && Boolean(json?.data?.lyrics), status: r.status, json };
}

export default async function handler(req, res) {
  const title = (req.query.title || "").trim();
  const artist = (req.query.artist || "").trim();
  const source = (req.query.source || "auto").trim();
  if (!title) {
    res.status(400).json({ error: "title is required" });
    return;
  }

  const q = new URLSearchParams({ title });
  if (artist) q.set("artist", artist);

  // Musixmatch sometimes returns a different language version (e.g. Cantonese
  // when Mandarin was wanted); YouTube tends to surface the more popular cut.
  // "auto" keeps the Musixmatch→YouTube fallback chain; the explicit sources
  // bypass it so the user can force one when auto picks the wrong version.
  let result;
  if (source === "youtube") {
    result = await tryFetch(`/v2/youtube/lyrics?${q}`);
  } else if (source === "musixmatch") {
    result = await tryFetch(`/v2/musixmatch/lyrics?${q}`);
  } else {
    result = await tryFetch(`/v2/musixmatch/lyrics?${q}`);
    if (!result.ok && result.status !== 429) {
      result = await tryFetch(`/v2/youtube/lyrics?${q}`);
    }
  }

  res
    .status(result.ok ? 200 : result.status || 502)
    .json(result.json ?? { error: "upstream returned no body" });
}
