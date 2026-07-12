// Fixture-vault harness for Atlas tests.
//
// Every E2E/integration test consumes `withFixtureVault`: it copies one of the
// committed `fixtures/<name>/` directories into a fresh temp dir, initializes a
// real git repo there (so agents never test against a shared fixture in place),
// runs the caller's callback, then tears the temp dir down. Isolation is the
// whole point — mutations inside the callback must never leak back into the
// committed `fixtures/` tree.
//
// Git is driven through `node:child_process` directly (git init/add/commit) — no
// external git library, per the task contract.

import { execFileSync } from "node:child_process";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The committed fixture vaults. Keep in sync with `fixtures/<name>/`. */
export type FixtureName =
  | "empty"
  | "small-valid"
  | "broken-links"
  | "duplicate-ids"
  | "conflicting-claims"
  | "source-heavy"
  | "schema-v1";

/**
 * A minimal git handle over a working directory, backed by `git` invoked via
 * `node:child_process`. Deliberately tiny — enough for fixture setup and for
 * tests to assert repo state without pulling in a git dependency.
 */
export interface SimpleGitHandle {
  /** The working-tree directory this handle operates in. */
  readonly dir: string;
  /** Run an arbitrary git subcommand, returning trimmed stdout. */
  run(args: string[]): string;
  /** Current HEAD commit SHA. */
  head(): string;
  /** `git status --porcelain` output (empty string ⇒ clean working tree). */
  status(): string;
  /** True when the working tree has no uncommitted changes. */
  isClean(): boolean;
}

/** Context handed to a `withFixtureVault` callback. */
export interface FixtureVaultContext {
  /** Absolute path to the temp copy of the fixture vault. */
  readonly vaultDir: string;
  /** Git handle bound to `vaultDir`. */
  readonly git: SimpleGitHandle;
}

// Repo-root-relative `fixtures/` directory. This module lives at
// packages/testing/{src,dist}/fixture.{ts,js}; the repo root is three levels up
// from either the `src` or `dist` directory, so the same relative path resolves
// whether vitest runs the TS source or a built `dist/` artifact.
const FIXTURES_ROOT = resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "../../../fixtures",
);

function git(dir: string): SimpleGitHandle {
  const run = (args: string[]): string =>
    execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
  return {
    dir,
    run,
    head: () => run(["rev-parse", "HEAD"]),
    status: () => run(["status", "--porcelain"]),
    isClean: () => run(["status", "--porcelain"]) === "",
  };
}

/**
 * Copy `fixtures/<name>/` into a fresh temp dir, initialize a git repo with a
 * single commit of the fixture tree, invoke `fn`, then always remove the temp
 * dir. Mutations made inside `fn` cannot affect the committed fixture.
 */
export async function withFixtureVault(
  name: FixtureName,
  fn: (ctx: FixtureVaultContext) => Promise<void>,
): Promise<void> {
  const source = join(FIXTURES_ROOT, name);
  if (!existsSync(source)) {
    throw new Error(`fixture vault not found: ${source}`);
  }

  const vaultDir = await mkdtemp(join(tmpdir(), `atlas-fixture-${name}-`));
  try {
    // Copy the fixture tree into the temp dir (contents, not the dir itself).
    await cp(source, vaultDir, { recursive: true });

    const handle = git(vaultDir);
    // Deterministic, self-contained identity + config so the harness never
    // depends on (or mutates) the caller's global git config.
    handle.run(["init", "-q", "-b", "main"]);
    handle.run(["config", "user.name", "Atlas Fixture"]);
    handle.run(["config", "user.email", "fixtures@atlas.local"]);
    handle.run(["config", "commit.gpgsign", "false"]);
    handle.run(["add", "-A"]);
    handle.run([
      "-c",
      "user.name=Atlas Fixture",
      "-c",
      "user.email=fixtures@atlas.local",
      "commit",
      "-q",
      "-m",
      `fixture: ${name}`,
    ]);

    await fn({ vaultDir, git: handle });
  } finally {
    await rm(vaultDir, { recursive: true, force: true });
  }
}
