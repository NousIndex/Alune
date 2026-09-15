// Lightweight per-song summary. The sidebar loads these instead of every song's
// full lyrics + timing; the full record is fetched only for the open song (and
// in background batches for lyric search). Shared by api/library.js, the vite
// dev mock, and the client — so it must stay dependency-free.

const HAN = /[㐀-鿿豈-﫿]/;
const KANA = /[぀-ヿ]/;
const HANGUL = /[가-힯ᄀ-ᇿ]/;
const LATIN_LETTER = /[a-zA-Z]/;

/* ---------------- whole-song dominant language ----------------
 * Counts script characters across the lyrics. If one language covers
 * ≥ threshold of the total, returns that language; otherwise "mixed".
 * Kanji (HAN) folds into Japanese when the song contains any kana,
 * since CJK songs rarely mix Chinese and Japanese in one work.
 */
export function dominantLang(text, threshold = 0.8) {
  let han = 0, kana = 0, hangul = 0, latin = 0;
  for (const ch of text || "") {
    if (KANA.test(ch)) kana++;
    else if (HANGUL.test(ch)) hangul++;
    else if (HAN.test(ch)) han++;
    else if (LATIN_LETTER.test(ch)) latin++;
  }
  const hasKana = kana > 0;
  const ja = hasKana ? kana + han : 0;
  const zh = hasKana ? 0 : han;
  const counts = { ja, zh, ko: hangul, en: latin };
  const total = ja + zh + hangul + latin;
  if (total === 0) return "en";
  let best = "en", bestCount = 0;
  for (const [k, v] of Object.entries(counts)) {
    if (v > bestCount) { best = k; bestCount = v; }
  }
  return bestCount / total >= threshold ? best : "mixed";
}

// True when a string contains at least one [mm:ss] LRC timestamp — i.e. it's
// real synced lyrics, not plain text. Gates the Follow button.
export const hasTimestamps = (lrc) => /\[\d{1,2}:\d{2}(?:[.:]\d{1,3})?\]/.test(lrc || "");

// Language for the sidebar badge + filter chips.
function detectLang(song) {
  if (song.lang && song.lang !== "auto") return song.lang;
  const lyrics = song.lyrics || "";
  const dom = dominantLang(lyrics);
  if (dom !== "mixed") return dom;
  // Truly mixed — fall back to first-match priority for the badge.
  if (KANA.test(lyrics)) return "ja";
  if (HANGUL.test(lyrics)) return "ko";
  if (HAN.test(lyrics)) return "zh";
  return "en";
}

// Changes whenever the stored record does (every write sets updatedAt), so the
// client can tell whether its cached full song is still current.
export const songRev = (song) => String(song.updatedAt || song.createdAt || 0);

export function summarizeSong(song) {
  return {
    id: song.id,
    title: song.title || "",
    artist: song.artist || "",
    lang: song.lang || "auto",
    createdAt: song.createdAt,
    ...(song.updatedAt ? { updatedAt: song.updatedAt } : {}),
    detLang: detectLang(song),
    hasSync: hasTimestamps(song.syncedLyrics),
    lyricsLen: (song.lyrics || "").length,
    rev: songRev(song),
  };
}
