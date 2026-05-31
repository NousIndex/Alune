import { useEffect, useMemo, useRef, useState } from "react";
import { recognizeAudio } from "../lib/recognizeApi.js";
import { buildLibIndex, findExistingFolded } from "../lib/dedup.js";

// How long to record before auto-identifying. ~7s is enough for AudD to match
// while keeping the upload tiny; the user can also stop early.
const RECORD_MS = 7000;

// Pick a container the browser can actually record. Chrome/Firefox do webm;
// Safari only does mp4. AudD accepts all of these.
function pickMime() {
  if (typeof MediaRecorder === "undefined") return "";
  for (const m of ["audio/webm", "audio/mp4", "audio/ogg"]) {
    try {
      if (MediaRecorder.isTypeSupported(m)) return m;
    } catch {
      /* isTypeSupported can throw on odd inputs — just skip */
    }
  }
  return "";
}

export default function Identify({ open, library, onSelect, onAddMissing, onClose }) {
  // idle → recording → identifying → (closes on a library hit) | matched | nomatch | error
  const [phase, setPhase] = useState("idle");
  const [error, setError] = useState("");
  const [recognized, setRecognized] = useState(null); // { title, artist } not in library
  const [secondsLeft, setSecondsLeft] = useState(0);

  const streamRef = useRef(null);
  const recorderRef = useRef(null);
  const chunksRef = useRef([]);
  const stopTimerRef = useRef(null);
  const countdownRef = useRef(null);

  const libIndex = useMemo(() => buildLibIndex(library || []), [library]);

  const releaseMic = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
  };
  const cleanup = () => {
    clearTimeout(stopTimerRef.current);
    clearInterval(countdownRef.current);
    if (recorderRef.current && recorderRef.current.state !== "inactive") {
      try {
        recorderRef.current.stop();
      } catch {
        /* already stopped */
      }
    }
    releaseMic();
  };

  // Tear down recording + reset whenever the modal closes; also on unmount.
  useEffect(() => {
    if (!open) {
      cleanup();
      setPhase("idle");
      setError("");
      setRecognized(null);
      setSecondsLeft(0);
    }
    return () => cleanup();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const start = async () => {
    setError("");
    setRecognized(null);
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      setPhase("error");
      setError("This browser can't access the microphone.");
      return;
    }
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      setPhase("error");
      setError(
        e?.name === "NotAllowedError"
          ? "Microphone permission was denied. Allow it and try again."
          : "Couldn't start the microphone."
      );
      return;
    }
    streamRef.current = stream;

    const mime = pickMime();
    let rec;
    try {
      rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    } catch {
      setPhase("error");
      setError("This browser can't record audio.");
      releaseMic();
      return;
    }
    recorderRef.current = rec;
    chunksRef.current = [];
    rec.ondataavailable = (e) => {
      if (e.data && e.data.size) chunksRef.current.push(e.data);
    };
    rec.onstop = () => finishRecording(rec.mimeType || mime || "audio/webm");
    rec.start();

    setPhase("recording");
    setSecondsLeft(Math.round(RECORD_MS / 1000));
    countdownRef.current = setInterval(
      () => setSecondsLeft((s) => Math.max(0, s - 1)),
      1000
    );
    stopTimerRef.current = setTimeout(stop, RECORD_MS);
  };

  const stop = () => {
    clearTimeout(stopTimerRef.current);
    clearInterval(countdownRef.current);
    const rec = recorderRef.current;
    if (rec && rec.state !== "inactive") {
      try {
        rec.stop(); // fires onstop → finishRecording
      } catch {
        /* already stopped */
      }
    }
  };

  const finishRecording = async (type) => {
    releaseMic(); // free the mic the instant we have audio
    const blob = new Blob(chunksRef.current, { type });
    chunksRef.current = [];
    if (blob.size < 1000) {
      setPhase("error");
      setError("That clip was too quiet or too short. Try again, closer to the speaker.");
      return;
    }
    setPhase("identifying");
    try {
      const result = await recognizeAudio(blob);
      if (!result) {
        setPhase("nomatch");
        return;
      }
      const hit = findExistingFolded(libIndex, result.title, result.artist);
      if (hit) {
        // It's in storage — open its lyrics straight away.
        onSelect(hit.song.id);
        onClose();
        return;
      }
      setRecognized(result);
      setPhase("matched"); // recognized, but not in the library yet
    } catch (e) {
      setPhase("error");
      setError(e?.message || "Recognition failed.");
    }
  };

  if (!open) return null;

  return (
    <div
      className="scrim open"
      onClick={(e) => {
        // Don't let an outside click close the modal mid-record.
        if (e.target.classList.contains("scrim") && phase !== "recording" && phase !== "identifying")
          onClose();
      }}
    >
      <div className="modal identify-modal">
        <h2>Identify what's playing</h2>

        {phase === "idle" && (
          <>
            <p className="hint">
              Hold your device near the speaker. We'll record about{" "}
              {Math.round(RECORD_MS / 1000)} seconds, identify the song, and open its
              lyrics if it's already in your library.
            </p>
            <div className="modal-actions">
              <button className="btn text" onClick={onClose}>
                Cancel
              </button>
              <button className="btn primary" onClick={start}>
                ● Listen
              </button>
            </div>
          </>
        )}

        {phase === "recording" && (
          <>
            <div className="identify-status">
              <span className="mic-pulse" aria-hidden="true" />
              <div>
                <strong>Listening…</strong>
                <div className="hint">{secondsLeft}s left</div>
              </div>
            </div>
            <div className="modal-actions">
              <button className="btn primary" onClick={stop}>
                Stop &amp; identify
              </button>
            </div>
          </>
        )}

        {phase === "identifying" && (
          <div className="identify-status">
            <span className="pulse" aria-hidden="true" />
            <strong>Identifying…</strong>
          </div>
        )}

        {phase === "nomatch" && (
          <>
            <p className="hint">
              Couldn't identify the song — try again with the volume up and the mic
              closer to the speaker.
            </p>
            <div className="modal-actions">
              <button className="btn text" onClick={onClose}>
                Close
              </button>
              <button className="btn primary" onClick={start}>
                Try again
              </button>
            </div>
          </>
        )}

        {phase === "matched" && recognized && (
          <>
            <div className="identify-result">
              <strong>{recognized.title || "Unknown title"}</strong>
              <span className="a">{recognized.artist || "Unknown artist"}</span>
              <div className="hint">Recognized, but it's not in your library yet.</div>
            </div>
            <div className="modal-actions">
              <button className="btn text" onClick={start}>
                Try again
              </button>
              <button
                className="btn primary"
                onClick={() => {
                  onAddMissing({ title: recognized.title, artist: recognized.artist });
                  onClose();
                }}
              >
                Add to library
              </button>
            </div>
          </>
        )}

        {phase === "error" && (
          <>
            <div className="hint error">{error}</div>
            <div className="modal-actions">
              <button className="btn text" onClick={onClose}>
                Close
              </button>
              <button className="btn primary" onClick={start}>
                Try again
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
