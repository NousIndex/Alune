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
const MIN_LYRIC_CHARS = 20;

const SOURCES = [
  { id: "auto", label: "Auto" },
  { id: "musixmatch", label: "Musixmatch" },
  { id: "youtube", label: "YouTube" },
];

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
  const [source, setSource] = useState("auto");

  useEffect(() => {
    if (open) {
      setForm(initial ? { ...initial } : EMPTY);
      setFetchState({ loading: false, error: "" });
      setSaveState({ saving: false, error: "" });
      setSource("auto");
    }
  }, [open, initial]);

  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && onClose();
    if (open) window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const isEdit = Boolean(initial?.id);

  const onFetch = async () => {
    // 1) Check existing library before hitting the lyrics API. Catches the
    //    case where the user has typed enough to identify a song already saved.
    //    Skip in edit mode — finding the song you're editing isn't a dup.
    if (!isEdit) {
      const existingNow = findExisting(library || [], form.title, form.artist);
      if (existingNow) {
        onSelectExisting?.(existingNow);
        return;
      }
    }

    setFetchState({ loading: true, error: "" });
    try {
      const data = await fetchLyrics({ title: form.title, artist: form.artist, source });

      // 2) Re-check after the API resolves the artist — covers the case where
      //    the user typed only a title and an artist was unknown until now.
      const fetchedTitle = data.trackName || form.title;
      const fetchedArtist = data.artistName || form.artist;
      if (!isEdit) {
        const existingAfter = findExisting(library || [], fetchedTitle, fetchedArtist);
        if (existingAfter) {
          onSelectExisting?.(existingAfter);
          return;
        }
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

  const lyricsLen = form.lyrics.trim().length;
  const hasTitle = form.title.trim().length > 0;
  const hasArtist = form.artist.trim().length > 0;
  const hasEnoughLyrics = lyricsLen >= MIN_LYRIC_CHARS;
  const canSave = hasTitle && hasArtist && hasEnoughLyrics && !saveState.saving;

  const validationHint = !hasTitle
    ? "Add a title before saving."
    : !hasArtist
      ? "Artist is required."
      : !hasEnoughLyrics
        ? `Add at least ${MIN_LYRIC_CHARS} characters of lyrics (${lyricsLen}/${MIN_LYRIC_CHARS}).`
        : "";

  const onSaveClick = async () => {
    if (!canSave) return;
    setSaveState({ saving: true, error: "" });
    try {
      const payload = { ...form, title: form.title.trim() };
      if (isEdit) payload.id = initial.id;
      await onSave(payload);
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
          <label>Artist / source</label>
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
            <div className="fetch-controls">
              <div className="seg seg-compact" role="group" aria-label="Lyrics source">
                {SOURCES.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    className={source === s.id ? "sel" : ""}
                    onClick={() => setSource(s.id)}
                    disabled={fetchState.loading}
                    title={
                      s.id === "auto"
                        ? "Try Musixmatch, fall back to YouTube"
                        : `Force ${s.label} source`
                    }
                  >
                    {s.label}
                  </button>
                ))}
              </div>
              <button
                type="button"
                className="btn ghost sm"
                onClick={onFetch}
                disabled={!canFetch}
                title="Fetch lyrics from the selected source"
              >
                {fetchState.loading ? "Fetching…" : "Fetch lyrics"}
              </button>
            </div>
          </div>
          <textarea
            value={form.lyrics}
            onChange={set("lyrics")}
            placeholder="Paste lyrics here, one line per line…"
          />
          {fetchState.error && <div className="hint error">{fetchState.error}</div>}
        </div>

        {saveState.error && <div className="hint error">{saveState.error}</div>}
        {!saveState.error && validationHint && (
          <div className="hint">{validationHint}</div>
        )}
        <div className="modal-actions">
          <button className="btn text" onClick={onClose} disabled={saveState.saving}>
            Cancel
          </button>
          <button
            className="btn primary"
            onClick={onSaveClick}
            disabled={!canSave}
            title={!canSave && validationHint ? validationHint : undefined}
          >
            {saveState.saving ? "Saving…" : isEdit ? "Save changes" : "Save song"}
          </button>
        </div>
      </div>
    </div>
  );
}
