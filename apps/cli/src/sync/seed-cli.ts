#!/usr/bin/env node
/**
 * `sync/seed-cli` — the bash→TypeScript bridge the adopt-vault bootstrap invokes to
 * seed the `sync_cursors` row (60-A task 1.6). The shell script NEVER reimplements
 * the insert; it shells out here so the single {@link seedSyncCursor} code path (the
 * idempotent `INSERT OR IGNORE`) is the only writer.
 *
 * Usage:
 *   node dist/sync/seed-cli.js --config <dir> --source-id <id> --upstream-ref <ref>
 *
 * `--config` is the directory holding `brain.config.yaml`; the ledger path comes from
 * that config. The store MUST already be migrated (`brain db migrate` runs first in
 * the bootstrap), so this opens without applying DDL. Emits a one-line JSON result and
 * exits 0 on success, 2 on any failure (fail-closed — the bootstrap HALTS on non-zero).
 */
import { isAbsolute, resolve } from "node:path";
import { openStore } from "@atlas/sqlite-store";
import { loadConfig } from "../config/load.js";
import { seedSyncCursor } from "./seed.js";

interface Args {
  config: string;
  sourceId: string;
  upstreamRef: string;
}

function parse(argv: string[]): Args {
  let config: string | undefined;
  let sourceId: string | undefined;
  let upstreamRef: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--config") config = argv[++i];
    else if (a === "--source-id") sourceId = argv[++i];
    else if (a === "--upstream-ref") upstreamRef = argv[++i];
    else throw new Error(`unknown argument: ${a}`);
  }
  if (config === undefined) throw new Error("--config <dir> is required");
  if (sourceId === undefined) throw new Error("--source-id <id> is required");
  if (upstreamRef === undefined) throw new Error("--upstream-ref <ref> is required");
  return { config, sourceId, upstreamRef };
}

function main(): number {
  let args: Args;
  try {
    args = parse(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`seed-cli: ${e instanceof Error ? e.message : String(e)}\n`);
    return 2;
  }

  try {
    const { config } = loadConfig(args.config, process.env);
    const dbPath = isAbsolute(config.sqlite.path)
      ? config.sqlite.path
      : resolve(args.config, config.sqlite.path);
    const store = openStore({ path: dbPath });
    try {
      const res = seedSyncCursor(store, { sourceId: args.sourceId, upstreamRef: args.upstreamRef });
      process.stdout.write(JSON.stringify({ command: "sync seed", ...res }) + "\n");
      return 0;
    } finally {
      store.close();
    }
  } catch (e) {
    process.stderr.write(`seed-cli: ${e instanceof Error ? e.message : String(e)}\n`);
    return 2;
  }
}

process.exit(main());
