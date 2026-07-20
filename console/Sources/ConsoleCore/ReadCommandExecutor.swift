import Foundation

// P6-Task-1 — the ONE generic executor every read-on-focus surface goes through.
//
// It is the schema-bound, execution-class-gated gateway to the runtime-inventoried 25-command read
// surface (17 read + 4 audited-read + 4 pure). No write path can ride it: a command whose
// `executionClass` is not read/audited-read/pure is refused (`NotAReadCommand`) BEFORE any spawn, so a
// mutating or projection-write command can never be invoked through this seam. Reads are never polled —
// the cadence guard owns that; this executor runs only on user focus/action.
//
// It also satisfies the `ReadInvoker` seam (JobState.swift) so the paginating `JobsListReader` routes
// its `jobs list --json` pages through the SAME schema-validating gateway rather than a raw runner.

/// Failures the read gateway raises.
public enum ReadCommandError: Error, Sendable, Equatable {
    /// The command exists in the registry but is not a read-class command — a write path can never ride
    /// this executor. Carries the offending command + its execution class.
    case notAReadCommand(command: String, executionClass: String)
    /// No such command in the bound registry (checked before any spawn).
    case unknownCommand(String)
    /// The command has no bound schema in the contract bundle (the checkout is incomplete).
    case noSchema(command: String)
    /// Exit 0 but stdout failed strict validation against the command's `schemaRef`.
    case invalidOutput(command: String, [ValidationError])
    /// The spawn itself failed (launch / timeout / cancellation).
    case spawnFailed(command: String, detail: String)
    /// A nonzero exit whose stdout/stderr parsed as an error envelope — surfaced typed.
    case failed(ErrorEnvelope)
    /// A nonzero exit with no parseable error envelope (carries the exit code + captured stderr text).
    case unparseableFailure(command: String, exitCode: Int32, stderr: String)
}

/// The schema-bound, execution-class-gated read gateway. Holds no credential, opens no socket, mints no
/// capability. Every read-on-focus surface (`note show`, `git review`, `jobs list`, `git status`,
/// `index status`, …) invokes exactly one `run` per user action.
public struct ReadCommandExecutor: ReadInvoker, Sendable {
    private let runner: ProcessRunner
    private let binary: ResolvedBinary
    /// The contract bundle is taken EXCLUSIVELY from `binary.bundle` — never accepted as an independent
    /// parameter. A separate bundle would let a caller execute binary A while gating, schema-validating,
    /// and choosing the cwd from bundle B's contract, defeating the schema-bound invariant (a command
    /// could run under another checkout's execution classes / schemas). Deriving it from the resolved
    /// binary makes that structurally impossible: the bytes spawned and the schema they are validated
    /// against always come from the same resolved checkout.
    private var bundle: ContractBundle { binary.bundle }

    public init(runner: ProcessRunner, binary: ResolvedBinary) {
        self.runner = runner
        self.binary = binary
    }

    /// The bound error-envelope parser, built on demand (the `SchemaValidator` it wraps is not `Sendable`,
    /// so it cannot be stored on this `Sendable` gateway). Best-effort — a malformed bound schema simply
    /// means a nonzero exit surfaces as `unparseableFailure`.
    private func makeEnvelopeParser() -> ErrorEnvelopeParser? {
        try? ErrorEnvelopeParser(schema: bundle.errorEnvelopeSchema)
    }

    /// Run a read-class command with `--json`, strict-validate its stdout, and return the validated bytes.
    ///
    /// 1. Look up the `CommandRow`; REFUSE any command whose `executionClass` is not read/audited-read/pure
    ///    (throws `NotAReadCommand` — write paths can never ride this executor).
    /// 2. Resolve the command's schema from the bundle; spawn with `--json`.
    /// 3. exit 0 ⇒ strict-validate stdout against the `schemaRef` and return it.
    /// 4. nonzero ⇒ strict-parse the error envelope and throw it typed (else `unparseableFailure`).
    public func run(_ command: String, args: [String]) async throws -> Data {
        guard let row = bundle.commands.first(where: { $0.name == command }) else {
            throw ReadCommandError.unknownCommand(command)
        }
        guard ReadSurface.readExecutionClasses.contains(row.executionClass) else {
            throw ReadCommandError.notAReadCommand(command: command, executionClass: row.executionClass)
        }
        guard let schema = bundle.schema(for: command) else {
            throw ReadCommandError.noSchema(command: command)
        }

        // Build the argv: the command's own tokens, the caller's args, and a guaranteed `--json` (brain
        // emits the JSON envelope only when `--json` is sniffed). A caller that already passed `--json`
        // is not double-flagged.
        var arguments = command.split(separator: " ").map(String.init)
        arguments.append(contentsOf: args)
        if !arguments.contains("--json") { arguments.append("--json") }

        // A read is a NON-egress spawn: the shared builder strips any inherited capability key so a
        // shell-launched Console never forwards it to a read.
        let req = SpawnRequest(
            executable: binary.launch,
            arguments: arguments,
            cwd: bundle.checkoutRoot,
            environment: ChildEnvironment.nonEgress(overlay: binary.baseEnv),
            // Bound the spawn: a wedged read child (locked SQLite / stuck daemon) must throw
            // SpawnTimeout, never hang — an unbounded read parks the serialized jobs-publish chain and
            // strands an open `busy` utterance (R2 finding).
            timeout: ConsoleConstants.readCommandTimeout,
            command: command,
            commandSchema: schema
        )

        let result: SpawnResult
        do {
            result = try await runner.run(req)
        } catch {
            throw ReadCommandError.spawnFailed(command: command, detail: "\(error)")
        }

        if result.exitCode == 0 {
            guard let validator = try? SchemaValidator(schema: schema) else {
                throw ReadCommandError.noSchema(command: command)
            }
            if case .invalid(let errs) = validator.validate(result.stdout) {
                throw ReadCommandError.invalidOutput(command: command, errs)
            }
            return result.stdout
        }

        // Nonzero: surface the error envelope typed (from stdout, else stderr), or an unparseable failure.
        if let parser = makeEnvelopeParser(),
           let envelope = (try? parser.parse(result.stdout)) ?? (try? parser.parse(result.stderr)) {
            throw ReadCommandError.failed(envelope)
        }
        throw ReadCommandError.unparseableFailure(
            command: command, exitCode: result.exitCode,
            stderr: String(decoding: result.stderr, as: UTF8.self))
    }
}
