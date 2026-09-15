import { useEffect, useMemo, useState } from "react";
import Library from "./components/Library.jsx";
import Reader from "./components/Reader.jsx";
import Editor from "./components/Editor.jsx";
import Notice from "./components/Notice.jsx";
import AdminGate from "./components/AdminGate.jsx";
import SearchOverlay from "./components/SearchOverlay.jsx";
import Identify from "./components/Identify.jsx";
import PlaylistImport from "./components/PlaylistImport.jsx";
import AdminTools from "./components/AdminTools.jsx";
import { loadSettings, saveSettings } from "./lib/storage.js";
import { getLibrary, addSong, updateSong, deleteSong } from "./lib/libraryApi.js";
import TimingFinder from "./components/TimingFinder.jsx";
import { getAdminToken, clearAdminToken } from "./lib/admin.js";
import {
  loadCachedMeta,
  saveCachedMeta,
  loadFullSong,
  loadFullSongs,
  cacheFullSong,
} from "./lib/songCache.js";
import { summarizeSong } from "../api/_songMeta.js";
import {
  lightSearchText,
  getCachedOrBuild,
  indexLibraryInBackground,
} from "./lib/searchIndex.js";

export default function App() {
  // Song summaries (no lyrics) — see api/_songMeta.js. Seeded from the last
  // visit's copy so the sidebar renders instantly, then refreshed from the API.
  const [cachedMeta] = useState(loadCachedMeta);
  const [library, setLibrary] = useState(() => cachedMeta || []);
  const [libState, setLibState] = useState({ loading: !cachedMeta, error: "" });
  const [settings, setSettings] = useState(loadSettings);
  const [activeId, setActiveId] = useState(null);
  // Full record (lyrics + timing) for the open song only.
  const [activeFull, setActiveFull] = useState(null);
  const [search, setSearch] = useState("");
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingSong, setEditingSong] = useState(null);
  const [railOpen, setRailOpen] = useState(false);
  const [searchOverlayOpen, setSearchOverlayOpen] = useState(false);
  const [identifyOpen, setIdentifyOpen] = useState(false);
  const [timingFinderOpen, setTimingFinderOpen] = useState(false);
  const [notice, setNotice] = useState({ open: false, message: "" });
  const [adminOpen, setAdminOpen] = useState(false);
  const [isAdmin, setIsAdmin] = useState(() => Boolean(getAdminToken()));
  const [playlistImportOpen, setPlaylistImportOpen] = useState(false);
  const [playlistImportMode, setPlaylistImportMode] = useState("url");
  const [adminToolsOpen, setAdminToolsOpen] = useState(false);
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
        // With a cached list on screen, keep showing it rather than an error.
        setLibState({ loading: false, error: cachedMeta ? "" : e.message });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!libState.loading) saveCachedMeta(library);
  }, [library, libState.loading]);

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

    // Batch index updates: one state change per song meant ~1000 Map copies and
    // sidebar re-renders on every startup, even when everything was cached.
    const pending = new Map();
    let latest = null;
    let timer = null;
    const flush = () => {
      timer = null;
      if (pending.size) {
        const batch = new Map(pending);
        pending.clear();
        setSearchIndex((m) => {
          const next = new Map(m);
          for (const [k, v] of batch) next.set(k, v);
          return next;
        });
      }
      if (latest) setIndexProgress(latest);
    };
    const stop = indexLibraryInBackground(
      library,
      ({ id, text, done, total, finished }) => {
        if (id && text) pending.set(id, text);
        latest = { done, total, finished };
        if (finished) {
          clearTimeout(timer);
          flush();
        } else if (!timer) {
          timer = setTimeout(flush, 300);
        }
      },
      loadFullSongs
    );
    return () => {
      stop();
      clearTimeout(timer);
    };
  }, [library]);

  const activeMeta = useMemo(
    () => library.find((s) => s.id === activeId) || null,
    [library, activeId]
  );

  // Load the open song's full record: from IndexedDB when its revision still
  // matches, otherwise from the API. Re-runs when the song is edited (new rev).
  useEffect(() => {
    if (!activeMeta) {
      setActiveFull(null);
      return;
    }
    let cancelled = false;
    setActiveFull((cur) => (cur && cur.id === activeMeta.id ? cur : null));
    loadFullSong(activeMeta)
      .then((song) => {
        if (!cancelled) setActiveFull(song);
      })
      .catch((e) => {
        if (!cancelled) setNotice({ open: true, message: e?.message || "Couldn't load lyrics." });
      });
    return () => {
      cancelled = true;
    };
  }, [activeMeta?.id, activeMeta?.rev]);

  const activeSong = activeFull && activeFull.id === activeId ? activeFull : null;

  const handleSave = async (form) => {
    if (form.id) {
      // Edit path — PATCH the existing song and replace it in the library.
      const updated = await updateSong(form);
      await cacheFullSong(updated);
      setActiveFull(updated);
      setLibrary((lib) => lib.map((s) => (s.id === updated.id ? summarizeSong(updated) : s)));
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
    await cacheFullSong(song);
    setActiveFull(song);
    setLibrary((lib) =>
      lib.some((s) => s.id === song.id) ? lib : [summarizeSong(song), ...lib]
    );
    setActiveId(song.id);
    setEditorOpen(false);
    setEditingSong(null);
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

  // From the Identify modal: a song was recognized but isn't in the library.
  // Open the Editor prefilled so the user can fetch lyrics and save it with the
  // existing add flow (which also de-dupes against what's already stored).
  const handleAddRecognized = ({ title, artist }) => {
    setEditingSong({ title: title || "", artist: artist || "", lang: "auto", lyrics: "" });
    setEditorOpen(true);
  };

  const handleEditActive = () => {
    if (!activeSong) return;
    setEditingSong(activeSong);
    setEditorOpen(true);
  };

  // Admin: timing was saved for the open song via the TimingFinder dialog —
  // patch it into the library so the Follow button appears immediately.
  const handleTimingSaved = (updated) => {
    cacheFullSong(updated);
    setActiveFull(updated);
    setLibrary((lib) => lib.map((s) => (s.id === updated.id ? summarizeSong(updated) : s)));
    setNotice({
      open: true,
      message: `Timed lyrics saved to “${updated.title}” — Follow mode is ready.`,
    });
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
  // Cycle original → simplified → traditional → original.
  const ZH_CYCLE = { original: "simplified", simplified: "traditional", traditional: "original" };
  const cycleZhVariant = () =>
    setSettings((s) => ({ ...s, zhVariant: ZH_CYCLE[s.zhVariant] || "simplified" }));
  const toggleHideOriginal = () =>
    setSettings((s) => ({ ...s, hideOriginal: !s.hideOriginal }));
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
          setEditingSong(null);
          setEditorOpen(true);
          setRailOpen(false);
        }}
        onIdentify={() => {
          setIdentifyOpen(true);
          setRailOpen(false);
        }}
        onImportPlaylist={() => {
          setPlaylistImportMode("url");
          setPlaylistImportOpen(true);
          setRailOpen(false);
        }}
        onBulkAdd={() => {
          setPlaylistImportMode("paste");
          setPlaylistImportOpen(true);
          setRailOpen(false);
        }}
        onAdminTools={() => {
          setAdminToolsOpen(true);
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
            onCycleZhVariant={cycleZhVariant}
            onToggleHideOriginal={toggleHideOriginal}
            onResize={resize}
            isAdmin={isAdmin}
            onEdit={handleEditActive}
            onDelete={handleDeleteActive}
            onFindTiming={() => setTimingFinderOpen(true)}
          />
        ) : activeMeta ? (
          <div className="center-state">
            <div className="pulse" />
            <p>Loading lyrics…</p>
          </div>
        ) : (
          <div className="center-state">
            <h3>A quieter place for lyrics.</h3>
            <p>
              Pick a song from the shared library, or add one. Chinese gets Hànyǔ
              Pīnyīn, Japanese gets rōmaji — set right above the characters.
            </p>
            <div className="center-actions">
              <button
                className="btn primary"
                onClick={() => {
                  setEditingSong(null);
                  setEditorOpen(true);
                }}
              >
                Add a song
              </button>
              {/* Hidden for now — see the note in Library.jsx. The Identify
                  modal + plumbing stay wired so this is a one-line re-enable
                  once we pick a (free) recognition provider.
              <button className="btn ghost" onClick={() => setIdentifyOpen(true)}>
                ● Identify a song
              </button>
              */}
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

      <Identify
        open={identifyOpen}
        library={library}
        onSelect={(id) => setActiveId(id)}
        onAddMissing={handleAddRecognized}
        onClose={() => setIdentifyOpen(false)}
      />

      <PlaylistImport
        open={playlistImportOpen}
        library={library}
        initialMode={playlistImportMode}
        onClose={() => setPlaylistImportOpen(false)}
        onImported={async () => {
          // Pull fresh state so newly added songs appear in the list. We could
          // splice them client-side, but the bulk path touches dedup keys + may
          // resolve titles differently — a full refresh is simpler and only
          // happens once per import.
          try {
            const fresh = await getLibrary();
            setLibrary(fresh);
          } catch {
            // Non-fatal — user can refresh manually.
          }
        }}
      />

      <TimingFinder
        open={timingFinderOpen}
        song={activeSong}
        onClose={() => setTimingFinderOpen(false)}
        onSaved={handleTimingSaved}
      />

      <AdminTools
        open={adminToolsOpen}
        library={library}
        onClose={() => setAdminToolsOpen(false)}
        onBackfillComplete={async () => {
          try {
            const fresh = await getLibrary();
            setLibrary(fresh);
          } catch {}
        }}
      />

      <Notice
        open={notice.open}
        message={notice.message}
        onClose={() => setNotice((n) => ({ ...n, open: false }))}
      />
    </div>
  );
}
