// Shared helpers for resolving an artist name to its CJK/Latin alias counterpart.
// Used by /api/alias, /api/aliases, /api/backfill, and the Vite dev proxies.
//
// Files prefixed with "_" are not deployed as Vercel routes — they're just
// modules imported by the routed handlers.

import { Redis } from "@upstash/redis";

const HAN_RE = /[㐀-鿿]/;
const LATIN_RE = /[A-Za-z]/;
const MB_BASE = "https://musicbrainz.org/ws/2";
const MB_UA = "Alune/1.0 ( https://github.com/anthropics/claude-code )";

// MusicBrainz carries some artist aliases that are a CJK name encoded in Big5 /
// GB and then read back as Latin-1 — e.g. 周華健 surfaces as "©PµØ°·" (Big5) and
// "ÖÜ»ª½¡" (GB). The byte soup shows up as C1 control characters (never present
// in real text) or a cluster of Latin-1 symbol-block code points. Accented
// letters used in genuine names (é, ñ, ü, ø, ß…) live outside these ranges, so
// this stays clear of false positives.
const C1_CONTROL_RE = /[\u0080-\u009F]/;
const LATIN1_SYMBOL_RE = /[\u00A1-\u00BF\u00D7\u00F7]/g;

export function looksLikeMojibake(s) {
  if (!s) return false;
  if (C1_CONTROL_RE.test(s)) return true;
  return (s.match(LATIN1_SYMBOL_RE) || []).length >= 2;
}

// Drop whitespace-delimited tokens that are mojibake, keeping the rest. Used to
// repair artist fields a previous backfill already wrote in combined form, e.g.
// "周華健 ©PµØ°·" → "周華健". Returns "" only if every token was mojibake.
export function stripMojibake(s) {
  const str = (s || "").trim();
  if (!str) return "";
  return str.split(/\s+/).filter((tok) => !looksLikeMojibake(tok)).join(" ").trim();
}

export function normalizeName(s) {
  return (s || "").toLowerCase().trim().replace(/\s+/g, " ").normalize("NFC");
}

export function hasHan(s) {
  return HAN_RE.test(s || "");
}

export function hasLatin(s) {
  return LATIN_RE.test(s || "");
}

// User wants Chinese-first format: "薛之谦 Joker Xue" regardless of which side
// was provided originally. If both sides are the same script, we don't merge
// — only mixed-script pairs get joined.
export function formatPair(original, alias) {
  if (!alias || looksLikeMojibake(alias)) return original || "";
  if (hasHan(original) && !hasHan(alias)) return `${original} ${alias}`;
  if (!hasHan(original) && hasHan(alias)) return `${alias} ${original}`;
  return original;
}

export function kvClient() {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

function pickAlternateScript(original, names) {
  const norm = normalizeName(original);
  const wantHan = !hasHan(original);
  for (const n of names) {
    if (!n || looksLikeMojibake(n)) continue;
    if (normalizeName(n) === norm) continue;
    if (wantHan && hasHan(n)) return n;
    if (!wantHan && hasLatin(n) && !hasHan(n)) return n;
  }
  return null;
}

async function mbFetch(path) {
  const res = await fetch(`${MB_BASE}${path}`, {
    headers: { "User-Agent": MB_UA, Accept: "application/json" },
  });
  if (!res.ok) return null;
  return res.json().catch(() => null);
}

function escapeLucene(s) {
  // Inside a quoted phrase, only `"` and `\` are special.
  return s.replace(/["\\]/g, "\\$&");
}

// Returns { original, alias, formatted, source }.
// alias is null when no counterpart was found. The result is always cached so
// repeated lookups (e.g. backfill scans) only hit MusicBrainz once per artist.
export async function resolveAlias(name, redis) {
  const raw = (name || "").trim();
  // Repair inputs a previous backfill already wrote in corrupted combined form
  // (e.g. "周華健 ©PµØ°·"): drop the mojibake token so the clean CJK part drives
  // the lookup. Falls back to the raw value if nothing's left to resolve on.
  const original = stripMojibake(raw) || raw;
  const result = { original, alias: null, formatted: original, source: "none" };
  if (!original) return result;
  const norm = normalizeName(original);

  if (redis) {
    const override = await redis.hget("alias:overrides", norm);
    if (override) {
      const aliasName = typeof override === "string" ? override : (override?.alias || null);
      if (aliasName && !looksLikeMojibake(aliasName)) {
        return {
          original,
          alias: aliasName,
          formatted: formatPair(original, aliasName),
          source: "override",
        };
      }
    }
    const cached = await redis.get(`alias:cache:${norm}`);
    // Ignore poisoned cache entries and fall through to re-resolve, overwriting
    // them below — older caches may hold a mojibake alias from MusicBrainz.
    if (cached !== null && cached !== undefined && !looksLikeMojibake(cached)) {
      const aliasName = cached === "" ? null : cached;
      return {
        original,
        alias: aliasName,
        formatted: formatPair(original, aliasName),
        source: "musicbrainz-cache",
      };
    }
  }

  let aliasName = null;
  try {
    const q = encodeURIComponent(`artist:"${escapeLucene(original)}"`);
    const search = await mbFetch(`/artist?query=${q}&fmt=json&limit=5`);
    const candidates = search?.artists || [];
    const match =
      candidates.find((a) => {
        if (normalizeName(a.name) === norm) return true;
        return (a.aliases || []).some((al) => normalizeName(al.name) === norm);
      }) || candidates[0];
    if (match) {
      const fromSearch = [match.name, ...(match.aliases || []).map((a) => a.name)];
      aliasName = pickAlternateScript(original, fromSearch);
      if (!aliasName && match.id) {
        const full = await mbFetch(`/artist/${match.id}?inc=aliases&fmt=json`);
        if (full) {
          const fromLookup = [full.name, ...(full.aliases || []).map((a) => a.name)];
          aliasName = pickAlternateScript(original, fromLookup);
        }
      }
    }
  } catch {
    // MB unreachable / rate-limited — return original unchanged.
  }

  if (redis) {
    // Cache hits AND misses for 30 days. Storing "" for misses keeps the
    // distinction between "no alias" and "never looked up".
    await redis.set(`alias:cache:${norm}`, aliasName ?? "", { ex: 60 * 60 * 24 * 30 });
  }

  return {
    original,
    alias: aliasName,
    formatted: formatPair(original, aliasName),
    source: aliasName ? "musicbrainz" : "none",
  };
}
