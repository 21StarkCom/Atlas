/**
 * `key-resolution.test` — lazy Gemini credential resolution (Phase-2 cutover).
 *
 * Asserts: the `ATLAS_GEMINI_API_KEY` env override beats the Keychain; the
 * blank-Ubuntu path (neither the env var nor a reachable `security` binary) never
 * resolves the key and never throws from the presence probe; and a runtime grep
 * proves no capability mint / `ATLAS_EGRESS_CAPABILITY_KEY` survives on the provider
 * path.
 */
import { afterEach, describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { newRunId } from "@atlas/contracts";
import {
  resolveGeminiApiKey,
  hasGeminiApiKey,
  createInProcessInvoker,
  GEMINI_API_KEY_ENV,
  ProviderCallError,
} from "../src/index.js";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");

let savedEnv: string | undefined;
let savedPath: string | undefined;
let savedTestMode: string | undefined;
let savedFake: string | undefined;
afterEach(() => {
  if (savedEnv === undefined) delete process.env[GEMINI_API_KEY_ENV];
  else process.env[GEMINI_API_KEY_ENV] = savedEnv;
  if (savedPath !== undefined) process.env.PATH = savedPath;
  if (savedTestMode === undefined) delete process.env.ATLAS_TEST_MODE;
  else process.env.ATLAS_TEST_MODE = savedTestMode;
  if (savedFake === undefined) delete process.env.ATLAS_FAKE_PROVIDER;
  else process.env.ATLAS_FAKE_PROVIDER = savedFake;
  savedEnv = undefined;
  savedPath = undefined;
  savedTestMode = undefined;
  savedFake = undefined;
});

/** Blank out PATH so `security` cannot be found — simulates the blank-Ubuntu host. */
function simulateNoSecurityBinary(): void {
  savedPath = process.env.PATH;
  process.env.PATH = "";
}

describe("resolveGeminiApiKey / hasGeminiApiKey", () => {
  it("the env var overrides the Keychain (env wins) and never shells out", () => {
    savedEnv = process.env[GEMINI_API_KEY_ENV];
    process.env[GEMINI_API_KEY_ENV] = "env-key-123";
    // PATH blanked: if the resolver honored the env var it never needs `security`.
    simulateNoSecurityBinary();
    expect(resolveGeminiApiKey()).toBe("env-key-123");
    expect(hasGeminiApiKey()).toBe(true);
  });

  it("blank-Ubuntu path (no env, no `security`) never resolves the key and does not throw from the probe", () => {
    savedEnv = process.env[GEMINI_API_KEY_ENV];
    delete process.env[GEMINI_API_KEY_ENV];
    simulateNoSecurityBinary();
    // The non-throwing probe: false, never throws.
    expect(() => hasGeminiApiKey()).not.toThrow();
    expect(hasGeminiApiKey()).toBe(false);
    // The throwing resolver: an authentication ProviderCallError, never a raw crash.
    const err = (() => {
      try {
        resolveGeminiApiKey();
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(ProviderCallError);
    expect(err).toMatchObject({ kind: "authentication", retryable: false });
  });

  it("an empty env var does not count as present (falls through)", () => {
    savedEnv = process.env[GEMINI_API_KEY_ENV];
    process.env[GEMINI_API_KEY_ENV] = "";
    simulateNoSecurityBinary();
    expect(hasGeminiApiKey()).toBe(false);
  });
});

describe("resolution reads the SUPPLIED env mapping, not process.env (RunContext.env threading)", () => {
  it("resolves from an env mapping whose flag is ABSENT from process.env", () => {
    // The key lives ONLY in the passed mapping (the command's ctx.env). process.env
    // has no key and PATH is blanked, so a leak to process.env / Keychain would fail.
    savedEnv = process.env[GEMINI_API_KEY_ENV];
    delete process.env[GEMINI_API_KEY_ENV];
    simulateNoSecurityBinary();
    const env = { PATH: "", [GEMINI_API_KEY_ENV]: "ctx-env-key" } as NodeJS.ProcessEnv;
    expect(resolveGeminiApiKey(env)).toBe("ctx-env-key");
    expect(hasGeminiApiKey(env)).toBe(true);
    // And the ambient process still has none (the mapping did not leak through it).
    expect(hasGeminiApiKey()).toBe(false);
  });

  it("the gated fake provider activates from the env MAPPING flags, never resolving a real key", async () => {
    // The flags are passed ONLY through the invoker's env mapping — NOT process.env —
    // exactly as a child-process CLI drive does via runCli's env argument. The fake
    // must activate (no Keychain / live Gemini access), so an embed round-trips
    // deterministically WITHOUT any credential.
    savedEnv = process.env[GEMINI_API_KEY_ENV];
    delete process.env[GEMINI_API_KEY_ENV];
    savedTestMode = process.env.ATLAS_TEST_MODE;
    savedFake = process.env.ATLAS_FAKE_PROVIDER;
    delete process.env.ATLAS_TEST_MODE;
    delete process.env.ATLAS_FAKE_PROVIDER;
    simulateNoSecurityBinary();
    const env = { PATH: "", ATLAS_TEST_MODE: "1", ATLAS_FAKE_PROVIDER: "1" } as NodeJS.ProcessEnv;
    const invoker = createInProcessInvoker({ env });
    const out = await invoker({
      runId: newRunId(),
      body: { operation: "embed", request: { model: "gemini-embedding-001", texts: ["a", "b"], dimensions: 4 } },
    });
    expect(out.ok).toBe(true);
    if (out.ok) {
      const result = out.result as { vectors: number[][]; dimensions: number };
      expect(result.vectors).toHaveLength(2);
      expect(result.dimensions).toBe(4);
    }
  });
});

describe("no capability mint / ATLAS_EGRESS_CAPABILITY_KEY on the provider path", () => {
  const PROVIDER_PATH_FILES = [
    "apps/cli/src/commands/query.ts",
    "apps/cli/src/commands/index-ops.ts",
    "apps/cli/src/commands/index-eval.ts",
    "apps/cli/src/commands/enrich.ts",
    "apps/cli/src/commands/maintain.ts",
    "apps/cli/src/retrieval/wiring.ts",
    "apps/cli/src/workflows/model-plan-generator.ts",
  ];

  it("no provider-path file mints a capability or reads the egress capability key", () => {
    for (const rel of PROVIDER_PATH_FILES) {
      const src = readFileSync(join(REPO_ROOT, rel), "utf8");
      expect(src, `${rel} must not mint a capability`).not.toMatch(/mintEgressCapability/);
      expect(src, `${rel} must not read ATLAS_EGRESS_CAPABILITY_KEY`).not.toMatch(/ATLAS_EGRESS_CAPABILITY_KEY/);
    }
  });
});
