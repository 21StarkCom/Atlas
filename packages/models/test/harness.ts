/**
 * Shared egress-stack harness for the `@atlas/models` tests. Wires the REAL
 * cross-store path locally (no OS provisioning): a temp git repo + an in-process
 * `BrokerService` (real F4 audit signing), a file-backed `Store`, an
 * `EgressService` with an injectable fake adapter + in-memory quarantine sink, and
 * a `ModelsClient` whose invoker drives the service in-process. Everything runs
 * without `ATLAS_PROVISIONED`/`ATLAS_LIVE_GEMINI`.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { newRunId } from "@atlas/contracts";
import {
  BrokerService,
  EgressService,
  generateEd25519,
  mintEgressCapability,
  ProviderCallError,
  providerError,
  type AttestationKey,
  type EgressInvokeParams,
  type EgressInvokeResult,
  type ProviderAdapter,
  type Usage,
} from "@atlas/broker";
import type { QuarantineSink } from "@atlas/scan";
import { openStore, type Store, type LedgerBackupConfig, type AuditBroker } from "@atlas/sqlite-store";
import { ModelsClient, type ReceiptSink } from "../src/index.js";

export const CAPABILITY_SECRET = randomBytes(32);
export const MODEL = "gemini-3.5-flash";

/**
 * A deterministic fake adapter (no network) implementing the serialize→transmit→parse
 * trio the egress server drives, so the server scans the EXACT serialized request
 * bytes (the request JSON, carrying the prompt) and the EXACT raw response bytes.
 * `over` swaps any trio method.
 */
export function fakeAdapter(over: Partial<ProviderAdapter> = {}): ProviderAdapter {
  return {
    provider: "gemini",
    host: "generativelanguage.googleapis.com",
    serialize: (_op, req) => ({ path: "/fake", bytes: Buffer.from(JSON.stringify(req), "utf8") }),
    transmit: (_s, signal) =>
      signal?.aborted
        ? Promise.reject(new ProviderCallError(providerError("cancelled", { message: "aborted" })))
        : Promise.resolve({ rawResponse: Buffer.from(JSON.stringify({ text: "ok", usage: { inputTokens: 10, outputTokens: 5 } }), "utf8"), retries: 0 }),
    parse: (op, req, raw) => {
      const json = JSON.parse(Buffer.from(raw).toString("utf8")) as { text?: string; usage?: Usage };
      if (op === "embed") {
        const r = req as { texts: string[]; dimensions: number; model: string };
        const usage: Usage = { inputTokens: 4 };
        return { result: { vectors: r.texts.map(() => [0, 0, 0, 0]), dimensions: r.dimensions, usage, model: r.model }, usage, model: r.model };
      }
      const usage: Usage = json.usage ?? { inputTokens: 10, outputTokens: 5 };
      if (op === "generateObject") return { result: {}, usage, model: req.model };
      return { result: { text: json.text ?? "ok", usage, model: req.model }, usage, model: req.model };
    },
    costMicros: (_m: string, u: Usage) => u.inputTokens + (u.outputTokens ?? 0),
    ...over,
  };
}

/** An in-memory quarantine sink recording captures. */
export function memSink(): QuarantineSink & { captures: { origin: string }[] } {
  const captures: { origin: string }[] = [];
  return { captures, quarantine: (i) => { captures.push({ origin: i.origin }); return Promise.resolve(); } };
}

/** Map an `EgressService` outcome to the `EgressInvokeResult` the client consumes. */
export function serviceInvoker(service: EgressService): (p: EgressInvokeParams, signal?: AbortSignal) => Promise<EgressInvokeResult> {
  return async (params, signal) => {
    const out = await service.invoke(params, signal);
    if (out.ok) return { ok: true, result: out.result, receipt: out.receipt };
    if (out.providerError) return { ok: false, providerError: out.error, receipt: out.receipt };
    return { ok: false, refusal: out.refusal, ...(out.receipt !== undefined ? { receipt: out.receipt } : {}) };
  };
}

