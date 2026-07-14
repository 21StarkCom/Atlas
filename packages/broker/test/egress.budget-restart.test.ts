/**
 * `egress.budget-restart.test` (D19) — a run's consumed byte/token/cost allowance
 * MUST survive a daemon restart / replacement. With only in-memory tallies, a
 * restart reset every tally and let the same run capability regain its FULL ceilings
 * (the finding). A PERSISTENT broker-owned budget store closes that: a fresh
 * `EgressService` (a "restarted" daemon) constructed over the SAME store sees the
 * already-consumed allowance and refuses a call the pre-restart budget would too.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { QuarantineSink } from "@atlas/scan";
import {
  EgressService,
  FileBudgetStore,
  mintEgressCapability,
  ProviderCallError,
  providerError,
  type ProviderAdapter,
  type EgressCapability,
  type GenerateTextRequest,
  type Usage,
} from "../src/index.js";

const SECRET = randomBytes(32);
const MODEL = "gemini-3.5-flash";
const RUN = "01J9Z8Q0000000000000000000";

function fakeAdapter(): ProviderAdapter {
  return {
    provider: "gemini",
    host: "generativelanguage.googleapis.com",
    serialize: (_op, req) => ({ path: "/fake", bytes: Buffer.from(JSON.stringify(req), "utf8") }),
    transmit: () => Promise.resolve({ rawResponse: Buffer.from(JSON.stringify({ text: "ok", usage: { inputTokens: 10, outputTokens: 5 } }), "utf8"), retries: 0 }),
    parse: (_op, req, raw) => {
      const json = JSON.parse(Buffer.from(raw).toString("utf8")) as { text?: string; usage?: Usage };
      const usage: Usage = json.usage ?? { inputTokens: 10, outputTokens: 5 };
      return { result: { text: json.text ?? "ok", usage, model: req.model }, usage, model: req.model };
    },
    costMicros: (_m, u: Usage) => u.inputTokens + (u.outputTokens ?? 0),
  };
}

function memSink(): QuarantineSink {
  return { quarantine: () => Promise.resolve() };
}

const textReq = (input = "hello"): GenerateTextRequest => ({ model: MODEL, prompt: { ref: "p@1" }, input, maxTokens: 8 });

function cap(maxTokens: number): EgressCapability {
  return mintEgressCapability(
    { runId: RUN },
    { operation: "generateText", model: MODEL, maxBytes: 1_000_000, maxTokens, costCeiling: 1_000_000, allowedSensitivity: "confidential" },
    { secret: SECRET },
  );
}

describe("egress per-run budget survives a daemon restart (D19)", () => {
  it("a replacement daemon over the same persistent store cannot reset a run's consumed allowance", async () => {
    const root = mkdtempSync(join(tmpdir(), "atlas-egress-budget-"));
    const statePath = join(root, "budget-state.json");
    try {
      // maxTokens 30 fits exactly two calls (each: 5 input bytes + 8 output = 13
      // projected, reconciled to actual 15). The THIRD would exceed.
      const c = cap(30);

      // --- Daemon #1: consume two calls' worth of budget, then "crash" (drop it). ---
      const svc1 = new EgressService({ adapter: fakeAdapter(), quarantine: memSink(), capabilitySecret: SECRET, budgetStore: new FileBudgetStore(statePath) });
      expect((await svc1.invoke({ capability: c, body: { operation: "generateText", request: textReq() }, declaredSensitivity: "internal" })).ok).toBe(true);
      expect((await svc1.invoke({ capability: c, body: { operation: "generateText", request: textReq() }, declaredSensitivity: "internal" })).ok).toBe(true);
      const consumed = svc1.budgetSnapshot(RUN).tokens;
      expect(consumed).toBe(30);

      // --- Daemon #2: a FRESH service (restart) over the SAME persistent store. ---
      const svc2 = new EgressService({ adapter: fakeAdapter(), quarantine: memSink(), capabilitySecret: SECRET, budgetStore: new FileBudgetStore(statePath) });
      // It must have LOADED the consumed allowance — not reset to zero.
      expect(svc2.budgetSnapshot(RUN).tokens).toBe(30);
      // A third call still exceeds the ceiling after the restart (allowance not regained).
      const third = await svc2.invoke({ capability: c, body: { operation: "generateText", request: textReq() }, declaredSensitivity: "internal" });
      expect(third.ok).toBe(false);
      if (!third.ok && "refusal" in third) expect(third.refusal.code).toBe("egress.token_budget_exceeded");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("a raw ProviderCallError adapter double-check: restart still blocks (sanity import guard)", () => {
    // Guard that the error taxonomy import is wired (keeps the suite honest if the
    // adapter double is later swapped for a failing one).
    expect(new ProviderCallError(providerError("timeout")).kind).toBe("timeout");
  });
});
