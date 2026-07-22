/**
 * `phase2-support` — shared harness for the Phase-2 release-blocking exit E2E
 * (`phase2-non-integration.e2e.test`) and the Phase-2 observability run-matrix
 * (`observability-matrix.test`). Task 2.10 / #36.
 *
 * NOT a test file (no `.test.ts` suffix — vitest ignores it). It stands up the REAL
 * production seams both suites drive — never a test-only reimplementation:
 *   - a started {@link BrokerService} exposed over its REAL Unix-socket server
 *     ({@link startBrokerServer}) so every capture/audit interaction goes through the
 *     genuine {@link BrokerClient} IPC transport (protocol framing, dispatch, refusals);
 *   - a {@link ModelsClient} over the in-process invoker ({@link createInProcessInvoker}
 *     with a stubbed adapter), so a
 *     model-transmitting run's requests go through the ACTUAL model boundary (each
 *     transmission emits one receipt → one `model_calls` row) — no fabricated receipts;
 *   - a file-backed workflow store + a git-backed fixture vault + REAL AEAD backup
 *     custody resolved through the production `backupConfig` (D9 test seam).
 *
 * ## The production enforcement layers the exit test drives (round-3 findings)
 * Phase 2's restriction — "the vault cannot be mutated via model output" — is
 * enforced by PRODUCTION code in independent layers, and each is exercised against
 * its real seam here:
 *
 *   1. **Capture wiring** (`ingest/wiring.ts`). {@link captureDeps} assembles the
 *      capture dependencies through the PRODUCTION `buildCaptureDeps` /
 *      `connectBrokerIntegration` (round-3 finding 1 — no duplicated adapter). So the
 *      exit test proves the SAME wiring a real `source add` / `ingest --apply` uses:
 *      the broker signs the `run.integrated` event broker-side via
 *      `signAndIntegrateSourceCapture` (the CLI never holds the attestation key).
 *   2. **Policy (the operation gate).** The production model-output orchestration
 *      boundary (`src/synthesis/model-output.ts` — {@link submitModelDerivedOperation})
 *      consults `assertOperationAllowed(op, 2)` FIRST, fail-closed. The exit test
 *      drives THAT production boundary (round-3 finding 2) and injects its synthetic
 *      gate-bypass mutation there.
 *   3. **Authority (the broker).** Two distinct real seams are proven: the Tier-1
 *      capture path (`signAndIntegrateSourceCapture` — {@link attemptForbiddenCanonicalInstall})
 *      AND the general authorized canonical-advance path (`advanceProtectedRef` —
 *      {@link attemptForbiddenAuthorizedAdvance}, round-3 finding 3). Neither lets a
 *      model-derived artifact reach a canonical install.
 *
 * The MUTATION PROOF injects a synthetic bypass at the production boundary (a no-op
 * `gate`) so a Phase-4-style executor persists a synthesis `ChangePlan` and commits
 * model-derived Markdown DIRECTLY to canonical — which the all-sinks invariant detects.
 */
import { deepStrictEqual } from "node:assert";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import {
  canonicalSerialize,
  newRunId,
  ChangePlanSchema,
  type AuditEvent,
  type ChangePlan,
  type ChangePlanOpName,
  type RiskTier,
  type RunManifest,
  type SignedAuditEvent,
} from "@atlas/contracts";
import {
  BrokerClient,
  BrokerService,
  generateEd25519,
  signRaw,
  startBrokerServer,
  type AttestationKey,
} from "@atlas/broker";
import {
  DurableReceiptSink,
  ModelsClient,
  buildModelCallStatement,
  createInProcessInvoker,
  loadJournaledReceipts,
  modelCallAuditRecord,
  providerError,
  ProviderCallError,
  type ModelCallReceipt,
  type ProviderAdapter,
  type ReceiptSink,
  type Usage,
} from "@atlas/models";
import {
  type LedgerBackupConfig,
  type LedgerStatement,
  type SqliteDatabase,
  type Store,
} from "@atlas/sqlite-store";
import { openRepo, type Repo } from "@atlas/git";
import { PrePersistenceGuard, type QuarantineSink, type SecretFinding } from "@atlas/scan";
import type { RunContext } from "../../src/handlers.js";
import { openWorkflowStore, startRun, type TerminalExtras, type WorkflowDeps } from "../../src/workflows/index.js";
import { buildCaptureDeps, connectBrokerIntegration } from "../../src/ingest/wiring.js";
import { captureSource, type CaptureDeps, type CaptureResult } from "../../src/ingest/capture.js";
import type { SynthesisExecutor } from "../../src/synthesis/model-output.js";
import { assertOperationAllowed, type GatePhase } from "../../src/policies/operation-gate.js";

/** Repo root from THIS file (apps/cli/test/e2e → four levels up). */
export const REPO_ROOT = join(import.meta.dirname, "..", "..", "..", "..");

/** The canonical protected ref the capture fast-forwards (matches production default). */
export const CANONICAL_REF = "refs/heads/main";
/** The audit + trust protected refs (broker-only writable) — snapshotted as sinks. */
export const AUDIT_REF = "refs/audit/runs";
export const TRUST_REF = "refs/trust/ledger";
const ZERO_OID = "0".repeat(40);
const FIXED_NOW = "2026-07-14T00:00:00.000Z";
const CAPABILITY_KEY_ID = "test-key-v1";
const MODEL = "gemini-3.5-flash";

