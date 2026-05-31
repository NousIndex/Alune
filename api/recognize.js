// Song recognition proxy. The browser records a short mic clip and POSTs the
// raw audio bytes here; we forward them to AudD (https://audd.io) with the
// secret API token and return just the matched title/artist. Keeping the token
// server-side is the whole reason this route exists — the client never sees it.
//
// Set AUDD_API_TOKEN in Vercel to enable. Without it the route 503s, mirroring
// how the playlist route behaves when Spotify/YouTube creds are missing.

// Disable the body parser so we can read the raw binary audio upload.
export const config = { api: { bodyParser: false } };

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const token = process.env.AUDD_API_TOKEN;
  if (!token) {
    res.status(503).json({
      error: "Song recognition isn't configured. Set AUDD_API_TOKEN in Vercel.",
    });
    return;
  }

  let audio;
  try {
    audio = await readRawBody(req);
  } catch {
    res.status(400).json({ error: "Couldn't read the audio upload." });
    return;
  }
  // A few seconds of Opus/AAC is tens of KB; anything tiny is silence or noise.
  if (!audio || audio.length < 1000) {
    res.status(400).json({ error: "Audio clip was empty or too short." });
    return;
  }

  const contentType = req.headers["content-type"] || "audio/webm";

  try {
    // FormData / Blob are globals on the Vercel Node 18+ runtime (undici), same
    // as the global fetch already used by api/_playlist.js.
    const form = new FormData();
    form.append("api_token", token);
    form.append("file", new Blob([audio], { type: contentType }), "clip.webm");

    const r = await fetch("https://api.audd.io/", { method: "POST", body: form });
    const json = await r.json().catch(() => null);
    if (!json) {
      res.status(502).json({ error: "Recognition service returned an unreadable response." });
      return;
    }
    if (json.status === "error") {
      res.status(502).json({ error: json.error?.error_message || "Recognition failed." });
      return;
    }
    if (!json.result) {
      // Reached the service fine, it just didn't recognize anything.
      res.status(200).json({ matched: false });
      return;
    }
    res.status(200).json({
      matched: true,
      title: json.result.title || "",
      artist: json.result.artist || "",
      album: json.result.album || "",
      songLink: json.result.song_link || "",
    });
  } catch (e) {
    res.status(502).json({ error: `Couldn't reach the recognition service: ${e.message}` });
  }
}
