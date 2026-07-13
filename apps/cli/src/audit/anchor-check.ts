/**
 * `audit/anchor-check` — the shared audit-head / WORM-anchor verification reused
 * by `doctor` (the `audit-anchor` health check) and `status` (`audit.anchorOk`),
 * so both surfaces apply the SAME anti-truncation + anti-rewrite logic.
 *
 * ## Git ref is authoritative; SQLite is a cross-check (round-3 finding 1)
 * The previous version reconstructed the "live audit chain" from UNPRIVILEGED
 * SQLite rows and verified THAT against the anchor. But truncating or rewriting
 * the protected `refs/audit/runs` ref while leaving SQLite untouched would report
 * healthy, and the broker-append/ledger-commit crash window could produce false
 * alarms. So the authoritative check now goes through the broker's READ-ONLY
 * {@link AuditChainStatus} interface — the broker re-reads the ACTUAL ref + the
 * broker-owned WORM anchor and re-verifies signatures, seq continuity, and the
 * anchored position. SQLite is consulted only as a SEPARATE cross-check that the
 * ledger's audit projection agrees with the git ref (a divergence is reported,
 * not used to prove the ref).
 *
 * When the broker is unreachable the git ref CANNOT be verified, so this reports a
 * degraded `sqlite-only` verdict (the old structural anchor-file check) that is
 * explicitly flagged as unverified-against-the-ref rather than falsely healthy —
 * a truncation of the ref alone can no longer read as ok.
 */
import { existsSync, readFileSync } from "node:fs";
import { AuditAnchorSchema, SignedEnvelopeSchema, type SignedEnvelope } from "@atlas/contracts";
import { verifyEnvelope, parsePublicKeyFlexible, type AuditChainStatus } from "@atlas/broker";
import type { SqliteDatabase } from "@atlas/sqlite-store";

/** The read-only broker interface this check consults (structural — a `BrokerClient` satisfies it). */
export interface AuditChainProbe {
  getAuditChainStatus(): Promise<AuditChainStatus>;
}

/** The outcome of {@link verifyAuditAnchor}. */
export interface AnchorCheckResult {
  /** `false` on any truncation / rewrite / corruption / SQLite-vs-ref divergence. */
  readonly ok: boolean;
  /** The authoritative audit chain length (the git ref count when verified; else the SQLite count). */
  readonly headSeq: number;
  /** The authoritative git head of the audit ref (empty when there are none / unverifiable). */
  readonly head: string;
  /** Whether the git ref itself was verified (`git`) or only the SQLite fallback ran (`sqlite-only`). */
  readonly source: "git" | "sqlite-only";
  /** A human-readable reason (present when `!ok`, or a note when a check is only partial). */
  readonly detail?: string;
}

/** The live `run.*` event count + latest git head from the ledger. */
function liveAudit(db: SqliteDatabase): { count: number; head: string } {
  const c = db.prepare(`SELECT COUNT(*) AS n FROM audit_events WHERE event_type NOT LIKE 'db.%'`).get() as { n: number };
  const top = db
    .prepare(`SELECT git_head FROM audit_events WHERE event_type NOT LIKE 'db.%' ORDER BY seq DESC LIMIT 1`)
    .get() as { git_head: string | null } | undefined;
  return { count: c.n, head: top?.git_head ?? "" };
}

/** The git head recorded for the `position`-th (1-indexed) `run.*` event, or null. */
function headAtPosition(db: SqliteDatabase, position: number): string | null {
  if (position <= 0) return null;
  const row = db
    .prepare(`SELECT git_head FROM audit_events WHERE event_type NOT LIKE 'db.%' ORDER BY seq ASC LIMIT 1 OFFSET ?`)
    .get(position - 1) as { git_head: string | null } | undefined;
  return row?.git_head ?? null;
}

/** Resolve the attestation public key (best-effort) for signature verification. */
function resolveAttestationPub(env: NodeJS.ProcessEnv): string | null {
  const explicit = env.ATLAS_AUDIT_ATTESTATION_PUB;
  const candidates = [
    explicit,
    process.platform === "darwin"
      ? "/usr/local/etc/atlas/keys/shared/audit-attestation.pub"
      : "/etc/atlas/keys/shared/audit-attestation.pub",
  ].filter((p): p is string => typeof p === "string" && p.length > 0);
  for (const p of candidates) {
    if (existsSync(p)) {
      try {
        return readFileSync(p, "utf8").trim();
      } catch {
        /* fall through to the next candidate */
      }
    }
  }
  return null;
}

/**
 * Verify the audit head. The AUTHORITATIVE check is the broker's read-only
 * {@link AuditChainProbe} over the ACTUAL `refs/audit/runs` + WORM anchor
 * (round-3 finding 1); SQLite is a separate cross-check. When `broker` is `null`
 * or its RPC fails, this falls back to the SQLite-only structural anchor check,
 * clearly flagged `sqlite-only` (unverified against the git ref).
 */
