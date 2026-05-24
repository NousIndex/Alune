import { useEffect, useMemo, useState } from "react";
import { fetchPlaylist } from "../lib/playlistApi.js";
import { fetchLyrics, getRateLimitStatus, onRateLimitChange } from "../lib/lyricsApi.js";
import { addSong } from "../lib/libraryApi.js";
import { resolveAliasOrOriginal } from "../lib/aliasApi.js";
import { toCsv, downloadCsv } from "../lib/csv.js";

const PHASE = {
  INPUT: "input",      // typing the URL
  PREVIEW: "preview",  // tracklist fetched, awaiting confirmation
  IMPORTING: "importing",
  DONE: "done",
};

const MIN_LYRIC_CHARS = 20;
// One at a time. The lyrics API caps us at ~10 calls/min, so concurrency > 1
// doesn't speed anything up — the shared limiter in lyricsApi.js serializes
// them anyway. Keeping it at 1 also makes "current track" in the UI accurate.
const CONCURRENCY = 1;

// Normalize that matches Editor.jsx's findExisting() — keeps the dedup logic
// consistent between manual add and bulk import.
const norm = (s) =>
  (s || "").toLowerCase().trim().replace(/\s+/g, " ").normalize("NFC");

function findExistingInLibrary(library, title, artist) {
  const t = norm(title);
  if (!t) return null;
  const a = norm(artist);
  if (a) {
    return library.find((s) => norm(s.title) === t && norm(s.artist) === a) || null;
  }
  return null;
}

async function runWithConcurrency(items, worker, concurrency, onProgress) {
  const results = new Array(items.length);
  let cursor = 0;
  let done = 0;
  async function next() {
    const i = cursor++;
    if (i >= items.length) return;
    try {
      results[i] = await worker(items[i], i);
    } catch (e) {
      results[i] = { error: e };
    }
    done++;
    onProgress?.(done, items.length, results[i], i);
    return next();
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, next));
  return results;
}

