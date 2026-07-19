import Foundation

/// A subprocess launch request. `executable[0]` MUST be an absolute path — `Foundation.Process`
/// takes a file URL and performs no shell/PATH expansion; resolution to absolute happens upstream
/// (`BinaryResolution`), and the runner rejects a non-absolute token with a typed error.
public struct SpawnRequest: Sendable {
    /// Launch argv. `[0]` is the absolute executable path; `[1...]` are argv prefixed before `arguments`
    /// (e.g. `[node, .../bin.js]`). No PATH lookup is performed here.
    public let executable: [String]
    public let arguments: [String]
    public let cwd: URL
    /// The full environment handed to the child; no implicit inheritance beyond what is passed.
    public let environment: [String: String]
    public let stdin: Data?
    /// One-shot runs only; nil = no timeout (streams end via exit/terminate).
    public let timeout: Duration?

    public init(
        executable: [String],
        arguments: [String] = [],
        cwd: URL,
        environment: [String: String],
        stdin: Data? = nil,
        timeout: Duration? = nil
    ) {
        self.executable = executable
        self.arguments = arguments
        self.cwd = cwd
        self.environment = environment
        self.stdin = stdin
        self.timeout = timeout
    }
}

public struct SpawnResult: Sendable {
    public let exitCode: Int32
    public let stdout: Data
    public let stderr: Data
    public init(exitCode: Int32, stdout: Data, stderr: Data) {
        self.exitCode = exitCode
        self.stdout = stdout
        self.stderr = stderr
    }
}

/// Errors the spawn layer raises (distinct from a non-zero child exit, which is data on `SpawnResult`).
public enum SpawnError: Error, Equatable, Sendable {
    /// `executable[0]` was not an absolute path.
    case executableNotAbsolute(String)
    /// The `run` timeout elapsed; the child was reaped (SIGTERM→SIGKILL) before this was thrown.
    case timedOut(Duration)
    /// The executable at the resolved path could not be launched.
    case launchFailed(path: String, underlying: String)
    /// `executable` was empty.
    case emptyExecutable
}

/// The single owner of subprocess launch. One-shot `run` and a long-lived `stream`.
public protocol ProcessRunner: Sendable {
    /// Runs to completion, draining stdout+stderr concurrently. A non-zero exit is surfaced in the
    /// result, never thrown. Throws `SpawnError.timedOut` on expiry (child reaped) and honors Swift
    /// task cancellation the same way.
    func run(_ req: SpawnRequest) async throws -> SpawnResult
    /// Spawns a long-lived process exposing raw stdout byte chunks + an exit completion.
    func stream(_ req: SpawnRequest) throws -> StreamHandle
}

/// `Foundation.Process`-backed runner. Each `run`/`stream` spawns a fresh process; there is no
/// shared mutable process state on the struct, so one instance is safely shareable across the
/// `WatchSupervisor`/`AttachCoordinator`/`PrivilegedFlow` actors.
public struct SystemProcessRunner: ProcessRunner {
    public init() { _ = Self.sigpipeIgnored }

    /// Writing to a child's stdin whose read-end has closed (e.g. after a reap) delivers SIGPIPE,
    /// which by default kills THIS process. Ignore it once, process-wide, so such a write instead
    /// fails with EPIPE (swallowed by `try?`) — matching how Node and other spawners behave.
    private static let sigpipeIgnored: Bool = {
        signal(SIGPIPE, SIG_IGN)
        return true
    }()

    static func validate(_ req: SpawnRequest) throws {
        guard let first = req.executable.first else { throw SpawnError.emptyExecutable }
        guard first.hasPrefix("/") else { throw SpawnError.executableNotAbsolute(first) }
    }

