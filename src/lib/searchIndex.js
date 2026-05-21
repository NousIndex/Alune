import { pinyin } from "pinyin-pro";
import { toRomaji, isKana } from "wanakana";
import { HAN, KANA, HANGUL, ensureKuroshiro, hangulTextRomaji } from "./romanize.js";

const DB_NAME = "alune";
const DB_VERSION = 1;
const STORE = "searchIndex";

// Bump to invalidate every cached entry (e.g. if romanization rules change).
const INDEX_VERSION = 2;

/* ---------------- IndexedDB helpers ---------------- */
let dbPromise = null;
function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function idbGet(id) {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}
async function idbGetAll() {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return [];
  }
}
async function idbPut(rec) {
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(rec);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    /* IDB unavailable — silently skip the cache; in-memory index still works. */
  }
}

/* ---------------- Romanization (search-only, plain strings) ---------------- */
function pinyinForms(text) {
  if (!HAN.test(text)) return "";
  try {
    const toned = pinyin(text, { toneType: "symbol", v: true });
    const plain = pinyin(text, { toneType: "none", v: true });
    const smashed = pinyin(text, { toneType: "none", v: true, separator: "" });
    return ` ${toned} ${plain} ${smashed}`;
  } catch {
    return "";
  }
}

// Kana-only romaji. Cheap, sync; doesn't need kuroshiro.
function kanaRomaji(text) {
  if (!KANA.test(text)) return "";
  let out = "";
  for (const ch of text) out += isKana(ch) ? toRomaji(ch) : " ";
  return ` ${out}`;
}

function koreanRomaji(text) {
  if (!HANGUL.test(text)) return "";
  return ` ${hangulTextRomaji(text)}`;
}

// Full romaji using kuroshiro (kanji readings). Falls back to kana-only if
// the dictionary couldn't load. Splits input into lines so a parse failure
// on one line doesn't drop the whole song.
async function fullJapaneseRomaji(text) {
  if (!KANA.test(text) && !HAN.test(text)) return "";
  const k = await ensureKuroshiro();
  if (!k) return kanaRomaji(text);
  const out = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    try {
      const romaji = await k.convert(line, { to: "romaji", romajiSystem: "hepburn" });
      out.push(romaji);
    } catch {
      out.push("");
    }
  }
  return " " + out.join(" ");
}

function normalize(s) {
  return (s || "").toLowerCase().replace(/\s+/g, " ").trim();
}

/* ---------------- Index builders ---------------- */
// Sync, instant. Title + artist + pinyin + kana-only romaji.
// Kanji titles aren't romaji-searchable until headRomajiText fills in.
export function lightSearchText(song) {
  const head = `${song.title || ""} ${song.artist || ""}`;
  const extras = pinyinForms(head) + kanaRomaji(head) + koreanRomaji(head);
  return normalize(head + extras);
}

// Async, fast (kuroshiro on a short string). Adds kanji readings for titles.
async function headRomajiText(song) {
  const head = `${song.title || ""} ${song.artist || ""}`;
  const extras = pinyinForms(head) + (await fullJapaneseRomaji(head)) + koreanRomaji(head);
  return normalize(head + extras);
}

// Async, slow. Full song including lyrics. This is the cache entry.
async function fullSearchText(song) {
  const body = `${song.title || ""} ${song.artist || ""} ${song.lyrics || ""}`;
  const extras = pinyinForms(body) + (await fullJapaneseRomaji(body)) + koreanRomaji(body);
  return normalize(body + extras);
}

export async function getCachedOrBuild(song) {
  const cached = await idbGet(song.id);
  if (cached && cached.v === INDEX_VERSION && cached.text) return cached.text;
  const text = await fullSearchText(song);
  await idbPut({ id: song.id, v: INDEX_VERSION, text });
  return text;
}

/* ---------------- Background indexer ----------------
 * Two passes so kanji titles become romaji-searchable seconds after page load,
 * instead of waiting for the slow lyric pass to reach them in order.
 *   Phase 1 (fast): title+artist with kuroshiro for uncached songs.
 *   Phase 2 (slow): full song body; cached songs are hydrated instantly.
 */
const idle =
  typeof window !== "undefined" && typeof window.requestIdleCallback === "function"
    ? () => new Promise((r) => window.requestIdleCallback(r, { timeout: 200 }))
    : () => new Promise((r) => setTimeout(r, 0));

export function indexLibraryInBackground(songs, onProgress) {
  let cancelled = false;
  const total = songs.length;
  let done = 0;

  const run = async () => {
    // Snapshot the cache once so phase 2 doesn't hit IDB per song.
    const cache = new Map();
    for (const rec of await idbGetAll()) {
      if (rec.v === INDEX_VERSION && rec.text) cache.set(rec.id, rec.text);
    }

    // Phase 1 — head romanization for uncached songs.
    for (let i = 0; i < total; i++) {
      if (cancelled) return;
      const song = songs[i];
      if (cache.has(song.id)) continue;
      try {
        const text = await headRomajiText(song);
        if (!cancelled) onProgress({ id: song.id, text, done, total, finished: false });
      } catch { /* skip; phase 2 will retry */ }
      await idle();
    }

    // Phase 2 — full bodies. Cached songs are O(1); fresh songs do the work.
    for (let i = 0; i < total; i++) {
      if (cancelled) return;
      const song = songs[i];
      let text = cache.get(song.id);
      if (!text) {
        try {
          text = await fullSearchText(song);
          await idbPut({ id: song.id, v: INDEX_VERSION, text });
        } catch {
          done++;
          continue;
        }
      }
      done++;
      if (!cancelled) onProgress({ id: song.id, text, done, total, finished: false });
      await idle();
    }
    if (!cancelled) onProgress({ id: null, text: null, done, total, finished: true });
  };

  run();
  return () => {
    cancelled = true;
  };
}
