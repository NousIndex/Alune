// True when a string contains at least one [mm:ss] LRC timestamp. Shared with
// the server, which precomputes it as `hasSync` in song summaries.
export { hasTimestamps } from "../../api/_songMeta.js";

// Role labels that begin a credits line in CJK LRC files ("词：李荣浩",
// "编曲：…", "母带后期处理录音室：…", "OP：…"). Matched as a *prefix* of the part
// before the colon, so "弦乐编写"/"录音工作室"/"母带后期…" all catch.
const CREDIT_PREFIX =
  /^(作?词|作?曲|编曲|制作|出品|监制|发行|策划|统筹|企?宣|宣传|和声|和音|混音|缩混|录音|母带|音乐|弦乐|吉他|贝斯|贝司|鼓|键盘|手风琴|打击乐|配唱|配器|海报|妆发|造型|摄影|平面|视觉|导演|剪辑|经纪|执行|艺人|版权|OP|SP|词曲)/i;

// A credits/metadata line: "<role label>：<value>" (full-width or half colon).
// Conservative — real lyric lines essentially never start "<role>：".
export function isCreditLine(text) {
  const m = (text || "").match(/^\s*([^：:]{1,16})[：:]/);
  return !!m && CREDIT_PREFIX.test(m[1].trim());
}

// Drop the leading credits + title-header block so karaoke shows only sung
// lines. Removes credit lines anywhere, plus a leading "Title - Artist" header.
export function stripCreditEntries(entries, { title = "" } = {}) {
  const out = entries.filter((e) => !isCreditLine(e.text));
  const t = (title || "").trim();
  if (out.length && t && /\s[-–—]\s/.test(out[0].text) && out[0].text.includes(t)) {
    out.shift();
  }
  return out;
}

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
