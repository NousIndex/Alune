// Sends a recorded audio clip to the serverless recognizer (the AudD proxy in
// api/recognize.js) and returns the identified track, or null when nothing
// matched. Throws with a readable message on configuration / service errors.
export async function recognizeAudio(blob) {
  const res = await fetch("/api/recognize", {
    method: "POST",
    headers: { "Content-Type": blob.type || "audio/webm" },
    body: blob,
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error(json?.error || `Recognition failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  if (!json?.matched) return null;
  return {
    title: json.title || "",
    artist: json.artist || "",
    album: json.album || "",
    songLink: json.songLink || "",
  };
}