/** A live in-process broker + its REAL socket server + egress stack + store + git vault. */
export interface Phase2Harness {
  readonly root: string;
  readonly vaultDir: string;
  readonly dbPath: string;
  readonly worktreesPath: string;
  readonly anchorPath: string;
  /** The started broker service (owner of the attestation key + protected refs). */
  readonly service: BrokerService;
  /** The REAL broker socket path the CLI seams connect to via {@link BrokerClient}. */
  readonly socketPath: string;
  /** The per-run durable receipt-journal dir (paired with {@link DurableReceiptSink}). */
  readonly receiptsDir: string;
  readonly attestation: AttestationKey;
  readonly backup: LedgerBackupConfig;
  /** Open a fresh (already-migrated) workflow store over the shared DB file. */
  openStore(): Store;
  /** The vault git repo handle. */
  repo(): Repo;
  /** Run a git command inside the vault repo, returning trimmed stdout. */
  git(args: string[]): string;
  /** Run a git command in an arbitrary cwd (e.g. a throwaway worktree). */
  gitIn(cwd: string, args: string[], input?: Buffer): string;
  /** A partial {@link RunContext} the PRODUCTION wiring reads (finding 1). */
  runContext(): RunContext;
  cleanup(): Promise<void>;
}

/** A quarantine sink that records entries (never used on the clean-capture path). */
class RecordingQuarantine implements QuarantineSink {
  readonly entries: { origin: string; findings: readonly SecretFinding[] }[] = [];
  quarantine(input: { bytes: Uint8Array; origin: string; findings: readonly SecretFinding[] }): Promise<void> {
    this.entries.push({ origin: input.origin, findings: input.findings });
    return Promise.resolve();
  }
}

/**
 * A deterministic fake provider adapter (no network) implementing the
 * serialize→transmit→parse trio the in-process invoker drives — so it produces a REAL
 * receipt (mirrors `@atlas/models` test harness). A model-transmitting run drives this
 * through {@link createInProcessInvoker} + {@link ModelsClient}.
 */
function fakeAdapter(): ProviderAdapter {
  return {
    provider: "gemini",
    host: "generativelanguage.googleapis.com",
    serialize: (_op, req) => ({ path: "/fake", bytes: Buffer.from(JSON.stringify(req), "utf8") }),
    transmit: (_s, signal) =>
      signal?.aborted
        ? Promise.reject(new ProviderCallError(providerError("cancelled", { message: "aborted" })))
        : Promise.resolve({
            rawResponse: Buffer.from(JSON.stringify({ text: "ok", usage: { inputTokens: 10, outputTokens: 5 } }), "utf8"),
            retries: 0,
          }),
    parse: (op, req, raw) => {
      const json = JSON.parse(Buffer.from(raw).toString("utf8")) as { text?: string; usage?: Usage };
      const usage: Usage = json.usage ?? { inputTokens: 10, outputTokens: 5 };
      if (op === "generateObject") return { result: {}, usage, model: req.model };
      return { result: { text: json.text ?? "ok", usage, model: req.model }, usage, model: req.model };
    },
    costMicros: (_m: string, u: Usage) => u.inputTokens + (u.outputTokens ?? 0),
  };
}

/**
 * Stand up a Phase-2 harness: a seeded git vault (two canonical Markdown notes + a
 * non-Markdown asset), a started `BrokerService` EXPOSED OVER ITS REAL SOCKET SERVER,
 * a migrated workflow store, and an AEAD backup config whose
 * key is ALSO provisioned in the production custody test seam so `backupConfig(ctx)`
 * resolves the identical key.
 */
