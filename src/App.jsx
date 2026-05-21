import { useEffect, useMemo, useState } from "react";
import Library from "./components/Library.jsx";
import Reader from "./components/Reader.jsx";
import Editor from "./components/Editor.jsx";
import Notice from "./components/Notice.jsx";
import { loadSettings, saveSettings } from "./lib/storage.js";
import { getLibrary, addSong } from "./lib/libraryApi.js";
import {
  lightSearchText,
  getCachedOrBuild,
  indexLibraryInBackground,
} from "./lib/searchIndex.js";

export default function App() {
  const [library, setLibrary] = useState([]);
  const [libState, setLibState] = useState({ loading: true, error: "" });
  const [settings, setSettings] = useState(loadSettings);
  const [activeId, setActiveId] = useState(null);
  const [search, setSearch] = useState("");
  const [editorOpen, setEditorOpen] = useState(false);
  const [railOpen, setRailOpen] = useState(false);
  const [notice, setNotice] = useState({ open: false, message: "" });
  const [searchIndex, setSearchIndex] = useState(() => new Map());
  const [indexProgress, setIndexProgress] = useState({ done: 0, total: 0, finished: false });

  useEffect(() => {
    let cancelled = false;
    getLibrary()
      .then((songs) => {
        if (cancelled) return;
        setLibrary(songs);
        setLibState({ loading: false, error: "" });
      })
      .catch((e) => {
        if (cancelled) return;
        setLibState({ loading: false, error: e.message });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => saveSettings(settings), [settings]);
  useEffect(() => {
    document.documentElement.style.setProperty("--lyric-size", settings.size + "rem");
  }, [settings.size]);

  // Sync light index (title + artist + pinyin/romaji) for instant search,
  // then upgrade per song with the full lyric index in the background.
  useEffect(() => {
    if (!library.length) {
      setSearchIndex(new Map());
      setIndexProgress({ done: 0, total: 0, finished: true });
      return;
    }
    const light = new Map();
    for (const s of library) light.set(s.id, lightSearchText(s));
    setSearchIndex(light);
    setIndexProgress({ done: 0, total: library.length, finished: false });

    const stop = indexLibraryInBackground(library, ({ id, text, done, total, finished }) => {
      if (id && text) {
        setSearchIndex((m) => {
          const next = new Map(m);
          next.set(id, text);
          return next;
        });
      }
      setIndexProgress({ done, total, finished });
    });
    return stop;
  }, [library]);

  const activeSong = useMemo(
    () => library.find((s) => s.id === activeId) || null,
    [library, activeId]
  );

  const handleSave = async (form) => {
    const { song, existed } = await addSong(form);
    setLibrary((lib) =>
      lib.some((s) => s.id === song.id) ? lib : [song, ...lib]
    );
    setActiveId(song.id);
    setEditorOpen(false);
    if (existed) {
      setNotice({
        open: true,
        message: `“${song.title}” is already in the library — opening it.`,
      });
    }
    // Pre-warm index for the new song so it's searchable immediately by pinyin/romaji.
    setSearchIndex((m) => new Map(m).set(song.id, lightSearchText(song)));
    getCachedOrBuild(song).then((text) => {
      setSearchIndex((m) => new Map(m).set(song.id, text));
    });
  };

  const toggleRomaji = () =>
    setSettings((s) => ({ ...s, showRomaji: !s.showRomaji }));
  const resize = (delta) =>
    setSettings((s) => ({
      ...s,
      size: Math.min(2.6, Math.max(1.0, +(s.size + delta).toFixed(2))),
    }));

  const selectSong = (id) => {
    setActiveId(id);
    setRailOpen(false);
  };

  return (
    <div className={"app" + (railOpen ? " rail-open" : "")}>
      <button
        className="rail-toggle"
        onClick={() => setRailOpen((o) => !o)}
        aria-label={railOpen ? "Close library" : "Open library"}
      >
        {railOpen ? "✕" : "☰"}
      </button>
      <div className="rail-backdrop" onClick={() => setRailOpen(false)} />

      <Library
        library={library}
        loading={libState.loading}
        error={libState.error}
        activeId={activeId}
        search={search}
        onSearch={setSearch}
        onSelect={selectSong}
        onAdd={() => {
          setEditorOpen(true);
          setRailOpen(false);
        }}
        onExport={exportLibrary}
        searchIndex={searchIndex}
        indexProgress={indexProgress}
      />

      <main className="stage">
        {activeSong ? (
          <Reader
            key={activeSong.id}
            song={activeSong}
            settings={settings}
            onToggleRomaji={toggleRomaji}
            onResize={resize}
          />
        ) : (
          <div className="center-state">
            <h3>A quieter place for lyrics.</h3>
            <p>
              Pick a song from the shared library, or add one. Chinese gets Hànyǔ
              Pīnyīn, Japanese gets rōmaji — set right above the characters.
            </p>
            <button className="btn primary" onClick={() => setEditorOpen(true)}>
              Add a song
            </button>
          </div>
        )}
      </main>

      <Editor
        open={editorOpen}
        library={library}
        onSave={handleSave}
        onSelectExisting={(song) => {
          setActiveId(song.id);
          setEditorOpen(false);
          setNotice({
            open: true,
            message: `“${song.title}” is already in the library — opening it.`,
          });
        }}
        onClose={() => setEditorOpen(false)}
      />

      <Notice
        open={notice.open}
        message={notice.message}
        onClose={() => setNotice((n) => ({ ...n, open: false }))}
      />
    </div>
  );
}
