/**
 * runCli / router — command routing, output-mode wiring, config + exit-code
 * mapping. The renderer/JSON emitter/lock/diag wiring is exercised end-to-end
 * with a temp cwd + config and injected fake handlers.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli, type CommandHandler, type RunContext } from "../src/main.js";
import { SecretDetectedError } from "@atlas/scan";
import { CliError, EXIT } from "../src/errors/envelope.js";
import { parseArgv, loadRegistry } from "../src/router.js";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");
const EXAMPLE = readFileSync(join(REPO_ROOT, "brain.config.example.yaml"), "utf8");
const registry = loadRegistry(REPO_ROOT);

let cwd: string;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "atlas-cli-"));
  writeFileSync(join(cwd, "brain.config.yaml"), EXAMPLE, "utf8");
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));

function capture(): NodeJS.WritableStream & { text: string } {
  return {
    text: "",
    write(chunk: string | Uint8Array): boolean {
      (this as { text: string }).text +=
        typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      return true;
    },
  } as NodeJS.WritableStream & { text: string };
}

function run(
  argv: string[],
  env: NodeJS.ProcessEnv = {},
  handlers: Record<string, CommandHandler> = {},
): Promise<{ code: number; out: string; err: string }> {
  const out = capture();
  const err = capture();
  return runCli(argv, env, { cwd, handlers, stdout: out, stderr: err, root: REPO_ROOT }).then(
    (code) => ({ code, out: out.text, err: err.text }),
  );
}

describe("parseArgv", () => {
  it("matches multi-word commands longest-first", () => {
    expect(parseArgv(["source", "trust", "promote", "x"], registry).command).toBe(
      "source trust promote",
    );
    expect(parseArgv(["db", "status"], registry).command).toBe("db status");
    expect(parseArgv(["status"], registry).command).toBe("status");
  });

  it("strips global flags anywhere and forwards the rest in ORIGINAL order", () => {
    const p = parseArgv(["--json", "db", "status", "--foo", "bar"], registry);
    expect(p.flags.json).toBe(true);
    expect(p.command).toBe("db status");
    // Order-sensitive: `--foo bar` must not be reordered to `bar --foo`.
    expect(p.rest).toEqual(["--foo", "bar"]);
  });

  it("preserves the order of interleaved command-specific flags and values", () => {
    const p = parseArgv(["status", "--foo", "bar", "--baz", "qux"], registry);
    expect(p.command).toBe("status");
    expect(p.rest).toEqual(["--foo", "bar", "--baz", "qux"]);
  });

  it("preserves order for a leading command-specific flag (no command matched)", () => {
    const p = parseArgv(["--foo", "bar"], registry);
    expect(p.command).toBeNull();
    expect(p.rest).toEqual(["--foo", "bar"]);
  });

  it("rejects a missing value after --config as a usage error (exit 5)", () => {
    try {
      parseArgv(["status", "--config"], registry);
      throw new Error("expected a usage error");
    } catch (e) {
      expect(e).toBeInstanceOf(CliError);
      expect((e as CliError).exitCode).toBe(EXIT.USAGE);
      expect((e as CliError).message).toContain("--config");
    }
  });

  it("returns null command for an unknown token sequence", () => {
    expect(parseArgv(["frobnicate"], registry).command).toBeNull();
  });

  it("parses --config=<path> and --config <path>", () => {
    expect(parseArgv(["--config=/a.yaml", "status"], registry).configPath).toBe("/a.yaml");
    expect(parseArgv(["--config", "/b.yaml", "status"], registry).configPath).toBe("/b.yaml");
  });
});

describe("runCli", () => {
  it("prints usage on --help (exit 0) via the renderer", async () => {
    const { code, out } = await run(["--help"]);
    expect(code).toBe(EXIT.OK);
    expect(out).toContain("brain — Atlas CLI");
    expect(out).toContain("db status");
  });

  it("dispatches a registered handler and returns its exit code", async () => {
    let got: RunContext | null = null;
    const { code } = await run(["status"], {}, {
      status: (ctx) => {
        got = ctx;
        ctx.render("all good");
        return EXIT.OK;
      },
    });
    expect(code).toBe(EXIT.OK);
    expect(got).not.toBeNull();
    expect(got!.command).toBe("status");
    expect(got!.runId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/); // ULID
  });

  it("routes human output through the renderer (sanitized) to stdout", async () => {
    const { out } = await run(["status"], {}, {
      status: (ctx) => {
        ctx.render("hi\x1b[31mRED\x1b[0m");
        return 0;
      },
    });
    expect(out).toContain("hiRED");
    expect(out).not.toContain("\x1b");
  });

  it("maps an unknown command to a usage error (exit 5)", async () => {
    const { code, err } = await run(["frobnicate"]);
    expect(code).toBe(EXIT.USAGE);
    expect(err).toContain("unknown command");
  });

  it("emits a JSON envelope on failure in --json mode (exit code mapped)", async () => {
    const { code, out } = await run(["status", "--json"], {}, {
      status: () => {
        throw new CliError({
          code: "backup-unhealthy",
          message: "blocked",
          hint: "run backup",
          exitCode: EXIT.ACTION_REQUIRED,
          retryable: true,
        });
      },
    });
    expect(code).toBe(EXIT.ACTION_REQUIRED);
    const env = JSON.parse(out);
    expect(env).toMatchObject({ code: "backup-unhealthy", retryable: true });
  });

  it("maps a scan guard's SecretDetectedError to the secret-scan exit code (3)", async () => {
    const { code, out } = await run(["status", "--json"], {}, {
      status: () => {
        throw new SecretDetectedError(
          "note.md",
          [{ ruleId: "aws-access-key-id", title: "AWS access key id", severity: "high", startOffset: 0, endOffset: 20, redactedPreview: "‹redacted:20 chars›" }],
          "pre-persistence",
        );
      },
    });
    expect(code).toBe(EXIT.SECRET_SCAN);
    const env = JSON.parse(out);
    expect(env.code).toBe("secret-scan");
    expect(env.message).toContain("note.md");
    // The redacted preview must not leak the raw secret through the envelope.
    expect(out).not.toContain("AKIA");
  });

  it("honours --json for an argument-PARSE failure (JSON envelope, not human text)", async () => {
    // `--config` with no value is a usage error thrown BEFORE the full parse
    // completes; the already-supplied `--json` must still route it to the JSON
    // envelope on stdout, with stderr left clean.
    const { code, out, err } = await run(["--json", "--config"]);
    expect(code).toBe(EXIT.USAGE);
    expect(err).toBe("");
    const envelope = JSON.parse(out);
    expect(envelope.code).toBe("usage");
    expect(envelope.message).toContain("--config");
  });

  it("falls back to a human parse error on stderr when --json is absent", async () => {
    const { code, out, err } = await run(["--config"]);
    expect(code).toBe(EXIT.USAGE);
    expect(out).toBe("");
    expect(err).toContain("error:");
    expect(err).toContain("--config");
  });

  it("renders a human error to stderr (not stdout) when not --json", async () => {
    const { code, out, err } = await run(["status"], {}, {
      status: () => {
        throw CliError.usage("bad flag", "try --help");
      },
    });
    expect(code).toBe(EXIT.USAGE);
    expect(out).toBe("");
    expect(err).toContain("error: bad flag");
    expect(err).toContain("hint: try --help");
  });

  it("wraps an unexpected (non-CliError) throw as internal (exit 4)", async () => {
    const { code, err } = await run(["status"], {}, {
      status: () => {
        throw new Error("kaboom");
      },
    });
    expect(code).toBe(EXIT.INTERNAL);
    expect(err).toContain("error:");
  });

  it("returns a config error (exit 2) with envelope when config is invalid (--json)", async () => {
    writeFileSync(
      join(cwd, "brain.config.yaml"),
      EXAMPLE.replace("dimensions: 768", "dimensions: not-a-number"),
      "utf8",
    );
    const { code, out } = await run(["status", "--json"], {}, { status: () => 0 });
    expect(code).toBe(EXIT.CONFIG);
    const env = JSON.parse(out);
    expect(env.code).toBe("config-invalid");
    expect(env.details.field).toContain("indexing.dimensions");
  });

  it("reports a not-implemented command from the registry (exit 5)", async () => {
    // `git refresh` is a real registry command with no handler wired in this build.
    // This case gets re-pointed each time its stand-in ships: `db migrate` served it until
    // it became the shared migration composition root, then `ingest` until Task 2.6 (#32),
    // then `enrich` until Task 4.11 implemented it. Pick any row still `implemented: false`.
    const { code, out } = await run(["git", "refresh", "--json"], {}, {});
    expect(code).toBe(EXIT.USAGE);
    expect(JSON.parse(out).code).toBe("not-implemented");
  });

  it("wires config-derived locks + logs (a handler can withLock and log)", async () => {
    const { code } = await run(["status"], {}, {
      status: async (ctx) => {
        ctx.log.info("working", { step: 1 });
        return ctx.withLock("jobs-runner", () => EXIT.OK);
      },
    });
    expect(code).toBe(EXIT.OK);
    // The logger wrote to <cwd>/.atlas/logs per the example config.
    expect(existsSync(join(cwd, ".atlas", "logs", "atlas.log"))).toBe(true);
  });
});
