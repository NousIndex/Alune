import { pinyin } from "pinyin-pro";
import { toRomaji, isKana } from "wanakana";

const HAN = /[\u3400-\u9fff\uf900-\ufaff]/;
const KANA = /[\u3040-\u30ff]/;
const HANGUL = /[\uac00-\ud7af\u1100-\u11ff]/;

const esc = (s) =>
  (s || "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );

/* ------------------------------------------------------------------ *
 * Japanese engine state
 *   'pending' | 'full' (kanji+kana) | 'kana' (wanakana only) | 'none'
 * ------------------------------------------------------------------ */
let kuroshiro = null;
let KuroshiroClass = null; // resolved constructor — used for Util access
let kuroReady = null;
let jpEngine = "pending";
export const getJpEngine = () => jpEngine;

// CDN builds expose either the class directly on the global or wrap it in
// `{ default: Class }` (ESM-style). Unwrap before instantiating.
function resolveGlobal(name) {
  if (typeof window === "undefined") return null;
  const g = window[name];
  if (!g) return null;
  return typeof g === "function" ? g : g.default || null;
}

const kuroLibsLoaded = () =>
  !!resolveGlobal("Kuroshiro") && !!resolveGlobal("KuromojiAnalyzer");

// Lets other modules (e.g. searchIndex) reuse the same kuroshiro instance
// rather than triggering a second dictionary load. Returns null on failure.
export async function ensureKuroshiro() {
  await initKuroshiro();
  return jpEngine === "full" ? kuroshiro : null;
}

export function pinyinAvailable() {
  try {
    return typeof pinyin === "function";
  } catch {
    return false;
  }
}

// Loads the full kanji+kana engine. If the dictionary can't be fetched it never
// throws — it downgrades to wanakana (kana-only, no dictionary required).
function initKuroshiro() {
  if (kuroReady) return kuroReady;
  if (!kuroLibsLoaded()) {
    jpEngine = "kana";
    kuroReady = Promise.resolve(null);
    return kuroReady;
  }
  try {
    KuroshiroClass = resolveGlobal("Kuroshiro");
    const KuromojiAnalyzer = resolveGlobal("KuromojiAnalyzer");
    kuroshiro = new KuroshiroClass();
    const analyzer = new KuromojiAnalyzer({ dictPath: "/dict/" });
    kuroReady = kuroshiro
      .init(analyzer)
      .then(() => {
        jpEngine = "full";
        return analyzer;
      })
      .catch((e) => {
        console.warn("[alune] kuroshiro init failed; falling back to kana-only", e);
        jpEngine = "none";
        return null;
      });
    return kuroReady;
  } catch (e) {
    console.warn("[alune] kuroshiro construction threw; falling back to kana-only", e);
    jpEngine = "none";
    kuroReady = Promise.resolve(null);
    return kuroReady;
  }
}

/* ---------------- Korean: per-syllable Revised Romanization ---------------- *
 * Decomposes each Hangul syllable into initial/medial/final jamo and maps each
 * to its RR form. Doesn't apply inter-syllable assimilation rules — accurate
 * enough for ruby annotations and substring search, while staying sync + tiny.
 */
const KO_INITIAL = [
  "g", "kk", "n", "d", "tt", "r", "m", "b", "pp",
  "s", "ss", "", "j", "jj", "ch", "k", "t", "p", "h",
];
const KO_MEDIAL = [
  "a", "ae", "ya", "yae", "eo", "e", "yeo", "ye",
  "o", "wa", "wae", "oe", "yo", "u", "wo", "we", "wi",
  "yu", "eu", "ui", "i",
];
const KO_FINAL = [
  "", "k", "k", "k", "n", "n", "n", "t", "l", "k",
  "m", "l", "l", "l", "p", "l", "m", "p", "p", "t",
  "t", "ng", "t", "t", "k", "t", "p", "t",
];
export function hangulSyllableRomaji(ch) {
  const code = ch.codePointAt(0);
  const idx = code - 0xac00;
  if (idx < 0 || idx > 11171) return "";
  const initial = Math.floor(idx / (21 * 28));
  const medial = Math.floor((idx % (21 * 28)) / 28);
  const final = idx % 28;
  return KO_INITIAL[initial] + KO_MEDIAL[medial] + KO_FINAL[final];
}
// Plain-text romanization (for the search index — no HTML).
export function hangulTextRomaji(text) {
  let out = "";
  for (const ch of text) {
    if (ch >= "가" && ch <= "힯") out += hangulSyllableRomaji(ch);
    else out += ch;
  }
  return out;
}
function renderKoreanLine(line) {
  let out = "";
  for (const ch of line) {
    if (ch >= "가" && ch <= "힯") {
      const romaji = hangulSyllableRomaji(ch);
      out += romaji
        ? `<ruby>${esc(ch)}<rt>${esc(romaji)}</rt></ruby>`
        : esc(ch);
    } else {
      out += esc(ch);
    }
  }
  return out;
}

/* ---------------- Chinese: variant conversion + per-character ruby ---------------- *
 * opencc-js carries sizable dictionaries, so it's dynamically imported — a
 * reader left on "original" never downloads it. The first switch to
 * Simplified/Traditional fetches the chunk once; converters are then cached.
 * The same library powers the search variant fallback in api/_chinese.js.
 */
let _openccPromise = null;
let _t2s = null;
let _s2t = null;
// Resolves to a sync (text) => text converter, or null for "original".
async function getConverter(variant) {
  if (variant !== "simplified" && variant !== "traditional") return null;
  const mod = await (_openccPromise ||= import("opencc-js"));
  const Converter = mod.Converter || mod.default?.Converter;
  if (variant === "simplified")
    return (_t2s ||= Converter({ from: "tw", to: "cn" }));
  return (_s2t ||= Converter({ from: "cn", to: "tw" }));
}

// Convert the line first so the pinyin readings match the characters shown.
function renderChineseLine(line, convert) {
  if (convert) line = convert(line);
  if (!pinyinAvailable()) return esc(line);
  const arr = pinyin(line, { type: "all", toneType: "symbol", v: true });
  return arr
    .map((o) =>
      o.isZh && o.pinyin
        ? `<ruby>${esc(o.origin)}<rt>${esc(o.pinyin)}</rt></ruby>`
        : esc(o.origin)
    )
    .join("");
}

/* ---------------- Japanese: word-level ruby, with kana fallback ---------------- */
async function renderJapaneseLine(line) {
  const analyzer = await initKuroshiro();
  if (analyzer && jpEngine === "full") {
    let tokens;
    try {
      tokens = await analyzer.parse(line);
    } catch (e) {
      console.warn("[alune] analyzer.parse threw:", e);
      throw e;
    }
    const Util = KuroshiroClass && KuroshiroClass.Util;
    if (!Util || typeof Util.kanaToRomaji !== "function") {
      console.warn("[alune] Kuroshiro.Util.kanaToRomaji is missing", {
        hasClass: !!KuroshiroClass,
        utilKeys: Util ? Object.keys(Util) : null,
      });
    }
    return tokens
      .map((t) => {
        const surface = t.surface_form;
        let reading = "";
        if (t.reading && t.reading !== "*" && Util && Util.kanaToRomaji) {
          try {
            reading = Util.kanaToRomaji(t.reading, "hepburn");
          } catch (e) {
            console.warn("[alune] kanaToRomaji threw for", t.reading, e);
          }
        }
        if (t.pos === "助詞") {
          if (surface === "は") reading = "wa";
          else if (surface === "へ") reading = "e";
        }
        const isJP = HAN.test(surface) || KANA.test(surface);
        return reading && isJP
          ? `<ruby>${esc(surface)}<rt>${esc(reading)}</rt></ruby>`
          : esc(surface);
      })
      .join("");
  }
  return romajiKanaFallback(line);
}

// No dictionary: romanize kana directly (おはよう → ohayou). Kanji stay as-is.
function romajiKanaFallback(line) {
  let out = "";
  let buf = "";
  const flush = () => {
    if (!buf) return;
    out += `<ruby>${esc(buf)}<rt>${esc(toRomaji(buf))}</rt></ruby>`;
    buf = "";
  };
  for (const ch of line) {
    if (isKana(ch)) buf += ch;
    else {
      flush();
      out += esc(ch);
    }
  }
  flush();
  return out;
}

/* ---------------- whole-song dominant language ----------------
 * Counts script characters across the lyrics. If one language covers
 * ≥ threshold of the total, returns that language; otherwise "mixed".
 * Kanji (HAN) folds into Japanese when the song contains any kana,
 * since CJK songs rarely mix Chinese and Japanese in one work.
 */
const LATIN_LETTER = /[a-zA-Z]/;
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

/* ---------------- per-line language routing ---------------- */
function lineLang(line, songLang) {
  if (songLang === "en") return "en";
  if (songLang === "zh") return HAN.test(line) ? "zh" : "en";
  if (songLang === "ja") return KANA.test(line) || HAN.test(line) ? "ja" : "en";
  if (songLang === "ko") return HANGUL.test(line) ? "ko" : "en";
  if (KANA.test(line)) return "ja";
  if (HANGUL.test(line)) return "ko";
  if (HAN.test(line)) return "zh";
  return "en";
}

async function renderLine(line, songLang, zhConvert) {
  if (line.trim() === "") return { blank: true };
  const lang = lineLang(line, songLang);
  let html;
  try {
    if (lang === "zh") html = renderChineseLine(line, zhConvert);
    else if (lang === "ja") html = await renderJapaneseLine(line);
    else if (lang === "ko") html = renderKoreanLine(line);
    else html = esc(line);
  } catch (e) {
    console.warn(
      `[alune] renderLine failed (lang=${lang}): ${e?.name}: ${e?.message}\n  line: ${line.slice(0, 60)}\n  jpEngine: ${jpEngine}`,
      e
    );
    html = esc(line);
  }
  return { blank: false, html };
}

const NOTE_KANA =
  "Kana is romanized, but kanji readings need the dictionary at /dict/, which couldn’t be loaded. " +
  "Make sure `npm install` populated public/dict (it runs scripts/copy-dict.mjs).";
const NOTE_NONE =
  "The Japanese romanizer couldn’t load — check your connection (the analyzer scripts load from a CDN).";
const NOTE_PENDING =
  "Japanese romanizer is still initializing. If this message stays, check the browser console.";
const NOTE_PINYIN = "Pinyin engine couldn’t load — original characters shown.";

/* ---------------- public API: render an entire song ---------------- */
export async function renderSong(song, { zhVariant = "original" } = {}) {
  const rawLines = song.lyrics.split("\n");
  const zhConvert = await getConverter(zhVariant);
  const lines = [];
  for (const ln of rawLines) lines.push(await renderLine(ln, song.lang, zhConvert));

  const needsJP =
    song.lang === "ja" ||
    (song.lang === "auto" && rawLines.some((l) => KANA.test(l)));

  let note = "";
  if (needsJP) {
    if (jpEngine === "kana") note = NOTE_KANA;
    else if (jpEngine === "none") note = NOTE_NONE;
    else if (jpEngine === "pending") note = NOTE_PENDING;
  }
  if (!note && song.lang !== "ja" && HAN.test(song.lyrics) && !pinyinAvailable())
    note = NOTE_PINYIN;

  return { lines, note };
}

export { HAN, KANA, HANGUL };
