import Foundation
import os

/// Sanitizes an argv for logging under an allowlist. Binary path, command/subcommand tokens, flag
/// names, enumerated flag values, and structural/ID operands (`jobId`, note `id`, `--limit`, …) log
/// intact; a user-supplied free-text operand (the `query` positional — the one such operand in the V1
/// set) is replaced with `<redacted:<command> len=NN>`. The redaction set is Console-owned by
/// **schema-arg NAME**, but each name's concrete argv position is resolved from the bound command
/// schema at runtime — never a hardcoded index.
public enum ArgvClassifier {
    /// command → the set of that command's schema arg NAMES (from `x-atlas-contract.args[].name`) that
    /// carry user free-text and must be redacted. Linking by schema-arg name makes the mapping
    /// stale-guardable: a name absent from the command schema is a bug the coverage test catches.
    public static let sensitiveOperands: [String: Set<String>] = [
        "query": ["<text>"],
    ]

    /// The ordered positional-argument names declared in a command schema's `x-atlas-contract.args`.
    public static func positionalArgNames(schema: Data) -> [String] {
        guard let obj = try? JSONSerialization.jsonObject(with: schema) as? [String: Any],
              let contract = obj["x-atlas-contract"] as? [String: Any],
              let args = contract["args"] as? [[String: Any]] else {
            return []
        }
        return args.compactMap { $0["name"] as? String }
    }

    /// What a command schema declares about one flag: whether it takes a value, an optional numeric
    /// `lo..hi` constraint, and an optional enumerated value set. Used to decide, fail-closed, whether a
    /// flag's VALUE may be logged intact (numeric-in-range or enumerated) or must be redacted.
    struct FlagSpec {
        var takesValue: Bool
        var range: (lo: Double, hi: Double)?
        var enumValues: Set<String>?
    }

    /// The flag specs a command schema declares (`flags` + `commonFlags`), keyed by base flag name.
    static func flagSpecs(schema: Data) -> [String: FlagSpec] {
        guard let obj = try? JSONSerialization.jsonObject(with: schema) as? [String: Any],
              let contract = obj["x-atlas-contract"] as? [String: Any] else {
            return [:]
        }
        var map: [String: FlagSpec] = [:]
        let flagLists = [contract["flags"], contract["commonFlags"]]
        for list in flagLists {
            if let flags = list as? [[String: Any]] {
                for f in flags {
                    guard let name = f["name"] as? String else { continue }
                    record(name, constraint: f["constraint"] as? String,
                           enums: (f["enum"] as? [Any])?.compactMap { $0 as? String }, into: &map)
                }
            } else if let flags = list as? [String] {
                for name in flags { record(name, constraint: nil, enums: nil, into: &map) }
            }
        }
        return map
    }

    private static func record(_ decl: String, constraint: String?, enums: [String]?, into map: inout [String: FlagSpec]) {
        // decl e.g. "--k <n>" or "--config <path>" or "--no-answer".
        let parts = decl.split(separator: " ", maxSplits: 1, omittingEmptySubsequences: true)
        guard let base = parts.first.map(String.init), base.hasPrefix("-") else { return }
        map[base] = FlagSpec(takesValue: decl.contains("<"), range: parseRange(constraint),
                             enumValues: enums.map(Set.init))
    }

    /// Parses a `"1..100"`-style numeric constraint into a closed range.
    private static func parseRange(_ constraint: String?) -> (lo: Double, hi: Double)? {
        guard let c = constraint else { return nil }
        let parts = c.components(separatedBy: "..")
        guard parts.count == 2, let lo = Double(parts[0].trimmingCharacters(in: .whitespaces)),
              let hi = Double(parts[1].trimmingCharacters(in: .whitespaces)) else { return nil }
        return (lo, hi)
    }

    /// Whether a flag's VALUE may be logged intact. Fail-closed: a value is preserved ONLY when the
    /// schema affirmatively classifies it as structural (numeric, in range if a constraint is declared)
    /// or enumerated. Anything else — an out-of-range/non-numeric value, a free-text path, an
    /// unclassified flag — is redacted, so a misplaced secret (e.g. `--k=sk-SECRET`) never lands in a log.
    static func flagValueIsSafe(_ value: String, spec: FlagSpec) -> Bool {
        if let enumValues = spec.enumValues { return enumValues.contains(value) }
        guard let n = Double(value) else { return false } // non-numeric, unclassified ⇒ redact
        if let r = spec.range { return n >= r.lo && n <= r.hi }
        return true // a plain number with no declared range is structural
    }

