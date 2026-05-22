import { adminHeaders } from "./admin.js";

export async function getLibrary() {
  const res = await fetch("/api/library");
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(json?.error || `Failed to load library (${res.status})`);
  return json.songs || [];
}

export async function addSong(song) {
  const res = await fetch("/api/library", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(song),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(json?.error || `Failed to save song (${res.status})`);
  return { song: json.song, existed: !!json.existed };
}

export async function updateSong(patch) {
  const res = await fetch("/api/library", {
    method: "PATCH",
    headers: { "content-type": "application/json", ...adminHeaders() },
    body: JSON.stringify(patch),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(json?.error || `Failed to update song (${res.status})`);
  return json.song;
}

export async function deleteSong(id) {
  const res = await fetch(`/api/library?id=${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: adminHeaders(),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(json?.error || `Failed to delete song (${res.status})`);
  return json;
}
