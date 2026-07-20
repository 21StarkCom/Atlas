import ConsoleCore
import ConsoleUI

// Phase-1/5 executable entry. The @main SwiftUI App scene is assembled in Phase 6; for now this is a
// buildable, launchable executable the assemble-app.sh script packages into the .app bundle.
//
// The startup sweep runs FIRST, before anything else and before any privileged flow can begin: a crash or
// kill during a previous session can leave a signed authorization artifact behind in a per-flow temp dir,
// and the crash-leftover contract requires that sweep to be wired into the real launch path — not merely
// defined and exercised by a unit test. Phase 6 keeps this as the first statement of its App init.
ConsoleLaunch.performStartupCleanup()

print(ConsoleUI.identity)
