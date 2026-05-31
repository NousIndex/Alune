// Fetch timed lyrics (LRC + duration) for a title/artist from /api/synced.
// Returns null on a clean miss; throws only on a real server/network error.
export async function fetchSynced({ title, artist }) {
  const t = (title || "").trim();
  if (!t) return null;
  const q = new URLSearchParams({ title: t });
  if (artist && artist.trim()) q.set("artist", artist.trim());
  const res = await fetch(`/api/synced?${q}`);
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(json?.error || `Timed-lyrics lookup failed (${res.status})`);
  if (!json?.found) return null;
  return {
    syncedLyrics: json.syncedLyrics || "",
    duration: Number(json.duration) || 0,
    source: json.source || "",
  };
}
