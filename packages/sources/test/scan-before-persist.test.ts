/**
 * `scan-before-persist.test` (Task 2.3, D15) — a secret-bearing source yields NO file
 * on any temp/parser/worktree sink before the reject, and a filesystem probe during
 * the run finds no unscanned normalized bytes.
 *
 * The proof is structural + behavioral, run against the REAL compiled worker:
 *   1. `runInSandbox` on a secret-bearing markdown returns the distinct exit-3
 *      `scan-rejection` (no stream, no attestation) — the scan runs INSIDE the sandbox
 *      before anything is released.
 *   2. Driving the same worker via `spawnSandboxed` with a caller-owned (un-cleaned)
 *      worker-private temp shows: the control is `scan-rejection`, the output pipe
 *      received ZERO bytes, and the worker temp is EMPTY — the worker wrote no
 *      normalized bytes to its private sink.
 *   3. A filesystem sweep of the launcher's temp area (before/after + a poll during the
 *      run) never finds the normalized/secret content on disk — the normalized bytes
 *      exist only in memory until scanned, then leave only via the attested pipe.
 *   4. A clean source DOES stream its bytes with a verifying attestation, and those
 *      bytes are likewise never written to any file (streamed, not persisted).
 *
 * The secret is assembled at runtime (never a committed literal) so neither git push
 * protection nor this file contains a matchable credential.
 */
import { describe, expect, it, beforeAll } from "vitest";
import { fileURLToPath } from "node:url";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { probeSandbox, runInSandbox, spawnSandboxed, DEFAULT_SANDBOX_LIMITS } from "../src/index.js";

const REAL_WORKER = fileURLToPath(new URL("../dist/worker/main.js", import.meta.url));

// A live-format AWS access-key id, assembled at runtime (matches the scan ruleset).
const SECRET_TOKEN = "AKIA" + "A".repeat(16);
const SECRET_MARKDOWN = `---\ntitle: leak\n---\n\n# Note\n\nembedded credential: ${SECRET_TOKEN}\n`;

/**
 * A PROVISIONED host MUST support the sandbox — an unsupported report there is a hard
 * failure, not a silent skip that greens CI without exercising D15 (wing round-2 finding).
 * macOS: hosted CI can run Seatbelt ⇒ `CI=true` darwin is strict. Linux: cgroup
 * `resource-caps` needs delegated cgroups stock GitHub-hosted runners lack, so Linux
 * strictness is opt-in via `ATLAS_SANDBOX_REQUIRE=1` (set by CI once cgroup delegation is
 * provisioned — tracked on #5 / PR #72); until then a hosted Linux runner loud-skips.
 */
const REQUIRE_SUPPORTED =
  process.env.ATLAS_SANDBOX_REQUIRE === "1" ||
  (process.env.CI === "true" && platform() === "darwin");

let supported = false;
beforeAll(async () => {
  const rep = await probeSandbox();
  supported = rep.supported;
  if (!supported) {
    const missing = rep.checks.filter((c) => !c.available).map((c) => c.guarantee).join(", ");
    if (REQUIRE_SUPPORTED) {
      throw new Error(
        `[scan-before-persist] provisioned CI host must support the sandbox but does not (${rep.host}: ${missing}). ` +
          `Refusing to green-skip the D15 suite.`,
      );
    }
    console.warn("[scan-before-persist] SKIP: sandbox unsupported on this host");
  }
  if (REQUIRE_SUPPORTED && !existsSync(REAL_WORKER)) {
    throw new Error(`[scan-before-persist] worker dist missing at ${REAL_WORKER} — build @atlas/sources before CI`);
  }
  if (!existsSync(REAL_WORKER)) {
    console.warn(`[scan-before-persist] worker dist missing at ${REAL_WORKER} — run \`pnpm --filter @atlas/sources build\` first`);
  }
});

/** Recursively collect every regular file under `dir` (bounded; ignores errors). */
function walkFiles(dir: string, acc: string[] = [], depth = 0): string[] {
  if (depth > 6) return acc;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return acc;
  }
  for (const name of entries) {
    const p = join(dir, name);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) walkFiles(p, acc, depth + 1);
    else if (st.isFile()) acc.push(p);
  }
  return acc;
}

/**
 * True if any file under the launcher's worker-private temp dirs (`atlas-worker-*`)
 * contains `needle`. Deliberately scoped to the worker-private sinks — NOT the input
 * scratch (`atlas-sbp-*`), since the untrusted INPUT file legitimately holds the
 * secret; the invariant under test is that no NORMALIZED byte reaches a sink.
 */
