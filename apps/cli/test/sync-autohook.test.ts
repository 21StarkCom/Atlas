/**
 * `atlas-sync-wrapper.sh` — the two-step launchd auto-hook, v2 (#334).
 *
 * The wrapper closes the sync→drain gap: `brain sync` reconciles and any
 * enqueued jobs (e.g. reverify) only run when drained. v2 retires the whole
 * egress-capability custody machinery (ADR-0003) — no Keychain fetch, no fd
 * hand-off — so what remains asserted here is the SEQUENCING and exit-code
 * routing of the rendered artifact against a recording `brain` stub.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const WRAPPER_SRC = fileURLToPath(new URL("../../../provisioning/macos/atlas-sync-wrapper.sh", import.meta.url));

let dir: string;

const P = {
  wrapper: (): string => join(dir, "atlas-sync-wrapper.sh"),
  brain: (): string => join(dir, "brain"),
  log: (): string => join(dir, "calls.log"),
  configDir: (): string => join(dir, "conf"),
};

/** Render the shipped wrapper the way provisioning does (placeholders substituted). */
function renderWrapper(): void {
  const src = readFileSync(WRAPPER_SRC, "utf8")
    .replaceAll("@ATLAS_BRAIN_BIN@", P.brain())
    .replaceAll("@ATLAS_CONFIG_DIR@", P.configDir());
  writeFileSync(P.wrapper(), src, { mode: 0o755 });
}

/** A `brain` stub that records argv + cwd, then exits per subcommand. */
function writeBrainStub(opts: { syncRc: number; drainRc?: number }): void {
  const script = `#!/usr/bin/env bash
sub="$1"
{
  echo "ARGV|$*"
  echo "PWD|$sub|$PWD"
} >> ${JSON.stringify(P.log())}
if [ "$sub" = "jobs" ]; then exit ${opts.drainRc ?? 0}; fi
exit ${opts.syncRc}
`;
  writeFileSync(P.brain(), script, { mode: 0o755 });
}

function runWrapper(): { status: number; stderr: string } {
  const res = spawnSync(P.wrapper(), [], { encoding: "utf8", env: { PATH: "/usr/bin:/bin" } });
  return { status: res.status ?? -1, stderr: res.stderr };
}

function invocations(): string[] {
  try {
    return readFileSync(P.log(), "utf8")
      .split("\n")
      .filter((l) => l.startsWith("ARGV|"))
      .map((l) => l.slice("ARGV|".length));
  } catch {
    return [];
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "atlas-autohook-"));
  mkdirSync(P.configDir(), { recursive: true });
  // The wrapper `cd`s here and refuses to run without it — launchd's cwd is `/`.
  writeFileSync(join(P.configDir(), "brain.config.yaml"), "vault:\n  path: .\n");
  renderWrapper();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("atlas-sync-wrapper — step sequencing (v2)", () => {
  it("drains after a CLEAN sync (exit 0), running both steps from the config dir", () => {
    writeBrainStub({ syncRc: 0 });
    const r = runWrapper();
    expect(r.status, r.stderr).toBe(0);
    expect(invocations()).toEqual(["sync --json", "jobs run --all --json"]);
    const pwds = readFileSync(P.log(), "utf8").split("\n").filter((l) => l.startsWith("PWD|"));
    for (const l of pwds) expect(l.endsWith(P.configDir())).toBe(true);
  });

  it("propagates the drain's failure status", () => {
    writeBrainStub({ syncRc: 0, drainRc: 7 });
    const r = runWrapper();
    expect(r.status).toBe(7);
    expect(invocations()).toEqual(["sync --json", "jobs run --all --json"]);
  });

  it.each([1, 2, 4, 5])("exits %i without draining when sync exits %i", (rc) => {
    writeBrainStub({ syncRc: rc });
    const r = runWrapper();
    expect(r.status).toBe(rc);
    expect(invocations()).toEqual(["sync --json"]); // no drain after a true abort
  });
});

describe("atlas-sync-wrapper — provisioning guards", () => {
  it("refuses (exit 2) when the config dir has no brain.config.yaml", () => {
    rmSync(join(P.configDir(), "brain.config.yaml"));
    writeBrainStub({ syncRc: 0 });
    const r = runWrapper();
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/no brain\.config\.yaml/);
    expect(invocations()).toEqual([]);
  });

  it("refuses (exit 2) when the brain binary is missing", () => {
    const r = runWrapper(); // no stub written
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/brain executable not found/);
  });
});
