/**
 * `egress.bypass.test` (D17) + `model_calls` persistence (D6/D18).
 *
 * The OS-layer bypass check — a direct (non-launcher) outbound from the agent UID
 * fails at the OS layer — requires host provisioning and is skipped without
 * `ATLAS_PROVISIONED` (expected locally). The always-run half exercises the
 * in-broker defence end-to-end: a secret planted in a prompt is blocked in-broker,
 * quarantined, AND a `model_calls` row is written via `finalizeLedgerWrite` for the
 * REFUSED transmission — idempotent per `(runId, requestHash)`, with NO per-call
 * `run.*` event (D6: one terminal event per run, many `model_calls`).
 */
import { afterEach, describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { EgressRefusal, buildModelCallStatement, persistModelCalls, modelCallId, modelCallAuditRecord, DurableReceiptSink, finalizeRunModelCalls, loadJournaledReceipts } from "../src/index.js";
import type { ModelCallReceipt } from "../src/index.js";
import { createEgressHarness, runId, MODEL, type EgressHarness } from "./harness.js";

let h: EgressHarness;
afterEach(() => h?.cleanup());

const PLANTED = "AKIAIOSFODNN7EXAMPLE aws_secret_access_key=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";

function readonlyEvent(rid: string): import("@atlas/sqlite-store").RunContext["event"] {
  return {
    schemaVersion: 1,
    eventId: runId(),
    kind: "run.readonly",
    occurredAt: "2026-07-12T09:14:22.581Z",
    runId: rid,
    subjects: [],
    canonicalCommit: "0".repeat(40),
    detail: {},
  };
}

describe("egress.bypass — in-broker secret block + quarantine + model_calls row", () => {
  it("blocks a secret planted in the prompt in-broker and quarantines it", async () => {
    h = await createEgressHarness();
    const rid = runId();
    const receipts: ModelCallReceipt[] = [];
    const client = h.client((r) => { receipts.push(r); });
    const err = await client
      .generateText({ model: MODEL, prompt: { ref: "p@1" }, input: PLANTED, maxTokens: 8 }, h.mintCap(rid))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EgressRefusal);
    expect((err as EgressRefusal).code).toBe("egress.secret_detected");
    expect(h.sink.captures.length).toBe(1);
    // The refusal STILL produced a receipt (the model_calls precursor).
    expect(receipts).toHaveLength(1);
    expect(receipts[0]?.outcome).toBe("refused");
  });

  it("writes a model_calls row for the REFUSED transmission via finalizeLedgerWrite", async () => {
    h = await createEgressHarness();
    const rid = runId();
    const receipts: ModelCallReceipt[] = [];
    const client = h.client((r) => { receipts.push(r); });
    await client.generateText({ model: MODEL, prompt: { ref: "p@1" }, input: PLANTED, maxTokens: 8 }, h.mintCap(rid)).catch(() => {});

    const store = h.openStore();
    try {
      h.seedRun(store, rid);
      await persistModelCalls(store, h.auditBroker(), { receipts, event: readonlyEvent(rid), backup: h.backup });
      const rows = store.db.prepare("SELECT * FROM model_calls WHERE run_id = ?").all(rid) as { call_id: string; cost_micros: number }[];
      expect(rows).toHaveLength(1);
      expect(rows[0]?.call_id).toBe(modelCallId(rid, receipts[0]!.requestHash));
      expect(rows[0]?.cost_micros).toBe(0); // pre-flight refusal consumed nothing
    } finally {
      store.close();
    }
  });

  it("writes a model_calls row for a SUCCESSFUL transmission and is idempotent per (runId, requestHash)", async () => {
    h = await createEgressHarness();
    const rid = runId();
    const receipts: ModelCallReceipt[] = [];
    const client = h.client((r) => { receipts.push(r); });
    await client.generateText({ model: MODEL, prompt: { ref: "p@1" }, input: "clean", maxTokens: 8 }, h.mintCap(rid));

    const store = h.openStore();
    try {
      h.seedRun(store, rid);
      await persistModelCalls(store, h.auditBroker(), { receipts, event: readonlyEvent(rid), backup: h.backup });
      // Re-drive the SAME receipt — idempotent on the derived call_id.
      const stmt = buildModelCallStatement(receipts[0]!);
      store.db.prepare(stmt.sql).run(...(stmt.params as unknown[]));
      const rows = store.db.prepare("SELECT * FROM model_calls WHERE run_id = ?").all(rid) as { cost_micros: number }[];
      expect(rows).toHaveLength(1); // exactly once despite the replay
      expect(rows[0]?.cost_micros).toBe(15);
    } finally {
      store.close();
    }
  });

  it("DURABLY journals each receipt and folds the journal into ONE finalize even after a 'crash' before finalize", async () => {
    h = await createEgressHarness();
    const journalDir = mkdtempSync(join(tmpdir(), "atlas-receipts-"));
    try {
      const rid = runId();
      // The client's sink is the DURABLE journal (not an in-memory array): each
      // transmission's receipt is fsync'd to disk BEFORE the call returns.
      const durable = new DurableReceiptSink(journalDir);
      const client = h.client(durable.sink);
      await client.generateText({ model: MODEL, prompt: { ref: "p@1" }, input: "one", maxTokens: 8 }, h.mintCap(rid));
      await client.generateText({ model: MODEL, prompt: { ref: "p@1" }, input: "two", maxTokens: 8 }, h.mintCap(rid));

      // Simulate a CRASH before finalize: nothing in memory, only the durable journal.
      const journaled = loadJournaledReceipts(journalDir, rid);
      expect(journaled).toHaveLength(2);
      // The FULL allowlisted audit fields are retained (folded into the run's single
      // terminal signed audit event via modelCallAuditRecord — not dropped): request/
      // response hashes, destination, latency, retries, outcome, tokens, cost.
      const rec = modelCallAuditRecord(journaled[0]!);
      expect(rec.requestHash).toMatch(/^sha256:/);
      expect(rec.responseHash).toMatch(/^sha256:/);
      expect(rec.destination).toContain("googleapis");
      expect(rec.outcome).toBe("success");
      expect(typeof rec.latencyMs).toBe("number");
      expect(typeof rec.retries).toBe("number");

      const store = h.openStore();
      try {
        h.seedRun(store, rid);
        // Recovery finalize reads the journal (no in-memory receipts) → writes rows.
        await finalizeRunModelCalls(store, h.auditBroker(), { journalDir, event: readonlyEvent(rid), backup: h.backup });
        const calls = store.db.prepare("SELECT COUNT(*) c FROM model_calls WHERE run_id = ?").get(rid) as { c: number };
        const events = store.db.prepare("SELECT COUNT(*) c FROM audit_events WHERE run_id = ?").get(rid) as { c: number };
        expect(calls.c).toBe(2); // both receipts survived the "crash" and persisted
        expect(events.c).toBe(1); // ONE terminal audit event (D6), not one per call
        // The journal is cleared after a successful finalize (a re-drive is a no-op).
        expect(loadJournaledReceipts(journalDir, rid)).toHaveLength(0);
      } finally {
        store.close();
      }
    } finally {
      rmSync(journalDir, { recursive: true, force: true });
    }
  });

  it("attaches MANY model_calls to ONE terminal run event (D6: no run.* per call)", async () => {
    h = await createEgressHarness();
    const rid = runId();
    const receipts: ModelCallReceipt[] = [];
    const client = h.client((r) => { receipts.push(r); });
    const cap = h.mintCap(rid);
    // Three transmissions in the same run, distinct inputs → distinct requestHashes.
    await client.generateText({ model: MODEL, prompt: { ref: "p@1" }, input: "one", maxTokens: 8 }, cap);
    await client.generateText({ model: MODEL, prompt: { ref: "p@1" }, input: "two", maxTokens: 8 }, cap);
    await client.generateText({ model: MODEL, prompt: { ref: "p@1" }, input: "three", maxTokens: 8 }, cap);
    expect(receipts).toHaveLength(3);

    const store = h.openStore();
    try {
      h.seedRun(store, rid);
      await persistModelCalls(store, h.auditBroker(), { receipts, event: readonlyEvent(rid), backup: h.backup });
      const calls = store.db.prepare("SELECT COUNT(*) c FROM model_calls WHERE run_id = ?").get(rid) as { c: number };
      const events = store.db.prepare("SELECT COUNT(*) c FROM audit_events WHERE run_id = ?").get(rid) as { c: number };
      expect(calls.c).toBe(3); // three model_calls
      expect(events.c).toBe(1); // exactly ONE terminal audit event for the run
    } finally {
      store.close();
    }
  });
});

