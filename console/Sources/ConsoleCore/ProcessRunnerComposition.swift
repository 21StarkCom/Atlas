import Foundation

/// The composition root for subprocess launching. It constructs the ONE shared `SystemProcessRunner`,
/// wraps it once in the `LoggingProcessRunner` decorator, and exposes ONLY the wrapped runner — typed
/// as the `ProcessRunner` protocol so callers cannot downcast to the inner runner. Every downstream
/// component (`WatchSupervisor`, `AttachCoordinator`, `PrivilegedFlow`, …) receives `runner` from here,
/// so "every spawn routes through sanitized logging" is structural: no component can obtain an
/// unwrapped `SystemProcessRunner` and bypass the logging seam.
///
/// Per-command sanitization rides each `SpawnRequest` (`command` + `commandSchema`), so the single
/// wrapped runner handles every command without re-wrapping.
public struct ProcessRunnerComposition {
    /// The shared, logging-wrapped runner every component receives. Deliberately typed as the protocol
    /// (not `LoggingProcessRunner`) and backed by a `private` inner runner, so there is no API path to
    /// the unwrapped runner.
    public let runner: ProcessRunner

    /// - Parameter sink: where spawn/termination/failure records go (default: the production
    ///   `os.Logger`-backed `ConsoleLogSink`). Tests inject a recording sink.
    public init(sink: SpawnLogging = ConsoleLogSink()) {
        self.runner = LoggingProcessRunner(wrapping: SystemProcessRunner(), sink: sink)
    }
}
