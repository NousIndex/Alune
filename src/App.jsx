import { useEffect, useMemo, useState } from "react";
import Library from "./components/Library.jsx";
import Reader from "./components/Reader.jsx";
import Editor from "./components/Editor.jsx";
import Notice from "./components/Notice.jsx";
import AdminGate from "./components/AdminGate.jsx";
import SearchOverlay from "./components/SearchOverlay.jsx";
import { loadSettings, saveSettings } from "./lib/storage.js";
import { getLibrary, addSong, updateSong, deleteSong } from "./lib/libraryApi.js";
import { getAdminToken, clearAdminToken } from "./lib/admin.js";
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
  const [editingSong, setEditingSong] = useState(null);
  const [railOpen, setRailOpen] = useState(false);
  const [searchOverlayOpen, setSearchOverlayOpen] = useState(false);
  const [notice, setNotice] = useState({ open: false, message: "" });
  const [adminOpen, setAdminOpen] = useState(false);
  const [isAdmin, setIsAdmin] = useState(() => Boolean(getAdminToken()));
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
    if (form.id) {
      // Edit path — PATCH the existing song and replace it in the library.
      const updated = await updateSong(form);
      setLibrary((lib) => lib.map((s) => (s.id === updated.id ? updated : s)));
      setActiveId(updated.id);
      setEditorOpen(false);
      setEditingSong(null);
      setSearchIndex((m) => new Map(m).set(updated.id, lightSearchText(updated)));
      getCachedOrBuild(updated).then((text) => {
        setSearchIndex((m) => new Map(m).set(updated.id, text));
      });
      return;
    }
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

  const handleEditActive = () => {
    if (!activeSong) return;
    setEditingSong(activeSong);
    setEditorOpen(true);
  };

  const handleDeleteActive = async () => {
    if (!activeSong) return;
    const ok = window.confirm(
      `Delete “${activeSong.title}” from the shared library? This can't be undone.`
    );
    if (!ok) return;
    try {
      await deleteSong(activeSong.id);
      const removedId = activeSong.id;
      setLibrary((lib) => lib.filter((s) => s.id !== removedId));
      setActiveId(null);
      setSearchIndex((m) => {
        const next = new Map(m);
        next.delete(removedId);
        return next;
      });
    } catch (e) {
      setNotice({ open: true, message: e?.message || "Couldn't delete." });
    }
  };

  const handleAdminSignOut = () => {
    clearAdminToken();
    setIsAdmin(false);
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
      <button
        className="rail-search-btn"
        onClick={() => setSearchOverlayOpen(true)}
        aria-label="Search library"
      >
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
          <circle cx="10.5" cy="10.5" r="6.5" fill="none" stroke="currentColor" strokeWidth="2" />
          <line x1="15.3" y1="15.3" x2="20" y2="20" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
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
        searchIndex={searchIndex}
        indexProgress={indexProgress}
        isAdmin={isAdmin}
        onAdminSignIn={() => setAdminOpen(true)}
        onAdminSignOut={handleAdminSignOut}
      />

      <main className="stage">
        {activeSong ? (
          <Reader
            key={activeSong.id}
            song={activeSong}
            settings={settings}
            onToggleRomaji={toggleRomaji}
            onResize={resize}
            isAdmin={isAdmin}
            onEdit={handleEditActive}
            onDelete={handleDeleteActive}
          />
        ) : (
          <div className="center-state">
            <h3>A quieter place for lyrics.</h3>
            <p>
              Pick a song from the shared library, or add one. Chinese gets Hànyǔ
              Pīnyīn, Japanese gets rōmaji — set right above the characters.
            </p>
            <div className="center-actions">
              <button className="btn primary" onClick={() => setEditorOpen(true)}>
                Add a song
              </button>
              <button
                className="btn ghost"
                onClick={() => setSearchOverlayOpen(true)}
                disabled={library.length === 0}
                title={
                  library.length === 0
                    ? "Library is empty — add a song first."
                    : "Search the library"
                }
              >
                <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
                  <circle cx="10.5" cy="10.5" r="6.5" fill="none" stroke="currentColor" strokeWidth="2" />
                  <line x1="15.3" y1="15.3" x2="20" y2="20" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                </svg>
                Search songs
              </button>
            </div>
          </div>
        )}
      </main>

      <Editor
        open={editorOpen}
        initial={editingSong}
        library={library}
        onSave={handleSave}
        onSelectExisting={(song) => {
          setActiveId(song.id);
          setEditorOpen(false);
          setEditingSong(null);
          setNotice({
            open: true,
            message: `“${song.title}” is already in the library — opening it.`,
          });
        }}
        onClose={() => {
          setEditorOpen(false);
          setEditingSong(null);
        }}
      />

      <AdminGate
        open={adminOpen}
        onClose={() => setAdminOpen(false)}
        onSignedIn={() => {
          setIsAdmin(true);
          setAdminOpen(false);
        }}
      />

      <SearchOverlay
        open={searchOverlayOpen}
        library={library}
        onSelect={(id) => setActiveId(id)}
        onClose={() => setSearchOverlayOpen(false)}
      />

      <Notice
        open={notice.open}
        message={notice.message}
        onClose={() => setNotice((n) => ({ ...n, open: false }))}
      />
    </div>
  );
}
