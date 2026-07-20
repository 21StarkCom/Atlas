import Foundation

/// The application-startup composition seam. The `@main` executable (Phase 6) calls
/// `ConsoleLaunch.performStartupCleanup()` exactly once, before any privileged flow can begin, so a crash
/// or kill during a previous session cannot leave a signed authorization artifact behind in a per-flow
/// temp dir. This is the required launch cleanup for `PrivilegedFlow`'s crash-leftover contract: the
/// sweep is wired into the launch path, not merely defined.
public enum ConsoleLaunch {
    /// Remove every leftover per-flow directory under the privileged-flow cache root. Idempotent and
    /// tolerant of an absent root (a first launch has nothing to sweep). Defaults to the production flows
    /// root; tests inject a throwaway root to assert stale dirs are removed.
    public static func performStartupCleanup(flowsRoot: URL = PrivilegedFlow.defaultFlowsRoot) {
        PrivilegedFlow.sweepLeftoverFlows(root: flowsRoot)
    }
}
