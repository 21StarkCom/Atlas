/**
 * Canonical serialization — `atlas-jcs-v1` (security/broker contract §8.2).
 *
 * RFC 8785 JSON Canonicalization Scheme with fixed rules so any two processes
 * produce BYTE-IDENTICAL output (the process-seam contract):
 *   1. UTF-8, no BOM; object keys sorted by UTF-16 code-unit order.
 *   2. No insignificant whitespace; JCS minimal string escaping (via JSON.stringify).
 *   3. Numbers use the ECMAScript shortest round-trip form; NaN/Infinity rejected.
 *      (Timestamps are RFC-3339 strings by contract, never numeric.)
 *   4. `undefined`/absent object keys are omitted (never emitted as `null`).
 *
 * Pure and dependency-free: identical input → identical bytes, always.
 */

/** The canonicalization id this module implements (see contract §8.2). */
export const CANONICALIZATION_ID = "atlas-jcs-v1";

const encoder = new TextEncoder();

function canonicalString(v: unknown): string {
  if (v === null) return "null";

  const t = typeof v;

  if (t === "boolean") return v ? "true" : "false";

  if (t === "number") {
    const n = v as number;
    if (!Number.isFinite(n)) {
      throw new Error(`canonicalSerialize: non-finite number (NaN/Infinity) is not serializable`);
    }
    // ECMAScript Number→String is the shortest round-trip form JCS mandates.
    return String(n);
  }

  if (t === "string") {
    // NFC so semantically-equal Unicode strings serialize to identical bytes.
    return JSON.stringify((v as string).normalize("NFC"));
  }

  if (t === "bigint") {
    throw new Error(`canonicalSerialize: bigint is not JSON-serializable`);
  }

  if (Array.isArray(v)) {
    return `[${v.map((el) => canonicalArrayElement(el)).join(",")}]`;
  }

  if (t === "object") {
    const obj = v as Record<string, unknown>;
    // Normalize keys to NFC BEFORE sorting. Sorting raw and normalizing later
    // would diverge across processes: an NFD key (e.g. "é") and its NFC
    // form ("é") sort to different positions by UTF-16 code unit, so two
    // processes feeding the same data in different Unicode forms would emit
    // members in different orders — breaking the byte-identity seam contract.
    const entries = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .map((k) => ({ key: k.normalize("NFC"), value: obj[k] }))
      // Compare by UTF-16 code units (JCS's rule) on the already-NFC keys.
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    for (let i = 1; i < entries.length; i++) {
      // Distinct raw keys can collapse to one NFC key — an ambiguous object we
      // must reject rather than silently emit a duplicate/last-wins member.
      if (entries[i]!.key === entries[i - 1]!.key) {
        throw new Error(
          `canonicalSerialize: duplicate object key after NFC normalization ("${entries[i]!.key}")`,
        );
      }
    }
    const members = entries.map((e) => `${JSON.stringify(e.key)}:${canonicalString(e.value)}`);
    return `{${members.join(",")}}`;
  }

  // function / symbol / undefined at a value position are not representable.
  throw new Error(`canonicalSerialize: unsupported value of type ${t}`);
}

function canonicalArrayElement(v: unknown): string {
  // JSON arrays cannot hold holes/undefined; surface that rather than coercing
  // to null (which would silently diverge from the object-key omission rule).
  if (v === undefined) {
    throw new Error(`canonicalSerialize: undefined is not valid inside an array`);
  }
  return canonicalString(v);
}

/**
 * Serialize `v` to its canonical UTF-8 byte string under `atlas-jcs-v1`.
 * Throws on NaN/Infinity, bigint, and non-JSON value types.
 */
export function canonicalSerialize(v: unknown): Uint8Array {
  return encoder.encode(canonicalString(v));
}

/** Convenience: the canonical form as a UTF-8 string (same bytes as above). */
export function canonicalStringify(v: unknown): string {
  return canonicalString(v);
}
