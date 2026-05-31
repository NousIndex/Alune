import { useEffect, useRef, useState } from "react";
import { renderSong } from "../lib/romanize.js";
import { parseLrc } from "../lib/lrc.js";

// Karaoke Follow mode. Only mounted for songs that have stored synced lyrics
// (the Follow button is gated on that), so timing always exists here. We render
// the LRC's lines with the normal pinyin/romaji pipeline, then advance a
// centered highlight on a clock the user can pace and re-sync — KTV backing
// tracks differ from the studio master, so it's a *relative* clock: tap the
// line you're on to anchor, then nudge the pace.

const RATE_STEP = 1.06;
const SRC_LABEL = { lrclib: "LRCLIB", netease: "NetEase", stored: "saved timing" };

export default function Karaoke({ song, settings, lyricsClass, onExit }) {
  const [phase, setPhase] = useState("loading"); // loading | ready
  const [timed, setTimed] = useState([]); // [{ timeMs, text }]
  const [rendered, setRendered] = useState([]); // [{ html }] aligned to timed
  const [source, setSource] = useState("");
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(-1);
  const [rate, setRate] = useState(1);

  // Clock: songMs = baseSong + (now - baseClock) * rate. Held in refs so the
  // rAF loop doesn't re-subscribe every frame.
  const baseSongRef = useRef(0);
  const baseClockRef = useRef(0);
  const songMsRef = useRef(0);
  const rateRef = useRef(1);
  const currentRef = useRef(-1);
  const rafRef = useRef(0);
  const lineRefs = useRef([]);

  useEffect(() => {
    rateRef.current = rate;
  }, [rate]);
  useEffect(() => {
    currentRef.current = current;
  }, [current]);

  // ---- Parse stored LRC + render the lines ----
  useEffect(() => {
    let cancelled = false;
    setPhase("loading");
    setPlaying(false);
    setCurrent(-1);
    songMsRef.current = 0;
    baseSongRef.current = 0;

    const entries = parseLrc(song.syncedLyrics || "");
    (async () => {
      const textLines = entries.map((e) => e.text);
      const synthetic = { ...song, lyrics: textLines.join("\n") };
      const res = await renderSong(synthetic, { zhVariant: settings.zhVariant || "original" });
      if (cancelled) return;
      const renderedLines = res.lines.filter((l) => !l.blank);
      const n = Math.min(renderedLines.length, entries.length);
      setTimed(entries.slice(0, n));
      setRendered(renderedLines.slice(0, n));
      setSource(song.syncedSource || "stored");
      lineRefs.current = [];
      // Auto-start the clock from the top the moment Follow opens.
      baseSongRef.current = 0;
      baseClockRef.current = performance.now();
      songMsRef.current = 0;
      setPhase("ready");
      setPlaying(true);
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [song.id, song.syncedLyrics, settings.zhVariant]);

  // ---- The clock ----
  useEffect(() => {
    if (phase !== "ready" || !playing || !timed.length) return;
    const lastMs = timed[timed.length - 1].timeMs;
    const tick = () => {
      const songMs = baseSongRef.current + (performance.now() - baseClockRef.current) * rateRef.current;
      songMsRef.current = songMs;
      let idx = -1;
      for (let i = 0; i < timed.length; i++) {
        if (timed[i].timeMs <= songMs) idx = i;
        else break;
      }
      if (idx !== currentRef.current) setCurrent(idx);
      if (songMs > lastMs + 4000) {
        setPlaying(false);
        return;
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [phase, playing, timed]);

  // ---- Keep the active line centered ----
  useEffect(() => {
    if (current < 0) return;
    const el = lineRefs.current[current];
    if (el && typeof el.scrollIntoView === "function") {
      el.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }, [current]);

  // ---- Keep the screen awake while the karaoke view is open ----
  useEffect(() => {
    if (typeof navigator === "undefined" || !navigator.wakeLock) return;
    let lock = null;
    const request = async () => {
      try {
        lock = await navigator.wakeLock.request("screen");
      } catch {
        /* unsupported / denied — non-fatal */
      }
    };
    request();
    const onVis = () => document.visibilityState === "visible" && request();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      try {
        lock && lock.release();
      } catch {
        /* gone */
      }
    };
  }, []);

  // ---- Controls ----
  const anchorTo = (songMs) => {
    baseSongRef.current = songMs;
    baseClockRef.current = performance.now();
    songMsRef.current = songMs;
  };
  const play = () => {
    anchorTo(songMsRef.current); // resume from where we are
    setPlaying(true);
  };
  const pause = () => setPlaying(false);
  const togglePlay = () => (playing ? pause() : play());
  const restart = () => {
    anchorTo(0);
    setCurrent(-1);
    setPlaying(true);
  };
  const adjustPace = (factor) => {
    anchorTo(songMsRef.current); // rebase so the change is seamless
    setRate((r) => Math.min(2, Math.max(0.5, +(r * factor).toFixed(3))));
  };
  // Tap the line you're actually on → make it "now" and keep going.
  const syncToLine = (i) => {
    if (timed[i]) anchorTo(timed[i].timeMs);
    setCurrent(i);
  };

  return (
    <div className="karaoke">
      <div className="karaoke-bar">
        <button className="kbtn" onClick={togglePlay} title={playing ? "Pause" : "Play"}>
          {playing ? "⏸" : "▶"}
        </button>
        <button className="kbtn" onClick={restart} title="Restart from the top">
          ⟲
        </button>
        <span className="ksep" />
        <button className="kbtn" onClick={() => adjustPace(1 / RATE_STEP)} title="Slower">
          −
        </button>
        <span className="krate" title="Playback pace">{Math.round(rate * 100)}%</span>
        <button className="kbtn" onClick={() => adjustPace(RATE_STEP)} title="Faster">
          +
        </button>
        {source && <span className="ksrc">{SRC_LABEL[source] || source}</span>}
        <button className="kbtn kexit" onClick={onExit} title="Exit Follow mode">
          ✕ Exit
        </button>
      </div>

      <div className="karaoke-hint">Tap the line you're on to re-sync · use −/+ to match the pace</div>

      <div className="reader-wrap karaoke-wrap">
        <article className="reader">
          {phase === "loading" ? (
            <div className="center-state">
              <div className="pulse" />
              <p>Setting up the timing…</p>
            </div>
          ) : (
            <div className={lyricsClass + " follow"}>
              {rendered.map((ln, i) => (
                <div
                  key={i}
                  ref={(el) => (lineRefs.current[i] = el)}
                  className={"lyric-line" + (current === i ? " active" : "")}
                  onClick={() => syncToLine(i)}
                  dangerouslySetInnerHTML={{ __html: ln.html }}
                />
              ))}
            </div>
          )}
        </article>
      </div>
    </div>
  );
}
