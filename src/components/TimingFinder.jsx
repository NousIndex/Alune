import { useEffect, useState } from "react";
import { fetchSyncedCandidates } from "../lib/syncedApi.js";
import { parseLrc } from "../lib/lrc.js";
import { updateSong } from "../lib/libraryApi.js";
import { useScrimDismiss } from "../lib/useScrimDismiss.js";

const fmtDur = (s) => (s ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}` : "—");

// Admin dialog to fetch karaoke timing for one song, with editable search terms
// AND a candidate list — LRCLIB often has several versions (single, album,
// live, cover), so the admin can pick the right one instead of taking whatever
// matched first. Saving only writes the timing fields, never the lyrics.
export default function TimingFinder({ open, song, onClose, onSaved }) {
  const [title, setTitle] = useState("");
  const [artist, setArtist] = useState("");
  const [phase, setPhase] = useState("idle"); // idle | searching | result | saving
  const [candidates, setCandidates] = useState([]); // each: { ...cand, lines, lineCount }
  const [selected, setSelected] = useState(0);
  const [searched, setSearched] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (open && song) {
      setTitle(song.title || "");
      setArtist(song.artist || "");
      setPhase("idle");
      setCandidates([]);
      setSelected(0);
      setSearched(false);
      setError("");
    }
  }, [open, song]);

  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && phase !== "saving" && onClose();
    if (open) window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, phase, onClose]);

  const dismiss = useScrimDismiss(onClose, phase !== "saving");

  if (!open || !song) return null;

  const search = async () => {
    const t = title.trim();
    if (!t) return;
    setPhase("searching");
    setError("");
    setCandidates([]);
    setSearched(false);
    try {
      const list = await fetchSyncedCandidates({ title: t, artist: artist.trim() });
      const withLines = list.map((c) => {
        const lines = parseLrc(c.syncedLyrics);
        return { ...c, lines, lineCount: lines.length };
      });
      setCandidates(withLines);
      setSelected(0);
      setSearched(true);
      setPhase("result");
    } catch (e) {
      setError(e?.message || "Search failed");
      setPhase("idle");
    }
  };

  const save = async () => {
    const c = candidates[selected];
    if (!c) return;
    setPhase("saving");
    try {
      const updated = await updateSong({
        id: song.id,
        syncedLyrics: c.syncedLyrics,
        duration: c.duration,
        syncedSource: c.source,
      });
      onSaved?.(updated);
      onClose();
    } catch (e) {
      setError(e?.message || "Couldn't save");
      setPhase("result");
    }
  };

  const chosen = candidates[selected];

  return (
    <div className="scrim open" {...dismiss}>
      <div className="modal modal-wide">
        <h2>Find karaoke timing</h2>
        <p className="hint">
          Search LRCLIB for timed (synced) lyrics, then pick the right version.
          Tweak the title or artist if the stored values don't match — e.g. use
          just <code>周杰倫</code> or <code>Jay Chou</code> instead of the combined
          form. Saving adds only the timing; your lyrics aren't touched.
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
          (candidates.length ? (
            <div className="field">
              <div className="hint">
                {candidates.length} match{candidates.length === 1 ? "" : "es"} — pick the
                right version:
              </div>
              <ul className="candidate-list">
                {candidates.map((c, i) => (
                  <li
                    key={i}
                    className={"candidate" + (selected === i ? " sel" : "")}
                    onClick={() => setSelected(i)}
                  >
                    <input
                      type="radio"
                      checked={selected === i}
                      onChange={() => setSelected(i)}
                      aria-label={`Use ${c.trackName || "this match"}`}
                    />
                    <div className="cand-body">
                      <div className="cand-main">
                        <strong>{c.trackName || "—"}</strong>
                        <span className="cand-artist">{c.artistName || "—"}</span>
                      </div>
                      <div className="cand-meta">
                        {c.albumName ? `${c.albumName} · ` : ""}
                        {fmtDur(c.duration)} · {c.lineCount} lines · {c.source}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
              {chosen && (
                <pre className="lyrics-preview">
                  {chosen.lines.slice(0, 5).map((l) => l.text).join("\n")}
                  {chosen.lines.length > 5 ? "\n…" : ""}
                </pre>
              )}
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
            disabled={!chosen || phase === "saving"}
          >
            {phase === "saving" ? "Saving…" : "Use selected"}
          </button>
        </div>
      </div>
    </div>
  );
}