/**
 * D17 — the agent context has NO outbound network.
 *
 * The prior version of this suite ran `curl` as the VITEST RUNNER process (which has a
 * normal network) and asserted it failed. That proved nothing (and was red). It also
 * masked a REAL hole: `provisioning/profiles/agent.sb` carried
 * `(allow process-exec (with no-sandbox))`, and in SBPL that modifier runs the exec'd
 * child with NO profile at all — so every subprocess escaped the sandbox and
 * `(deny network*)` was a no-op. Verified by this test: with a POSITIVE CONTROL proving
 * the probe can reach the network unsandboxed, and the SAME probe under `agent.sb`
 * proving it cannot.
 *
 * This exercises the Seatbelt layer, which is testable unprivileged. The second D17
 * layer — the per-UID pf anchor (`provisioning/macos/agent-pf.conf`, loaded by
 * `sudo provisioning/macos/load-agent-pf.sh`) — is kernel state requiring root, so it is
 * an operator step and is asserted by the provisioning suite, not here.
 */
const AGENT_SB = fileURLToPath(new URL("../../../provisioning/profiles/agent.sb", import.meta.url));
const PROBE_URL = "https://generativelanguage.googleapis.com/";

/** Run `curl PROBE_URL` under the agent Seatbelt profile; true when it REACHED the network. */
function curlReachesNetworkUnderAgentProfile(): boolean {
  const vault = mkdtempSync(join(tmpdir(), "atlas-d17-vault-"));
  const work = mkdtempSync(join(tmpdir(), "atlas-d17-work-"));
  try {
    execFileSync(
      "sandbox-exec",
      [
        "-f", AGENT_SB,
        "-D", `VAULT_DIR=${vault}`,
        "-D", `WORK_TMP=${work}`,
        "-D", `HOME_KEYCHAIN=${process.env.HOME ?? "/Users/nobody"}/Library/Keychains`,
        "/usr/bin/curl", "-sS", "--max-time", "8", "-o", "/dev/null", PROBE_URL,
      ],
      { stdio: "ignore" },
    );
    return true; // curl exited 0 → it reached the network → D17 VIOLATED
  } catch {
    return false; // killed/denied by the sandbox → network denied
  } finally {
    rmSync(vault, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  }
}

describe.skipIf(platform() !== "darwin")("egress.bypass — OS-layer network denial (D17, Seatbelt layer)", () => {
  it("POSITIVE CONTROL: the probe DOES reach the network when unsandboxed (else the test proves nothing)", () => {
    let reached = false;
    try {
      execFileSync("/usr/bin/curl", ["-sS", "--max-time", "8", "-o", "/dev/null", PROBE_URL], { stdio: "ignore" });
      reached = true;
    } catch {
      reached = false;
    }
    // If this host has no egress at all, the negative test below would pass vacuously —
    // so skip loudly rather than claim a denial we did not demonstrate.
    if (!reached) {
      console.warn("[D17] SKIP: this host cannot reach the probe URL unsandboxed — the denial test would be vacuous");
      return;
    }
    expect(reached).toBe(true);
  });

  it("a direct outbound under the agent Seatbelt profile is DENIED (no `(with no-sandbox)` escape)", () => {
    // Guard: only meaningful when the unsandboxed control can actually reach the network.
    let controlReached = false;
    try {
      execFileSync("/usr/bin/curl", ["-sS", "--max-time", "8", "-o", "/dev/null", PROBE_URL], { stdio: "ignore" });
      controlReached = true;
    } catch {
      controlReached = false;
    }
    if (!controlReached) {
      console.warn("[D17] SKIP: no unsandboxed egress on this host — cannot prove the denial");
      return;
    }
    expect(curlReachesNetworkUnderAgentProfile()).toBe(false);
  });
});
