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
import { verifyEnvelope, parsePublicKeyFlexible, isBadRequestRefusal, type AuditChainStatus } from "@atlas/broker";
import { DB_EVENT_SEQ_BASE, type SqliteDatabase } from "@atlas/sqlite-store";
import { isTransportError } from "../health/socket-errors.js";

/** The read-only broker interface this check consults (structural — a `BrokerClient` satisfies it). */
export interface AuditChainProbe {
  getAuditChainStatus(): Promise<AuditChainStatus>;
}

/**
 * The typed, TOTAL outcome of the async broker chain-status probe — resolved to a
 * plain value BEFORE any SQLite transaction so a synchronous derivation can
 * consume it (console watch SP-1, Phase 1 Task 1). Classified against the ACTUAL
 * broker contract (`packages/broker/src/protocol.ts`):
 *  - `unreachable`     — broker null, a transport/socket error, the RPC timeout,
 *                        or ANY other unexpected throw (fail-safe to degrade).
 *                        `cause` carries the thrown message when it came from a
 *                        FAILED RPC (undefined only when the broker was `null`), so
 *                        the degraded verdict reproduces the pre-refactor reason
 *                        byte-for-byte (behavior/JSON parity — `doctor` exposes it).
 *  - `answered`        — a correlated, well-formed `AuditChainStatus`.
 *  - `protocol-error`  — a `broker.bad_request` refusal (the ONLY fatal outcome,
 *                        matched via `@atlas/broker`'s `isBadRequestRefusal`;
 *                        `detail` = the refusal code, `cause` = the thrown message).
 *                        Only `watch` treats it as fatal; `status`/`doctor` degrade
 *                        it exactly like a failed RPC (same legacy reason string).
 */
export type AnchorProbe =
  | { readonly kind: "unreachable"; readonly cause?: string }
  | { readonly kind: "answered"; readonly status: AuditChainStatus }
  | { readonly kind: "protocol-error"; readonly detail: string; readonly cause: string };

/** The thrown value's message, matching the legacy `e instanceof Error ? e.message : String(e)`. */
function throwMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Default bound (ms) on the chain-status RPC — an ignored/hung frame degrades, never stalls. */
const DEFAULT_PROBE_TIMEOUT_MS = 2000;

/** Resolve the RPC timeout from `ATLAS_WATCH_PROBE_TIMEOUT_MS` (default 2000ms). */
function probeTimeoutMs(env: NodeJS.ProcessEnv): number {
  const raw = env.ATLAS_WATCH_PROBE_TIMEOUT_MS;
  const n = raw !== undefined && raw !== "" ? Number(raw) : Number.NaN;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_PROBE_TIMEOUT_MS;
}

/** Race a promise against a timeout that rejects; the timer never keeps the process alive. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`audit chain-status probe timed out after ${ms}ms`)), ms);
    (timer as { unref?: () => void }).unref?.();
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e as Error);
      },
    );
  });
}

/**
 * Resolve the broker chain-status probe to a typed, TOTAL {@link AnchorProbe} — the
 * ONLY async part of the anchor check. The RPC is wrapped in a bounded timeout so an
 * ignored/uncorrelated frame (which never resolves) cannot hang a caller. Every
 * non-answered, non-`broker.bad_request` outcome degrades to `unreachable`; only a
 * `broker.bad_request` refusal is `protocol-error`. This resolver holds NO
 * transaction and touches NO SQLite — the caller runs {@link deriveAnchorVerdict}
 * synchronously against the resolved value.
 */
