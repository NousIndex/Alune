export async function fetchLyrics({ title, artist }) {
  const t = title?.trim();
  if (!t) throw new Error("Title is required");
  const q = new URLSearchParams({ title: t });
  if (artist?.trim()) q.set("artist", artist.trim());

  const res = await fetch(`/api/lyrics?${q}`);
  const json = await res.json().catch(() => null);
  if (!res.ok || !json?.data?.lyrics) {
    const msg = json?.data?.message || json?.error || `Request failed (${res.status})`;
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return json.data;
}
