import Foundation

/// The terminal result of a streamed process: its exit code and the full captured stderr.
/// `stderr` is NEVER swallowed — the supervisor/UI surface it on the error state (§behavior).
public struct StreamCompletion: Sendable {
    public let exitCode: Int32
    public let stderr: Data
    public init(exitCode: Int32, stderr: Data) {
        self.exitCode = exitCode
        self.stderr = stderr
    }
}

/// Long-lived stream reader for `brain watch`. Exposes **raw byte chunks** (not lines — framing is
/// `NDJSONFramer`'s job) and a `completion()` that resolves to the exit code + stderr after the
/// process exits. This separation lets the framer be unit-tested against adversarial chunking while
/// the supervisor branches on the exit code independently.
public final class StreamHandle: @unchecked Sendable {
    /// Raw stdout chunks as read from the pipe, in order. Finishes when stdout reaches EOF.
    public let bytes: AsyncThrowingStream<Data, Error>

    private let process: Process
    private let lock = NSLock()
    // Single stderr drain owner: only the stderr readability handler ever appends to this buffer,
    // and completion is frozen ONLY once that handler has reached EOF (see `stderrAtEOF`). This closes
    // the race where the termination handler snapshotted the buffer while a readability callback had
    // read a chunk but not yet appended it.
    private var stderrBuffer = Data()
    private var stderrAtEOF = false
    private var exitCode: Int32?
    private var completionResult: StreamCompletion?
    private var completionWaiters: [CheckedContinuation<StreamCompletion, Never>] = []

    init(process: Process, stdout: Pipe, stderr: Pipe) {
        self.process = process

        var cont: AsyncThrowingStream<Data, Error>.Continuation!
        self.bytes = AsyncThrowingStream { cont = $0 }
        let continuation = cont!

        stdout.fileHandleForReading.readabilityHandler = { fh in
            let chunk = fh.availableData
            if chunk.isEmpty {
                fh.readabilityHandler = nil
                continuation.finish()
            } else {
                continuation.yield(chunk)
            }
        }

        // The stderr handler is the SOLE reader of the stderr pipe. On the empty read (EOF, delivered
        // once the child's write end closes at exit) it marks EOF and attempts completion.
        stderr.fileHandleForReading.readabilityHandler = { [weak self] fh in
            let chunk = fh.availableData
            if chunk.isEmpty {
                fh.readabilityHandler = nil
                self?.markStderrEOF()
            } else {
                self?.appendStderr(chunk)
            }
        }

        process.terminationHandler = { [weak self] proc in
            self?.setExit(proc.terminationStatus)
        }
    }

    /// Resolves after process exit, exactly once, with the exit code and the full captured stderr.
    /// Safe to call before or after exit, and from multiple awaiters.
    public func completion() async -> StreamCompletion {
        await withCheckedContinuation { (cont: CheckedContinuation<StreamCompletion, Never>) in
            lock.lock()
            if let result = completionResult {
                lock.unlock()
                cont.resume(returning: result)
            } else {
                completionWaiters.append(cont)
                lock.unlock()
            }
        }
    }

    /// SIGTERM — a clean detach that `brain watch` reports as exit 0.
    public func terminate() {
        if process.isRunning { process.terminate() }
    }

    private func appendStderr(_ chunk: Data) {
        lock.lock(); defer { lock.unlock() }
        stderrBuffer.append(chunk)
    }

    private func markStderrEOF() {
        lock.lock()
        stderrAtEOF = true
        attemptCompletionLocked()
    }

    private func setExit(_ code: Int32) {
        lock.lock()
        if exitCode == nil { exitCode = code }
        attemptCompletionLocked()
    }

    /// Freezes completion iff BOTH the process has exited AND stderr has reached EOF, so no stderr
    /// chunk can arrive after the snapshot. Must be called with `lock` held; it unlocks before
    /// resuming waiters.
    private func attemptCompletionLocked() {
        guard completionResult == nil, let code = exitCode, stderrAtEOF else {
            lock.unlock()
            return
        }
        let result = StreamCompletion(exitCode: code, stderr: stderrBuffer)
        completionResult = result
        let waiters = completionWaiters
        completionWaiters.removeAll()
        lock.unlock()
        for w in waiters { w.resume(returning: result) }
    }
}
