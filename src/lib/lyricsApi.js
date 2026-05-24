// Upstream lyrics API allows ~10 calls/min. We cap to 9/min to leave a safety
// margin and observe 429s by backing off. The limiter is shared across all
// callers (Editor fetch, bulk import) via module-level state so single-call
// flows are unaffected when the queue is empty, but bulk imports automatically
// serialize through it.
const RATE_BUDGET = 9;
const RATE_WINDOW_MS = 60_000;
const BACKOFF_MS = 30_000;

const callTimes = []; // sliding window of recent call start times
let backoffUntil = 0;
const waiters = [];   // resolvers waiting for status updates

function notifyWaiters() {
  for (const fn of waiters.splice(0)) fn();
}

// Subscribe to limiter state changes — used by the UI to show waiting status.
export function onRateLimitChange(fn) {
  waiters.push(fn);
  return () => {
    const i = waiters.indexOf(fn);
    if (i >= 0) waiters.splice(i, 1);
  };
}

export function getRateLimitStatus() {
  const now = Date.now();
  while (callTimes.length && now - callTimes[0] >= RATE_WINDOW_MS) callTimes.shift();
  const used = callTimes.length;
  const remaining = Math.max(0, RATE_BUDGET - used);
  let nextSlotMs = 0;
  if (now < backoffUntil) nextSlotMs = backoffUntil - now;
  else if (used >= RATE_BUDGET) nextSlotMs = RATE_WINDOW_MS - (now - callTimes[0]);
  return { used, remaining, budget: RATE_BUDGET, windowMs: RATE_WINDOW_MS, nextSlotMs };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForSlot() {
  // Loop because timers + clock drift can leave us slightly off — re-check
  // after every sleep instead of trusting the first calculation.
  for (;;) {
    const now = Date.now();
    if (now < backoffUntil) {
      await sleep(backoffUntil - now + 50);
      notifyWaiters();
      continue;
    }
    while (callTimes.length && now - callTimes[0] >= RATE_WINDOW_MS) callTimes.shift();
    if (callTimes.length < RATE_BUDGET) return;
    const waitMs = RATE_WINDOW_MS - (now - callTimes[0]) + 100;
    notifyWaiters();
    await sleep(waitMs);
  }
}

export async function fetchLyrics({ title, artist, source }) {
  const t = title?.trim();
  if (!t) throw new Error("Title is required");
  const q = new URLSearchParams({ title: t });
  if (artist?.trim()) q.set("artist", artist.trim());
  if (source && source !== "auto") q.set("source", source);

  await waitForSlot();
  callTimes.push(Date.now());
  notifyWaiters();

  const res = await fetch(`/api/lyrics?${q}`);
  // On rate-limit responses, pause every caller for the cooldown window so
  // the next attempt doesn't immediately re-trip the upstream limit.
  if (res.status === 429) {
    backoffUntil = Date.now() + BACKOFF_MS;
    notifyWaiters();
  }
  const json = await res.json().catch(() => null);
  if (!res.ok || !json?.data?.lyrics) {
    const msg = json?.data?.message || json?.error || `Request failed (${res.status})`;
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return json.data;
}
