import { pinyin } from "pinyin-pro";

const HAN = /[㐀-鿿豈-﫿]/;

// Baseline normalization: lowercase, trim, collapse whitespace, NFC. Matches
// what the server does in api/library.js.
export const norm = (s) =>
  (s || "").toLowerCase().trim().replace(/\s+/g, " ").normalize("NFC");

// Script-agnostic fold for dedup: Han characters become toneless pinyin so
// Traditional and Simplified variants collapse to the same key
// (專屬天使 / 专属天使 → "zhuan shu tian shi"). Latin/other text passes through
// normalized. Two genuinely different songs that happen to be homophones could
// collide, so callers pair the title fold with an artist check.
export function foldForDedup(s) {
  const base = norm(s);
  if (!base || !HAN.test(base)) return base;
  try {
    return pinyin(base, { toneType: "none", type: "array", nonZh: "consecutive" })
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
  } catch {
    return base;
  }
}

// Precompute fold keys for a library once, so per-track lookups during a bulk
// import don't re-run pinyin conversion against every song.
export function buildLibIndex(library) {
  return (library || []).map((song) => ({
    song,
    tf: foldForDedup(song.title),
    af: foldForDedup(song.artist),
  }));
}

// Returns { song, match } for a likely duplicate, else null. Comparison is on
// the folded keys so script variants match.
//   match: 'strict' — title + artist both match
//          'alias'  — title matches AND one artist contains the other
//                     ("Joker Xue" vs the saved "薛之谦 Joker Xue")
//          'title'  — title matches and is unique in the library, and the
//                     caller gave NO artist to disambiguate with
export function findExistingFolded(libIndex, title, artist) {
  const tf = foldForDedup(title);
  if (!tf) return null;
  const af = foldForDedup(artist);

  const sameTitle = libIndex.filter((e) => e.tf === tf);
  if (!sameTitle.length) return null;

  if (af) {
    const strict = sameTitle.find((e) => e.af === af);
    if (strict) return { song: strict.song, match: "strict" };

    if (af.length >= 2) {
      const nested = sameTitle.find((e) => {
        if (!e.af) return false;
        return e.af.includes(af) || af.includes(e.af);
      });
      if (nested) return { song: nested.song, match: "alias" };
    }

    // An artist was provided but matched none of the same-title songs above —
    // they're genuinely different works (爱你 by 陳芳語 vs 爱你 by 王心凌), not a
    // duplicate. Don't fall through to the title-only guess.
    return null;
  }

  // No artist to disambiguate with: if exactly one saved song carries this
  // title, it's almost certainly the one the user means.
  if (sameTitle.length === 1) return { song: sameTitle[0].song, match: "title" };
  return null;
}
