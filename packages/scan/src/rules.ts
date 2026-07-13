/**
 * `@atlas/scan` ruleset — the deterministic, versioned secret-detection rules.
 *
 * Two rule families:
 *   1. **Structural credential shapes** (high severity) — provider-specific
 *      regexes for representative secret formats (AWS, GitHub, Google, Slack,
 *      Stripe, JWT, PEM private-key blocks) plus a keyword-anchored generic
 *      assignment rule.
 *   2. **An entropy heuristic** (medium severity) — long, high-entropy,
 *      mixed-alphabet tokens that no structural rule claimed. Thresholds are
 *      tuned conservatively so ordinary prose and content hashes (hex ⇒ ≤ 4.0
 *      bits/char) do NOT trip it, while base64/base62 random secrets (≥ ~5 bits)
 *      do.
 *
 * Determinism is a contract: the ruleset carries a stable id + integer version;
 * a change to any rule bumps {@link RULESET_VERSION}. Given the same bytes and
 * version, {@link import("./engine.js").scanBytes} returns byte-identical findings.
 */
import type { FindingSeverity } from "./types.js";

/** Stable ruleset identity (reproducibility stamp on every verdict). */
export const RULESET_ID = "atlas-scan-ruleset-v1" as const;
/** Integer ruleset version — bumped whenever any rule below changes. */
export const RULESET_VERSION = 1 as const;

/** A raw match a rule produced, before redaction/normalization by the engine. */
export interface RawMatch {
  readonly ruleId: string;
  readonly title: string;
  readonly severity: FindingSeverity;
  readonly start: number;
  readonly end: number;
  /** The matched substring (kept only inside the engine; never surfaced raw). */
  readonly value: string;
  readonly entropyBitsPerChar?: number;
}

/** A structural rule: a global regex + which capture group holds the secret token. */
interface StructuralRule {
  readonly id: string;
  readonly title: string;
  readonly severity: FindingSeverity;
  readonly pattern: RegExp;
  /**
   * Capture-group index whose span locates the sensitive token. `0` = the whole
   * match. When > 0 the match range narrows to that group (so the redacted
   * preview + offsets cover the credential, not the surrounding keyword).
   */
  readonly group: number;
}

/**
 * The structural rules, applied in this fixed order. Every `pattern` MUST carry
 * the global (`g`) flag (the engine relies on `lastIndex` iteration).
 */
export const STRUCTURAL_RULES: readonly StructuralRule[] = [
  {
    id: "aws-access-key-id",
    title: "AWS access key id",
    severity: "high",
    // AKIA/ASIA/… prefixes + 16 upper-alnum chars (the canonical 20-char id).
    pattern: /\b((?:AKIA|ASIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|A3T[A-Z0-9])[A-Z0-9]{16})\b/g,
    group: 1,
  },
  {
    id: "aws-secret-access-key",
    title: "AWS secret access key",
    severity: "high",
    // Keyword-anchored 40-char base64-ish secret (the classic aws_secret_access_key).
    pattern: /aws.{0,3}secret.{0,3}(?:access.{0,3})?key\s*[:=]\s*["']?([A-Za-z0-9/+]{40})/gi,
    group: 1,
  },
  {
    id: "github-token",
    title: "GitHub token",
    severity: "high",
    pattern: /\b((?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36})\b/g,
    group: 1,
  },
  {
    id: "github-pat",
    title: "GitHub fine-grained PAT",
    severity: "high",
    pattern: /\b(github_pat_[A-Za-z0-9]{22}_[A-Za-z0-9]{59})\b/g,
    group: 1,
  },
  {
    id: "google-api-key",
    title: "Google API key",
    severity: "high",
    pattern: /\b(AIza[A-Za-z0-9_-]{35})\b/g,
    group: 1,
  },
  {
    id: "slack-token",
    title: "Slack token",
    severity: "high",
    pattern: /\b(xox[baprs]-[A-Za-z0-9-]{10,})\b/g,
    group: 1,
  },
  {
    id: "slack-webhook",
    title: "Slack incoming webhook",
    severity: "high",
    pattern: /(https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9]+\/[A-Za-z0-9]+\/[A-Za-z0-9]+)/g,
    group: 1,
  },
  {
    id: "stripe-secret-key",
    title: "Stripe secret key",
    severity: "high",
    pattern: /\b((?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,})\b/g,
    group: 1,
  },
  {
    id: "jwt",
    title: "JSON Web Token",
    severity: "high",
    // header.payload.signature — the header segment always starts with base64url("{"").
    pattern: /\b(eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})\b/g,
    group: 1,
  },
  {
    id: "private-key-block",
    title: "PEM private-key block",
    severity: "high",
    pattern: /(-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----)/g,
    group: 1,
  },
  {
    id: "generic-secret-assignment",
    title: "Secret-like assignment",
    severity: "high",
    // A secret-ish key name assigned a non-trivial value (quoted or ≥ 8 non-space chars).
    pattern:
      /\b(?:password|passwd|pwd|secret|api[_-]?key|apikey|access[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key|token)\b\s*[:=]\s*(?:"([^"\n]{6,})"|'([^'\n]{6,})'|([^\s"'#]{8,}))/gi,
    group: 0,
  },
] as const;

/** Alphabet the entropy heuristic treats as a candidate token character. */
const TOKEN_CHAR = /[A-Za-z0-9+/=_-]/;

/** Entropy-heuristic tuning (medium severity, versioned with the ruleset). */
export const ENTROPY_RULE = {
  id: "high-entropy-token",
  title: "High-entropy token",
  severity: "medium" as FindingSeverity,
  /** Minimum token length considered (below this, entropy is not meaningful). */
  minLength: 32,
  /**
   * Minimum Shannon entropy (bits/char). Hex (16-symbol) tops out at 4.0, so a
   * sha256 digest never trips; random base64 sits ~5.5–6.0. 4.3 is comfortably
   * between them.
   */
  minEntropyBitsPerChar: 4.3,
} as const;

/** Shannon entropy (bits per character) of `s`. Deterministic; pure. */
export function shannonEntropy(s: string): number {
  if (s.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

/** True when `s` mixes character classes (has ≥ 2 of: lower, upper, digit, symbol). */
export function isMixedAlphabet(s: string): boolean {
  let classes = 0;
  if (/[a-z]/.test(s)) classes++;
  if (/[A-Z]/.test(s)) classes++;
  if (/[0-9]/.test(s)) classes++;
  if (/[+/=_-]/.test(s)) classes++;
  return classes >= 2;
}

/**
 * Extract maximal candidate tokens (runs of {@link TOKEN_CHAR}) with their start
 * offsets. Deterministic left-to-right scan; used only by the entropy heuristic.
 */
export function tokenize(text: string): { value: string; start: number }[] {
  const out: { value: string; start: number }[] = [];
  let start = -1;
  for (let i = 0; i <= text.length; i++) {
    const ch = i < text.length ? text[i]! : "";
    if (ch !== "" && TOKEN_CHAR.test(ch)) {
      if (start === -1) start = i;
    } else if (start !== -1) {
      out.push({ value: text.slice(start, i), start });
      start = -1;
    }
  }
  return out;
}
