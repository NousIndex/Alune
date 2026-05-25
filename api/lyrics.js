const UPSTREAM = "https://lyrics.lewdhutao.my.eu.org";
// The upstream is flaky: it intermittently 500s on a query that succeeds when
// retried a moment later. Retry transient failures a couple times so the user
// doesn't have to mash the Fetch button. ATTEMPTS counts the first try too.
const ATTEMPTS = 3;
const RETRY_DELAY_MS = 400;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchOnce(path) {
  try {
    const r = await fetch(`${UPSTREAM}${path}`);
    const json = await r.json().catch(() => null);
    return { ok: r.ok && Boolean(json?.data?.lyrics), status: r.status, json };
  } catch {
    // Couldn't reach upstream at all (DNS / TLS / timeout). status 0 marks it.
    return { ok: false, status: 0, json: null };
  }
}

// Only transient conditions are worth retrying: 5xx server errors and total
// unreachability (status 0). A 429 means slow down (retrying makes it worse),
// and any other 4xx (e.g. 404 "no lyrics") is a definitive answer.
const isTransient = (r) => r.status === 0 || r.status >= 500;

async function tryFetch(path) {
  let result;
  for (let i = 0; i < ATTEMPTS; i++) {
    result = await fetchOnce(path);
    if (!isTransient(result)) return result; // success or definitive failure
    if (i < ATTEMPTS - 1) await sleep(RETRY_DELAY_MS * (i + 1));
  }
  return result;
}

// Actionable message when no lyrics came back, instead of a raw "no body".
// Prefers the upstream's own structured message (e.g. "No lyrics found …").
function failureMessage(result) {
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

  if (result.ok) {
    res.status(200).json(result.json);
    return;
  }
  // Pass the upstream's JSON through when it has one (so the client can read
  // data.message); otherwise synthesize a clear error for the missing body.
  res
    .status(result.status || 502)
    .json(result.json ?? { error: failureMessage(result) });
}