export async function makePhase2Harness(): Promise<Phase2Harness> {
  const root = mkdtempSync(join(tmpdir(), "atlas-p2-"));
  const vaultDir = join(root, "vault");
  mkdirSync(vaultDir, { recursive: true });
  const dbPath = join(root, ".atlas", "atlas.db");
  mkdirSync(join(root, ".atlas"), { recursive: true });
  const worktreesPath = join(root, ".atlas", "worktrees");
  mkdirSync(worktreesPath, { recursive: true });
  const backupDir = join(root, ".atlas", "backups");
  const custodyDir = join(root, ".atlas", "custody");
  mkdirSync(custodyDir, { recursive: true });
  const receiptsDir = join(root, ".atlas", "receipts");
  const anchorPath = join(root, "anchor", "audit-anchor");
  const socketPath = join(root, "broker.sock");

  const gitIn = (cwd: string, args: string[], input?: Buffer): string =>
    execFileSync("git", args, {
      cwd,
      ...(input !== undefined ? { input } : {}),
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Aryeh Stark",
        GIT_AUTHOR_EMAIL: "aryeh@21stark.com",
        GIT_COMMITTER_NAME: "Aryeh Stark",
        GIT_COMMITTER_EMAIL: "aryeh@21stark.com",
      },
    }).trim();
  const git = (args: string[]): string => gitIn(vaultDir, args);

  git(["init", "-q", "-b", "main"]);
  git(["config", "commit.gpgsign", "false"]);
  // Two canonical Markdown notes — the "before" content the exit test proves is
  // byte-identical after every model-derived attempt.
  writeFileSync(
    join(vaultDir, "note-alpha.md"),
    ["---", "id: concept-alpha", "title: Alpha", "type: concept", "status: active", "schema_version: 1", "created: 2026-07-14", "updated: 2026-07-14", "---", "# Alpha", "The alpha note. Links [[concept-beta]].", ""].join("\n"),
    "utf8",
  );
  writeFileSync(
    join(vaultDir, "note-beta.md"),
    ["---", "id: concept-beta", "title: Beta", "type: concept", "status: active", "schema_version: 1", "created: 2026-07-14", "updated: 2026-07-14", "---", "# Beta", "The beta note.", ""].join("\n"),
    "utf8",
  );
  // A non-Markdown canonical sink too, so the all-sinks invariant covers more than
  // `*.md` (round-2 finding 3: a forbidden op must not mutate a non-Markdown file).
  mkdirSync(join(vaultDir, "assets"), { recursive: true });
  writeFileSync(join(vaultDir, "assets", "logo.svg"), "<svg><!-- alpha --></svg>\n", "utf8");
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "seed"]);

  const attKp = generateEd25519();
  const attestation: AttestationKey = {
    signerId: "atlas-audit-attestation-v1",
    privateKey: attKp.privateKey,
    publicKey: attKp.publicKey,
  };
  const service = new BrokerService({
    repoDir: vaultDir,
    refs: { canonical: CANONICAL_REF, audit: AUDIT_REF, trust: TRUST_REF },
    anchorPath,
    signers: [
      {
        signerId: attestation.signerId,
        publicKey: attKp.publicKeyString,
        permittedOps: [],
        status: "active",
        enrolledAt: "2026-07-01T00:00:00.000Z",
      },
    ],
    attestation,
    testMode: true,
  });
  await service.start();
  // Expose the broker over its REAL Unix-socket server — the CLI seams connect via
  // BrokerClient, so both suites drive the genuine IPC transport (round-2 finding 1).
  const server = await startBrokerServer(service, socketPath);

  // The AEAD backup key: one key shared by BOTH the harness `backup` config and the
  // PRODUCTION `backupConfig(ctx)` (which reads it from the gated custody test seam),
  // so a capture driven through production wiring and a run driven with `h.backup`
  // write mutually-verifiable backups.
  const backupKey = randomBytes(32);
  writeFileSync(join(custodyDir, `${CAPABILITY_KEY_ID}.key`), Buffer.from(backupKey).toString("base64"), "utf8");
  const backup: LedgerBackupConfig = { dir: backupDir, key: backupKey, keyId: CAPABILITY_KEY_ID, keep: 10 };

  // Migrate the ledger up front (0001 core + 0003 provenance + 0006 idempotency).
  {
    const store = openWorkflowStore({ path: dbPath });
    store.close();
  }

  const runContext = (): RunContext =>
    ({
      cwd: root,
      env: { ...process.env, ATLAS_TEST_MODE: "1", ATLAS_CUSTODY_TEST_DIR: custodyDir } as NodeJS.ProcessEnv,
      config: {
        config: {
          broker: { socket_path: socketPath, egress_socket_path: join(root, "egress.sock") },
          sqlite: { path: dbPath, ledger_backup: { dir: backupDir, key_id: CAPABILITY_KEY_ID, keep: 10 } },
          vault: { path: vaultDir },
          git: { worktrees_path: worktreesPath },
        },
      },
    }) as unknown as RunContext;

  return {
    root,
    vaultDir,
    dbPath,
    worktreesPath,
    anchorPath,
    service,
    socketPath,
    receiptsDir,
    attestation,
    backup,
    openStore: () => openWorkflowStore({ path: dbPath }),
    repo: () => openRepo(vaultDir),
    git,
    gitIn,
    runContext,
    async cleanup(): Promise<void> {
      await server.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

// ── the deterministic capture path (driven through PRODUCTION wiring + broker) ─

/**
 * Assemble {@link CaptureDeps} for a REAL applied Tier-1 capture using the PRODUCTION
 * wiring (`buildCaptureDeps`, round-3 finding 1) — the same assembly a real `source
 * add` / `ingest --apply` uses. The broker-side integration seam
 * (`connectBrokerIntegration`) signs the `run.integrated` event BROKER-side over the
 * socket; the CLI holds no attestation key. The DB path, repo, worktree dir, and AEAD
 * backup all come from the production `RunContext` reader chain.
 */
export function captureDeps(h: Phase2Harness, command = "source add"): CaptureDeps {
  return buildCaptureDeps(h.runContext(), command);
}

/** Perform one deterministic Tier-1 capture of `inputPath` (funnels `captureSource`). */
export function captureViaBroker(h: Phase2Harness, inputPath: string, command = "source add"): Promise<CaptureResult> {
  const guard = new PrePersistenceGuard(new RecordingQuarantine());
  return captureSource({ path: inputPath, guard, deps: captureDeps(h, command) });
}

/**
 * Sanity-check that the PRODUCTION broker-integration seam is reachable + wired for
 * broker-side signing (finding 1): a fresh `connectBrokerIntegration` connects the
 * real socket, exposes the integrator, and closes. Throws if the seam is unavailable.
 */
export async function assertBrokerIntegrationWired(h: Phase2Harness): Promise<void> {
  const integration = await connectBrokerIntegration(h.runContext());
  try {
    if (typeof integration.integrate !== "function") throw new Error("integration seam not wired");
  } finally {
    integration.close();
  }
}

// ── valid model-derived ChangePlan fixtures (parsed through the upstream SSOT) ─

/**
 * One VALID operation payload per `ChangePlanOpName` (round-2 finding 2). These are
 * PARSED through the upstream `ChangePlanSchema` in {@link validChangePlan} — a
 * fabricated `{op}` double-cast is never submitted to the gate. Shapes mirror the
 * contracts fixture matrix (`packages/contracts/test/op-fixtures.mjs`); iterating
 * `CHANGE_PLAN_OPS` in {@link validChangePlan} forces a fixture for every op, so a
 * newly-added op can never silently escape the exit test.
 */
const HASH = "a".repeat(64);
const RENDITION_ID = `sha256:${HASH}:text/markdown:1:1`;
const OP_FIXTURES: Readonly<Record<ChangePlanOpName, Record<string, unknown>>> = {
  CreateNote: { op: "CreateNote", opVersion: 1, noteType: "concept", title: "Model Derived", frontmatter: { status: "active" }, body: "# Model\n\nbody", expectedAbsent: true },
  UpdateSection: { op: "UpdateSection", opVersion: 1, newContent: "replaced body", selector: { path: "Overview", expectedContentHash: `sha256:${HASH}` } },
  AppendSection: { op: "AppendSection", opVersion: 1, content: "appended line", createIfAbsent: true, selector: { path: "Log" } },
  SetFrontmatterField: { op: "SetFrontmatterField", opVersion: 1, field: "status", value: "archived", mode: "update", expectedCurrentValueHash: `sha256:${HASH}` },
  AddAlias: { op: "AddAlias", opVersion: 1, alias: "Alias" },
  SetLink: { op: "SetLink", opVersion: 1, action: "add", linkTarget: "note/2026/other", alias: "Other" },
  CreateRelationship: { op: "CreateRelationship", opVersion: 1, predicate: "depends-on", object: "note/2026/other" },
  CreateClaim: { op: "CreateClaim", opVersion: 1, claimText: "A claim.", claimKey: "claim/x", provenance: [RENDITION_ID] },
  AttachEvidence: { op: "AttachEvidence", opVersion: 1, claimKey: "claim/x", renditionId: RENDITION_ID, locator: "char:0-42", quoteHash: `sha256:${HASH}`, verification: "valid" },
  UpdateEvidenceVerification: { op: "UpdateEvidenceVerification", opVersion: 1, claimKey: "claim/x", lineageId: `sha256:${HASH}`, supersedesEvidenceId: `sha256:${HASH}`, expectedSupersededRenditionId: RENDITION_ID, toVerification: "valid", replacementRenditionId: `sha256:${HASH}:text/markdown:1:2`, locator: "char:0-42", quoteHash: `sha256:${HASH}` },
  ProposeMerge: { op: "ProposeMerge", opVersion: 1, survivor: "note/2026/survivor", sourceNotes: ["note/2026/dup"] },
  ProposeRename: { op: "ProposeRename", opVersion: 1, newTitle: "Renamed", newAliases: ["Old Name"] },
  ProposeArchive: { op: "ProposeArchive", opVersion: 1, reason: "superseded by a newer note" },
  CreateTask: { op: "CreateTask", opVersion: 1, title: "Reserved task", state: "open", due: "2026-08-01" },
  UpdateTaskState: { op: "UpdateTaskState", opVersion: 1, taskId: "note/2026/task", toState: "done" },
};

/**
 * Build a VALID model-derived {@link ChangePlan} for `opName`, PARSED through the
 * upstream `ChangePlanSchema` (envelope + operation + cross-field superRefine) —
 * so the object handed to the operation gate carries every required `opVersion` +
 * operation-specific field, never a fabricated cast (round-2 finding 2). Envelope
 * fields carry the caller's proposed risk + prompt-injection-shaped payload.
 */
export function validChangePlan(
  opName: ChangePlanOpName,
  over: { proposedRisk?: RiskTier; injection?: string } = {},
): ChangePlan {
  const operation = OP_FIXTURES[opName];
  if (operation === undefined) throw new Error(`no valid fixture for op "${opName}" — add one to OP_FIXTURES`);
  const injection = over.injection ?? "model-derived change";
  return ChangePlanSchema.parse({
    target: injection.slice(0, 60) || "concept-alpha",
    rationale: injection,
    sourceIds: [injection],
    retrievedEvidence: [],
    confidence: 0.99,
    proposedRisk: over.proposedRisk ?? "tier-1",
    reversibility: "reversible",
    schemaVersion: 1,
    operation,
  });
}

// ── the synthesis executor a gate-bypass would reach (test-only, past the gate) ─

/**
 * The synthesis executor a Phase-4-style pipeline would run if the production gate
 * did not stop it: persist a synthesis `ChangePlan` (violating "no synthesis
 * ChangePlan created") and commit a model-derived note to canonical (violating
 * "canonical HEAD + Markdown byte-identical"). Bind one with
 * {@link import("../../src/synthesis/model-output.js").submitModelDerivedOperation}
 * as its `execute`. It is reached ONLY past the gate — under the real gate it never
 * runs; under a no-op gate (the synthetic bypass mutation) it writes DIRECTLY,
 * skipping the broker authority too — the "all enforcement removed" scenario the
 * exit invariant must detect.
 */
export function synthesisExecutor(h: Phase2Harness, marker = "synthesis"): (plan: ChangePlan) => void {
  return (plan: ChangePlan): void => {
    const runId = newRunId();
    const op = plan.operation.op;
    const planId = `${marker}-${op}-${runId}`;
    const store = h.openStore();
    try {
      store.ledger.upsertAgentRun({ run_id: runId, operation: "enrich", status: "planned", tier: 3, started_at: FIXED_NOW, updated_at: FIXED_NOW });
      store.db
        .prepare(`INSERT INTO change_plans (plan_id, run_id, tier, confidence, summary, plan_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(planId, runId, 3, plan.confidence, `${op}: ${plan.rationale.slice(0, 40)}`, createHash("sha256").update(planId).digest("hex"), FIXED_NOW);
    } finally {
      store.close();
    }
    const notePath = join(h.vaultDir, `${marker}-derived.md`);
    writeFileSync(notePath, ["---", "id: model-derived", "title: Model Derived", "---", "# Model Derived", plan.rationale, ""].join("\n"), "utf8");
    h.git(["add", `${marker}-derived.md`]);
    h.git(["commit", "-q", "-m", `synthesis ${op}`]);
  };
}

// ── TEST-ONLY synthetic gate-bypass seam (round-2 wing finding 1) ─────────────

/**
 * A GENUINELY TEST-ONLY composition seam for the mutation proof. It runs the production
 * boundary's exact two-step composition —
 * {@link import("../../src/synthesis/model-output.js").submitModelDerivedOperation} =
 * "consult the SSOT gate, then — only if it permits — run the executor" — but exercises
 * the REAL production gate `assertOperationAllowed` (imported from `src/`, NOT a
 * re-declared stub — round-3 wing finding) at a TEST-SUPPLIED phase.
 *
 * The one knob is the phase: at `phase: 4` the REAL gate PERMITS synthesis, so the
 * executor runs and mutates the vault — the "what if the Phase-2 restriction didn't
 * apply" scenario the exit test needs to prove the all-sinks invariant has teeth. Because
 * it calls the same gate function production calls, it cannot pass while production's gate
 * diverges. It stays in `test/`, so the production surface still ships NO caller-supplied
 * gate/phase and NO bypass symbol (round-2 wing finding 1); the export-surface regression
 * pins that. `phase: 2` here would (correctly) throw for a synthesis op, exactly as
 * production does — the mutation proof passes 4.
 */
export async function submitThroughSyntheticGate(
  plan: ChangePlan,
  submission: { readonly execute: SynthesisExecutor; readonly phase: GatePhase },
): Promise<void> {
  // The REAL production gate at the test-supplied phase — NOT a re-declared no-op.
  assertOperationAllowed(plan.operation, submission.phase);
  // Past the gate: the Phase-4-style executor mutates the vault directly.
  await submission.execute(plan);
}

// ── the broker AUTHORITY refuses a model-derived canonical install (two seams) ─

/**
 * A forbidden model-derived canonical-move attempt whose throwaway candidate commit is
 * built UP FRONT — BEFORE the caller takes the baseline snapshot — so the candidate's
 * (dangling) objects appear in BOTH the before AND after object sets. That keeps the
 * refusal window symmetric WITHOUT ever pruning between the operation and the assertion
 * (round-3 wing finding 1): a prune there could delete a dangling object a DEFECTIVE
 * broker actually left behind — hiding the exact mutation the object-store snapshot must
 * detect — and could remove unrelated pre-existing dangling objects. The candidate is
 * established once by {@link prepareForbiddenCanonicalInstall} /
 * {@link prepareForbiddenAuthorizedAdvance}; {@link ForbiddenAttempt.run} then drives the
 * real broker seam, which must REJECT.
 */
export interface ForbiddenAttempt {
  /**
   * The throwaway model-derived candidate commit, ALREADY created (dangling) in the
   * object store. The caller snapshots the baseline AFTER preparing, so this object is
   * captured in the baseline and the refusal leaves the object set unchanged — no prune.
   */
  readonly candidate: string;
  /** Drive the real broker seam; rejects with the broker refusal (never resolves). */
  run(): Promise<never>;
}

/**
 * Prepare a forbidden canonical-install attempt through the REAL Tier-1
 * capture-integration seam (the broker, over its socket) with a model-derived commit
 * that touches a NON-`sources/**` path. The candidate commit is built NOW (before the
 * caller's baseline snapshot); {@link ForbiddenAttempt.run} drives the broker, which
 * refuses (`broker.capture_scope_violation`). Proves the production authority refuses a
 * model-derived canonical install through the CAPTURE path even for a caller that skipped
 * the policy gate. Leaves canonical + the working tree UNTOUCHED.
 */
export function prepareForbiddenCanonicalInstall(h: Phase2Harness): ForbiddenAttempt {
  const base = h.git(["rev-parse", CANONICAL_REF]);
  // Build the throwaway candidate BEFORE the caller snapshots the baseline (round-3 wing
  // finding 1) so its dangling objects are symmetric across before/after — no prune.
  const captureCommit = buildModelDerivedCommit(h, "model-derived-forbidden.md", "# Injected by a model\nforbidden canonical install\n");
  return {
    candidate: captureCommit,
    async run(): Promise<never> {
      const { manifest, runId } = manifestFor(base);
      const event = unsignedIntegratedEvent(runId, captureCommit, base);
      const client = await BrokerClient.connect(h.socketPath);
      try {
        await client.signAndIntegrateSourceCapture({ captureCommit, expectedBase: base, manifest, event });
      } finally {
        client.close();
      }
      // Reaching here means the broker ACCEPTED a model-derived install — the authority
      // is broken. The scope check MUST have thrown above.
      throw new Error(`broker integrated a model-derived (non-sources) commit ${captureCommit} — capture scope not enforced`);
    },
  };
}

/**
 * Prepare a forbidden authorized-advance attempt through the SEPARATE
 * `advanceProtectedRef` seam (round-3 finding 3) with a model-derived commit + a
 * NON-attestation-signed `run.integrated` event. This is the general privileged
 * canonical-move path a Phase-4 integration would use — distinct from the capture RPC's
 * `sources/**` scope check. The candidate commit is built NOW (before the caller's
 * baseline snapshot); {@link ForbiddenAttempt.run} drives the broker, which refuses
 * (`broker.audit_signature_invalid`) BEFORE the ref advances because the CLI cannot forge
 * the audit-attestation signature: a model-derived artifact cannot reach a SUCCESSFUL
 * `advanceProtectedRef`. Canonical stays UNTOUCHED.
 */
export function prepareForbiddenAuthorizedAdvance(h: Phase2Harness): ForbiddenAttempt {
  const base = h.git(["rev-parse", CANONICAL_REF]);
  // A model-derived commit that fast-forwards canonical (so CAS + ancestry PASS and the
  // ONLY thing standing between it and canonical is the attestation signature). Built
  // BEFORE the caller's baseline snapshot (round-3 wing finding 1) — no prune needed.
  const newCommit = buildModelDerivedCommit(h, "model-derived-advance.md", "# Injected by a model\nforbidden authorized advance\n");
  const { manifest, runId } = manifestFor(base);

  // A schema-valid `run.integrated` event bound to the commit — but signed with a
  // THROWAWAY key (the CLI cannot hold the broker's attestation key). The broker
  // re-verifies the signature against its attestation public key and refuses.
  const event: AuditEvent = {
    schemaVersion: 1,
    eventId: newRunId(),
    kind: "run.integrated",
    seq: 0,
    occurredAt: FIXED_NOW,
    runId,
    subjects: [],
    canonicalCommit: newCommit,
    prevAuditHead: ZERO_OID,
    detail: { baseRef: base },
  };
  const forged = generateEd25519();
  const signed: SignedAuditEvent = {
    event,
    // Signed with the throwaway key but claiming the attestation signerId → the
    // broker resolves the REAL attestation public key and the verify fails.
    signature: signRaw(canonicalSerialize(event), forged.privateKey),
    signerId: h.attestation.signerId,
  };

  return {
    candidate: newCommit,
    async run(): Promise<never> {
      const client = await BrokerClient.connect(h.socketPath);
      try {
        await client.advanceProtectedRef({ ref: CANONICAL_REF, expectedOld: base, newCommit, manifest, auditEvent: signed });
      } finally {
        client.close();
      }
      throw new Error(`broker advanced canonical to a model-derived commit ${newCommit} on an unattested event — authority broken`);
    },
  };
}

/**
 * Write a stray DANGLING model-derived git object (loose commit/tree/blob with NO ref)
 * into the vault store and return its commit oid — simulating a DEFECTIVE broker that
 * leaves an object behind. `git rev-list --all` would miss it; the all-objects snapshot
 * ({@link gitObjectSet}) detects it (round-3 wing finding 1 regression).
 */
export function writeDanglingObject(h: Phase2Harness, marker = "defective-broker"): string {
  const blob = h.gitIn(h.vaultDir, ["hash-object", "-w", "--stdin"], Buffer.from(`${marker} dangling object\n`));
  const tree = h.gitIn(h.vaultDir, ["mktree"], Buffer.from(`100644 blob ${blob}\t${marker}.md\n`));
  return h.gitIn(h.vaultDir, ["commit-tree", tree, "-m", `${marker} (dangling, unreachable)`]);
}

/** Build a model-derived (non-`sources/**`) commit in a throwaway worktree; leaves canonical + main tree untouched. */
function buildModelDerivedCommit(h: Phase2Harness, fileName: string, contents: string): string {
  const branch = `forbidden-${newRunId()}`;
  const wtDir = join(h.worktreesPath, branch);
  h.git(["worktree", "add", "-q", "-b", branch, wtDir, CANONICAL_REF]);
  try {
    writeFileSync(join(wtDir, fileName), contents, "utf8");
    h.gitIn(wtDir, ["add", "-A"]);
    h.gitIn(wtDir, ["commit", "-q", "-m", "model-derived (forbidden)"]);
    return h.gitIn(wtDir, ["rev-parse", "HEAD"]);
  } finally {
    h.git(["worktree", "remove", "--force", wtDir]);
    try {
      h.git(["branch", "-D", branch]);
    } catch {
      /* best-effort */
    }
  }
}

/** A schema-valid `integrated` {@link RunManifest} for a fresh run on `base`. */
function manifestFor(base: string): { manifest: RunManifest; runId: string } {
  const runId = newRunId();
  return {
    runId,
    manifest: { schemaVersion: 1, runId, state: "integrated", createdAt: FIXED_NOW, canonicalBaseCommit: base, targets: [] },
  };
}

/** An UNSIGNED `run.integrated` event for the capture RPC (the broker signs it). */
function unsignedIntegratedEvent(runId: string, canonicalCommit: string, base: string): Omit<AuditEvent, "prevAuditHead"> {
  return {
    schemaVersion: 1,
    eventId: newRunId(),
    kind: "run.integrated",
    // Any schema-valid seq: the capture RPC throws the scope violation BEFORE seq is checked.
    seq: 0,
    occurredAt: FIXED_NOW,
    runId,
    subjects: [],
    canonicalCommit,
    detail: { baseRef: base },
  };
}

// ── sink snapshotting (byte-level, across ALL sinks) ─────────────────────────

/** A byte-level snapshot of EVERY sink the Phase-2 restriction must leave untouched. */
export interface SinkSnapshot {
  /** The canonical protected ref head (`refs/heads/main`). */
  readonly canonicalHead: string;
  /** The audit protected ref head (`refs/audit/runs`) — broker-only writable. */
  readonly auditHead: string;
  /** The trust protected ref head (`refs/trust/ledger`) — broker-only writable. */
  readonly trustHead: string;
  /** The WORM audit anchor file bytes (base64) — the append-only attestation chain. */
  readonly anchor: string;
  /** EVERY file in the canonical committed tree → base64 bytes (not just `*.md`). */
  readonly canonicalFiles: Record<string, string>;
  /** EVERY file in the working vault dir (excl. `.git`) → base64 bytes. */
  readonly workingFiles: Record<string, string>;
  /** Every commit on the canonical ref, oldest→newest. */
  readonly commits: readonly string[];
  /**
   * The COMPLETE stored git object set (sorted oids from `git cat-file
   * --batch-all-objects`) — every loose AND packed object, INCLUDING dangling ones
   * (round-2 wing finding 2). A model-derived object written to the store appears here
   * whether it is reachable (installed to canonical / parked on a stray ref) OR left
   * DANGLING (a loose commit/blob with no ref) — `git rev-list --all` would miss the
   * dangling case. The authority-refusal helpers build their throwaway candidate BEFORE
   * the baseline snapshot, so the refusal window stays symmetric with NO prune between
   * the operation and the assertion (round-3 wing finding 1) — a dangling object left by
   * a defective broker is therefore DETECTED.
   */
  readonly gitObjects: readonly string[];
  /**
   * EVERY file under the external persistence roots OUTSIDE the vault (the `.atlas`
   * sink tree — backups, custody, receipts, worktrees, …) → base64 bytes, excluding
   * ONLY the exact active ledger DB + its WAL/SHM/journal companions by full path
   * (captured logically by {@link tables}; their WAL/shm churn is not a logical
   * mutation). A stray model-derived artifact written to an external sink — INCLUDING a
   * `.db`-named one that is not the active DB — is DETECTED here (round-3 wing finding 2).
   */
  readonly externalRoots: Record<string, string>;
  /** EVERY ledger table's full contents (`SELECT *` per user table) — deep-compared. */
  readonly tables: Record<string, readonly Record<string, unknown>[]>;
}

function base64Of(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

/** Read every file (recursively) in `dir`, excluding `.git` → path → base64 bytes. */
function walkFiles(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (cur: string): void => {
    for (const entry of readdirSync(cur)) {
      if (entry === ".git") continue;
      const full = join(cur, entry);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else out[relative(dir, full)] = base64Of(readFileSync(full));
    }
  };
  walk(dir);
  return out;
}

/** Read EVERY file in the canonical committed tree via git plumbing (byte-level). */
function canonicalFiles(h: Phase2Harness): Record<string, string> {
  if (safeRef(h, CANONICAL_REF) === null) return {};
  const out: Record<string, string> = {};
  const listed = h.git(["ls-tree", "-r", "--name-only", CANONICAL_REF]);
  for (const path of listed.split("\n").map((s) => s.trim()).filter(Boolean)) {
    const bytes = execFileSync("git", ["show", `${CANONICAL_REF}:${path}`], { cwd: h.vaultDir });
    out[path] = base64Of(bytes);
  }
  return out;
}

function safeRef(h: Phase2Harness, ref: string): string | null {
  try {
    return h.git(["rev-parse", "--verify", "-q", ref]);
  } catch {
    return null;
  }
}

/** The canonical ref's commit list (oldest→newest), or empty if unborn. */
export function canonicalCommits(h: Phase2Harness): string[] {
  if (safeRef(h, CANONICAL_REF) === null) return [];
  const log = h.git(["log", "--format=%H", "--reverse", CANONICAL_REF]);
  return log.length === 0 ? [] : log.split("\n").map((s) => s.trim());
}

/** The changed paths of `commit` vs its first parent (a capture touches only `sources/`). */
export function commitChangedPaths(h: Phase2Harness, commit: string): string[] {
  const out = h.git(["diff-tree", "--no-commit-id", "--name-only", "-r", commit]);
  return out.length === 0 ? [] : out.split("\n").map((s) => s.trim()).filter(Boolean);
}

/**
 * The COMPLETE stored git object set (sorted, de-duplicated oids) — EVERY loose AND
 * packed object via `git cat-file --batch-all-objects`, NOT just the reachable set
 * (round-2 wing finding 2). `git rev-list --all --objects` deliberately omits DANGLING
 * objects, so a model-derived object written to the store WITHOUT a ref (a stray loose
 * commit/blob) would go undetected. Capturing all-objects closes that hole: a stray
 * model-derived object — reachable via a stray ref OR left dangling — is DETECTED.
 *
 * The authority-refusal helpers ({@link prepareForbiddenCanonicalInstall} /
 * {@link prepareForbiddenAuthorizedAdvance}) build their throwaway CANDIDATE commit
 * BEFORE the caller's baseline snapshot, so the candidate's dangling objects are present
 * in BOTH before/after sets — the refusal window stays symmetric WITHOUT any prune
 * between the operation and the assertion (round-3 wing finding 1). Nothing is ever
 * pruned here, so a dangling object a DEFECTIVE broker leaves behind is DETECTED.
 */
function gitObjectSet(h: Phase2Harness): string[] {
  const out = execFileSync("git", ["cat-file", "--batch-all-objects", "--batch-check=%(objectname)"], { cwd: h.vaultDir, encoding: "utf8" });
  const oids = out
    .split("\n")
    .map((line) => line.trim())
    .filter((oid): oid is string => Boolean(oid));
  return [...new Set(oids)].sort();
}

/**
 * True iff `fullPath` is the EXACT active ledger DB or one of its WAL/SHM/journal
 * companions (round-3 wing finding 2). Only these exact paths are excluded from the
 * external-root snapshot — their WAL/shm churn on open is not a logical mutation, and the
 * DB's logical contents are captured by {@link snapshotTables}. Any OTHER `.db`-named
 * artifact (e.g. a model-derived `.atlas/stray-model.db`) is NOT excluded, so a stray
 * DB-shaped sink write is DETECTED. Matching by full path (not basename suffix) closes
 * the prior hole where every `*.db`/`*.db-wal`/… basename was invisible.
 */
function isActiveDbFile(fullPath: string, dbPath: string): boolean {
  return fullPath === dbPath || [`${dbPath}-wal`, `${dbPath}-shm`, `${dbPath}-journal`].includes(fullPath);
}

/**
 * Every file under the external `.atlas` persistence root (outside the vault) →
 * base64 bytes, excluding ONLY the exact active ledger DB + its WAL/SHM/journal
 * companions by FULL PATH (covered logically by the table snapshot; their WAL/shm churn
 * on open is not a logical mutation). A stray model-derived artifact written to any
 * external sink — INCLUDING a `.db`-named one that is not the active DB — is DETECTED
 * (round-3 wing finding 2).
 */
function externalRootFiles(h: Phase2Harness): Record<string, string> {
  const atlasDir = join(h.root, ".atlas");
  if (!existsSync(atlasDir)) return {};
  const out: Record<string, string> = {};
  const walk = (cur: string): void => {
    for (const entry of readdirSync(cur)) {
      const full = join(cur, entry);
      if (isActiveDbFile(full, h.dbPath)) continue;
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else out[relative(h.root, full)] = base64Of(readFileSync(full));
    }
  };
  walk(atlasDir);
  return out;
}

/** Snapshot every user table's full contents (`SELECT *`), sorted by name for stability. */
function snapshotTables(store: Store): Record<string, Record<string, unknown>[]> {
  const names = (
    store.db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
      .all() as { name: string }[]
  ).map((r) => r.name);
  const out: Record<string, Record<string, unknown>[]> = {};
  for (const name of names) {
    // No writes occur between before/after snapshots, so b-tree order is identical
    // both times; `SELECT *` (no ORDER BY) is a stable, complete per-table capture.
    out[name] = store.db.prepare(`SELECT * FROM "${name}"`).all() as Record<string, unknown>[];
  }
  return out;
}

/** Snapshot every sink the Phase-2 restriction must leave byte-identical. */
export function snapshotSinks(h: Phase2Harness): SinkSnapshot {
  const store = h.openStore();
  try {
    return {
      canonicalHead: safeRef(h, CANONICAL_REF) ?? ZERO_OID,
      auditHead: safeRef(h, AUDIT_REF) ?? ZERO_OID,
      trustHead: safeRef(h, TRUST_REF) ?? ZERO_OID,
      anchor: existsSync(h.anchorPath) ? base64Of(readFileSync(h.anchorPath)) : "",
      canonicalFiles: canonicalFiles(h),
      workingFiles: walkFiles(h.vaultDir),
      commits: canonicalCommits(h),
      gitObjects: gitObjectSet(h),
      externalRoots: externalRootFiles(h),
      tables: snapshotTables(store),
    };
  } finally {
    store.close();
  }
}

/**
 * Assert two sink snapshots are byte-identical across ALL sinks (throws on any
 * difference). Used directly by the green exit test (must not throw) and wrapped
 * in `expect(...).toThrow()` by the MUTATION PROOFS (must throw — proving teeth).
 */
export function assertSinksUnchanged(before: SinkSnapshot, after: SinkSnapshot): void {
  deepStrictEqual(after, before);
}

// ── projection marker (a REAL projection state change, finding 4) ────────────

/** Insert a durable projection marker (a `notes` projection row) — a real state change. */
export function insertProjectionMarker(db: SqliteDatabase, noteId: string): void {
  db.prepare(
    `INSERT INTO notes (note_id, slug, title, type, schema_version, status, file_path, content_hash, created, updated)
     VALUES (?, ?, ?, ?, 1, 'active', ?, ?, ?, ?)`,
  ).run(noteId, noteId, `Projection ${noteId}`, "concept", `${noteId}.md`, `sha256:${HASH}`, FIXED_NOW, FIXED_NOW);
}

/** Whether the durable projection marker row exists. */
export function hasProjectionMarker(store: Store, noteId: string): boolean {
  return store.db.prepare(`SELECT 1 FROM notes WHERE note_id = ?`).get(noteId) !== undefined;
}

// ── a REAL model-transmitting run (observability, finding 5) ──────────────────

/** The outcome of {@link driveModelTransmittingRun}. */
export interface ModelTransmittingRun {
  readonly runId: string;
  readonly receipts: readonly ModelCallReceipt[];
  /** The applicable workflow terminal a model-transmitting Phase-2 run reaches. */
  readonly terminalKind: "run.failed";
}

/**
 * Exercise a REAL Phase-2 model-transmitting workflow run end-to-end (round-3 finding
 * 4/5) — nothing fabricated:
 *   1. `startRun` (`run.started`) → `checkpoint("planned")` (`run.planned`) through the
 *      production workflow engine.
 *   2. Transmit to the model N times through the PRODUCTION model boundary
 *      ({@link ModelsClient} over the in-process invoker), each call binding to the run
 *      and each transmission emitting ONE receipt through a
 *      {@link DurableReceiptSink} (one durable `model_calls` intent per transmission).
 *   3. The run FAILS (Phase 2 cannot integrate a model-derived synthesis): terminate
 *      through the PRODUCTION workflow API `RunHandle.fail()`, folding all N receipts'
 *      `model_calls` rows + their allowlisted audit records into the SINGLE `run.failed`
 *      terminal event + transaction (D6 — one `run.*` per run, N `model_calls` rows,
 *      no per-call event), with `agent_runs` transitioning to `failed@planned`.
 */
export async function driveModelTransmittingRun(h: Phase2Harness, transmissions = 3): Promise<ModelTransmittingRun> {
  const store = h.openStore();
  const client = await BrokerClient.connect(h.socketPath);
  const now = (): string => FIXED_NOW;
  const receiptSink: ReceiptSink = new DurableReceiptSink(h.receiptsDir).sink;
  const models = new ModelsClient(createInProcessInvoker({ adapter: fakeAdapter() }), receiptSink);
  try {
    const base = h.git(["rev-parse", CANONICAL_REF]);
    const deps: WorkflowDeps = { store, broker: client, backup: h.backup, repo: h.repo(), now };
    const handle = await startRun(deps, { operation: "enrich", canonicalCommit: base });
    const runId = handle.runId;
    await handle.checkpoint("planned", {
      planId: `${runId}-plan`,
      tier: 3,
      confidence: 0.5,
      summary: "model-derived synthesis (Phase 2 cannot integrate it)",
      planHash: "0".repeat(64),
      canonicalRef: CANONICAL_REF,
      baseRef: base,
    });

    // ── Transmit N times through the REAL in-process model boundary. Each call binds
    // to this run and emits exactly one receipt via the sink.
    for (let i = 0; i < transmissions; i++) {
      await models.generateText({ model: MODEL, prompt: { ref: `p@${i}` }, input: `transmission ${i}`, maxTokens: 16 }, { runId });
    }

    // Load the DURABLY-journaled receipts (one per transmission) and fold them into
    // the run's SINGLE terminal via the production RunHandle.fail() API.
    const receipts = loadJournaledReceipts(h.receiptsDir, runId);
    const extras: TerminalExtras = {
      ledgerWrite: receipts.map((r) => buildModelCallStatement(r, { now })) as LedgerStatement[],
      detail: { modelCalls: receipts.map(modelCallAuditRecord) },
    };
    await handle.fail("planned", "phase 2 cannot integrate model-derived synthesis", undefined, extras);
    return { runId, receipts, terminalKind: "run.failed" };
  } finally {
    client.close();
    store.close();
  }
}

export { openStore } from "@atlas/sqlite-store";
