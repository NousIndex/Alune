// Shared helpers for parsing Spotify / YouTube playlist URLs and fetching the
// tracklist. Imported by both api/playlist.js (production) and the Vite dev
// proxy so behavior stays in sync.

const SPOTIFY_TOKEN_URL = "https://accounts.spotify.com/api/token";
const SPOTIFY_API = "https://api.spotify.com/v1";
const YT_API = "https://www.googleapis.com/youtube/v3";

export function detectSource(url) {
  if (/open\.spotify\.com\/playlist\//.test(url)) return "spotify";
  if (/(youtube\.com|youtu\.be)/.test(url) && /[?&]list=/.test(url)) return "youtube";
  return null;
}

export function extractSpotifyId(url) {
  const m = url.match(/playlist\/([A-Za-z0-9]+)/);
  return m ? m[1] : null;
}

export function extractYoutubeId(url) {
  try {
    return new URL(url).searchParams.get("list");
  } catch {
    return null;
  }
}

let spotifyTokenCache = { token: null, expiresAt: 0 };

async function getSpotifyToken() {
  if (spotifyTokenCache.token && spotifyTokenCache.expiresAt > Date.now() + 60_000) {
    return spotifyTokenCache.token;
  }
  const id = process.env.SPOTIFY_CLIENT_ID;
  const secret = process.env.SPOTIFY_CLIENT_SECRET;
  if (!id || !secret) {
    const err = new Error(
      "Spotify credentials not configured. Set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET in Vercel."
    );
    err.status = 503;
    throw err;
  }
  const auth = Buffer.from(`${id}:${secret}`).toString("base64");
  const res = await fetch(SPOTIFY_TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const err = new Error(`Spotify auth failed (${res.status}): ${body.slice(0, 200)}`);
    err.status = 502;
    throw err;
  }
  const json = await res.json();
  spotifyTokenCache = {
    token: json.access_token,
    expiresAt: Date.now() + (json.expires_in || 3600) * 1000,
  };
  return spotifyTokenCache.token;
}

export async function fetchSpotifyPlaylist(playlistId) {
  const token = await getSpotifyToken();
  const headers = { Authorization: `Bearer ${token}` };

  let playlistTitle = "";
  const meta = await fetch(`${SPOTIFY_API}/playlists/${playlistId}?fields=name`, { headers });
  if (meta.ok) playlistTitle = (await meta.json().catch(() => ({}))).name || "";
  else if (meta.status === 404) {
    const err = new Error("Spotify playlist not found (is it public?)");
    err.status = 404;
    throw err;
  }

  const tracks = [];
  let url = `${SPOTIFY_API}/playlists/${playlistId}/tracks?fields=items(track(name,artists(name),external_urls)),next&limit=100`;
  while (url) {
    const res = await fetch(url, { headers });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      const err = new Error(`Spotify playlist fetch failed (${res.status}): ${body.slice(0, 200)}`);
      err.status = res.status === 404 ? 404 : 502;
      throw err;
    }
    const json = await res.json();
    for (const it of json.items || []) {
      if (!it.track || !it.track.name) continue;
      tracks.push({
        title: it.track.name,
        artist: (it.track.artists || []).map((a) => a.name).filter(Boolean).join(", "),
        externalUrl: it.track.external_urls?.spotify || "",
      });
    }
    url = json.next;
  }
  return { tracks, playlistTitle };
}

// Drop common decorations like "(Official MV)", "[HD]", " - Topic" before
// trying to split out artist/title.
function cleanYoutubeTitle(raw) {
  return (raw || "")
    .replace(/[\(\[][^\)\]]*(official|mv|m\/v|music video|audio|lyric[s]?|hd|4k|live|cover|视频|MV)[^\)\]]*[\)\]]/gi, "")
    .replace(/[\(\[]\s*[\)\]]/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function parseYoutubeTitle(raw, channelTitle) {
  const cleaned = cleanYoutubeTitle(raw);
  // Common forms: "Artist - Title", "Artist – Title", "Artist — Title", "Artist | Title"
  const sep = /\s+[\-–—|]\s+/;
  const parts = cleaned.split(sep);
  if (parts.length >= 2) {
    return {
      title: parts.slice(1).join(" - ").trim(),
      artist: parts[0].trim(),
    };
  }
  const channel = (channelTitle || "").replace(/\s*-\s*Topic$/, "").trim();
  return { title: cleaned, artist: channel };
}

export async function fetchYoutubePlaylist(playlistId) {
  const key = process.env.YOUTUBE_API_KEY;
  if (!key) {
    const err = new Error("YouTube API key not configured. Set YOUTUBE_API_KEY in Vercel.");
    err.status = 503;
    throw err;
  }

  let playlistTitle = "";
  try {
    const metaRes = await fetch(
      `${YT_API}/playlists?part=snippet&id=${encodeURIComponent(playlistId)}&key=${key}`
    );
    if (metaRes.ok) {
      const meta = await metaRes.json();
      playlistTitle = meta.items?.[0]?.snippet?.title || "";
    }
  } catch {
    // Title is nice-to-have, not critical.
  }

  const tracks = [];
  let pageToken = "";
  do {
    const params = new URLSearchParams({
      part: "snippet",
      playlistId,
      maxResults: "50",
      key,
    });
    if (pageToken) params.set("pageToken", pageToken);
    const res = await fetch(`${YT_API}/playlistItems?${params}`);
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      const err = new Error(`YouTube playlist fetch failed (${res.status}): ${body.slice(0, 200)}`);
      err.status = res.status === 404 ? 404 : 502;
      throw err;
    }
    const json = await res.json();
    for (const it of json.items || []) {
      const s = it.snippet || {};
      const title = s.title || "";
      if (!title || title === "Deleted video" || title === "Private video") continue;
      const channelTitle = s.videoOwnerChannelTitle || s.channelTitle || "";
      const parsed = parseYoutubeTitle(title, channelTitle);
      tracks.push({
        ...parsed,
        externalUrl: s.resourceId?.videoId
          ? `https://www.youtube.com/watch?v=${s.resourceId.videoId}`
          : "",
      });
    }
    pageToken = json.nextPageToken || "";
  } while (pageToken);

  return { tracks, playlistTitle };
}

export async function fetchPlaylist(url) {
  const source = detectSource(url);
  if (!source) {
    const err = new Error(
      "Couldn't detect a Spotify or YouTube playlist URL. Expected open.spotify.com/playlist/... or youtube.com/playlist?list=..."
    );
    err.status = 400;
    throw err;
  }
  if (source === "spotify") {
    const id = extractSpotifyId(url);
    if (!id) {
      const err = new Error("Couldn't extract Spotify playlist ID from URL");
      err.status = 400;
      throw err;
    }
    const data = await fetchSpotifyPlaylist(id);
    return { source, ...data };
  }
  const id = extractYoutubeId(url);
  if (!id) {
    const err = new Error("Couldn't extract YouTube playlist ID from URL");
    err.status = 400;
    throw err;
  }
  const data = await fetchYoutubePlaylist(id);
  return { source, ...data };
}
