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

// Throwaway keywords commonly seen in parenthetical tags on YouTube titles.
// Used to decide whether to strip a (...) or [...] group entirely.
const YT_TAG_KEYWORDS = /(official|mv|m\/v|music\s*video|audio|lyric[s]?|hd|4k|live|cover|视频|动态歌词|動態歌詞|歌詞版?|歌词版?|歌詞|歌词|完整版|高音質|高音质|高清|字幕|純音樂|纯音乐|純伴奏|純音檔|消音|伴奏)/i;

// A 【...】 tag containing one of these is the strongest "this is a lyric
// reupload, not an original release" signal we have. When present we know
// 「...」/『...』 snippets in the same title are teaser lyrics and can be
// stripped aggressively. When absent, short CJK quote-bracket content is
// usually a movie or song reference (e.g. 「月老」) and should be preserved.
const LYRIC_CHANNEL_TAG = /【\s*(動態歌詞|动态歌词|歌詞版?|歌词版?|Lyrics?\s*Video?|Lyrics?)[^】]*】/i;

// 「X」 or 『X』 with 6+ chars is almost always a lyric excerpt even without
// the channel tag, so still strip those. Short bracketed references (≤5
// chars) likely point at a movie/song title and stay.
const LONG_QUOTE_SNIPPET_RE = /[『「][^』」]{6,}[』」]/g;

// 原唱：X — credits the original singer. Strong artist signal that the parser
// can grab even when the title has no separator.
const ORIGINAL_ARTIST_RE = /[（(]\s*(?:原唱|原唱者|原作|原作者|演唱)\s*[:：]\s*([^）)]+?)\s*[）)]/;

// Naked tag phrases that appear outside brackets. Stripped so they don't end
// up as part of the song title (e.g. "Official Music Video" without parens).
const NAKED_TAG_RE = /\b(official\s*(?:music\s*video|video|audio|MV|m\/v)|music\s*video|m\/v\b|lyric\s*video|歌詞版|歌詞|完整版|高音質|純音樂|純音檔|動態歌詞)\b/gi;

function cleanYoutubeTitle(raw, opts = {}) {
  const { stripQuoteSnippets = false } = opts;
  let s = raw || "";
  // Strip the 原唱 paren entirely after the caller has already extracted it.
  s = s.replace(/[（(]\s*(?:原唱|原唱者|原作|原作者|演唱)\s*[:：][^）)]*[）)]/g, "");
  // CJK decoration brackets — keyword-gated only. Bare 【...】 sometimes holds
  // the actual song title (e.g. "盧廣仲【刻在我心底的名字】"), so we don't
  // strip those unless they look like tags.
  s = s.replace(/【([^】]*)】/g, (m, inner) => (YT_TAG_KEYWORDS.test(inner) ? "" : m));
  s = s.replace(/〔([^〕]*)〕/g, (m, inner) => (YT_TAG_KEYWORDS.test(inner) ? "" : m));
  s = s.replace(/《([^》]*)》/g, (m, inner) => (YT_TAG_KEYWORDS.test(inner) ? "" : m));
  // CJK quote-bracket excerpts. Conditional on the lyric-channel signal (see
  // caller). Long snippets (6+ chars) get stripped regardless.
  if (stripQuoteSnippets) {
    s = s.replace(/『[^』]*』/g, "");
    s = s.replace(/「[^」]*」/g, "");
    s = s.replace(/〈[^〉]*〉/g, "");
  } else {
    s = s.replace(LONG_QUOTE_SNIPPET_RE, "");
  }
  // ASCII parens/brackets — keyword-gated, so things like "(feat. X)" or
  // bracketed subtitles stay.
  s = s.replace(/[\(\[][^\)\]]*[\)\]]/g, (m) =>
    YT_TAG_KEYWORDS.test(m) ? "" : m
  );
  s = s.replace(/[\(\[]\s*[\)\]]/g, "");
  // Full-width parens (CJK convention), same keyword gate.
  s = s.replace(/（([^）]*)）/g, (m, inner) => (YT_TAG_KEYWORDS.test(inner) ? "" : m));
  s = s.replace(/（\s*）/g, "");
  // Naked throwaway phrases like "Official Music Video" outside any bracket.
  s = s.replace(NAKED_TAG_RE, " ");
  // Decorative music symbols.
  s = s.replace(/[♪♫♬]+/g, " ");
  // Collapse whitespace and trim stray punctuation at the edges.
  s = s.replace(/\s{2,}/g, " ").trim();
  s = s.replace(/^[\s\-–—|·•]+|[\s\-–—|·•]+$/g, "");
  return s;
}

const normCompact = (s) =>
  (s || "").toLowerCase().replace(/\s+/g, "").normalize("NFC");

// Does `part` look like the channel's identity? True when the normalized
// channel name contains the normalized part (e.g. channel "林俊杰 Official"
// contains "林俊杰"; channel "JJ Lin - Topic" → "jjlin" contains "jjlin"
// from the part "JJ Lin"). Cross-script matches (CJK part vs Latin channel)
// won't catch — that's handled later via alias resolution on the client.
function partMatchesChannel(part, channelClean) {
  const p = normCompact(part);
  const c = normCompact(channelClean);
  if (!p || !c || p.length < 2) return false;
  return c.includes(p);
}

function parseYoutubeTitle(raw, channelTitle) {
  // Extract artist hints from the raw title BEFORE the cleaner removes them.
  const originalArtistMatch = (raw || "").match(ORIGINAL_ARTIST_RE);
  const originalArtist = originalArtistMatch?.[1]?.trim() || "";

  const isLyricRepost = LYRIC_CHANNEL_TAG.test(raw || "");
  const cleaned = cleanYoutubeTitle(raw, { stripQuoteSnippets: isLyricRepost });
  const channelClean = (channelTitle || "").replace(/\s*-\s*Topic$/, "").trim();

  // Pattern 1: "X - Y" with a dash/pipe separator. Default reading is
  // "Artist - Title"; the channel-name tiebreaker flips it to "Title - Artist"
  // when the tail clearly matches the channel.
  const sep = /\s+[\-–—|]\s+/;
  const parts = cleaned.split(sep);
  if (parts.length >= 2) {
    const head = parts[0].trim();
    const tail = parts.slice(1).join(" - ").trim();
    const headIsArtist = partMatchesChannel(head, channelClean);
    const tailIsArtist = partMatchesChannel(tail, channelClean);
    if (tailIsArtist && !headIsArtist) {
      return { title: head, artist: originalArtist || tail };
    }
    return { title: tail, artist: originalArtist || head };
  }

  // Pattern 2: "Artist 【Title】 (extras)" — common in official Asian uploads
  // where the bracketed content holds the actual song title. The cleaner has
  // already stripped tag-keyword brackets, so anything left here is content.
  const bracketMatch = cleaned.match(/^(.+?)\s*【([^】]+)】\s*(.*)$/);
  if (bracketMatch) {
    const before = bracketMatch[1].trim();
    const inner = bracketMatch[2].trim();
    if (before.length >= 1 && inner.length >= 2) {
      return { title: inner, artist: originalArtist || before };
    }
  }

  if (isLyricRepost) {
    return { title: cleaned, artist: originalArtist || "" };
  }
  return { title: cleaned, artist: originalArtist || channelClean };
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
        channelTitle,
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
