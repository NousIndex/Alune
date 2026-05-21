import { useMemo, useState } from "react";
import { HAN, KANA, HANGUL } from "../lib/romanize.js";

const FILTERS = [
  { id: "all", label: "All" },
  { id: "zh", label: "中" },
  { id: "ja", label: "あ" },
  { id: "ko", label: "한" },
  { id: "en", label: "EN" },
];

function detectLang(song) {
  if (song.lang && song.lang !== "auto") return song.lang;
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
  onExport,
  searchIndex,
  indexProgress,
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

  const q = search.trim().toLowerCase();
  const shown = library.filter((s) => {
    if (filter !== "all" && langById.get(s.id) !== filter) return false;
    if (q && !(searchIndex.get(s.id) || "").includes(q)) return false;
    return true;
  });

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
        <button className="add-btn" title="Add a song" onClick={onAdd}>
          +
        </button>
      </div>

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
                  {s.artist || "—"}
                </div>
              </div>
            );
          })
        )}
      </div>

      <div className="rail-foot">
        <button onClick={onExport} disabled={!library.length}>Export ↓</button>
        {indexing && (
          <span className="idx-hint">
            indexing {indexProgress.done}/{indexProgress.total}
          </span>
        )}
      </div>
    </aside>
  );
}
