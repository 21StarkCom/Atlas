/**
 * `@atlas/scan` engine — `scanBytes`, the deterministic fail-closed detector.
 *
 * Decodes the bytes to text before scanning. The accepted encodings match the
 * text-format set in `docs/specs/normalization-contract.md` (utf-8, utf-8-bom,
 * utf-16le-bom, utf-16be-bom) so a secret hidden in a BOM-marked UTF-16 source is
 * caught on the raw pre-persistence scan, not missed until after parsing. Detection
 * keys off the leading BOM (the contract's "declared/detected BOM wins" rule); any
 * other byte stream is decoded lossily as UTF-8 (a decode error never hides a
 * match). Then it runs the versioned ruleset (structural credential shapes first,
 * then the entropy heuristic over tokens no structural rule claimed) and returns an
 * ordered, de-duplicated {@link ScanVerdict}. Findings carry ONLY non-secret
 * metadata; the raw match never leaves this module (it is masked before it reaches
 * a finding).
 *
 * Determinism: identical bytes ⇒ identical findings (stable order, stable
 * redaction), stamped with the ruleset id + version.
 */
import type { ScanContext, ScanVerdict, SecretFinding } from "./types.js";
import {
  ENTROPY_RULE,
  RULESET_ID,
  RULESET_VERSION,
  STRUCTURAL_RULES,
  isMixedAlphabet,
  shannonEntropy,
  tokenize,
  type RawMatch,
} from "./rules.js";

/** Lossy decoders — malformed bytes become U+FFFD, never a scan bypass. */
const UTF8 = new TextDecoder("utf-8", { fatal: false });
const UTF16LE = new TextDecoder("utf-16le", { fatal: false });

/**
 * Decode `bytes` to text for scanning, honouring the leading BOM per the
 * normalization contract's accepted text encodings (utf-8, utf-8-bom,
 * utf-16le-bom, utf-16be-bom). The BOM is stripped so offsets are into the content.
 * UTF-16BE is byte-swapped into LE and decoded with the LE decoder, so we don't
 * depend on the optional `utf-16be` ICU label being present. Anything without a
 * recognized BOM is treated as UTF-8 (the default for the text formats).
 */
function decodeForScan(bytes: Uint8Array): string {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return UTF16LE.decode(bytes.subarray(2)); // UTF-16LE BOM
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return decodeUtf16be(bytes.subarray(2)); // UTF-16BE BOM
  }
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return UTF8.decode(bytes.subarray(3)); // UTF-8 BOM
  }
  return UTF8.decode(bytes); // UTF-8 (default) / lossy for anything else
}

/** Decode UTF-16BE by swapping to LE first (avoids the optional `utf-16be` label). */
function decodeUtf16be(bytes: Uint8Array): string {
  const n = bytes.length - (bytes.length % 2);
  const swapped = new Uint8Array(bytes.length);
  for (let i = 0; i < n; i += 2) {
    swapped[i] = bytes[i + 1]!;
    swapped[i + 1] = bytes[i]!;
  }
  if (n !== bytes.length) swapped[n] = bytes[n]!; // trailing odd byte (lossy → U+FFFD)
  return UTF16LE.decode(swapped);
}

/**
 * Redact a matched value to a non-reversible preview. Emits NO character of the
 * secret — only the rule-agnostic length — so a finding can never leak the match.
 */
function redact(value: string): string {
  return `‹redacted:${[...value].length} chars›`;
}

/** Regex cloned with the `d` (hasIndices) flag so capture-group offsets are available. */
function withIndices(re: RegExp): RegExp {
  const flags = re.flags.includes("d") ? re.flags : re.flags + "d";
  return new RegExp(re.source, flags);
}

