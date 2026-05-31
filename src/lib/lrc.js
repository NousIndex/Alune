// True when a string contains at least one [mm:ss] LRC timestamp — i.e. it's
// real synced lyrics, not plain text. Gates the Follow button.
export const hasTimestamps = (lrc) => /\[\d{1,2}:\d{2}(?:[.:]\d{1,3})?\]/.test(lrc || "");

// Parse an LRC string ("[mm:ss.xx] text") into time-ordered { timeMs, text }
// entries. A single line may carry several timestamps (repeated chorus); each
// becomes its own entry. Metadata-only lines ([ar:], [ti:], empty text) are
// dropped so what's left is exactly the sung lines we highlight.
export function parseLrc(lrc) {
  if (!lrc) return [];
  const tag = /\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/g;
  const out = [];
  for (const raw of lrc.split(/\r?\n/)) {
    tag.lastIndex = 0;
    const stamps = [];
    let m;
    while ((m = tag.exec(raw))) {
      const min = +m[1];
      const sec = +m[2];
      const fracStr = m[3] || "";
      const frac = fracStr ? +fracStr / 10 ** fracStr.length : 0;
      stamps.push(Math.round((min * 60 + sec + frac) * 1000));
    }
    if (!stamps.length) continue;
    const text = raw.replace(tag, "").trim();
    if (!text) continue;
    for (const t of stamps) out.push({ timeMs: t, text });
  }
  out.sort((a, b) => a.timeMs - b.timeMs);
  return out;
}
