// Timed-lyrics fetcher. Returns LRC (per-line [mm:ss.xx] timestamps) plus the
// song duration, used to drive karaoke Follow mode. Tries LRCLIB first (free,
// no key) and an optional NetEase Cloud Music proxy for better Chinese/CJK
// coverage. Files prefixed "_" are modules, not deployed Vercel routes.
//
// NetEase has no official public API, so it's gated behind NETEASE_API_BASE —
// point that at a self-hosted NeteaseCloudMusicApi (Binaryify) instance to
// enable it. Without it, only LRCLIB is used.

const LRCLIB = "https://lrclib.net/api";
const HAN_RE = /[㐀-鿿豈-﫿]/;

// A usable LRC has at least one [mm:ss] timestamp; bare metadata lines don't.
const hasTimestamps = (lrc) => /\[\d{1,2}:\d{2}(?:[.:]\d{1,3})?\]/.test(lrc || "");

async function fetchJson(url, opts) {
  try {
    const r = await fetch(url, opts);
    if (!r.ok) return null;
    return await r.json().catch(() => null);
  } catch {
    return null;
  }
}

// LRCLIB: /api/search returns candidates carrying syncedLyrics + duration, no
// key and no need to know the duration up front.
async function fromLrclib(title, artist) {
  const q = new URLSearchParams({ track_name: title });
  if (artist) q.set("artist_name", artist);
  const arr = await fetchJson(`${LRCLIB}/search?${q}`, {
    headers: { "User-Agent": "Alune (https://github.com/) lyrics reader" },
  });
  if (!Array.isArray(arr)) return null;
  const hit = arr.find((c) => c && hasTimestamps(c.syncedLyrics));
  if (!hit) return null;
  return {
    syncedLyrics: hit.syncedLyrics,
    duration: Math.round(Number(hit.duration) || 0),
    source: "lrclib",
  };
}

// NetEase via a Binaryify NeteaseCloudMusicApi instance: /search → song id,
// then /lyric → { lrc: { lyric } }.
async function fromNetease(title, artist) {
  const base = (process.env.NETEASE_API_BASE || "").replace(/\/+$/, "");
  if (!base) return null;
  const keywords = [title, artist].filter(Boolean).join(" ");
  const search = await fetchJson(
    `${base}/search?keywords=${encodeURIComponent(keywords)}&limit=5&type=1`
  );
  const song = search?.result?.songs?.[0];
  if (!song?.id) return null;
  const lyric = await fetchJson(`${base}/lyric?id=${song.id}`);
  const lrc = lyric?.lrc?.lyric || "";
  if (!hasTimestamps(lrc)) return null;
  return {
    syncedLyrics: lrc,
    duration: Math.round((Number(song.duration) || 0) / 1000),
    source: "netease",
  };
}

// Keep only the Han tokens of a mixed string — drops the romanized/English
// half that the CJK lyric sources don't index. Both halves show up in this
// library: combined artists ("周兴哲 Xing Zhe Zhou" → "周兴哲") and bilingual
// titles ("你不属于我 You Don't Belong to Me" → "你不属于我"). Returns "" when
// there's no Han at all.
function hanOnly(s) {
  if (!s || !HAN_RE.test(s)) return "";
  return s
    .split(/\s+/)
    .filter((tok) => HAN_RE.test(tok))
    .join(" ")
    .trim();
}

// Resolve timed lyrics for a title/artist, or null if none found. For CJK we
// try NetEase first (far better coverage); otherwise LRCLIB first. Both the
// title and artist are searched Han-only first, then with the full string as a
// fallback so non-Chinese / un-stripped entries still resolve.
export async function fetchSyncedLyrics({ title, artist }) {
  const t = (title || "").trim();
  if (!t) return null;
  const a = (artist || "").trim();
  const hanT = hanOnly(t);
  const hanA = hanOnly(a);
  const cjk = !!hanT || !!hanA;

  // De-duped try lists, most-precise (Han-only) first.
  const titleTries = [...new Set([hanT, t].filter(Boolean))];
  const artistTries = [...new Set([hanA, a].filter(Boolean))];
  if (!artistTries.length) artistTries.push(""); // title-only search

  for (const tt of titleTries) {
    for (const aa of artistTries) {
      const r = cjk
        ? (await fromNetease(tt, aa)) || (await fromLrclib(tt, aa))
        : (await fromLrclib(tt, aa)) || (await fromNetease(tt, aa));
      if (r) return r;
    }
  }
  return null;
}
