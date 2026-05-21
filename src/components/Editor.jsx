import { useEffect, useState } from "react";
import { fetchLyrics } from "../lib/lyricsApi";

const LANGS = [
  { id: "auto", label: "Auto-detect" },
  { id: "zh", label: "中文" },
  { id: "ja", label: "日本語" },
  { id: "ko", label: "한국어" },
  { id: "en", label: "English" },
];

const EMPTY = { title: "", artist: "", lang: "auto", lyrics: "" };

const norm = (s) =>
  (s || "").toLowerCase().trim().replace(/\s+/g, " ").normalize("NFC");
// Strict dedup matches the server (title + artist). Loose match (title only)
// is used as a secondary pre-check when the user hasn't entered an artist yet.
function findExisting(library, title, artist) {
  const t = norm(title);
  if (!t) return null;
  const a = norm(artist);
  if (a) {
    const strict = library.find(
      (s) => norm(s.title) === t && norm(s.artist) === a
    );
    if (strict) return strict;
  }
  const matchesTitle = library.filter((s) => norm(s.title) === t);
  // Only auto-match by title alone if it's unambiguous.
  return matchesTitle.length === 1 ? matchesTitle[0] : null;
}

export default function Editor({ open, initial, library, onSave, onSelectExisting, onClose }) {
  const [form, setForm] = useState(EMPTY);
  const [fetchState, setFetchState] = useState({ loading: false, error: "" });
  const [saveState, setSaveState] = useState({ saving: false, error: "" });

  useEffect(() => {
    if (open) {
      setForm(initial ? { ...initial } : EMPTY);
      setFetchState({ loading: false, error: "" });
      setSaveState({ saving: false, error: "" });
    }
  }, [open, initial]);

  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && onClose();
    if (open) window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const onFetch = async () => {
    // 1) Check existing library before hitting the lyrics API. Catches the
    //    case where the user has typed enough to identify a song already saved.
    const existingNow = findExisting(library || [], form.title, form.artist);
    if (existingNow) {
      onSelectExisting?.(existingNow);
      return;
    }

    setFetchState({ loading: true, error: "" });
    try {
      const data = await fetchLyrics({ title: form.title, artist: form.artist });

      // 2) Re-check after the API resolves the artist — covers the case where
      //    the user typed only a title and an artist was unknown until now.
      const fetchedTitle = data.trackName || form.title;
      const fetchedArtist = data.artistName || form.artist;
      const existingAfter = findExisting(library || [], fetchedTitle, fetchedArtist);
      if (existingAfter) {
        onSelectExisting?.(existingAfter);
        return;
      }

      setForm((f) => ({
        ...f,
        lyrics: data.lyrics,
        artist: f.artist.trim() || data.artistName || "",
        title: f.title.trim() || data.trackName || "",
      }));
      setFetchState({ loading: false, error: "" });
    } catch (e) {
      setFetchState({ loading: false, error: e.message || "Couldn't fetch lyrics" });
    }
  };

  const canFetch = form.title.trim().length > 0 && !fetchState.loading;

  const onSaveClick = async () => {
    if (saveState.saving) return;
    setSaveState({ saving: true, error: "" });
    try {
      await onSave({ ...form, title: form.title.trim() || "Untitled" });
      // Editor unmounts on success; no need to clear state.
    } catch (e) {
      setSaveState({ saving: false, error: e?.message || "Couldn't save" });
    }
  };

  return (
    <div
      className="scrim open"
      onClick={(e) => e.target.classList.contains("scrim") && onClose()}
    >
      <div className="modal">
        <h2>{initial ? "Edit song" : "Add a song"}</h2>

        <div className="field">
          <label>Title</label>
          <input value={form.title} onChange={set("title")} placeholder="Song title" />
        </div>

        <div className="field">
          <label>
            Artist / source <span className="opt">(optional)</span>
          </label>
          <input
            value={form.artist}
            onChange={set("artist")}
            placeholder="Artist, album, poet…"
          />
        </div>

        <div className="field">
          <label>Language</label>
          <div className="seg">
            {LANGS.map((l) => (
              <button
                key={l.id}
                className={form.lang === l.id ? "sel" : ""}
                onClick={() => setForm((f) => ({ ...f, lang: l.id }))}
              >
                {l.label}
              </button>
            ))}
          </div>
          <div className="hint">
            Auto-detect works line-by-line. Force a language if a Japanese line is all
            kanji (no kana), or pick English to skip readings entirely.
          </div>
        </div>

        <div className="field">
          <div className="field-row">
            <label>Lyrics</label>
            <button
              type="button"
              className="btn ghost sm"
              onClick={onFetch}
              disabled={!canFetch}
              title="Fetch lyrics from Musixmatch / YouTube Music"
            >
              {fetchState.loading ? "Fetching…" : "Fetch lyrics"}
            </button>
          </div>
          <textarea
            value={form.lyrics}
            onChange={set("lyrics")}
            placeholder="Paste lyrics here, one line per line…"
          />
          {fetchState.error && <div className="hint error">{fetchState.error}</div>}
        </div>

        {saveState.error && <div className="hint error">{saveState.error}</div>}
        <div className="modal-actions">
          <button className="btn text" onClick={onClose} disabled={saveState.saving}>
            Cancel
          </button>
          <button
            className="btn primary"
            onClick={onSaveClick}
            disabled={saveState.saving}
          >
            {saveState.saving ? "Saving…" : "Save song"}
          </button>
        </div>
      </div>
    </div>
  );
}