export interface EgressHarness {
  readonly service: EgressService;
  readonly brokerService: BrokerService;
  readonly backup: LedgerBackupConfig;
  readonly sink: QuarantineSink & { captures: { origin: string }[] };
  client(receiptSink: ReceiptSink, schemaRegistry?: Readonly<Record<string, import("zod").z.ZodTypeAny>>): ModelsClient;
  openStore(): Store;
  mintCap(runId: string, over?: Partial<Parameters<typeof mintEgressCapability>[1]>): ReturnType<typeof mintEgressCapability>;
  /** Insert the `agent_runs` parent row a `model_calls` FK requires. */
  seedRun(store: Store, runId: string): void;
  auditBroker(): AuditBroker;
  cleanup(): void;
}

const roots: string[] = [];

export async function createEgressHarness(
  adapter: ProviderAdapter = fakeAdapter(),
  schemaRegistry?: Readonly<Record<string, import("zod").z.ZodTypeAny>>,
): Promise<EgressHarness> {
  const root = mkdtempSync(join(tmpdir(), "atlas-egress-"));
  roots.push(root);
  const repoDir = join(root, "repo");
  mkdirSync(repoDir, { recursive: true });
  const dbPath = join(root, "ledger.db");
  const anchorPath = join(root, "anchor", "audit-anchor");

  const git = (args: string[]): void => {
    execFileSync("git", args, {
      cwd: repoDir,
      env: { ...process.env, GIT_AUTHOR_NAME: "A", GIT_AUTHOR_EMAIL: "a@b.c", GIT_COMMITTER_NAME: "A", GIT_COMMITTER_EMAIL: "a@b.c" },
    });
  };
  git(["init", "-q", "-b", "main"]);
  git(["config", "commit.gpgsign", "false"]);
  writeFileSync(join(repoDir, "README.md"), "seed\n");
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "seed"]);

  const attKp = generateEd25519();
  const attestation: AttestationKey = { signerId: "atlas-audit-attestation-v1", privateKey: attKp.privateKey, publicKey: attKp.publicKey };
  const brokerService = new BrokerService({
    repoDir,
    refs: { canonical: "refs/heads/main", audit: "refs/audit/runs", trust: "refs/trust/ledger" },
    anchorPath,
    signers: [{ signerId: attestation.signerId, publicKey: attKp.publicKeyString, permittedOps: [], status: "active", enrolledAt: "2026-07-01T00:00:00.000Z" }],
    attestation,
    testMode: true,
  });
  await brokerService.start();

  const sink = memSink();
  const service = new EgressService({
    adapter,
    quarantine: sink,
    capabilitySecret: CAPABILITY_SECRET,
    ...(schemaRegistry !== undefined ? { schemaRegistry } : {}),
  });
  const backup: LedgerBackupConfig = { dir: join(root, "backups"), key: randomBytes(32), keyId: "test-key-v1", keep: 10 };

  return {
    service,
    brokerService,
    backup,
    sink,
    client(receiptSink: ReceiptSink, clientSchemaRegistry?: Readonly<Record<string, import("zod").z.ZodTypeAny>>): ModelsClient {
      return new ModelsClient(
        serviceInvoker(service),
        receiptSink,
        clientSchemaRegistry !== undefined ? { schemaRegistry: clientSchemaRegistry } : {},
      );
    },
    openStore(): Store {
      const store = openStore({ path: dbPath });
      store.migrate();
      return store;
    },
    mintCap(runId, over = {}) {
      return mintEgressCapability(
        { runId },
        { operation: "generateText", model: MODEL, maxBytes: 100_000, maxTokens: 100_000, costCeiling: 100_000, allowedSensitivity: "restricted", ...over },
        { secret: CAPABILITY_SECRET },
      );
    },
    seedRun(store, runId) {
      store.db
        .prepare(`INSERT OR IGNORE INTO agent_runs (run_id, operation, status, checkpoint_seq, started_at, updated_at) VALUES (?,?,?,?,?,?)`)
        .run(runId, "ingest", "planned", 0, "2026-07-12T09:00:00.000Z", "2026-07-12T09:00:00.000Z");
    },
    auditBroker(): AuditBroker {
      return { signAndAppendAuditEvent: (u) => brokerService.signAndAppendAuditEvent(u) };
    },
    cleanup(): void {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

export function runId(): string {
  return newRunId();
}
