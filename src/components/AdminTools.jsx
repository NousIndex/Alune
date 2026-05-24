import { useEffect, useState } from "react";
import {
  listOverrides,
  saveOverride,
  deleteOverride,
  backfill,
} from "../lib/aliasApi.js";

const MODES = {
  HOME: "home",
  PREVIEW: "preview",
  APPLYING: "applying",
  DONE: "done",
};

export default function AdminTools({ open, onClose, onBackfillComplete }) {
  const [mode, setMode] = useState(MODES.HOME);
  const [overrides, setOverrides] = useState([]);
  const [loadState, setLoadState] = useState({ loading: false, error: "" });
  const [form, setForm] = useState({ original: "", alias: "" });
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");

  const [scanState, setScanState] = useState({ scanning: false, error: "" });
  const [preview, setPreview] = useState(null); // { scanned, proposed, changes }
  const [applyResult, setApplyResult] = useState(null);

  useEffect(() => {
    if (!open) return;
    setMode(MODES.HOME);
    setForm({ original: "", alias: "" });
    setFormError("");
    setPreview(null);
    setApplyResult(null);
    setScanState({ scanning: false, error: "" });
    refresh();
  }, [open]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape" && mode !== MODES.APPLYING) onClose();
    };
    if (open) window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, mode, onClose]);

  const refresh = async () => {
    setLoadState({ loading: true, error: "" });
    try {
      const list = await listOverrides();
      setOverrides(list);
      setLoadState({ loading: false, error: "" });
    } catch (e) {
      setLoadState({ loading: false, error: e.message || "Couldn't load overrides" });
    }
  };

  const handleSave = async () => {
    setFormError("");
    const original = form.original.trim();
    const alias = form.alias.trim();
    if (!original || !alias) {
      setFormError("Both names are required.");
      return;
    }
    setSaving(true);
    try {
      await saveOverride(original, alias);
      setForm({ original: "", alias: "" });
      await refresh();
    } catch (e) {
      setFormError(e.message || "Couldn't save");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (original) => {
    if (!window.confirm(`Remove alias for "${original}"?`)) return;
    try {
      await deleteOverride(original);
      await refresh();
    } catch (e) {
      alert(e.message || "Couldn't delete");
    }
  };

  const startBackfill = async () => {
    setScanState({ scanning: true, error: "" });
    setMode(MODES.PREVIEW);
    try {
      const result = await backfill({ dryRun: true });
      setPreview(result);
      setScanState({ scanning: false, error: "" });
    } catch (e) {
      setScanState({ scanning: false, error: e.message || "Scan failed" });
    }
  };

  const applyBackfill = async () => {
    setMode(MODES.APPLYING);
    try {
      const result = await backfill({ dryRun: false });
      setApplyResult(result);
      setMode(MODES.DONE);
      onBackfillComplete?.(result);
    } catch (e) {
      setScanState({ scanning: false, error: e.message || "Apply failed" });
      setMode(MODES.PREVIEW);
    }
  };

  if (!open) return null;

  return (
    <div
      className="scrim open"
      onClick={(e) =>
        e.target.classList.contains("scrim") && mode !== MODES.APPLYING && onClose()
      }
    >
      <div className="modal modal-wide">
        <h2>Admin tools</h2>

        {mode === MODES.HOME && (
          <>
            <section className="admin-section">
              <h3>Artist aliases</h3>
              <p className="hint">
                Manual entries always win over MusicBrainz lookups. The reverse
                mapping is saved automatically — if you add{" "}
                <code>薛之谦 ↔ Joker Xue</code>, looking up either name returns the
                combined form <code>薛之谦 Joker Xue</code>.
              </p>
              <div className="alias-form">
                <input
                  placeholder="Original (either script)"
                  value={form.original}
                  onChange={(e) => setForm((f) => ({ ...f, original: e.target.value }))}
                />
                <input
                  placeholder="Alias (the other script)"
                  value={form.alias}
                  onChange={(e) => setForm((f) => ({ ...f, alias: e.target.value }))}
                />
                <button
                  className="btn primary sm"
                  onClick={handleSave}
                  disabled={saving}
                >
                  {saving ? "Saving…" : "Add"}
                </button>
              </div>
              {formError && <div className="hint error">{formError}</div>}

              <div className="alias-list">
                {loadState.loading ? (
                  <div className="hint">Loading…</div>
                ) : loadState.error ? (
                  <div className="hint error">{loadState.error}</div>
                ) : overrides.length === 0 ? (
                  <div className="hint">No manual overrides yet.</div>
                ) : (
                  <table>
                    <thead>
                      <tr>
                        <th>Original</th>
                        <th>Alias</th>
                        <th>Combined</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {overrides.map((o) => (
                        <tr key={o.key}>
                          <td>{o.original}</td>
                          <td>{o.alias}</td>
                          <td className="combined">{o.formatted}</td>
                          <td>
                            <button
                              className="btn text sm"
                              onClick={() => handleDelete(o.original)}
                              title="Remove this pair"
                            >
                              ✕
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </section>

            <section className="admin-section">
              <h3>Backfill existing songs</h3>
              <p className="hint">
                Re-resolve every saved song's artist using current overrides +
                MusicBrainz, and update those that have a counterpart. Shows a
                preview before applying.
              </p>
              <button className="btn ghost" onClick={startBackfill}>
                Scan library for alias updates
              </button>
            </section>

            <div className="modal-actions">
              <button className="btn text" onClick={onClose}>Close</button>
            </div>
          </>
        )}

        {mode === MODES.PREVIEW && (
          <BackfillPreview
            scanState={scanState}
            preview={preview}
            onCancel={() => setMode(MODES.HOME)}
            onApply={applyBackfill}
          />
        )}

        {mode === MODES.APPLYING && (
          <div className="import-progress">
            <div className="progress-bar"><div className="progress-fill indet" /></div>
            <div className="progress-text">
              <strong>Applying changes…</strong>
            </div>
          </div>
        )}

        {mode === MODES.DONE && applyResult && (
          <BackfillDone
            result={applyResult}
            onClose={() => {
              setMode(MODES.HOME);
              setApplyResult(null);
            }}
          />
        )}
      </div>
    </div>
  );
}

function BackfillPreview({ scanState, preview, onCancel, onApply }) {
  if (scanState.scanning) {
    return (
      <div className="import-progress">
        <div className="progress-bar"><div className="progress-fill indet" /></div>
        <div className="progress-text"><strong>Scanning library…</strong></div>
        <div className="hint">
          First run can take a moment per artist while we query MusicBrainz.
          Subsequent runs hit the cache and are nearly instant.
        </div>
      </div>
    );
  }
  if (scanState.error) {
    return (
      <>
        <div className="hint error">{scanState.error}</div>
        <div className="modal-actions">
          <button className="btn text" onClick={onCancel}>Back</button>
        </div>
      </>
    );
  }
  if (!preview) return null;
  return (
    <>
      <div className="hint">
        Scanned <strong>{preview.scanned}</strong> songs.{" "}
        <strong>{preview.proposed}</strong> have an alias update available.
      </div>
      {preview.changes.length > 0 ? (
        <table className="changes-table">
          <thead>
            <tr>
              <th>Title</th>
              <th>From</th>
              <th>To</th>
              <th>Source</th>
            </tr>
          </thead>
          <tbody>
            {preview.changes.map((c) => (
              <tr key={c.id}>
                <td>{c.title}</td>
                <td>{c.from}</td>
                <td className="to">{c.to}</td>
                <td>
                  <span className={"src-tag " + c.source}>{c.source}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div className="hint">Nothing to change — every artist is already in its combined form.</div>
      )}
      <div className="modal-actions">
        <button className="btn text" onClick={onCancel}>Back</button>
        <button
          className="btn primary"
          onClick={onApply}
          disabled={preview.changes.length === 0}
        >
          Apply {preview.changes.length} update{preview.changes.length === 1 ? "" : "s"}
        </button>
      </div>
    </>
  );
}

function BackfillDone({ result, onClose }) {
  return (
    <>
      <div className="results-summary">
        <div className="result-card added">
          <div className="big">{result.updated}</div>
          <div>updated</div>
        </div>
        <div className="result-card existed">
          <div className="big">{result.proposed - result.updated}</div>
          <div>skipped</div>
        </div>
        <div className="result-card">
          <div className="big">{result.scanned}</div>
          <div>scanned</div>
        </div>
      </div>
      {result.skipped && result.skipped.length > 0 && (
        <>
          <div className="results-tools">
            <strong>Skipped ({result.skipped.length}):</strong>
          </div>
          <ul className="failed-list">
            {result.skipped.map((s, i) => (
              <li key={i}>
                <div>
                  <span className="t">{s.title}</span>{" "}
                  <span className="a">— {s.from} → {s.to}</span>
                </div>
                <div className="reason">{s.reason}</div>
              </li>
            ))}
          </ul>
        </>
      )}
      <div className="hint">
        Reload the library to see the updated artist names.
      </div>
      <div className="modal-actions">
        <button className="btn primary" onClick={onClose}>Done</button>
      </div>
    </>
  );
}
