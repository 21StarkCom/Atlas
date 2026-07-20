/**
 * Capability-secret custody resolution (#60 Phase 6, Task 6.2).
 *
 * The launchd sync wrapper must hand the capability-MAC secret to the drain
 * WITHOUT writing it to disk and WITHOUT putting it in the environment, so the
 * shared resolver accepts a command-scoped **fd** form
 * (`ATLAS_EGRESS_CAPABILITY_KEY_FD`) alongside the existing custody **path**
 * form (`ATLAS_EGRESS_CAPABILITY_KEY`). Both the CLI mint resolver
 * (`@atlas/models`) and the egress daemon consume this one function so the two
 * ends can never disagree about the representation.
 *
 * Fail-closed is the whole point: neither form set, an unreadable fd, or an
 * empty secret must THROW — never resolve to a degraded/empty credential.
 */
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, openSync, closeSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveCapabilitySecret,
  __resetCapabilityFdCache,
  CAPABILITY_KEY_ENV,
  CAPABILITY_KEY_FD_ENV,
} from "../src/egress/capability-custody.js";

const dirs: string[] = [];
const fds: number[] = [];

function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), "atlas-custody-"));
  dirs.push(d);
  return d;
}

beforeEach(() => {
  __resetCapabilityFdCache();
});

afterEach(() => {
  __resetCapabilityFdCache();
  for (const fd of fds.splice(0)) {
    try {
      closeSync(fd);
    } catch {
      /* already closed by the resolver */
    }
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("resolveCapabilitySecret — custody-path form (existing)", () => {
  it("reads and trims the secret file named by ATLAS_EGRESS_CAPABILITY_KEY", () => {
    const dir = scratch();
    const path = join(dir, "egress-capability.key");
    writeFileSync(path, "  s3cret-value\n", { mode: 0o640 });
    expect(resolveCapabilitySecret({ [CAPABILITY_KEY_ENV]: path })).toBe("s3cret-value");
  });

  it("fails closed when the named file does not exist", () => {
    const dir = scratch();
    expect(() => resolveCapabilitySecret({ [CAPABILITY_KEY_ENV]: join(dir, "absent.key") })).toThrow(
      /capability mint secret/i,
    );
  });

  it("fails closed on an empty secret file rather than minting with an empty key", () => {
    const dir = scratch();
    const path = join(dir, "empty.key");
    writeFileSync(path, "   \n");
    expect(() => resolveCapabilitySecret({ [CAPABILITY_KEY_ENV]: path })).toThrow(/empty/i);
  });
});

describe("resolveCapabilitySecret — fd form (Task 6.2)", () => {
  it("reads the secret from the file descriptor named by ATLAS_EGRESS_CAPABILITY_KEY_FD", () => {
    const dir = scratch();
    const path = join(dir, "fd-source");
    writeFileSync(path, "fd-delivered-secret\n");
    const fd = openSync(path, "r");
    fds.push(fd);
    expect(resolveCapabilitySecret({ [CAPABILITY_KEY_FD_ENV]: String(fd) })).toBe("fd-delivered-secret");
  });

  it("prefers the command-scoped fd form when BOTH forms are present", () => {
    const dir = scratch();
    const filePath = join(dir, "path-form.key");
    writeFileSync(filePath, "path-form-secret\n");
    const fdPath = join(dir, "fd-form");
    writeFileSync(fdPath, "fd-form-secret\n");
    const fd = openSync(fdPath, "r");
    fds.push(fd);
    expect(
      resolveCapabilitySecret({
        [CAPABILITY_KEY_ENV]: filePath,
        [CAPABILITY_KEY_FD_ENV]: String(fd),
      }),
    ).toBe("fd-form-secret");
  });

  it("fails closed on a non-numeric fd", () => {
    expect(() => resolveCapabilitySecret({ [CAPABILITY_KEY_FD_ENV]: "three" })).toThrow(
      /not a valid file descriptor/i,
    );
  });

  it("fails closed on a closed/never-opened fd rather than falling back to the path form", () => {
    const dir = scratch();
    const filePath = join(dir, "path-form.key");
    writeFileSync(filePath, "path-form-secret\n");
    const fd = openSync(filePath, "r");
    closeSync(fd);
    expect(() =>
      resolveCapabilitySecret({
        [CAPABILITY_KEY_ENV]: filePath,
        [CAPABILITY_KEY_FD_ENV]: String(fd),
      }),
    ).toThrow(/file descriptor/i);
  });

  it("fails closed on an empty fd payload", () => {
    const dir = scratch();
    const path = join(dir, "empty-fd");
    writeFileSync(path, "");
    const fd = openSync(path, "r");
    fds.push(fd);
    expect(() => resolveCapabilitySecret({ [CAPABILITY_KEY_FD_ENV]: String(fd) })).toThrow(/empty/i);
  });
});

/**
 * REGRESSION (review round 1, CRITICAL). The wrapper feeds fd 3 from a PIPE
 * (`exec 3< <(printf …)`), and the mint path resolves the secret afresh on every
 * `mintEgressCapability` — while one `brain jobs run --all` drains many jobs in one
 * process. Un-memoized, the first minting job would drain the pipe and every later
 * one would see EOF → "secret is empty" → a transient `internal` that burns the
 * job's whole attempt budget. Exactly one egress-bearing job per 300 s cycle would
 * ever succeed, which is the failure Phase 6 exists to close.
 */
describe("resolveCapabilitySecret — fd form is memoized (a pipe yields its payload ONCE)", () => {
  it("returns the same secret on repeated resolves over a real single-consumption PIPE", () => {
    const dir = scratch();
    const script = join(dir, "pipe.sh");
    const out = join(dir, "resolved.txt");
    // A real pipe fd, exactly as the wrapper builds it, feeding a real Node process
    // that resolves three times — the multi-mint drain, reproduced end to end.
    const resolverJs = join(dir, "resolve.mjs");
    writeFileSync(
      resolverJs,
      [
        // The BUILT module — this is the artifact the drain actually loads.
        `import { resolveCapabilitySecret } from ${JSON.stringify(fileURLToPath(new URL("../dist/src/egress/capability-custody.js", import.meta.url)))};`,
        `import { writeFileSync } from "node:fs";`,
        `const got = [];`,
        `for (let i = 0; i < 3; i++) { try { got.push(resolveCapabilitySecret()); } catch (e) { got.push("THREW: " + e.message); } }`,
        `writeFileSync(${JSON.stringify(out)}, JSON.stringify(got));`,
      ].join("\n"),
    );
    writeFileSync(
      script,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        `exec 3< <(printf '%s' "pipe-delivered-secret")`,
        `ATLAS_EGRESS_CAPABILITY_KEY_FD=3 ${JSON.stringify(process.execPath)} ${JSON.stringify(resolverJs)}`,
      ].join("\n"),
      { mode: 0o755 },
    );
    execFileSync(script, { stdio: "ignore" });
    expect(JSON.parse(readFileSync(out, "utf8"))).toEqual([
      "pipe-delivered-secret",
      "pipe-delivered-secret",
      "pipe-delivered-secret",
    ]);
  });

  it("does NOT memoize the path form — re-reading is what makes a rotation observable", () => {
    const dir = scratch();
    const path = join(dir, "rotating.key");
    writeFileSync(path, "old-secret\n");
    expect(resolveCapabilitySecret({ [CAPABILITY_KEY_ENV]: path })).toBe("old-secret");
    writeFileSync(path, "new-secret\n");
    expect(resolveCapabilitySecret({ [CAPABILITY_KEY_ENV]: path })).toBe("new-secret");
  });

  it("does not cache a FAILED read — a bad fd stays fail-closed on every attempt", () => {
    const dir = scratch();
    const path = join(dir, "empty-fd");
    writeFileSync(path, "");
    const fd = openSync(path, "r");
    fds.push(fd);
    expect(() => resolveCapabilitySecret({ [CAPABILITY_KEY_FD_ENV]: String(fd) })).toThrow(/empty/i);
    expect(() => resolveCapabilitySecret({ [CAPABILITY_KEY_FD_ENV]: String(fd) })).toThrow(/empty/i);
  });
});

describe("resolveCapabilitySecret — no custody at all", () => {
  it("throws naming BOTH accepted forms when neither is set", () => {
    let message = "";
    try {
      resolveCapabilitySecret({});
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain(CAPABILITY_KEY_ENV);
    expect(message).toContain(CAPABILITY_KEY_FD_ENV);
  });

  it("treats an empty-string env value as unset (fail closed, not a path of '')", () => {
    expect(() =>
      resolveCapabilitySecret({ [CAPABILITY_KEY_ENV]: "", [CAPABILITY_KEY_FD_ENV]: "" }),
    ).toThrow(/neither .* nor .* is set/i);
  });
});

describe("resolveCapabilitySecret — never leaks the secret", () => {
  it("does not include the secret value in the failure message when the fd read fails", () => {
    const dir = scratch();
    const path = join(dir, "secret.key");
    writeFileSync(path, "TOP-SECRET-VALUE\n");
    let message = "";
    try {
      resolveCapabilitySecret({ [CAPABILITY_KEY_FD_ENV]: "9999" });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).not.toContain("TOP-SECRET-VALUE");
  });
});
