/**
 * `brain graduation scan --source <live> --copy <dest>` (Task 5.1 / #57) — the fail-closed
 * pre-graduation secret scan. Clones the LIVE legacy vault into a disposable copy (never mutating
 * the source), then scans BOTH the working tree and the full git history through the same detection
 * engine the ingest boundary uses. Every hit is AEAD-quarantined (`detected-credential`) and named
 * (no raw secret bytes). A non-empty finding set BLOCKS graduation (exit 3) and the verdict is
 * persisted as the scan-state gate the flag-free `graduation audit`/`migrate` commands check.
 * Output ⇒ `graduation-scan.schema.json`.
 */
import { execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { CliError, EXIT, emitJson } from "../errors/envelope.js";
import { registerCommand, type RunContext } from "../handlers.js";
import { quarantineStoreFromContext } from "../quarantine/config.js";
import { scanVaultCopy, scanGitHistory } from "../graduation/scan.js";
import { scanStatePath, writeScanState } from "../graduation/state.js";
import { ledgerDbPath, resolvePath } from "./backup-config.js";
import { readFileSync } from "node:fs";

interface Parsed { source: string; copy: string }
function parseArgs(argv: string[]): Parsed {
  let source: string | undefined, copy: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--source") source = argv[++i];
    else if (a.startsWith("--source=")) source = a.slice("--source=".length);
    else if (a === "--copy") copy = argv[++i];
    else if (a.startsWith("--copy=")) copy = a.slice("--copy=".length);
    else throw CliError.usage(`\`graduation scan\`: unknown flag/argument ${a}`);
  }
  if (source === undefined) throw CliError.usage(`\`graduation scan\`: --source <path> is required`);
  if (copy === undefined) throw CliError.usage(`\`graduation scan\`: --copy <path> is required`);
  return { source, copy };
}

interface Finding { opaqueId: string; path: string; location: "working-tree" | "history"; rule: string; commit?: string }

async function graduationScan(ctx: RunContext): Promise<number> {
  const p = parseArgs(ctx.argv);
  const source = resolvePath(ctx, p.source);
  const copy = resolvePath(ctx, p.copy);

  if (!existsSync(source)) {
    throw new CliError({ code: "source-not-found", message: `the live source vault does not exist at ${source}`, hint: "Pass --source pointing at the legacy vault.", exitCode: EXIT.CONFIG });
  }
  if (resolvePath(ctx, source) === copy) {
    throw new CliError({ code: "config-invalid", message: "--source and --copy must differ (the scan clones source into a DISPOSABLE copy)", exitCode: EXIT.CONFIG });
  }

  return ctx.withLock("vault-maintenance", async () => {
    // Create the disposable copy: a full clone (incl. history), NEVER touching the source.
    rmSync(copy, { recursive: true, force: true });
    try {
      execFileSync("git", ["clone", "--no-hardlinks", "--quiet", source, copy], { stdio: ["ignore", "ignore", "pipe"] });
    } catch (e) {
      throw new CliError({ code: "config-invalid", message: `could not clone --source into --copy: ${e instanceof Error ? e.message : String(e)}`, hint: "Ensure --source is a git repository and --copy is writable.", exitCode: EXIT.CONFIG, cause: e });
    }
    const copyHead = execFileSync("git", ["-C", copy, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

    // Scan the working tree AND the full history.
    const wt = scanVaultCopy(copy);
    const hist = scanGitHistory(copy);

    // Quarantine each offending file once (AEAD) and surface one finding per matched rule. The
    // quarantine store (AEAD custody) is resolved LAZILY — a clean copy never needs custody.
    const findings: Finding[] = [];
    if (wt.hits.length + hist.hits.length > 0) {
      const q = quarantineStoreFromContext(ctx);
      const grad = (origin: string) => ({ origin, category: "detected-credential", detectedAt: "graduation-scan" });
      for (const hit of wt.hits) {
        const opaqueId = q.quarantineItem({ bytes: readFileSync(resolvePath(ctx, `${copy}/${hit.file}`)), origin: hit.file, findings: hit.findings, graduation: grad(hit.file) });
        for (const f of hit.findings) findings.push({ opaqueId, path: hit.file, location: "working-tree", rule: f.ruleId });
      }
      for (const hit of hist.hits) {
        const bytes = execFileSync("git", ["-C", copy, "cat-file", "blob", `${hit.commit}:${hit.file}`], { maxBuffer: 256 * 1024 * 1024 });
        const opaqueId = q.quarantineItem({ bytes, origin: `${hit.file}@${hit.commit}`, findings: hit.findings, graduation: grad(hit.file) });
        for (const f of hit.findings) findings.push({ opaqueId, path: hit.file, location: "history", rule: f.ruleId, commit: hit.commit });
      }
    }

    const gate: "clean" | "blocked" = findings.length === 0 ? "clean" : "blocked";
    // The working-tree paths carrying ≥1 credential finding (Task 5.1 handshake). Persisted so
    // `graduation migrate` can SKIP + quarantine exactly these instead of hard-failing a blocked
    // gate; deterministic + deduped (history-only hits have no working-tree path to skip).
    const credentialPaths = [...new Set(wt.hits.map((h) => h.file))].sort();
    // History-only findings (in past commits, no working-tree file). Apply scrubs only the working
    // tree, so any non-zero count makes migrate hard-fail even with the credentialPaths handshake.
    const historyCredentialCount = findings.filter((f) => f.location === "history").length;
    // Persist the scan-state gate the downstream (flag-free) graduation commands read.
    writeScanState(scanStatePath(ledgerDbPath(ctx)), { copy, copyHead, gate, scannedAt: new Date().toISOString(), findingCount: findings.length, credentialPaths, historyCredentialCount });

    const out = {
      command: "graduation scan",
      copyHead,
      scanned: { workingTreeFiles: wt.scannedFiles, historyCommits: hist.historyCommits, includeHistory: true as const },
      findings,
      gate,
    };
    if (ctx.output.mode === "json") emitJson(out);
    else ctx.render(`graduation scan — ${wt.scannedFiles} file(s) + ${hist.historyCommits} commit(s): ${gate}${findings.length ? ` (${findings.length} finding(s))` : ""}`);
    // Fail-closed: a non-empty finding set exits 3 (secret-scan) so graduation cannot proceed.
    return gate === "clean" ? EXIT.OK : EXIT.SECRET_SCAN;
  });
}

registerCommand("graduation scan", graduationScan);

export { graduationScan, parseArgs };
