import SwiftUI
import ConsoleCore
import ConsoleUI

// P6-Task-4 — the real @main SwiftUI App scene (replaces the Phase-1 identity-printing stub).
//
// The startup sweep runs FIRST, before anything else and before any privileged flow can begin: a crash
// or kill during a previous session can leave a signed authorization artifact behind in a per-flow temp
// dir, and the crash-leftover contract requires that sweep to be wired into the real launch path. It is
// the first statement of the App's init — no window, model, or flow exists yet when it runs.
@main
struct AtlasConsoleApp: App {
    @State private var model: AppModel

    init() {
        // FIRST: sweep any leftover per-flow authorization artifacts from a prior crash/kill.
        ConsoleLaunch.performStartupCleanup()
        // Only then construct the app model (its `launch()` — settings → resolve → wire → start — runs
        // from the root view's `.task`, so the sweep always precedes any flow).
        _model = State(initialValue: AppModel())
    }

    var body: some Scene {
        // A SINGLETON `Window` (not `WindowGroup`): the model owns non-idempotent session/watcher state,
        // and a `WindowGroup` would let the user open a second window whose `MainWindow.task` runs
        // `launch()` again — spawning an overlapping session/watcher and overwriting the retained task
        // handles. One window ⇒ one composition root ⇒ one watcher. (`launch()` is ALSO single-flight, so
        // even a repeated `.task` invocation cannot double-start.)
        Window("Atlas Console", id: "main") {
            MainWindow(model: model)
        }
    }
}
