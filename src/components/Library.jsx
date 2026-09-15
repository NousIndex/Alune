import { useMemo, useState } from "react";
import { HAN, KANA, HANGUL, dominantLang } from "../lib/romanize.js";
import { hasTimestamps } from "../lib/lrc.js";
import { lightSearchText } from "../lib/searchIndex.js";

const normQ = (s) => (s || "").toLowerCase().replace(/\s+/g, " ").trim();
// Rank a match: title-prefix > title > artist > romanized title/artist > lyrics
// body. `head` is the title+artist text (with romanizations); the full index
// (which also has lyrics) was already used to decide membership.
function searchRank(song, head, q) {
  const t = normQ(song.title);
  const a = normQ(song.artist);
  if (t.startsWith(q)) return 5;
  if (t.includes(q)) return 4;
  if (a.includes(q)) return 3;
  if (head.includes(q)) return 2; // pinyin/romaji of the title or artist
  return 1; // matched only in the lyrics
}

const FILTERS = [
  { id: "all", label: "All" },
  { id: "zh", label: "中" },
  { id: "ja", label: "あ" },
  { id: "ko", label: "한" },
  { id: "en", label: "EN" },
];

function detectLang(song) {
  if (song.detLang) return song.detLang; // precomputed in the song summary
  if (song.lang && song.lang !== "auto") return song.lang;
  const dom = dominantLang(song.lyrics);
  if (dom !== "mixed") return dom;
  // Truly mixed — fall back to first-match priority for the badge.
  if (KANA.test(song.lyrics)) return "ja";
  if (HANGUL.test(song.lyrics)) return "ko";
  if (HAN.test(song.lyrics)) return "zh";
  return "en";
}
function badgeFor(song) {
  const lang = detectLang(song);
  const label = { zh: "中", ja: "あ", ko: "한", en: "EN" }[lang] || "·";
  return { lang, label };
}

export default function Library({
  library,
  loading,
  error,
  activeId,
  search,
  onSearch,
  onSelect,
  onAdd,
  onIdentify,
  onImportPlaylist,
  onBulkAdd,
  onAdminTools,
  searchIndex,
  indexProgress,
  isAdmin,
  onAdminSignIn,
  onAdminSignOut,
}) {
  const [filter, setFilter] = useState("all");

  // Detect each song's language once per library change.
  const langById = useMemo(() => {
    const m = new Map();
    for (const s of library) m.set(s.id, detectLang(s));
    return m;
  }, [library]);

  const counts = useMemo(() => {
    const c = { all: library.length, zh: 0, ja: 0, ko: 0, en: 0 };
    for (const lang of langById.values()) c[lang] = (c[lang] || 0) + 1;
    return c;
  }, [library, langById]);

  // Title+artist text (with romanizations) for ranking — the full searchIndex
  // gets overwritten with lyric-inclusive text, so we keep our own head copy.
  const headIndex = useMemo(() => {
    const m = new Map();
    for (const s of library) m.set(s.id, lightSearchText(s));
    return m;
  }, [library]);

  const q = normQ(search);
  let shown = library.filter((s) => {
    if (filter !== "all" && langById.get(s.id) !== filter) return false;
    if (q && !(searchIndex.get(s.id) || "").includes(q)) return false;
    return true;
  });
  // Rank matches so the song *titled* 妥協 beats songs that only mention it in
  // the lyrics. Keep library order when there's no query, and as a tiebreaker.
  if (q) {
    shown = shown
      .map((s, i) => ({ s, i, r: searchRank(s, headIndex.get(s.id) || "", q) }))
      .sort((x, y) => y.r - x.r || x.i - y.i)
      .map((x) => x.s);
  }

  const indexing =
    indexProgress &&
    !indexProgress.finished &&
    indexProgress.total > 0 &&
    indexProgress.done < indexProgress.total;

  return (
    <aside className="rail">
      <div className="brand">
        <h1>Alune</h1>
        <div className="sub">pinyin · romaji · lyrics</div>
      </div>

      <div className="rail-tools">
        <input
          className="search"
          placeholder="Search by title, pinyin, romaji…"
          value={search}
          onChange={(e) => onSearch(e.target.value)}
        />
        {/* Hidden for now: the mic "Identify what's playing" button. The full
            feature is built (api/recognize.js + components/Identify.jsx via
            onIdentify) but its recognition provider (AudD) isn't free for
            ongoing use. Re-enable this button — and the matching one in App's
            empty state — once we settle on a provider.
        <button
          className="mic-btn"
          title="Identify what's playing and open its lyrics"
          aria-label="Identify what's playing"
          onClick={onIdentify}
        >
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
            <rect x="9" y="3" width="6" height="11" rx="3" fill="none" stroke="currentColor" strokeWidth="2" />
            <path d="M5 11a7 7 0 0 0 14 0" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            <line x1="12" y1="18" x2="12" y2="21" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </button>
        */}
        <button className="add-btn" title="Add a song" onClick={onAdd}>
          +
        </button>
      </div>

      {isAdmin && (
        <div className="rail-admin-tools">
          <button
            className="btn ghost sm"
            onClick={onImportPlaylist}
            title="Bulk-import songs from a Spotify or YouTube playlist"
          >
            Import playlist
          </button>
          <button
            className="btn ghost sm"
            onClick={onBulkAdd}
            title="Paste a list of songs to add them all at once"
          >
            Bulk add
          </button>
          <button
            className="btn ghost sm"
            onClick={onAdminTools}
            title="Manage artist aliases and backfill existing songs"
          >
            Aliases / backfill
          </button>
        </div>
      )}

      <div className="rail-filter">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            className={"filter-chip" + (filter === f.id ? " sel" : "")}
            onClick={() => setFilter(f.id)}
            disabled={f.id !== "all" && counts[f.id] === 0}
            title={f.id === "all" ? "Show all songs" : `Show ${f.label} only`}
          >
            {f.label}
            <span className="count">{counts[f.id] || 0}</span>
          </button>
        ))}
      </div>

      <div className="song-list">
        {loading ? (
          <div className="empty-list">Loading library…</div>
        ) : error ? (
          <div className="empty-list">Couldn’t load library: {error}</div>
        ) : shown.length === 0 ? (
          <div className="empty-list">
            {library.length === 0
              ? <>No songs yet. Hit <strong>+</strong> to add the first one.</>
              : "Nothing matches."}
          </div>
        ) : (
          shown.map((s) => {
            const { lang, label } = badgeFor(s);
            return (
              <div
                key={s.id}
                className={"song-item" + (s.id === activeId ? " active" : "")}
                onClick={() => onSelect(s.id)}
              >
                <div className="t">{s.title}</div>
                <div className="a">
                  <span className={"badge " + lang}>{label}</span>
                  <span className="a-name">{s.artist || "—"}</span>
                  {(s.hasSync ?? hasTimestamps(s.syncedLyrics)) && (
                    <span className="follow-dot" title="Karaoke timing available — Follow ready">
                      ♪
                    </span>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>

      <div className="rail-foot">
        {isAdmin ? (
          <button
            className="admin-link signed-in"
            onClick={onAdminSignOut}
            title="Sign out of admin mode"
          >
            admin · signed in
          </button>
        ) : (
          <button
            className="admin-link"
            onClick={onAdminSignIn}
            title="Sign in as admin to edit / delete songs"
          >
            admin
          </button>
        )}
        {indexing && (
          <span className="idx-hint">
            indexing {indexProgress.done}/{indexProgress.total}
          </span>
        )}
      </div>
    </aside>
  );
}
