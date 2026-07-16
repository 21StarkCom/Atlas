/**
 * `brain validate [<note>]` (Task 4.11) — a deterministic, read-only validation report over a note
 * or the whole vault: parse/schema errors, dangling wiki-link references, and identity-key
 * collisions, plus the Tier-2 eligibility gate. Read-only (no ledger/projection mutation). Output
 * matches `validate.schema.json`.
 */
import { CliError, EXIT, emitJson } from "../errors/envelope.js";
import { registerCommand, type RunContext } from "../handlers.js";
import { readVault } from "../vault/reader.js";
import { validateVault } from "../validation/vault-validate.js";

function parseArgs(argv: string[]): string | undefined {
  const positional = argv.filter((a) => !a.startsWith("-"));
  if (positional.length > 1) throw CliError.usage(`\`validate\`: expected at most one [<note>] argument`);
  return positional[0];
}

async function validate(ctx: RunContext): Promise<number> {
  const note = parseArgs(ctx.argv);
  const snapshot = await readVault(ctx.config.config);
  const report = validateVault(snapshot, note);
  const out = {
    command: "validate",
    ok: report.ok,
    scope: note ?? "vault",
    findings: report.findings.map((f) => ({ code: f.code, severity: f.severity, message: f.message, ...(f.note ? { location: f.note } : {}) })),
    gates: report.gates,
  };
  if (ctx.output.mode === "json") emitJson(out);
  else ctx.render(`validate ${out.scope}: ${report.ok ? "ok" : `${report.findings.length} finding(s)`}`);
  return report.ok ? EXIT.OK : EXIT.VALIDATION;
}

registerCommand("validate", validate);

export { validate };
