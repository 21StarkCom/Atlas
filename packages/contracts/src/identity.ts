/**
 * Identity-key canonicalization — `atlas-identity-key-v1`.
 *
 * Every natural identifier the vault carries — a note `id`, an `alias`, or a
 * `[[wikilink]]` target — is folded to a single canonical key so that
 * "Aryeh Stark", "aryeh  stark", and "Aryeh-Stark" all collapse to the same
 * namespace slot (the `note_identity_keys.normalized_key` column, §2.7).
 *
 * This is the ONE versioned algorithm and it lives here, in the dependency-free
 * (Zod-only) contracts leaf, alongside its conformance vectors — so every
 * process across the seam folds identifiers identically. The CLI vault module
 * consumes/re-exports this; it does not own a private copy (D14).
 *
 * The transform is rune-safe: it operates on Unicode code points via `\p{…}`
 * property escapes under the `u` flag, so mixed Hebrew/English input normalizes
 * deterministically without splitting surrogate pairs or mangling combining
 * marks. Order is fixed — NFC → full case-fold → punctuation/symbol strip →
 * whitespace collapse → trim → NFC — so the result is stable across callers.
 */

/** The identity-key algorithm id this module implements (versioned per §2.7). */
export const IDENTITY_KEY_ALGORITHM_ID = "atlas-identity-key-v1";

/**
 * Pinned Unicode "full" case-folding table (`CaseFolding.txt`, status `F`).
 *
 * `String.prototype.toLowerCase` performs Unicode *simple* case *conversion* —
 * a 1:1 mapping that leaves the multi-code-point folds untouched: the Latin
 * ligatures (ﬀ→ff, ﬁ→fi, ﬃ→ffi, …), eszett (ß→ss), the Armenian ligatures, and
 * the Greek/precomposed expansions all stay put, so `oﬀice` would NOT fold to
 * `office`. Full case folding requires expanding every `F`-status source to its
 * canonical multi-character result.
 *
 * This is the COMPLETE set of `F`-status full foldings pinned to a single
 * Unicode version so every process across the seam folds identically. The `C`
 * (common) and `S` (simple) 1:1 foldings are handled by `toLowerCase()` after
 * expansion; the sole `C` divergence `toLowerCase()` gets wrong — Greek final
 * sigma ς→σ — is patched explicitly. Keys/values are BMP, so a plain
 * per-code-point lookup is rune-safe.
 */
const FULL_CASE_FOLD: ReadonlyMap<string, string> = new Map([
  ["ß", "ss"], // ß LATIN SMALL LETTER SHARP S
  ["İ", "i̇"], // İ LATIN CAPITAL LETTER I WITH DOT ABOVE
  ["ŉ", "ʼn"], // ŉ
  ["ǰ", "ǰ"], // ǰ
  ["ΐ", "ΐ"], // ΐ
  ["ΰ", "ΰ"], // ΰ
  ["և", "եւ"], // և ARMENIAN SMALL LIGATURE ECH YIWN
  ["ẖ", "ẖ"],
  ["ẗ", "ẗ"],
  ["ẘ", "ẘ"],
  ["ẙ", "ẙ"],
  ["ẚ", "aʾ"],
  ["ẞ", "ss"], // ẞ LATIN CAPITAL LETTER SHARP S
  ["ὐ", "ὐ"],
  ["ὒ", "ὒ"],
  ["ὔ", "ὔ"],
  ["ὖ", "ὖ"],
  ["ᾀ", "ἀι"],
  ["ᾁ", "ἁι"],
  ["ᾂ", "ἂι"],
  ["ᾃ", "ἃι"],
  ["ᾄ", "ἄι"],
  ["ᾅ", "ἅι"],
  ["ᾆ", "ἆι"],
  ["ᾇ", "ἇι"],
  ["ᾈ", "ἀι"],
  ["ᾉ", "ἁι"],
  ["ᾊ", "ἂι"],
  ["ᾋ", "ἃι"],
  ["ᾌ", "ἄι"],
  ["ᾍ", "ἅι"],
  ["ᾎ", "ἆι"],
  ["ᾏ", "ἇι"],
  ["ᾐ", "ἠι"],
  ["ᾑ", "ἡι"],
  ["ᾒ", "ἢι"],
  ["ᾓ", "ἣι"],
  ["ᾔ", "ἤι"],
  ["ᾕ", "ἥι"],
  ["ᾖ", "ἦι"],
  ["ᾗ", "ἧι"],
  ["ᾘ", "ἠι"],
  ["ᾙ", "ἡι"],
  ["ᾚ", "ἢι"],
  ["ᾛ", "ἣι"],
  ["ᾜ", "ἤι"],
  ["ᾝ", "ἥι"],
  ["ᾞ", "ἦι"],
  ["ᾟ", "ἧι"],
  ["ᾠ", "ὠι"],
  ["ᾡ", "ὡι"],
  ["ᾢ", "ὢι"],
  ["ᾣ", "ὣι"],
  ["ᾤ", "ὤι"],
  ["ᾥ", "ὥι"],
  ["ᾦ", "ὦι"],
  ["ᾧ", "ὧι"],
  ["ᾨ", "ὠι"],
  ["ᾩ", "ὡι"],
  ["ᾪ", "ὢι"],
  ["ᾫ", "ὣι"],
  ["ᾬ", "ὤι"],
  ["ᾭ", "ὥι"],
  ["ᾮ", "ὦι"],
  ["ᾯ", "ὧι"],
  ["ᾲ", "ὰι"],
  ["ᾳ", "αι"],
  ["ᾴ", "άι"],
  ["ᾶ", "ᾶ"],
  ["ᾷ", "ᾶι"],
  ["ᾼ", "αι"],
  ["ῂ", "ὴι"],
  ["ῃ", "ηι"],
  ["ῄ", "ήι"],
  ["ῆ", "ῆ"],
  ["ῇ", "ῆι"],
  ["ῌ", "ηι"],
  ["ῒ", "ῒ"],
  ["ΐ", "ΐ"],
  ["ῖ", "ῖ"],
  ["ῗ", "ῗ"],
  ["ῢ", "ῢ"],
  ["ΰ", "ΰ"],
  ["ῤ", "ῤ"],
  ["ῦ", "ῦ"],
  ["ῧ", "ῧ"],
  ["ῲ", "ὼι"],
  ["ῳ", "ωι"],
  ["ῴ", "ώι"],
  ["ῶ", "ῶ"],
  ["ῷ", "ῶι"],
  ["ῼ", "ωι"],
  ["ﬀ", "ff"], // ﬀ
  ["ﬁ", "fi"], // ﬁ
  ["ﬂ", "fl"], // ﬂ
  ["ﬃ", "ffi"], // ﬃ
  ["ﬄ", "ffl"], // ﬄ
  ["ﬅ", "st"], // ﬅ
  ["ﬆ", "st"], // ﬆ
  ["ﬓ", "մն"], // Armenian ligatures
  ["ﬔ", "մե"],
  ["ﬕ", "մի"],
  ["ﬖ", "վն"],
  ["ﬗ", "մխ"],
]);

