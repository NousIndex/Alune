import { fetchSyncedLyrics, searchSyncedCandidates } from "./_synced.js";

// GET /api/synced?title=...&artist=...        → { found, syncedLyrics, duration, source }
// GET /api/synced?list=1&title=...&artist=... → { candidates: [...] }  (admin pick)
// Timed lyrics for karaoke Follow mode. Always 200 on a clean miss so the client
// can distinguish "no timing" from a real error.
export default async function handler(req, res) {
  const title = (req.query.title || "").trim();
  const artist = (req.query.artist || "").trim();
  if (!title) {
    res.status(400).json({ error: "title is required" });
    return;
  }
  try {
    if (req.query.list) {
      const candidates = await searchSyncedCandidates({ title, artist });
      res.status(200).json({ candidates });
      return;
    }
    const result = await fetchSyncedLyrics({ title, artist });
    res.status(200).json(result ? { found: true, ...result } : { found: false });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
}
