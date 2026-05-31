import { useEffect, useState } from "react";
import { renderSong, dominantLang, HAN, KANA, HANGUL } from "../lib/romanize.js";
import { hasTimestamps } from "../lib/lrc.js";
import Karaoke from "./Karaoke.jsx";

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
function isChineseSong(song) {
  if (song.lang && song.lang !== "auto") return song.lang === "zh";
  return dominantLang(song.lyrics) === "zh";
}
// Any CJK script means there are readings to hide (covers mixed-language songs).
function hasReadings(song) {
  const t = song.lyrics || "";
  return HAN.test(t) || KANA.test(t) || HANGUL.test(t);
}

// Cycle button face: shows the variant currently applied.
const ZH_LABEL = {
  original: { text: "原 Original", title: "Showing original characters — click for Simplified" },
  simplified: { text: "简 Simplified", title: "Showing Simplified — click for Traditional" },
  traditional: { text: "繁 Traditional", title: "Showing Traditional — click for original" },
};

export default function Reader({
  song,
  settings,
  onToggleRomaji,
  onCycleZhVariant,
  onToggleHideOriginal,
  onResize,
  isAdmin,
  onEdit,
  onDelete,
}) {
  const zhVariant = settings.zhVariant || "original";
  const showVariant = isChineseSong(song);
  const showHideOriginal = hasReadings(song);
  const hideOriginal = !!settings.hideOriginal;
  const [status, setStatus] = useState("loading");
  const [lines, setLines] = useState([]);
  const [note, setNote] = useState("");
  const [active, setActive] = useState(-1);
  const [follow, setFollow] = useState(false);

  // The lyrics-container class is shared with Karaoke so Reading / reading-only
  // styling stays identical in Follow mode.
  const lyricsClass =
    "lyrics" + (settings.showRomaji ? "" : " no-ruby") + (hideOriginal ? " reading-only" : "");

  // Re-romanize when the song/content changes — and when the Chinese variant
  // changes, since that rewrites the actual characters (romaji visibility and
  // size are CSS-only and intentionally excluded).
  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    setActive(-1);
    renderSong(song, { zhVariant }).then((res) => {
      if (cancelled) return;
      setLines(res.lines);
      setNote(res.note);
      setStatus("ready");
    });
    return () => {
      cancelled = true;
    };
  }, [song.id, song.lyrics, song.lang, zhVariant]);

  // Only take over the screen on the very first render (no lines yet). A variant
  // switch re-renders too, but we keep the current lyrics up until it resolves.
  if (status === "loading" && lines.length === 0) {
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
          {showVariant && (
            <button
              className={"ctrl" + (zhVariant !== "original" ? " on" : "")}
              title={ZH_LABEL[zhVariant].title}
              onClick={onCycleZhVariant}
            >
              {ZH_LABEL[zhVariant].text}
            </button>
          )}
          {showHideOriginal && (
            <button
              className={"ctrl" + (hideOriginal ? "" : " on")}
              title={
                hideOriginal
                  ? "Reading only — click to show the original characters"
                  : "Hide the original characters, show only the reading"
              }
              onClick={onToggleHideOriginal}
            >
              {hideOriginal ? "◌ Original" : "◉ Original"}
            </button>
          )}
          <button className="ctrl icon" title="Smaller" onClick={() => onResize(-0.12)}>
            A−
          </button>
          <button className="ctrl icon" title="Larger" onClick={() => onResize(0.12)}>
            A+
          </button>
          {hasTimestamps(song.syncedLyrics) && (
            <button
              className={"ctrl" + (follow ? " on" : "")}
              title="Follow mode: auto-scroll and highlight the current line for karaoke"
              onClick={() => setFollow((f) => !f)}
            >
              {follow ? "◉ Follow" : "◌ Follow"}
            </button>
          )}
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

      {follow ? (
        <Karaoke
          song={song}
          settings={settings}
          lyricsClass={lyricsClass}
          onExit={() => setFollow(false)}
        />
      ) : (
        <div className="reader-wrap">
          <article className="reader">
            <div className="credit">{creditFor(song)}</div>
            <div className={lyricsClass}>
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
      )}
    </>
  );
}
