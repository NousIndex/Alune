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

export default function Editor({ open, initial, onSave, onClose }) {
  const [form, setForm] = useState(EMPTY);
  const [fetchState, setFetchState] = useState({ loading: false, error: "" });

  useEffect(() => {
    if (open) {
      setForm(initial ? { ...initial } : EMPTY);
      setFetchState({ loading: false, error: "" });
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
    setFetchState({ loading: true, error: "" });
    try {
      const data = await fetchLyrics({ title: form.title, artist: form.artist });
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

        <div className="modal-actions">
          <button className="btn text" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            onClick={() => onSave({ ...form, title: form.title.trim() || "Untitled" })}
          >
            Save song
          </button>
        </div>
      </div>
    </div>
  );
}
