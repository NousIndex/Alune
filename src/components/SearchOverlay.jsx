import { useEffect, useMemo, useRef, useState } from "react";

const MAX_RESULTS = 8;

function scoreMatch(song, indexText, q) {
  const t = (song.title || "").toLowerCase();
  const a = (song.artist || "").toLowerCase();
  if (t.startsWith(q)) return 4;
  if (t.includes(q)) return 3;
  if (a.includes(q)) return 2;
  if (indexText.includes(q)) return 1;
  return 0;
}

export default function SearchOverlay({
  open,
  library,
  searchIndex,
  onSelect,
  onClose,
}) {
  const [q, setQ] = useState("");
  const inputRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    setQ("");
    const id = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const results = useMemo(() => {
    const term = q.trim().toLowerCase();
    if (!term) return [];
    const scored = [];
    for (const s of library) {
      const idx = searchIndex.get(s.id) || "";
      const score = scoreMatch(s, idx, term);
      if (score > 0) scored.push({ s, score });
    }
    scored.sort(
      (a, b) => b.score - a.score || a.s.title.localeCompare(b.s.title)
    );
    return scored.slice(0, MAX_RESULTS).map((x) => x.s);
  }, [q, library, searchIndex]);

  if (!open) return null;

  const pick = (id) => {
    onSelect(id);
    onClose();
  };

  const onEnter = (e) => {
    if (e.key === "Enter" && results.length > 0) {
      e.preventDefault();
      pick(results[0].id);
    }
  };

  return (
    <div
      className="search-scrim"
      onClick={(e) => {
        if (e.target.classList.contains("search-scrim")) onClose();
      }}
    >
      <div className="search-panel" role="dialog" aria-label="Search library">
        <div className="search-panel-bar">
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
            <circle
              cx="10.5"
              cy="10.5"
              r="6.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            />
            <line
              x1="15.3"
              y1="15.3"
              x2="20"
              y2="20"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            />
          </svg>
          <input
            ref={inputRef}
            className="search-panel-input"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onEnter}
            placeholder="Search by title, artist, pinyin, romaji…"
          />
          <button
            className="search-panel-close"
            onClick={onClose}
            aria-label="Close search"
          >
            ✕
          </button>
        </div>
        <div className="search-panel-results">
          {q.trim().length === 0 ? (
            <div className="search-panel-hint">
              Type to search the library.
            </div>
          ) : results.length === 0 ? (
            <div className="search-panel-hint">No matches.</div>
          ) : (
            results.map((s) => (
              <button
                key={s.id}
                className="search-result"
                onClick={() => pick(s.id)}
              >
                <div className="t">{s.title}</div>
                <div className="a">{s.artist || "—"}</div>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
