import Foundation

// MARK: - Resume / replay / cursor selection
//
// Chooses the `--since-seq` argument from the persisted cursor + the user's resume mode, and decides
// whether a cursor is stale (above the ledger's head). The cursor is scoped to the run.* seq space; an
// empty-ledger cursor is `-1`. The safe-to-persist point is the post-replay checkpoint heartbeat — the
// planner only selects the resume ARG; persistence timing is the store's (Phase 4) concern.

/// The resume behaviour, from `Settings.resumeMode` (default `.resume`). `String`-backed Codable so the
/// Phase-4 `Settings` blob round-trips it.
public enum ResumeMode: String, Codable, Sendable, Equatable, CaseIterable {
    /// Resume forward from the persisted cursor (live-only if none yet).
    case resume
    /// Replay the entire run.* space (`--since-seq -1`).
    case replayAll
    /// No replay; live only (the cursor is still checkpointed for a later `resume`).
    case liveOnly
}

/// The chosen `brain watch` resume argument.
public enum ResumeArg: Equatable, Sendable {
    /// `--since-seq <seq>` (`-1` = replay all).
    case sinceSeq(Int)
    /// No `--since-seq` flag — the CLI streams live only.
    case liveOnly
}

public enum ResumePlanner {
    /// Select the resume argument. `resume` → a persisted cursor `>= 0` yields `.sinceSeq(cursor)`, else
    /// `.liveOnly`; `replayAll` → `.sinceSeq(-1)`; `liveOnly` → `.liveOnly`.
    public static func plan(mode: ResumeMode, persistedCursor: Int?) -> ResumeArg {
        switch mode {
        case .replayAll:
            return .sinceSeq(-1)
        case .liveOnly:
            return .liveOnly
        case .resume:
            if let cursor = persistedCursor, cursor >= 0 { return .sinceSeq(cursor) }
            return .liveOnly
        }
    }

    /// A cursor is stale (points above the ledger's head) iff the replay window came back empty AND the
    /// reported head is below what we requested: `replayEvents == 0 && resumeHead < requested`. This is
    /// the cursor-above-head case only (a re-clone whose replacement head sits below the stale cursor);
    /// the catch-up-past-cursor case is the accepted V1 residual (escape via `replayAll`).
    public static func isStaleCursor(replayEvents: Int, resumeHead: Int, requested: Int) -> Bool {
        replayEvents == 0 && resumeHead < requested
    }
}
