import { useEffect, useState } from "react";
import { fetchSynced } from "../lib/syncedApi.js";
import { parseLrc } from "../lib/lrc.js";
import { updateSong } from "../lib/libraryApi.js";

// Admin dialog to fetch karaoke timing for one song, with editable search terms.
// The stored artist is often the combined "周杰倫 Jay Chou" form which matches
// LRCLIB poorly — letting the admin tweak title/artist and preview the result
// before saving fixes that. Saving only writes the timing fields, never lyrics.
export default function TimingFinder({ open, song, onClose, onSaved }) {
  const [title, setTitle] = useState("");
  const [artist, setArtist] = useState("");
  const [phase, setPhase] = useState("idle"); // idle | searching | result | saving
  const [result, setResult] = useState(null); // { syncedLyrics, duration, source, lines }
  const [searched, setSearched] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (open && song) {
      setTitle(song.title || "");
      setArtist(song.artist || "");
      setPhase("idle");
      setResult(null);
      setSearched(false);
      setError("");
    }
  }, [open, song]);

  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && phase !== "saving" && onClose();
    if (open) window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, phase, onClose]);

  if (!open || !song) return null;

  const search = async () => {
    const t = title.trim();
    if (!t) return;
    setPhase("searching");
    setError("");
    setResult(null);
    setSearched(false);
    try {
      const r = await fetchSynced({ title: t, artist: artist.trim() });
      setResult(r?.syncedLyrics ? { ...r, lines: parseLrc(r.syncedLyrics) } : null);
      setSearched(true);
      setPhase("result");
    } catch (e) {
      setError(e?.message || "Search failed");
      setPhase("idle");
    }
  };

  const save = async () => {
    if (!result) return;
    setPhase("saving");
    try {
      const updated = await updateSong({
        id: song.id,
        syncedLyrics: result.syncedLyrics,
        duration: result.duration,
        syncedSource: result.source,
      });
      onSaved?.(updated);
      onClose();
    } catch (e) {
      setError(e?.message || "Couldn't save");
      setPhase("result");
    }
  };

  return (
    <div
      className="scrim open"
      onClick={(e) => e.target.classList.contains("scrim") && phase !== "saving" && onClose()}
    >
      <div className="modal">
        <h2>Find karaoke timing</h2>
        <p className="hint">
          Search LRCLIB for timed (synced) lyrics. Tweak the title or artist if the
          stored values don't match — e.g. use just <code>周杰倫</code> or{" "}
          <code>Jay Chou</code> instead of the combined form. Saving adds only the
          timing; your lyrics aren't touched.
        </p>

        <div className="field">
          <label>Title to search</label>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Song title"
            autoFocus
          />
        </div>
        <div className="field">
          <label>Artist to search</label>
          <input
            value={artist}
            onChange={(e) => setArtist(e.target.value)}
            placeholder="Artist (optional — try one script)"
          />
        </div>

        {phase === "result" &&
          (result ? (
            <div className="field">
              <div className="hint synced-ok">
                ♪ Found {result.lines.length} timed lines ({result.source})
                {result.duration ? ` · ${Math.floor(result.duration / 60)}:${String(result.duration % 60).padStart(2, "0")}` : ""}
              </div>
              <pre className="lyrics-preview">
                {result.lines.slice(0, 5).map((l) => l.text).join("\n")}
                {result.lines.length > 5 ? "\n…" : ""}
              </pre>
            </div>
          ) : (
            <div className="hint">No timed lyrics found — try different terms.</div>
          ))}
        {error && <div className="hint error">{error}</div>}

        <div className="modal-actions">
          <button className="btn text" onClick={onClose} disabled={phase === "saving"}>
            Cancel
          </button>
          <button
            className="btn ghost"
            onClick={search}
            disabled={phase === "searching" || phase === "saving" || !title.trim()}
          >
            {phase === "searching" ? "Searching…" : searched ? "Search again" : "Search"}
          </button>
          <button
            className="btn primary"
            onClick={save}
            disabled={!result || phase === "saving"}
          >
            {phase === "saving" ? "Saving…" : "Use this timing"}
          </button>
        </div>
      </div>
    </div>
  );
}