export default function PlaylistImport({ open, library, onClose, onImported }) {
  const [url, setUrl] = useState("");
  const [phase, setPhase] = useState(PHASE.INPUT);
  const [fetchError, setFetchError] = useState("");
  const [playlist, setPlaylist] = useState(null); // { source, playlistTitle }
  const [tracks, setTracks] = useState([]);       // local editable copy
  const [selected, setSelected] = useState(new Set()); // indexes into tracks
  const [progress, setProgress] = useState({ done: 0, total: 0, current: "" });
  const [results, setResults] = useState(null); // { added, existed, failed }

  useEffect(() => {
    if (open) {
      setUrl("");
      setPhase(PHASE.INPUT);
      setFetchError("");
      setPlaylist(null);
      setTracks([]);
      setSelected(new Set());
      setProgress({ done: 0, total: 0, current: "" });
      setResults(null);
    }
  }, [open]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== "Escape") return;
      // Don't let Escape kill an import mid-flight — easy to lose progress.
      if (phase === PHASE.IMPORTING) return;
      // If the user is editing a field, the first Escape blurs the input
      // instead of closing the whole modal (avoids losing typed edits).
      const ae = document.activeElement;
      if (ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA")) {
        ae.blur();
        return;
      }
      onClose();
    };
    if (open) window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, phase, onClose]);

  const canFetch = url.trim().length > 0 && phase === PHASE.INPUT;

  const onFetchTracklist = async () => {
    setFetchError("");
    try {
      const data = await fetchPlaylist(url.trim());
      const incoming = data.tracks || [];
      if (!incoming.length) {
        setFetchError("Playlist has no tracks (or they're all private/region-locked).");
        return;
      }
      setPlaylist({ source: data.source, playlistTitle: data.playlistTitle });
      // Shallow-clone so swap edits don't mutate the response object.
      setTracks(incoming.map((t) => ({ ...t })));
      // Pre-select all tracks; user can untick any they want to skip.
      setSelected(new Set(incoming.map((_, i) => i)));
      setPhase(PHASE.PREVIEW);
    } catch (e) {
      setFetchError(e.message || "Couldn't fetch the playlist.");
    }
  };

  const toggleTrack = (i) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  };

  const setAll = (on) => {
    if (!tracks.length) return;
    setSelected(on ? new Set(tracks.map((_, i) => i)) : new Set());
  };

  // Flip title ↔ artist on a single track. Used when the parser got the order
  // wrong (e.g. CJK lyric-channel uploads that put title before artist).
  const swapTrack = (i) => {
    setTracks((prev) => {
      const next = prev.slice();
      const t = next[i];
      if (!t) return prev;
      next[i] = { ...t, title: t.artist || "", artist: t.title || "" };
      return next;
    });
  };

  const swapAllSelected = () => {
    setTracks((prev) =>
      prev.map((t, i) =>
        selected.has(i) ? { ...t, title: t.artist || "", artist: t.title || "" } : t
      )
    );
  };

  // Inline edit: update one field of one track. The state holds the local
  // copy; nothing is sent to the server until startImport.
  const editTrack = (i, field, value) => {
    setTracks((prev) => {
      const next = prev.slice();
      if (!next[i]) return prev;
      next[i] = { ...next[i], [field]: value };
      return next;
    });
  };

  const startImport = async () => {
    if (!tracks.length) return;
    const queue = tracks
      .map((t, i) => ({ ...t, _idx: i }))
      .filter((_, i) => selected.has(i));
    if (!queue.length) return;

    setPhase(PHASE.IMPORTING);
    setProgress({ done: 0, total: queue.length, current: queue[0]?.title || "" });

    const added = [];
    const existed = [];
    const failed = [];

    await runWithConcurrency(
      queue,
      async (t) => {
        // Resolve alias up front so the dedup check uses the formatted artist —
        // catches the case where the library already has the song under the
        // "<CJK> <Latin>" form but the playlist gave just one side.
        const resolvedArtist = await resolveAliasOrOriginal(t.artist);

        // Pre-check the local library so we don't waste a lyrics fetch on dupes.
        const pre =
          findExistingInLibrary(library, t.title, resolvedArtist) ||
          findExistingInLibrary(library, t.title, t.artist);
        if (pre) {
          existed.push({ title: t.title, artist: resolvedArtist || t.artist, id: pre.id });
          return;
        }

        let lyricsData;
        try {
          lyricsData = await fetchLyrics({ title: t.title, artist: t.artist });
        } catch (e) {
          failed.push({
            title: t.title,
            artist: t.artist,
            reason: e?.message || "Lyrics not found",
            url: t.externalUrl || "",
          });
          return;
        }

        const finalTitle = lyricsData.trackName || t.title;
        const fetchedArtist = lyricsData.artistName || t.artist;
        const finalArtist =
          resolvedArtist && resolvedArtist !== t.artist
            ? resolvedArtist
            : await resolveAliasOrOriginal(fetchedArtist);

        const lyrics = (lyricsData.lyrics || "").trim();
        if (lyrics.length < MIN_LYRIC_CHARS) {
          failed.push({
            title: finalTitle,
            artist: finalArtist,
            reason: "Lyrics too short to save",
            url: t.externalUrl || "",
          });
          return;
        }

        try {
          const { song, existed: wasExisting } = await addSong({
            title: finalTitle,
            artist: finalArtist,
            lang: "auto",
            lyrics,
          });
          if (wasExisting) existed.push({ title: song.title, artist: song.artist, id: song.id });
          else added.push({ title: song.title, artist: song.artist, id: song.id });
        } catch (e) {
          failed.push({
            title: finalTitle,
            artist: finalArtist,
            reason: e?.message || "Couldn't save",
            url: t.externalUrl || "",
          });
        }
      },
      CONCURRENCY,
      (done, total, _r, idx) => {
        const next = queue[idx + 1];
        setProgress({ done, total, current: next ? next.title : "" });
      }
    );

    setResults({ added, existed, failed });
    setPhase(PHASE.DONE);
    onImported?.({ added, existed, failed });
  };

  const downloadFailuresCsv = () => {
    if (!results?.failed?.length) return;
    const csv = toCsv(results.failed, [
      { key: "title", label: "Title" },
      { key: "artist", label: "Artist" },
      { key: "reason", label: "Reason" },
      { key: "url", label: "Source URL" },
    ]);
    const slug = (playlist?.playlistTitle || "playlist")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "playlist";
    downloadCsv(`alune-failed-${slug}.csv`, csv);
  };

  if (!open) return null;

  const totalSelected = selected.size;

  return (
    <div
      className="scrim open"
      onClick={(e) =>
        e.target.classList.contains("scrim") && phase !== PHASE.IMPORTING && onClose()
      }
    >
      <div className="modal modal-wide">
        <h2>Import a playlist</h2>

        {phase === PHASE.INPUT && (
          <>
            <div className="field">
              <label>Spotify or YouTube playlist URL</label>
              <input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://open.spotify.com/playlist/…  or  https://www.youtube.com/playlist?list=…"
                autoFocus
              />
              <div className="hint">
                Public playlists only. The app fetches each track's lyrics, looks up
                artist aliases (e.g. 薛之谦 / Joker Xue), and saves new songs to the
                shared library. Existing songs are skipped.
              </div>
            </div>
            {fetchError && <div className="hint error">{fetchError}</div>}
            <div className="modal-actions">
              <button className="btn text" onClick={onClose}>Cancel</button>
              <button
                className="btn primary"
                onClick={onFetchTracklist}
                disabled={!canFetch}
              >
                Fetch tracklist
              </button>
            </div>
          </>
        )}

        {phase === PHASE.PREVIEW && playlist && (
          <PreviewList
            playlist={playlist}
            tracks={tracks}
            selected={selected}
            onToggle={toggleTrack}
            onSelectAll={() => setAll(true)}
            onSelectNone={() => setAll(false)}
            onSwap={swapTrack}
            onSwapAll={swapAllSelected}
            onEdit={editTrack}
            onBack={() => setPhase(PHASE.INPUT)}
            onStart={startImport}
            totalSelected={totalSelected}
          />
        )}

        {phase === PHASE.IMPORTING && (
          <ImportingView progress={progress} />
        )}

        {phase === PHASE.DONE && results && (
          <ResultsView
            results={results}
            onClose={onClose}
            onDownloadCsv={downloadFailuresCsv}
          />
        )}
      </div>
    </div>
  );
}