/** Run the structural rules, narrowing each match to its sensitive capture group. */
function structuralMatches(text: string): RawMatch[] {
  const out: RawMatch[] = [];
  for (const rule of STRUCTURAL_RULES) {
    const re = withIndices(rule.pattern);
    for (const m of text.matchAll(re)) {
      // Narrow to the configured group when it participated; else the whole match.
      let start = m.index;
      let end = m.index + m[0].length;
      let value = m[0];
      if (rule.group > 0) {
        const gi = m.indices?.[rule.group];
        const gv = m[rule.group];
        if (gi && gv !== undefined) {
          start = gi[0];
          end = gi[1];
          value = gv;
        }
      } else {
        // group 0 with alternation groups (generic-assignment): prefer the first
        // captured value's span so the preview length reflects the secret, not the
        // whole `key = "…"` expression. Falls back to the full match.
        for (let g = 1; g < m.length; g++) {
          const gv = m[g];
          const gi = m.indices?.[g];
          if (gv !== undefined && gi) {
            start = gi[0];
            end = gi[1];
            value = gv;
            break;
          }
        }
      }
      out.push({
        ruleId: rule.id,
        title: rule.title,
        severity: rule.severity,
        start,
        end,
        value,
      });
    }
  }
  return out;
}

/** True when [s,e) overlaps any range in `ranges`. */
function overlapsAny(s: number, e: number, ranges: { start: number; end: number }[]): boolean {
  for (const r of ranges) {
    if (s < r.end && r.start < e) return true;
  }
  return false;
}

/** Entropy heuristic over tokens not already claimed by a structural match. */
function entropyMatches(text: string, claimed: RawMatch[]): RawMatch[] {
  const out: RawMatch[] = [];
  for (const tok of tokenize(text)) {
    if (tok.value.length < ENTROPY_RULE.minLength) continue;
    if (!isMixedAlphabet(tok.value)) continue;
    const entropy = shannonEntropy(tok.value);
    if (entropy < ENTROPY_RULE.minEntropyBitsPerChar) continue;
    const end = tok.start + tok.value.length;
    if (overlapsAny(tok.start, end, claimed)) continue;
    out.push({
      ruleId: ENTROPY_RULE.id,
      title: ENTROPY_RULE.title,
      severity: ENTROPY_RULE.severity,
      start: tok.start,
      end,
      value: tok.value,
      entropyBitsPerChar: entropy,
    });
  }
  return out;
}

/** Deterministic order + de-duplication of identical (ruleId,start,end) findings. */
function normalize(matches: RawMatch[]): SecretFinding[] {
  const sorted = [...matches].sort(
    (a, b) => a.start - b.start || a.end - b.end || a.ruleId.localeCompare(b.ruleId),
  );
  const seen = new Set<string>();
  const findings: SecretFinding[] = [];
  for (const m of sorted) {
    const key = `${m.ruleId}:${m.start}:${m.end}`;
    if (seen.has(key)) continue;
    seen.add(key);
    findings.push({
      ruleId: m.ruleId,
      title: m.title,
      severity: m.severity,
      startOffset: m.start,
      endOffset: m.end,
      redactedPreview: redact(m.value),
      ...(m.entropyBitsPerChar !== undefined
        ? { entropyBitsPerChar: Math.round(m.entropyBitsPerChar * 1000) / 1000 }
        : {}),
    });
  }
  return findings;
}

/**
 * Scan `bytes` for secrets. Fail-closed: any structural credential shape or a
 * high-entropy token yields a dirty verdict. `context` is diagnostic only (it does
 * not change detection) — it names the boundary + origin for the caller's refusal
 * + quarantine metadata.
 */
export function scanBytes(input: {
  readonly bytes: Uint8Array;
  // Reserved for boundary-specific tuning; detection is context-independent today.
  readonly context: ScanContext;
}): ScanVerdict {
  const text = decodeForScan(input.bytes);
  const structural = structuralMatches(text);
  const entropy = entropyMatches(text, structural);
  const findings = normalize([...structural, ...entropy]);

  if (findings.length === 0) {
    return { clean: true, rulesetId: RULESET_ID, rulesetVersion: RULESET_VERSION };
  }
  return { clean: false, rulesetId: RULESET_ID, rulesetVersion: RULESET_VERSION, findings };
}

export { RULESET_ID, RULESET_VERSION } from "./rules.js";
