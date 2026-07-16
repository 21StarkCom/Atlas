/**
 * Audit-event, WORM-anchor, signer-registry, and erasure schemas mirroring the
 * security/broker contract §5, §6, §9.2, §12 (Task 0.3). Task 1.1 asserts the
 * doc's JSON examples validate against these mirrors
 * (`contracts.authorization.test`).
 */
import { z } from "zod";
import {
  Ulid,
  OpaqueId,
  CommitHash,
  Rfc3339Ms,
  Ed25519Sig,
  Ed25519PubKey,
  SchemaVersion1,
} from "./primitives.js";

// ---------------------------------------------------------------------------
// §2.5 closed set of git-ref audit event kinds
// ---------------------------------------------------------------------------

/** The closed `refs/audit/runs` event-kind set (plan §2.5). */
export const AUDIT_EVENT_KINDS = [
  "run.started",
  "run.planned",
  "run.integrated",
  "run.refreshed",
  "run.rejected",
  "run.rolled_back",
  "run.failed",
  "run.cancelled",
  "run.readonly",
  "run.projection",
] as const;

export type AuditEventKind = (typeof AUDIT_EVENT_KINDS)[number];

/**
 * Ledger-internal event kinds (contract §11, D6). These are written to the
 * SQLite `audit_events` table only — they are NOT part of the `refs/audit/runs`
 * enumeration and are not chained into the WORM anchor's event count.
 */
export const LEDGER_EVENT_KINDS = ["db.backup", "db.restore", "db.force_unblock", "evidence.retry_enqueued"] as const;

export type LedgerEventKind = (typeof LEDGER_EVENT_KINDS)[number];

// ---------------------------------------------------------------------------
// §5 audit-event payload
// ---------------------------------------------------------------------------

/** A subject referenced by an audit event, always by opaque salted id (§5.1). */
export const AuditSubjectSchema = z.object({
  type: z.enum(["note", "source"]),
  opaqueId: OpaqueId,
  saltVersion: z.number().int().positive(),
});

export type AuditSubject = z.infer<typeof AuditSubjectSchema>;

/**
 * The `refs/audit/runs` event payload (contract §5). `detail` is op-specific
 * (e.g. `{tier, effectiveRisk, authorizationRef}`) and carries allowlisted
 * metadata only — never raw content (plan §2.5); kept as an open record.
 */
export const AuditEventSchema = z.object({
  schemaVersion: SchemaVersion1,
  eventId: Ulid,
  kind: z.enum(AUDIT_EVENT_KINDS),
  seq: z.number().int().nonnegative(),
  occurredAt: Rfc3339Ms,
  runId: Ulid,
  subjects: z.array(AuditSubjectSchema),
  canonicalCommit: CommitHash,
  prevAuditHead: CommitHash,
  detail: z.record(z.string(), z.unknown()),
});

export type AuditEvent = z.infer<typeof AuditEventSchema>;

/**
 * In-memory signed audit event (Task 1.1 interface). Distinct from the on-wire
 * Ed25519 JSON envelope (§8.1) — here the signature is the raw 64-byte value.
 */
export interface SignedAuditEvent {
  readonly event: AuditEvent;
  readonly signature: Uint8Array;
  readonly signerId: string;
}

// ---------------------------------------------------------------------------
// §6 WORM audit-anchor
// ---------------------------------------------------------------------------

/** Append-only WORM audit-anchor record (contract §6). */
export const AuditAnchorSchema = z.object({
  schemaVersion: SchemaVersion1,
  anchoredAt: Rfc3339Ms,
  auditHead: CommitHash,
  eventCount: z.number().int().nonnegative(),
  signerId: z.string().min(1),
});

export type AuditAnchor = z.infer<typeof AuditAnchorSchema>;

// ---------------------------------------------------------------------------
// §5.1 opaque-id ↔ natural-id ledger mapping row
// ---------------------------------------------------------------------------

/** A row of the CLI-owned `audit_id_map` table (contract §5.1). */
export const AuditIdMapEntrySchema = z.object({
  opaqueId: OpaqueId,
  entityKind: z.enum(["note", "source"]),
  naturalId: z.string().min(1),
  saltVersion: z.number().int().positive(),
});

export type AuditIdMapEntry = z.infer<typeof AuditIdMapEntrySchema>;

// ---------------------------------------------------------------------------
// §9.2 signer registry entry
// ---------------------------------------------------------------------------

/** A signer-registry entry (contract §9.2). */
export const SignerRegistryEntrySchema = z.object({
  signerId: z.string().min(1),
  publicKey: Ed25519PubKey,
  permittedOps: z.array(z.string().min(1)),
  status: z.enum(["active", "revoked"]),
  enrolledAt: Rfc3339Ms,
  revokedAt: Rfc3339Ms.optional(),
});

export type SignerRegistryEntry = z.infer<typeof SignerRegistryEntrySchema>;

// ---------------------------------------------------------------------------
// §12.1 signed-tombstone erasure event
// ---------------------------------------------------------------------------

/** Signed-tombstone audit event for ordinary erasure (contract §12.1). */
export const TombstoneEventSchema = z.object({
  schemaVersion: SchemaVersion1,
  kind: z.literal("erase.tombstone"),
  erasedOpaqueId: OpaqueId,
  dataCategory: z.string().min(1),
  authorizationRef: z.string().min(1),
  erasedAt: Rfc3339Ms,
});

export type TombstoneEvent = z.infer<typeof TombstoneEventSchema>;

// ---------------------------------------------------------------------------
// §8.1 Ed25519 signed envelope (on-wire)
// ---------------------------------------------------------------------------

/**
 * The on-wire Ed25519 envelope over any signed object (§8.1). The signature
 * covers the canonical bytes of `payload`; `signature`/`canonicalization` are
 * themselves excluded from the signed bytes (§8.2 rule 5).
 */
export const SignedEnvelopeSchema = z.object({
  payload: z.record(z.string(), z.unknown()),
  signature: Ed25519Sig,
  signerId: z.string().min(1),
  canonicalization: z.string().min(1),
});

export type SignedEnvelope = z.infer<typeof SignedEnvelopeSchema>;