export async function verifyAuditAnchor(
  db: SqliteDatabase,
  anchorPath: string,
  env: NodeJS.ProcessEnv,
  broker: AuditChainProbe | null,
): Promise<AnchorCheckResult> {
  const live = liveAudit(db);

  if (broker !== null) {
    let git: AuditChainStatus;
    try {
      git = await broker.getAuditChainStatus();
    } catch (e) {
      // Broker present but the RPC failed — cannot verify the ref; degrade to the
      // SQLite-only fallback rather than falsely reporting healthy.
      return sqliteOnlyResult(db, anchorPath, env, `git ref unverified (broker RPC failed: ${e instanceof Error ? e.message : String(e)})`);
    }
    const base = { headSeq: git.count, head: git.head, source: "git" as const };
    if (!git.ok) {
      return { ok: false, ...base, detail: `git audit chain: ${git.detail ?? "verification failed"}` };
    }
    // SQLite cross-check: the ledger's audit projection must agree with the ref.
    // A divergence is a real ledger/ref inconsistency (reported, not used to prove
    // the ref). A benign in-flight append (SQLite one behind the ref during the
    // step-2→step-3 window) is not expected on a quiescent health surface, so any
    // mismatch is surfaced.
    if (live.count !== git.count || (git.count > 0 && live.head !== git.head)) {
      return {
        ok: false,
        ...base,
        detail:
          `SQLite audit projection diverged from the git audit ref ` +
          `(sqlite count ${live.count} head ${live.head || "(none)"} vs git count ${git.count} head ${git.head || "(none)"})`,
      };
    }
    return { ok: true, ...base };
  }

  return sqliteOnlyResult(db, anchorPath, env, "git ref unverified (broker unavailable)");
}

/**
 * The SQLite-only structural fallback (unverified against the git ref). It still
 * catches a SQLite-vs-anchor regression, but is explicitly flagged `sqlite-only`
 * and its detail carries the `reason` the git ref could not be verified, so the
 * caller can degrade it (never report it as a fully-healthy `git` verdict).
 */
function sqliteOnlyResult(
  db: SqliteDatabase,
  anchorPath: string,
  env: NodeJS.ProcessEnv,
  reason: string,
): AnchorCheckResult {
  const r = sqliteStructuralAnchorCheck(db, anchorPath, env);
  return { ...r, source: "sqlite-only", detail: r.detail ? `${r.detail}; ${reason}` : reason };
}

/** The prior count/position/signature anchor check computed from SQLite rows only. */
function sqliteStructuralAnchorCheck(
  db: SqliteDatabase,
  anchorPath: string,
  env: NodeJS.ProcessEnv,
): { ok: boolean; headSeq: number; head: string; detail?: string } {
  const live = liveAudit(db);
  const base = { headSeq: live.count, head: live.head };

  if (!existsSync(anchorPath)) {
    // Missing anchor is only benign when there is nothing to anchor yet.
    return live.count === 0
      ? { ok: true, ...base }
      : { ok: false, ...base, detail: `no WORM anchor at ${anchorPath} but ${live.count} live audit event(s) exist — anchor missing (cannot prove un-truncated)` };
  }

  // Parse the latest anchor record.
  let env0: SignedEnvelope;
  let anchored: { auditHead: string; eventCount: number };
  try {
    const lines = readFileSync(anchorPath, "utf8").split("\n").map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0) {
      return live.count === 0
        ? { ok: true, ...base }
        : { ok: false, ...base, detail: "WORM anchor file is empty but live audit events exist" };
    }
    env0 = SignedEnvelopeSchema.parse(JSON.parse(lines[lines.length - 1]!));
    anchored = AuditAnchorSchema.parse(env0.payload);
  } catch (e) {
    return { ok: false, ...base, detail: `WORM anchor unreadable/corrupt: ${e instanceof Error ? e.message : String(e)}` };
  }

  // Anti-truncation: the live count must never regress below the anchored count.
  if (live.count < anchored.eventCount) {
    return { ok: false, ...base, detail: `audit ref count ${live.count} regressed below anchored ${anchored.eventCount} — truncation` };
  }

  // Anti-rewrite: the git head at the anchored position must equal the anchored head.
  if (anchored.eventCount > 0) {
    const atPos = headAtPosition(db, anchored.eventCount);
    if (atPos !== anchored.auditHead) {
      return { ok: false, ...base, detail: `git head at anchored position ${anchored.eventCount} is ${atPos ?? "(none)"} ≠ anchored head ${anchored.auditHead} — suffix rewrite` };
    }
  }

  // Best-effort signature verification (only when the attestation pub key exists).
  const pubStr = resolveAttestationPub(env);
  if (pubStr !== null) {
    try {
      if (!verifyEnvelope(env0, parsePublicKeyFlexible(pubStr))) {
        return { ok: false, ...base, detail: "WORM anchor signature is invalid — anchor forgery/corruption" };
      }
    } catch (e) {
      return { ok: false, ...base, detail: `WORM anchor signature could not be verified: ${e instanceof Error ? e.message : String(e)}` };
    }
    return { ok: true, ...base };
  }
  return { ok: true, ...base, detail: "anchor structure verified; signature unverified (attestation public key not resolvable)" };
}