    /// Sanitizes `argv` for the given `command` using its bound `schema`. `argv` is the full launch
    /// vector (`[binaryPath, ...commandTokens, ...operandsAndFlags]`); the binary + command tokens are
    /// structural and pass through intact.
    ///
    /// **Fail-closed rules** (a leak here writes a secret to a persistent log):
    /// - Only schema-DECLARED flags are recognized as flags. A dash-prefixed token that is not a
    ///   declared flag is treated as a positional operand (a query may legitimately start with `-`),
    ///   so it is subject to redaction rather than passed through as a "flag name".
    /// - `--` ends flag parsing: every token after it is a positional operand.
    /// - If the command declares sensitive operands but the schema does not resolve them (empty or
    ///   malformed `x-atlas-contract.args`, or a declared sensitive name missing from the schema's
    ///   positionals), position mapping is untrustworthy ⇒ redact EVERY positional operand.
    /// - Redaction length is the operand's UTF-8 BYTE count (`tok.utf8.count`), per the contract.
    public static func sanitize(command: String, argv: [String], schema: Data) -> [String] {
        let sensitive = sensitiveOperands[command] ?? []
        let positionals = positionalArgNames(schema: schema)
        let specs = flagSpecs(schema: schema)
        let cmdTokens = command.split(separator: " ").map(String.init)

        // Fail closed: if this command has sensitive operands but the schema can't resolve all of
        // them to positionals, we can't trust position→name mapping, so redact every positional.
        let redactAllPositionals = !sensitive.isEmpty && !sensitive.isSubset(of: Set(positionals))

        // Locate the command-token run in argv; everything up to and including it is structural.
        let prefixEnd = commandRunEnd(argv: argv, cmdTokens: cmdTokens)
        var out = Array(argv[0..<prefixEnd])

        var positionalIndex = 0
        var flagsEnded = false
        // A free-text operand (the natural-language query) can span MULTIPLE bare argv tokens —
        // `brain query top secret text` is one query, not three operands. Once a sensitive positional
        // is reached, every following positional belongs to that operand and is redacted too; otherwise
        // `top` is redacted but `secret text` leaks verbatim.
        var sawSensitivePositional = false
        var i = prefixEnd
        while i < argv.count {
            let tok = argv[i]
            // `--` terminates flag parsing; the token itself is structural.
            if !flagsEnded, tok == "--" {
                out.append(tok)
                flagsEnded = true
                i += 1
                continue
            }
            let base = tok.split(separator: "=", maxSplits: 1).first.map(String.init) ?? tok
            if !flagsEnded, tok.hasPrefix("-"), let spec = specs[base] {
                out.append(tok.contains("=") ? redactFlagEqualsValue(tok, base: base, spec: spec) : tok)
                // `--flag=value` is self-contained; otherwise a value-taking flag consumes the next
                // token — logged intact ONLY if the schema classifies it as structural/enumerated.
                if !tok.contains("="), spec.takesValue, i + 1 < argv.count {
                    let value = argv[i + 1]
                    out.append(flagValueIsSafe(value, spec: spec)
                               ? value : "<redacted:val len=\(value.utf8.count)>")
                    i += 2
                    continue
                }
                i += 1
                continue
            }
            // A positional operand (including a dash-prefixed token that is NOT a declared flag).
            let argName = positionalIndex < positionals.count ? positionals[positionalIndex] : nil
            let isSensitive = redactAllPositionals || sawSensitivePositional
                || (argName.map(sensitive.contains) ?? false)
            if isSensitive {
                sawSensitivePositional = true
                out.append("<redacted:\(command) len=\(tok.utf8.count)>")
            } else {
                out.append(tok)
            }
            positionalIndex += 1
            i += 1
        }
        return out
    }

    /// Sanitizes a `--flag=value` token: keep the flag name, redact the value unless the schema
    /// classifies it as structural/enumerated.
    private static func redactFlagEqualsValue(_ tok: String, base: String, spec: FlagSpec) -> String {
        guard spec.takesValue else { return tok } // a valueless flag written with `=` is odd; leave as-is
        let value = String(tok.dropFirst(base.count + 1)) // drop "base="
        return flagValueIsSafe(value, spec: spec) ? tok : "\(base)=<redacted:val len=\(value.utf8.count)>"
    }

