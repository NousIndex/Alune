import { adminHeaders } from "./admin.js";

export async function fetchPlaylist(url) {
  const res = await fetch("/api/playlist", {
    method: "POST",
    headers: { "content-type": "application/json", ...adminHeaders() },
    body: JSON.stringify({ url }),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error(json?.error || `Failed to fetch playlist (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return json;
}
