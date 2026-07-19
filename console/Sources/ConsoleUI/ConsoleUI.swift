import ConsoleCore

/// Phase-1 placeholder for the SwiftUI view layer (filled in Phase 6). Kept minimal but real so the
/// module graph `ConsoleCore ← ConsoleUI ← AtlasConsole` is exercised from the start.
public enum ConsoleUI {
    /// A human-readable identity string; proves ConsoleUI links against ConsoleCore.
    public static var identity: String {
        "Atlas Console (\(ConsoleConstants.bundleIdentifier))"
    }
}
