import { useEffect, useState } from "react";
import { renderSong, dominantLang } from "../lib/romanize.js";

const CREDIT = {
  zh: "中文 · Pinyin",
  ja: "日本語 · Rōmaji",
  ko: "한국어 · Romaja",
  en: "English",
};
function creditFor(song) {
  if (song.lang && song.lang !== "auto") return CREDIT[song.lang] || "Lyrics";
  const dom = dominantLang(song.lyrics);
  return dom === "mixed" ? "Mixed" : CREDIT[dom] || "Lyrics";
}

export default function Reader({
  song,
  settings,
  onToggleRomaji,
  onResize,
  isAdmin,
  onEdit,
  onDelete,
}) {
  const [status, setStatus] = useState("loading");
  const [lines, setLines] = useState([]);
  const [note, setNote] = useState("");
  const [active, setActive] = useState(-1);

  // Re-romanize only when the song or its content changes — NOT on settings
  // changes (romaji visibility and size are handled with CSS, no recompute).
  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    setActive(-1);
    renderSong(song).then((res) => {
      if (cancelled) return;
      setLines(res.lines);
      setNote(res.note);
      setStatus("ready");
    });
    return () => {
      cancelled = true;
    };
  }, [song.id, song.lyrics, song.lang]);

  if (status === "loading") {
    return (
      <div className="center-state">
        <div className="pulse" />
        <p>Loading the Japanese dictionary (one-time, a few seconds)…</p>
      </div>
    );
  }

  return (
    <>
      <div className="stage-bar">
        <div className="meta">
          <h2>{song.title}</h2>
          <p>{song.artist}</p>
        </div>
        <div className="controls">
          <button
            className={"ctrl" + (settings.showRomaji ? " on" : "")}
            onClick={onToggleRomaji}
          >
            {settings.showRomaji ? "◉ Reading" : "◌ Reading"}
          </button>
          <button className="ctrl icon" title="Smaller" onClick={() => onResize(-0.12)}>
            A−
          </button>
          <button className="ctrl icon" title="Larger" onClick={() => onResize(0.12)}>
            A+
          </button>
          {isAdmin && (
            <>
              <button className="ctrl" title="Edit this song" onClick={onEdit}>
                Edit
              </button>
              <button
                className="ctrl danger"
                title="Delete this song"
                onClick={onDelete}
              >
                Delete
              </button>
            </>
          )}
        </div>
      </div>

      <div className="reader-wrap">
        <article className="reader">
          <div className="credit">{creditFor(song)}</div>
          <div className={"lyrics" + (settings.showRomaji ? "" : " no-ruby")}>
            {lines.map((ln, i) =>
              ln.blank ? (
                <div key={i} className="lyric-line blank" />
              ) : (
                <div
                  key={i}
                  className={"lyric-line" + (active === i ? " active" : "")}
                  onClick={() => setActive((a) => (a === i ? -1 : i))}
                  dangerouslySetInnerHTML={{ __html: ln.html }}
                />
              )
            )}
          </div>
          {note && <div className="engine-note">{note}</div>}
        </article>
      </div>
    </>
  );
}