    /// Fail closed with NO bound schema: positions can't be resolved, so redact every operand after the
    /// command-token run. Only the binary path (`argv[0]`) and the command tokens are structural. A
    /// dash-prefixed token is NOT treated as a safe flag name (a query may start with `-`), and a
    /// slash-containing operand is NOT treated as a safe path (a query may contain `/`) — both are
    /// redacted. Redaction length is the operand's UTF-8 byte count.
    public static func failClosedNoSchema(command: String, argv: [String]) -> [String] {
        let cmdTokens = command.split(separator: " ").map(String.init)
        let prefixEnd = commandRunEnd(argv: argv, cmdTokens: cmdTokens)
        var out = Array(argv[0..<prefixEnd])
        for tok in argv[prefixEnd...] {
            out.append("<redacted:\(command) len=\(tok.utf8.count)>")
        }
        return out
    }

    /// Index one past the command-token run inside argv (`[binary, ...cmdTokens, ...]`). Falls back to
    /// treating the whole argv as operands (prefix 0) if the run is not found.
    private static func commandRunEnd(argv: [String], cmdTokens: [String]) -> Int {
        guard !cmdTokens.isEmpty else { return 0 }
        if argv.count >= cmdTokens.count {
            for start in 0...(argv.count - cmdTokens.count) {
                if Array(argv[start..<start + cmdTokens.count]) == cmdTokens {
                    return start + cmdTokens.count
                }
            }
        }
        return 0
    }
}

/// The one `os.Logger` every spawn / state-transition routes through (subsystem `com.atlas.console`).
/// Argv is sanitized via `ArgvClassifier`; the egress capability key rides env and is never logged.
/// `brain` stderr is captured (never swallowed) for surfacing on error surfaces — this logger records
/// but does not consume it.
public struct ConsoleLog {
    private static let logger = Logger(subsystem: ConsoleConstants.logSubsystem, category: "console")

    /// The `.info` spawn line, sanitized. Exposed for testability (the composed string is asserted; the
    /// `os.Logger` sink is not directly readable in unit tests).
    public static func spawnLine(command: String, argv: [String], schema: Data?, exitCode: Int32?) -> String {
        let sanitized = schema.map { ArgvClassifier.sanitize(command: command, argv: argv, schema: $0) }
            ?? ArgvClassifier.failClosedNoSchema(command: command, argv: argv)
        let exit = exitCode.map { " exit=\($0)" } ?? ""
        return "spawn command=\(command) argv=\(sanitized.joined(separator: " "))\(exit)"
    }

    public static func spawn(command: String, argv: [String], schema: Data? = nil, exitCode: Int32? = nil) {
        logger.info("\(spawnLine(command: command, argv: argv, schema: schema, exitCode: exitCode), privacy: .public)")
    }

    /// The stream-termination line: exit code plus byte-length-only stderr metadata. Raw stderr is
    /// NEVER written verbatim — only `stderr=<redacted len=NN>`, so egress/child stderr can't leak into
    /// the persistent log (it is surfaced to error surfaces via `StreamCompletion.stderr` instead).
    public static func terminationLine(command: String, exitCode: Int32, stderr: Data) -> String {
        "termination command=\(command) exit=\(exitCode) stderr=<redacted len=\(stderr.count)>"
    }

    public static func termination(command: String, exitCode: Int32, stderr: Data) {
        let line = terminationLine(command: command, exitCode: exitCode, stderr: stderr)
        // A non-zero exit is an error surface; a clean detach (exit 0) is informational.
        if exitCode == 0 {
            logger.info("\(line, privacy: .public)")
        } else {
            logger.error("\(line, privacy: .public)")
        }
    }

    /// The `.error` failure line for a probe/spawn/decode failure.
    ///
    /// `detail` MUST be a Console-authored, content-free descriptor (a stage/reason token like
    /// `"timed out"` or `"exit=3"`) — never raw child output. Raw `brain`/egress stderr and query text
    /// are surfaced to the UI's error surface via `StreamCompletion.stderr` / `SpawnResult.stderr`, but
    /// they are NEVER written verbatim to this persistent log. When a captured stderr blob is relevant,
    /// pass it as `rawOutput`: only its UTF-8 byte length is recorded (`output=<redacted len=NN>`), so
    /// egress stderr or query text can't leak into the log.
    public static func failureLine(_ stage: String, path: String, detail: String, rawOutput: Data? = nil) -> String {
        var line = "failure stage=\(stage) path=\(path) detail=\(detail)"
        if let rawOutput { line += " output=<redacted len=\(rawOutput.count)>" }
        return line
    }

    public static func failure(_ stage: String, path: String, detail: String, rawOutput: Data? = nil) {
        logger.error("\(failureLine(stage, path: path, detail: detail, rawOutput: rawOutput), privacy: .public)")
    }
}
