/**
 * `brain status` (Task 1.9 / #25) — the read-only live-state summary (design D12).
 *
 * Reports: open runs by workflow state, queued/failed job counts, the quarantine
 * count, backup watermark health (watermark seq vs covered seq + healthy flag),
 * and the audit head + WORM-anchor reconciliation. As an executed Tier-0 read it
 * appends exactly one terminal `run.readonly` audit event (via {@link runReadAudit}
 * → `finalizeLedgerWrite`, §2.8) with read-run backup coalescing.
 *
 * The pure summary stays available even when the audit path is down: if the broker
 * is unreachable, the ledger is unavailable, or the backup watermark is BLOCKED,
 * the run degrades to non-persisting and the summary still prints (per the
 * committed `status.schema.json`). Phase-1 tables that do not exist yet (`jobs`
 * → 0002, quarantine → later) are read defensively as zero, so `status` is correct
 * at every migration frontier.
 */
import { BrokerClient } from "@atlas/broker";
import { openReadonlyLedger } from "@atlas/sqlite-store";
import { CliError, EXIT, emitJson } from "../errors/envelope.js";
import { registerCommand, type RunContext } from "../handlers.js";
import { openMigratedStore } from "./store-open.js";
import { ledgerDbPath } from "./backup-config.js";
import { runReadAudit } from "../audit/readonly.js";
import { resolveAnchorProbe, type AuditChainProbe, type AnchorProbe } from "../audit/anchor-check.js";
import { deriveSnapshot, captureConsistent, type SnapshotShape } from "../health/snapshot.js";

interface StatusOutput extends SnapshotShape {
  command: "status";
}

function parseArgs(argv: string[]): void {
  for (const a of argv) throw CliError.usage(`unknown flag/argument for \`status\`: ${a}`);
}

async function status(ctx: RunContext): Promise<number> {
  parseArgs(ctx.argv);

  // Read-only surface: require an ALREADY-migrated ledger — `status` must never
  // create the DB or apply DDL (round-2 finding F5). `openMigratedStore` throws a
  // mapped `db-unavailable` CliError when absent/unmigrated.
  const store = openMigratedStore(ctx);

  try {
    // Open the read-only ledger handle FIRST — BEFORE holding any broker socket — so a
    // missing/unmigrated ledger throws here with no connected client to leak (round-4
    // finding: `openReadonlyLedger` must not run after `connect()` outside a cleanup
    // scope). The broker connect + `ledger.close()`/`probe.close()` then live in one
    // try/finally, so any throw (connect, capture, derive) releases BOTH. Snapshot
    // through this read-only ledger handle — the EXACT shared `ReadonlyLedger`
    // `watch`'s attach uses (no ad-hoc `{db}` wrapper). The migrated `store` is
    // retained only for the audit append below.
    const ledger = openReadonlyLedger(ledgerDbPath(ctx));
    let probe: BrokerClient | null = null;
    let resolved: AnchorProbe = { kind: "unreachable" };
    let snap: SnapshotShape;
    try {
      // Best-effort broker connect (round-3 finding 1; Phase 1 Task 1) — a down broker
      // degrades to `sqlite-only` and never fails `status`.
      try {
        probe = await BrokerClient.connect(ctx.config.config.broker.socket_path);
      } catch {
        probe = null;
      }
      // Route through the SINGLE shared consistency protocol (Phase 1 Task 1) — the
      // SAME `captureConsistent` helper `watch`'s attach uses — instead of a private
      // resolve-then-transaction path. It resolves the async broker probe OUTSIDE any
      // transaction, then runs the synchronous SQLite derivation inside one brief read
      // transaction, re-checking `data_version` first and retrying (bounded) if the
      // ledger moved under the probe. On a stable read it collapses to exactly the
      // pre-refactor one-liner, so `status`'s golden is unchanged. `probeFn` writes the
      // resolved probe into `resolved` so the synchronous `deriveSnapshot` reads a
      // consistent value.
      const result = await captureConsistent(
        ledger,
        async () => (resolved = await resolveAnchorProbe(probe as AuditChainProbe | null, ctx.env)),
        (conn) =>
          deriveSnapshot({
            conn,
            anchorPath: ctx.config.config.git.audit_anchor_path,
            env: ctx.env,
            probe: resolved,
          }),
      );
      snap = result.captured;
    } finally {
      ledger.close();
      probe?.close();
    }
    const out: StatusOutput = { command: "status", ...snap };

    // Best-effort Tier-0 audit — reuse THIS store so we don't open a second handle.
    const audit = await runReadAudit(ctx, "run.readonly", "status", store);
    ctx.log.info("status", { openRuns: Object.keys(out.openRuns).length, audited: audit.recorded, runId: audit.runId });

    if (ctx.output.mode === "json") {
      emitJson(out);
    } else {
      ctx.render(
        `status — watermark seq ${out.backup.watermarkSeq} (covered ${out.backup.coveredSeq}, healthy: ${out.backup.healthy}); ` +
          `audit head seq ${out.audit.headSeq} (anchor ${out.audit.anchorOk ? "ok" : "MISMATCH"}` +
          `${out.audit.anchorSource === "sqlite-only" ? ", UNVERIFIED: broker unavailable, sqlite-only" : ""})`,
      );
    }
    return EXIT.OK;
  } finally {
    store.close();
  }
}

registerCommand("status", status);

export { status };
