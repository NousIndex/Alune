import { getSong, getSongs } from "./libraryApi.js";
import { songRev } from "../../api/_songMeta.js";

// Client cache for the split library: the summary list lives in localStorage
// (so the sidebar renders instantly on the next visit) and full songs live in
// IndexedDB keyed by id + revision (so a song's lyrics download once, and again
// only after it's edited).

const META_KEY = "alune.libraryMeta.v1";
const DB_NAME = "alune-songs";
const STORE = "songs";
// Keeps ?ids= URLs short and each response a few hundred KB at most.
const FETCH_BATCH = 50;

export function loadCachedMeta() {
  try {
    const v = JSON.parse(localStorage.getItem(META_KEY));
    return Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

export function saveCachedMeta(list) {
  try {
    localStorage.setItem(META_KEY, JSON.stringify(list));
  } catch {
    /* storage unavailable / full — next visit just loads from the API */
  }
}

let dbPromise = null;
function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function idbGetMany(ids) {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const store = tx.objectStore(STORE);
      const out = new Array(ids.length).fill(null);
      ids.forEach((id, i) => {
        const req = store.get(id);
        req.onsuccess = () => (out[i] = req.result || null);
      });
      tx.oncomplete = () => resolve(out);
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    return ids.map(() => null);
  }
}

async function idbPutMany(songs) {
  if (!songs.length) return;
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      for (const song of songs) store.put({ id: song.id, rev: songRev(song), song });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    /* IDB unavailable — songs are simply re-fetched next time */
  }
}

export const cacheFullSong = (song) => idbPutMany([song]);

// Full song for a summary: cached copy if its revision still matches, else fetched.
export async function loadFullSong(summary) {
  const [hit] = await idbGetMany([summary.id]);
  if (hit && hit.rev === summary.rev) return hit.song;
  const song = await getSong(summary.id);
  await idbPutMany([song]);
  return song;
}

// Bulk version for background indexing. Songs deleted server-side are dropped.
export async function loadFullSongs(summaries) {
  const hits = await idbGetMany(summaries.map((s) => s.id));
  const found = new Map();
  const missing = [];
  summaries.forEach((s, i) => {
    if (hits[i] && hits[i].rev === s.rev) found.set(s.id, hits[i].song);
    else missing.push(s.id);
  });
  for (let i = 0; i < missing.length; i += FETCH_BATCH) {
    const songs = await getSongs(missing.slice(i, i + FETCH_BATCH));
    await idbPutMany(songs);
    for (const s of songs) found.set(s.id, s);
  }
  return summaries.map((s) => found.get(s.id)).filter(Boolean);
}