function PreviewList({
  playlist,
  tracks,
  selected,
  onToggle,
  onSelectAll,
  onSelectNone,
  onSwap,
  onSwapAll,
  onEdit,
  onBack,
  onStart,
  totalSelected,
}) {
  const allOn = selected.size === tracks.length;
  return (
    <>
      <div className="playlist-meta">
        <strong>{playlist.playlistTitle || "Untitled playlist"}</strong>
        <span className="meta-sep">·</span>
        <span>
          {playlist.source === "spotify" ? "Spotify" : "YouTube"}
        </span>
        <span className="meta-sep">·</span>
        <span>{tracks.length} tracks</span>
      </div>
      <div className="playlist-tools">
        <button className="btn text sm" onClick={allOn ? onSelectNone : onSelectAll}>
          {allOn ? "Deselect all" : "Select all"}
        </button>
        <button
          className="btn text sm"
          onClick={onSwapAll}
          disabled={totalSelected === 0}
          title="Swap title ↔ artist for every selected track (useful when the whole playlist uses Title - Artist order)"
        >
          ⇄ Swap selected
        </button>
        <span className="muted">{totalSelected} selected</span>
      </div>
      <div className="hint">
        Tap a field to edit. Use ⇄ on a row to swap title and artist, or the
        toolbar swap to flip every selected track at once.
      </div>
      <ul className="track-list">
        {tracks.map((t, i) => (
          <li key={i} className={selected.has(i) ? "" : "off"}>
            <div className="track-row">
              <input
                type="checkbox"
                className="track-check"
                checked={selected.has(i)}
                onChange={() => onToggle(i)}
                aria-label="Include this track in the import"
              />
              <div className="track-fields">
                <input
                  type="text"
                  className="t-input"
                  value={t.title}
                  onChange={(e) => onEdit(i, "title", e.target.value)}
                  placeholder="Title"
                  aria-label="Song title"
                  spellCheck={false}
                />
                <input
                  type="text"
                  className={"a-input" + (t.artist ? "" : " empty")}
                  value={t.artist}
                  onChange={(e) => onEdit(i, "artist", e.target.value)}
                  placeholder="Artist (leave blank to search by title only)"
                  aria-label="Artist"
                  spellCheck={false}
                />
              </div>
              <button
                type="button"
                className="swap-btn"
                onClick={() => onSwap(i)}
                title="Swap title ↔ artist"
                aria-label="Swap title and artist"
              >
                ⇄
              </button>
            </div>
          </li>
        ))}
      </ul>
      <div className="modal-actions">
        <button className="btn text" onClick={onBack}>Back</button>
        <button
          className="btn primary"
          onClick={onStart}
          disabled={totalSelected === 0}
        >
          Import {totalSelected} {totalSelected === 1 ? "track" : "tracks"}
        </button>
      </div>
    </>
  );
}

