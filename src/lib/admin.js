const KEY = "alune.admin.token";

export function getAdminToken() {
  try {
    return localStorage.getItem(KEY) || "";
  } catch {
    return "";
  }
}

export function setAdminToken(t) {
  try {
    if (t) localStorage.setItem(KEY, t);
    else localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

export function clearAdminToken() {
  setAdminToken("");
}

export function adminHeaders() {
  const t = getAdminToken();
  return t ? { "x-admin-token": t } : {};
}

export async function verifyAdminToken(token) {
  const res = await fetch("/api/admin", {
    method: "POST",
    headers: { "x-admin-token": token },
  });
  if (res.ok) return { ok: true };
  const json = await res.json().catch(() => null);
  return { ok: false, error: json?.error || `Verify failed (${res.status})` };
}