function anyTempFileContains(needle: string): boolean {
  const roots = readdirSync(tmpdir())
    .filter((n) => n.startsWith("atlas-worker-"))
    .map((n) => join(tmpdir(), n));
  for (const root of roots) {
    for (const f of walkFiles(root)) {
      try {
        if (readFileSync(f, "utf8").includes(needle)) return true;
      } catch {
        /* binary / unreadable — skip */
      }
    }
  }
  return false;
}

describe.skipIf(platform() !== "darwin" && platform() !== "linux")("scan-before-persist (D15)", () => {
  it("a secret-bearing source is rejected exit-3 with no stream", async () => {
    if (!supported) return;
    const base = mkdtempSync(join(tmpdir(), "atlas-sbp-"));
    const input = join(base, "secret.md");
    writeFileSync(input, SECRET_MARKDOWN);
    try {
      const r = await runInSandbox({ inputPath: input, format: "markdown", denyReadRoots: [base] });
      expect(r.ok).toBe(false);
      if (r.ok) throw new Error("unreachable");
      expect(r.kind).toBe("scan-rejection");
      if (r.kind === "scan-rejection") {
        expect(r.code).toBe("secret-detected");
        expect(r.exit).toBe(3);
      }
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("the worker writes NO normalized bytes to its private temp before rejecting", async () => {
    if (!supported || !existsSync(REAL_WORKER)) return;
    const base = mkdtempSync(join(tmpdir(), "atlas-sbp-"));
    const input = join(base, "secret.md");
    const workTmp = join(base, "work"); // caller-owned: spawnSandboxed will NOT clean it
    writeFileSync(input, SECRET_MARKDOWN);
    try {
      const raw = await spawnSandboxed({
        modulePath: REAL_WORKER,
        request: { inputPath: input, format: "markdown", workTmp, maxOutputBytes: DEFAULT_SANDBOX_LIMITS.maxOutputBytes },
        limits: { ...DEFAULT_SANDBOX_LIMITS, wallClockMs: 25_000 },
        denyReadRoots: [base],
      });
      const control = JSON.parse(raw.control) as { kind: string };
      expect(control.kind).toBe("scan-rejection");
      // NO bytes were released on the output pipe.
      expect(raw.stdoutBytes.length).toBe(0);
      // The worker-private temp holds nothing — no normalized bytes touched disk.
      const leftovers = existsSync(workTmp) ? walkFiles(workTmp) : [];
      expect(leftovers, `worker temp must be empty, found: ${leftovers.join(", ")}`).toHaveLength(0);
      // And the normalized/secret content is nowhere on the temp sinks.
      expect(anyTempFileContains(SECRET_TOKEN)).toBe(false);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("a filesystem probe during the run never observes unscanned normalized bytes", async () => {
    if (!supported) return;
    const base = mkdtempSync(join(tmpdir(), "atlas-sbp-"));
    const input = join(base, "secret.md");
    writeFileSync(input, SECRET_MARKDOWN);
    let observedOnDisk = false;
    // Poll the temp sinks while the run is in flight.
    const poll = setInterval(() => {
      if (anyTempFileContains(SECRET_TOKEN)) observedOnDisk = true;
    }, 5);
    try {
      const r = await runInSandbox({ inputPath: input, format: "markdown", denyReadRoots: [base] });
      expect(r.ok).toBe(false);
    } finally {
      clearInterval(poll);
      rmSync(base, { recursive: true, force: true });
    }
    expect(observedOnDisk, "normalized secret bytes must never appear on any temp sink").toBe(false);
  });

  it("a clean source streams its bytes with a verifying attestation (and never persists them)", async () => {
    if (!supported) return;
    const base = mkdtempSync(join(tmpdir(), "atlas-sbp-"));
    const input = join(base, "clean.md");
    const body = "# Clean\n\nNo secrets here, just prose.\n";
    writeFileSync(input, body);
    const marker = "No secrets here, just prose";
    try {
      const r = await runInSandbox({ inputPath: input, format: "markdown", denyReadRoots: [base] });
      expect(r.ok).toBe(true);
      if (!r.ok) throw new Error("unreachable");
      const bytes = new Uint8Array(await new Response(r.stream).arrayBuffer());
      expect(new TextDecoder().decode(bytes)).toBe(body);
      expect(r.attestation.clean).toBe(true);
      expect(r.attestation.scannedBytes).toBe(bytes.length);
      // Even a CLEAN rendition is streamed, not written to a shared sink.
      expect(anyTempFileContains(marker)).toBe(false);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
