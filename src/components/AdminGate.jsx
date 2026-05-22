import { useEffect, useState } from "react";
import { verifyAdminToken, setAdminToken } from "../lib/admin.js";

export default function AdminGate({ open, onClose, onSignedIn }) {
  const [token, setToken] = useState("");
  const [state, setState] = useState({ checking: false, error: "" });

  useEffect(() => {
    if (open) {
      setToken("");
      setState({ checking: false, error: "" });
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e) => e.key === "Escape" && !state.checking && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose, state.checking]);

  if (!open) return null;

  const submit = async () => {
    const t = token.trim();
    if (!t || state.checking) return;
    setState({ checking: true, error: "" });
    const result = await verifyAdminToken(t);
    if (result.ok) {
      setAdminToken(t);
      setState({ checking: false, error: "" });
      onSignedIn();
    } else {
      setState({ checking: false, error: result.error || "Invalid token" });
    }
  };

  return (
    <div
      className="scrim open"
      onClick={(e) => {
        if (state.checking) return;
        if (e.target.classList.contains("scrim")) onClose();
      }}
    >
      <div className="modal admin-modal">
        <h2>Admin sign-in</h2>
        <div className="field">
          <label>Admin token</label>
          <input
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
            placeholder="Enter your admin token"
            autoFocus
          />
          <div className="hint">
            Unlocks Edit / Delete on songs. Token is stored in this browser only.
          </div>
        </div>
        {state.error && <div className="hint error">{state.error}</div>}
        <div className="modal-actions">
          <button className="btn text" onClick={onClose} disabled={state.checking}>
            Cancel
          </button>
          <button
            className="btn primary"
            onClick={submit}
            disabled={!token.trim() || state.checking}
          >
            {state.checking ? "Verifying…" : "Sign in"}
          </button>
        </div>
      </div>
    </div>
  );
}
