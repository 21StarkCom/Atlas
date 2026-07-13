/**
 * `contracts.authorization.test` — asserts every JSON example in the Task 0.3
 * security/broker contract validates against this package's Zod mirrors.
 *
 * Each fenced ```json block is parsed, routed to its schema by shape, and
 * required to validate. The machine-readable `authzContract` SSOT block is
 * skipped here — it is owned + linted by the retained `tools/contract-lint`.
 */
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ZodTypeAny } from "zod";
import {
  AuditEventSchema,
  AuditAnchorSchema,
  AuditIdMapEntrySchema,
  SignerRegistryEntrySchema,
  TombstoneEventSchema,
  AuthorizationChallengeSchema,
  AuthorizationResponseSchema,
} from "../src/index.js";

function findRepoRoot(start: string): string {
  let dir = start;
  while (true) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error("repo root not found");
    dir = parent;
  }
}

const root = findRepoRoot(dirname(fileURLToPath(import.meta.url)));
const CONTRACT_PATH = join(root, "docs/specs/security-broker-contract.md");
const markdown = readFileSync(CONTRACT_PATH, "utf8");

/** Extract fenced ```json blocks (mirrors tools/cli-contract's extractor). */
function extractJsonBlocks(md: string): string[] {
  const fence = /```json\b[^\n]*\n([\s\S]*?)```/g;
  const blocks: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = fence.exec(md)) !== null) blocks.push(m[1]!);
  return blocks;
}

interface Routed {
  label: string;
  schema: ZodTypeAny;
}

/** Route a parsed JSON example to the schema it should validate against. */
function route(obj: Record<string, unknown>): Routed | null {
  // The machine-readable authzContract SSOT — not a message; contract-lint owns it.
  if ("privilegedOps" in obj || "errorCatalog" in obj) return null;

  if (typeof obj.signingPayload === "string" && !("signature" in obj)) {
    return { label: "AuthorizationChallenge", schema: AuthorizationChallengeSchema };
  }
  if ("signature" in obj && "challenge" in obj) {
    return { label: "AuthorizationResponse", schema: AuthorizationResponseSchema };
  }
  if (obj.kind === "erase.tombstone") {
    return { label: "TombstoneEvent", schema: TombstoneEventSchema };
  }
  if (typeof obj.kind === "string" && obj.kind.startsWith("run.")) {
    return { label: "AuditEvent", schema: AuditEventSchema };
  }
  if ("auditHead" in obj && "eventCount" in obj) {
    return { label: "AuditAnchor", schema: AuditAnchorSchema };
  }
  if ("entityKind" in obj && "naturalId" in obj) {
    return { label: "AuditIdMapEntry", schema: AuditIdMapEntrySchema };
  }
  if ("permittedOps" in obj) {
    return { label: "SignerRegistryEntry", schema: SignerRegistryEntrySchema };
  }
  return null;
}

const parsed = extractJsonBlocks(markdown)
  .map((raw) => {
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      return { __unparseable: raw } as unknown;
    }
  })
  .filter((v): v is Record<string, unknown> => typeof v === "object" && v !== null && !("__unparseable" in (v as object)));

describe("security-broker-contract JSON examples validate against the Zod mirrors", () => {
  it("finds the contract doc and at least one JSON example", () => {
    expect(existsSync(CONTRACT_PATH)).toBe(true);
    expect(parsed.length).toBeGreaterThan(0);
  });

  const routed = parsed
    .map((obj) => ({ obj, r: route(obj) }))
    .filter((x): x is { obj: Record<string, unknown>; r: Routed } => x.r !== null);

  it("routes every schema-owned example type at least once", () => {
    const labels = new Set(routed.map((x) => x.r.label));
    for (const expected of [
      "AuthorizationChallenge",
      "AuthorizationResponse",
      "AuditEvent",
      "AuditAnchor",
      "AuditIdMapEntry",
      "SignerRegistryEntry",
      "TombstoneEvent",
    ]) {
      expect(labels).toContain(expected);
    }
  });

  it.each(
    parsed
      .map((obj, idx) => ({ obj, idx, r: route(obj) }))
      .filter((x): x is { obj: Record<string, unknown>; idx: number; r: Routed } => x.r !== null)
      .map((x) => [`block#${x.idx} → ${x.r.label}`, x.obj, x.r.schema] as const),
  )("%s validates", (_label, obj, schema) => {
    const result = schema.safeParse(obj);
    if (!result.success) {
      throw new Error(`${_label} failed:\n${JSON.stringify(result.error.issues, null, 2)}`);
    }
    expect(result.success).toBe(true);
  });
});
