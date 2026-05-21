import { useEffect, useState } from "react";

export default function Notice({ open, message, onClose, seconds = 3 }) {
  const [remaining, setRemaining] = useState(seconds);

  // Reset the timer whenever a fresh notice opens.
  useEffect(() => {
    if (open) setRemaining(seconds);
  }, [open, seconds]);

  // Tick once a second; auto-dismiss at zero. Cleanup prevents double-fires
  // when the parent re-renders mid-countdown.
  useEffect(() => {
    if (!open) return;
    if (remaining <= 0) {
      onClose();
      return;
    }
    const t = setTimeout(() => setRemaining((r) => r - 1), 1000);
    return () => clearTimeout(t);
  }, [open, remaining, onClose]);

  // Close on Escape, matching the rest of the app's modal behavior.
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="scrim open"
      onClick={(e) => e.target.classList.contains("scrim") && onClose()}
    >
      <div className="modal notice">
        <p className="notice-msg">{message}</p>
        <div className="modal-actions">
          <button className="btn primary" onClick={onClose}>
            OK · {remaining}
          </button>
        </div>
      </div>
    </div>
  );
}