export async function resolveAnchorProbe(
  broker: AuditChainProbe | null,
  env: NodeJS.ProcessEnv,
): Promise<AnchorProbe> {
  if (broker === null) return { kind: "unreachable" };
  try {
    const status = await withTimeout(broker.getAuditChainStatus(), probeTimeoutMs(env));
    return { kind: "answered", status };
  } catch (e) {
    // Single-authority socket taxonomy: classify EXPLICITLY through the shared
    // predicates before degrading, so this and the daemon probe cannot drift.
    //  1. The malformed-correlated-result refusal is the sole protocol fault. Its
    //     code is owned by `@atlas/broker` — the CLI never re-declares the literal.
    if (isBadRequestRefusal(e)) return { kind: "protocol-error", detail: e.code, cause: throwMessage(e) };
    //  2. An ordinary transport/socket failure — the shared `isTransportError` set
    //     (the SAME list the daemon probe consumes) — degrades to unreachable. The
    //     thrown message rides on `cause` so the degraded reason stays byte-identical
    //     to the pre-refactor `broker RPC failed: <message>` (doctor exposes it).
    if (isTransportError(e)) return { kind: "unreachable", cause: throwMessage(e) };
    //  3. The RPC timeout (an anchor-probe-specific concern, layered here, not in
    //     the socket set) or ANY other unexpected throw also degrade — the resolver
    //     is total, so `status` never regresses from its catch-all degradation.
    return { kind: "unreachable", cause: throwMessage(e) };
  }
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

/**
 * The live `run.*` event count + latest git head from the ledger. Run-space events
 * are `seq < DB_EVENT_SEQ_BASE` — partitioned by the RANGE, never by event-type
 * prefix: `evidence.retry_enqueued` is ledger-internal (high range, git_head NULL,
 * never on the broker chain), and counting it here raised a FALSE truncation/rewrite
 * alarm after any `brain evidence retry`.
 */
function liveAudit(db: SqliteDatabase): { count: number; head: string } {
  const c = db.prepare(`SELECT COUNT(*) AS n FROM audit_events WHERE seq < ${DB_EVENT_SEQ_BASE}`).get() as { n: number };
  const top = db
    .prepare(`SELECT git_head FROM audit_events WHERE seq < ${DB_EVENT_SEQ_BASE} ORDER BY seq DESC LIMIT 1`)
    .get() as { git_head: string | null } | undefined;
  return { count: c.n, head: top?.git_head ?? "" };
}

/** The git head recorded for the `position`-th (1-indexed) `run.*` event, or null. */
function headAtPosition(db: SqliteDatabase, position: number): string | null {
  if (position <= 0) return null;
  const row = db
    .prepare(`SELECT git_head FROM audit_events WHERE seq < ${DB_EVENT_SEQ_BASE} ORDER BY seq ASC LIMIT 1 OFFSET ?`)
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
  return deriveAnchorVerdict(db, anchorPath, env, await resolveAnchorProbe(broker, env));
}

/**
 * The SYNCHRONOUS verdict: run the existing SQLite cross-check against an
 * already-resolved {@link AnchorProbe} (console watch SP-1, Phase 1 Task 1). Safe
 * to call inside a `better-sqlite3` read transaction (no `await`). Maps BOTH
 * `unreachable` and `protocol-error` to the existing `sqliteOnlyResult` — so
 * `status`/`doctor` degraded behavior is byte-identical to the pre-refactor
 * catch-all. Only `watch` inspects `probe.kind === "protocol-error"` (to go fatal);
 * it never reaches this verdict for that case.
 */
export function deriveAnchorVerdict(
  db: SqliteDatabase,
  anchorPath: string,
  env: NodeJS.ProcessEnv,
  probe: AnchorProbe,
): AnchorCheckResult {
  if (probe.kind === "answered") {
    const git = probe.status;
    const live = liveAudit(db);
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

  // Both `unreachable` and `protocol-error` degrade to the SQLite-only fallback —
  // the git ref could not be verified either way. Reproduce the PRE-REFACTOR reason
  // exactly (behavior/JSON parity — `doctor` surfaces this detail):
  //   - a `null` broker → "broker unavailable" (legacy line);
  //   - ANY failed RPC (transport / timeout / unexpected throw / `broker.bad_request`
  //     refusal) → "broker RPC failed: <thrown message>", preserving the message the
  //     legacy `catch (e)` retained (a bad_request refusal was, pre-refactor, just
  //     another thrown RPC error — its message flows through `cause`).
  const reason =
    probe.kind === "unreachable" && probe.cause === undefined
      ? "git ref unverified (broker unavailable)"
      : `git ref unverified (broker RPC failed: ${probe.cause})`;
  return sqliteOnlyResult(db, anchorPath, env, reason);
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
