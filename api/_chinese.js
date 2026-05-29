// Traditional <-> Simplified helpers for the lyrics search fallback.
//
// Some songs are stored by the upstream provider under the other Han variant
// than the user typed (e.g. they search "國境之南" but the provider indexed
// "国境之南"). When a search misses, we retry once with the title/artist
// converted to the opposite variant.
//
// Files prefixed with "_" are not deployed as Vercel routes — they're just
// modules imported by the routed handlers (and the Vite dev proxy).

import * as OpenCC from "opencc-js";

const HAN_RE = /[㐀-鿿豈-﫿]/;
export const hasHan = (s) => HAN_RE.test(s || "");

// Converters are lazy: OpenCC only parses its dictionaries on first use, so we
// pay nothing unless the variant fallback actually fires.
let _t2s = null;
let _s2t = null;
const toSimplified = (s) => (_t2s ||= OpenCC.Converter({ from: "tw", to: "cn" }))(s);
const toTraditional = (s) => (_s2t ||= OpenCC.Converter({ from: "cn", to: "tw" }))(s);

// Rewrites text to the *other* Han variant, or returns null when there's no Han
// or the text is identical in both scripts (nothing worth retrying).
export function otherChineseVariant(text) {
  const s = (text || "").trim();
  if (!s || !hasHan(s)) return null;
  const simp = toSimplified(s);
  if (simp !== s) return simp; // input had Traditional chars -> Simplified
  const trad = toTraditional(s);
  if (trad !== s) return trad; // input was Simplified -> Traditional
  return null; // same in both variants
}

// Config toggle (env var, not UI). Defaults ON so the feature works out of the
// box; set LYRICS_TS_FALLBACK to 0/false/off/no to disable without a code change.
export function variantFallbackEnabled(env) {
  const v = String(env?.LYRICS_TS_FALLBACK ?? "").trim().toLowerCase();
  if (v === "") return true;
  return !["0", "false", "off", "no"].includes(v);
}