function ImportingView({ progress }) {
  const pct = progress.total
    ? Math.min(100, Math.round((progress.done / progress.total) * 100))
    : 0;
  const [rate, setRate] = useState(() => getRateLimitStatus());
  useEffect(() => {
    const off = onRateLimitChange(() => setRate(getRateLimitStatus()));
    // Tick once a second so the countdown moves while we're sleeping.
    const t = setInterval(() => setRate(getRateLimitStatus()), 1000);
    return () => { off(); clearInterval(t); };
  }, []);

  const remaining = Math.max(0, progress.total - progress.done);
  // Rough ETA — at 9 fetches/min plus the local processing per track, assume
  // ~7s per remaining track. Good enough to set expectations.
  const etaSec = remaining * 7;
  const etaText =
    etaSec < 60 ? `${etaSec}s`
    : `${Math.ceil(etaSec / 60)} min`;

  const waitingSec = Math.ceil(rate.nextSlotMs / 1000);

  return (
    <div className="import-progress">
      <div className="progress-bar">
        <div className="progress-fill" style={{ width: `${pct}%` }} />
      </div>
      <div className="progress-text">
        <strong>
          {progress.done} / {progress.total}
        </strong>{" "}
        {progress.current ? (
          <>
            <span className="muted">— current:</span> {progress.current}
          </>
        ) : null}
      </div>
      {waitingSec > 0 && (
        <div className="rate-wait">
          ⏳ Waiting {waitingSec}s for the lyrics API rate limit
          {rate.used >= rate.budget ? ` (${rate.used}/${rate.budget} used in the last minute)` : ""}…
        </div>
      )}
      <div className="hint">
        Lyrics fetches are capped at {rate.budget}/min to stay under the upstream
        limit. Rough ETA: ~{etaText}. Long playlists will pause periodically while
        the window resets — that's expected.
      </div>
    </div>
  );
}

function ResultsView({ results, onClose, onDownloadCsv }) {
  const { added, existed, failed } = results;
  return (
    <>
      <div className="results-summary">
        <div className="result-card added">
          <div className="big">{added.length}</div>
          <div>added</div>
        </div>
        <div className="result-card existed">
          <div className="big">{existed.length}</div>
          <div>already in library</div>
        </div>
        <div className="result-card failed">
          <div className="big">{failed.length}</div>
          <div>couldn't add</div>
        </div>
      </div>
      {failed.length > 0 && (
        <>
          <div className="results-tools">
            <strong>Couldn't add ({failed.length}):</strong>
            <button className="btn text sm" onClick={onDownloadCsv}>
              Download as CSV
            </button>
          </div>
          <ul className="failed-list">
            {failed.map((f, i) => (
              <li key={i}>
                <div>
                  <span className="t">{f.title}</span>{" "}
                  <span className="a">— {f.artist || "?"}</span>
                </div>
                <div className="reason">{f.reason}</div>
              </li>
            ))}
          </ul>
        </>
      )}
      <div className="modal-actions">
        <button className="btn primary" onClick={onClose}>Done</button>
      </div>
    </>
  );
}
