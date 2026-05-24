import { adminHeaders } from "./admin.js";

export async function resolveAlias(name) {
  const trimmed = (name || "").trim();
  if (!trimmed) return { original: "", alias: null, formatted: "", source: "none" };
  const res = await fetch(`/api/alias?name=${encodeURIComponent(trimmed)}`);
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error(json?.error || `Alias lookup failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return json;
}

// Soft variant: never throws. Used during save flows where a network failure
// shouldn't block the user from creating a song.
export async function resolveAliasOrOriginal(name) {
  try {
    const result = await resolveAlias(name);
    return result.formatted || name;
  } catch {
    return name;
  }
}

export async function listOverrides() {
  const res = await fetch("/api/aliases");
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(json?.error || `Failed to load overrides (${res.status})`);
  return json.overrides || [];
}

export async function saveOverride(original, alias) {
  const res = await fetch("/api/aliases", {
    method: "POST",
    headers: { "content-type": "application/json", ...adminHeaders() },
    body: JSON.stringify({ original, alias }),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(json?.error || `Failed to save override (${res.status})`);
  return json.entry;
}

export async function deleteOverride(original) {
  const res = await fetch(`/api/aliases?original=${encodeURIComponent(original)}`, {
    method: "DELETE",
    headers: adminHeaders(),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(json?.error || `Failed to delete override (${res.status})`);
  return json;
}

export async function backfill({ dryRun = true } = {}) {
  const res = await fetch("/api/backfill", {
    method: "POST",
    headers: { "content-type": "application/json", ...adminHeaders() },
    body: JSON.stringify({ dryRun }),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(json?.error || `Backfill failed (${res.status})`);
  return json;
}