    private static func makeProcess(_ req: SpawnRequest) -> (Process, Pipe, Pipe, Pipe?) {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: req.executable[0])
        process.arguments = Array(req.executable.dropFirst()) + req.arguments
        process.currentDirectoryURL = req.cwd
        process.environment = req.environment
        let outPipe = Pipe()
        let errPipe = Pipe()
        process.standardOutput = outPipe
        process.standardError = errPipe
        var inPipe: Pipe?
        if req.stdin != nil {
            let p = Pipe()
            process.standardInput = p
            inPipe = p
        }
        return (process, outPipe, errPipe, inPipe)
    }

    public func run(_ req: SpawnRequest) async throws -> SpawnResult {
        try Self.validate(req)
        let (process, outPipe, errPipe, inPipe) = Self.makeProcess(req)

        // Drain both pipes concurrently so a child exceeding pipe capacity on either stream never deadlocks.
        async let outData = Self.readToEnd(outPipe.fileHandleForReading)
        async let errData = Self.readToEnd(errPipe.fileHandleForReading)

        do {
            try process.run()
        } catch {
            _ = await outData
            _ = await errData
            throw SpawnError.launchFailed(path: req.executable[0], underlying: "\(error)")
        }

        // Pump stdin CONCURRENTLY (off the cooperative pool). A synchronous write blocks forever when
        // the child never drains a pipe-capacity-sized payload — that would bypass the timeout and
        // cancellation paths entirely. Kept off the reap path, the child can always be terminated; the
        // blocked write then unblocks on EPIPE once the child is reaped (and its read-end closes).
        let inHandle = inPipe?.fileHandleForWriting
        let stdinPump = Task { await Self.pumpStdin(inHandle, req.stdin) }

        let exit: Int32
        do {
            exit = try await Self.wait(process, timeout: req.timeout)
        } catch {
            // Timeout or cancellation: reap the child. A child that spawned (rather than exec'd) its
            // work may leave an orphan holding the pipe write-end open, so close the read handles to
            // unblock the concurrent drains instead of waiting for a distant EOF. Close the stdin
            // write handle too so a still-pending stdin write is released during the reap.
            Self.reap(process)
            try? outPipe.fileHandleForReading.close()
            try? errPipe.fileHandleForReading.close()
            try? inHandle?.close()
            _ = await outData
            _ = await errData
            await stdinPump.value
            throw error
        }

        await stdinPump.value
        return SpawnResult(exitCode: exit, stdout: await outData, stderr: await errData)
    }

    public func stream(_ req: SpawnRequest) throws -> StreamHandle {
        try Self.validate(req)
        let (process, outPipe, errPipe, inPipe) = Self.makeProcess(req)
        let handle = StreamHandle(process: process, stdout: outPipe, stderr: errPipe)
        try process.run()
        if let stdin = req.stdin, let inPipe {
            // Pump stdin off the cooperative pool. A synchronous write here deadlocks the caller when
            // the child never drains a pipe-capacity-sized payload — and unlike `run`, a stream caller
            // has already received its handle, so it could never terminate the process. The detached
            // write unblocks on EPIPE once the child's read-end closes (natural exit or `terminate()`).
            let inHandle = inPipe.fileHandleForWriting
            Task { await Self.pumpStdin(inHandle, stdin) }
        }
        return handle
    }

    // MARK: - Helpers

    /// Writes `data` to the child's stdin on a background queue, then closes the handle (sending EOF).
    /// Runs off the cooperative pool so a child that never reads cannot starve it; the blocked write
    /// returns EPIPE once the child's read-end closes (natural exit or reap), so this always completes.
    static func pumpStdin(_ handle: FileHandle?, _ data: Data?) async {
        guard let handle, let data else { return }
        await withCheckedContinuation { (cont: CheckedContinuation<Void, Never>) in
            DispatchQueue.global(qos: .userInitiated).async {
                try? handle.write(contentsOf: data)
                try? handle.close()
                cont.resume()
            }
        }
    }

    /// Blocking `readToEnd` moved off the cooperative pool so concurrent drains never starve.
    static func readToEnd(_ fh: FileHandle) async -> Data {
        await withCheckedContinuation { (cont: CheckedContinuation<Data, Never>) in
            DispatchQueue.global(qos: .userInitiated).async {
                let data = (try? fh.readToEnd()) ?? Data()
                cont.resume(returning: data)
            }
        }
    }

    /// Awaits process exit, racing an optional timeout and honoring task cancellation.
    static func wait(_ process: Process, timeout: Duration?) async throws -> Int32 {
        let exited = Self.exitFuture(process)
        guard let timeout else {
            let code = await withTaskCancellationHandler {
                await exited.value
            } onCancel: {
                Self.reap(process)
            }
            // `withTaskCancellationHandler` does not itself throw: on cancellation the handler reaps
            // the child, but the body still resolves to the termination status. Surface cancellation
            // as `CancellationError` so a reaped-by-cancel run is never reported as a successful exit.
            try Task.checkCancellation()
            return code
        }
        return try await withTaskCancellationHandler {
            try await withThrowingTaskGroup(of: Int32?.self) { group in
                group.addTask { await exited.value }
                group.addTask {
                    try await Task.sleep(for: timeout)
                    return nil
                }
                defer { group.cancelAll() }
                while let result = try await group.next() {
                    if let code = result {
                        // The exit branch resolved first. If that was because cancellation reaped the
                        // child (not a natural exit), propagate cancellation rather than the reap status.
                        try Task.checkCancellation()
                        return code
                    }
                    // Timeout branch fired first. Reap now so the exit-observer child task unblocks
                    // (its `await exited.value` only resolves once the process actually terminates);
                    // otherwise the task group would wait out the full child lifetime before rethrowing.
                    Self.reap(process)
                    throw SpawnError.timedOut(timeout)
                }
                throw SpawnError.timedOut(timeout)
            }
        } onCancel: {
            Self.reap(process)
        }
    }

    /// A `Task` that resolves to the process's termination status exactly once.
    private static func exitFuture(_ process: Process) -> Task<Int32, Never> {
        Task {
            let gate = ResumeGate()
            return await withCheckedContinuation { (cont: CheckedContinuation<Int32, Never>) in
                process.terminationHandler = { proc in
                    if gate.claim() { cont.resume(returning: proc.terminationStatus) }
                }
                // Guard the race where the child exited before the handler was installed.
                if !process.isRunning, gate.claim() {
                    cont.resume(returning: process.terminationStatus)
                }
            }
        }
    }

    /// A one-shot claim guard so an exit continuation is resumed exactly once under the
    /// handler-vs-already-exited race.
    private final class ResumeGate: @unchecked Sendable {
        private let lock = NSLock()
        private var claimed = false
        func claim() -> Bool {
            lock.lock(); defer { lock.unlock() }
            if claimed { return false }
            claimed = true
            return true
        }
    }

    /// SIGTERM, brief grace, then SIGKILL; always reaps to avoid a zombie.
    static func reap(_ process: Process) {
        guard process.isRunning else { return }
        process.terminate() // SIGTERM
        let deadline = Date().addingTimeInterval(2.0)
        while process.isRunning && Date() < deadline {
            usleep(20_000)
        }
        if process.isRunning {
            kill(process.processIdentifier, SIGKILL)
        }
        process.waitUntilExit()
    }
}
