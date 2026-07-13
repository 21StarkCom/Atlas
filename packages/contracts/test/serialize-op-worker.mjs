/**
 * Out-of-process serialization worker for `contracts.operations.test`.
 *
 * Imports the BUILT `@atlas/contracts` (dist) — a separate node process from the
 * vitest runner — and, for each op sample, INDEPENDENTLY parses the raw fixture
 * through `ChangePlanSchema` (proving the schema round-trips across the seam, not
 * just the serializer), then serializes the PARSED value and prints:
 *
 *   <index>\t<op>\t<sha256-hex-of-canonical-bytes>
 *
 * A trailing line reports whether an unknown payload key is REJECTED by the
 * strict op schema in this separate process:
 *
 *   unknown-key-rejected\t<true|false>
 *
 * The test spawns this worker twice and asserts byte-identical stdout, and that
 * the hashes equal the vitest process's own parse-then-serialize hashes — three
 * independent processes, one canonical form, unknown fields rejected everywhere.
 */
import { createHash } from "node:crypto";
import { canonicalSerialize, ChangePlanSchema } from "../dist/index.js";
import { OP_SAMPLES } from "./op-fixtures.mjs";

const lines = OP_SAMPLES.map((sample, i) => {
  // Parse independently in THIS process (throws on any drift), then serialize the
  // validated value — not the raw fixture.
  const parsed = ChangePlanSchema.parse(sample);
  const bytes = canonicalSerialize(parsed);
  const hex = createHash("sha256").update(bytes).digest("hex");
  return `${i}\t${parsed.operation.op}\t${hex}`;
});

// Prove the strict op payloads reject an unknown PAYLOAD key in this separate process too.
let rejected = false;
try {
  const base = OP_SAMPLES[0];
  ChangePlanSchema.parse({ ...base, operation: { ...base.operation, stowaway: true } });
} catch {
  rejected = true;
}
lines.push(`unknown-key-rejected\t${rejected}`);

// Prove the strict ENVELOPE rejects an unknown TOP-LEVEL key in this separate
// process too (R3-F2: a stowaway top-level field must be a hard rejection, never
// silently stripped before canonical serialization — otherwise the two seam
// processes could disagree on the canonical bytes).
let topLevelRejected = false;
try {
  ChangePlanSchema.parse({ ...OP_SAMPLES[0], stowaway: true });
} catch {
  topLevelRejected = true;
}
lines.push(`toplevel-unknown-key-rejected\t${topLevelRejected}`);

process.stdout.write(lines.join("\n") + "\n");