/**
 * Full Unicode case folding (locale-independent). Expand every `F`-status
 * source to its pinned multi-code-point result FIRST (iterating by code point,
 * so surrogate pairs and combining marks are never split), then apply
 * `toLowerCase()` for the 1:1 `C`/`S` foldings, then patch the one `C` fold
 * `toLowerCase()` misses — Greek final sigma ς→σ, so word-final and medial
 * sigma compare equal.
 */
function caseFold(s: string): string {
  let folded = "";
  for (const ch of s) folded += FULL_CASE_FOLD.get(ch) ?? ch;
  return folded.toLowerCase().replace(/ς/g, "σ");
}

/**
 * Canonicalize a natural identifier into its stable identity key.
 *
 * Steps (in order, each rune-safe):
 *  1. Unicode NFC — compose canonically-equivalent sequences to one form.
 *  2. Full case-fold — case-insensitive equality (a no-op for caseless scripts).
 *  3. Punctuation & symbols → a single space (rune-safe `\p{P}`/`\p{S}`).
 *  4. Collapse any run of Unicode whitespace to one ASCII space.
 *  5. Trim leading/trailing space.
 *  6. Re-apply NFC (case folding can perturb composition) so the key is stable.
 */
export function normalizeIdentityKey(s: string): string {
  return caseFold(s.normalize("NFC"))
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .normalize("NFC");
}

/** A single conformance vector for `atlas-identity-key-v1`. */
export interface IdentityKeyVector {
  /** Raw identifier fed to `normalizeIdentityKey`. */
  readonly input: string;
  /** The exact canonical key it must fold to. */
  readonly expected: string;
  /** Why this vector exists (documents the rule it pins). */
  readonly note: string;
}

/**
 * Conformance vectors owned alongside the algorithm. Any conforming
 * implementation of `atlas-identity-key-v1` must reproduce these exactly.
 */
export const IDENTITY_KEY_VECTORS: readonly IdentityKeyVector[] = [
  { input: "Aryeh Stark", expected: "aryeh stark", note: "ASCII case fold" },
  { input: "  Aryeh   Stark  ", expected: "aryeh stark", note: "whitespace collapse + trim" },
  { input: "Aryeh-Stark!", expected: "aryeh stark", note: "punctuation → space" },
  { input: "Project: Meridian (v2)", expected: "project meridian v2", note: "mixed punctuation" },
  // Decomposed (e + combining acute) folds identically to precomposed é.
  { input: "Café", expected: "café", note: "NFC of decomposed é" },
  { input: "Café", expected: "café", note: "NFC of precomposed é" },
  { input: "Straße", expected: "strasse", note: "eszett folds to ss" },
  { input: "STRASSE", expected: "strasse", note: "eszett equality with plain ss" },
  // Non-simple multi-code-point full folds: Latin ligatures expand (a plain
  // toLowerCase would leave them intact, so `oﬀice` would NOT equal `office`).
  { input: "oﬀice", expected: "office", note: "ﬀ ligature → ff (full fold)" },
  { input: "ﬁle", expected: "file", note: "ﬁ ligature → fi (full fold)" },
  { input: "eﬃcient", expected: "efficient", note: "ﬃ ligature → ffi (full fold)" },
  { input: "waﬄe", expected: "waffle", note: "ﬄ ligature → ffl (full fold)" },
  { input: "ﬅ", expected: "st", note: "ﬅ long-s+t ligature → st (full fold)" },
  // Armenian ligature (caseless) expands to two letters.
  { input: "և", expected: "եւ", note: "Armenian ﬔ ligature ech-yiwn → եւ" },
  // Ligature and its spelled-out form fold to the same key.
  { input: "eﬀ", expected: "eff", note: "ﬀ ligature equals plain ff" },
  // Greek final sigma folds to medial sigma.
  { input: "Σοφος", expected: "σοφοσ", note: "final sigma ς → σ" },
  // Hebrew is caseless: only whitespace/punctuation fold; letters are preserved.
  { input: "אריה  שטארק", expected: "אריה שטארק", note: "Hebrew whitespace collapse" },
  { input: "Aryeh — אריה", expected: "aryeh אריה", note: "mixed Hebrew/English, em-dash → space" },
];
