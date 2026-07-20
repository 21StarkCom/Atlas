import SwiftUI
import ConsoleCore

// The pure presentation layer — the accessibility substance a SwiftPM `swift test` run CAN host without
// an XCUI host. Every stateful indicator resolves to BOTH an SF Symbol AND text (never color-only), and
// every displayed value is control-safe. Views consume these; `AccessibilityAcceptanceTests` asserts on
// them directly (the launched-host checks — Full Keyboard Access, modal focus, the VoiceOver pass — are
// the documented manual live-drive checklist).

/// An indicator's redundant (symbol + text) presentation. The symbol is the icon; `text` is the label —
/// so information is never carried by color alone.
public struct StatusBadge: Equatable, Sendable {
    public let symbol: String
    public let text: String
    /// A semantic tint (advisory only — never the SOLE carrier of meaning; `symbol`+`text` are).
    public let tint: StatusTint
    public init(symbol: String, text: String, tint: StatusTint) {
        self.symbol = symbol; self.text = text; self.tint = tint
    }
}

public enum StatusTint: Equatable, Sendable { case ok, warn, bad, neutral }

public enum StatusPresentation {
    /// Daemon reachability — icon + text, distinct per state.
    public static func reachability(_ state: ReachState) -> StatusBadge {
        switch state {
        case .reachable: return StatusBadge(symbol: "checkmark.circle.fill", text: "Reachable", tint: .ok)
        case .unreachable: return StatusBadge(symbol: "exclamationmark.triangle.fill", text: "Unreachable", tint: .bad)
        case .notInstalled: return StatusBadge(symbol: "questionmark.circle", text: "Not installed", tint: .neutral)
        }
    }

    /// A job state — icon + text, distinct per queued/running/failed/succeeded/other.
    public static func jobState(_ state: String) -> StatusBadge {
        switch state {
        case "failed": return StatusBadge(symbol: "xmark.octagon.fill", text: "Failed", tint: .bad)
        case "running": return StatusBadge(symbol: "arrow.triangle.2.circlepath", text: "Running", tint: .neutral)
        case "pending", "ready": return StatusBadge(symbol: "clock", text: "Queued", tint: .neutral)
        case "succeeded", "completed", "done": return StatusBadge(symbol: "checkmark.circle.fill", text: "Succeeded", tint: .ok)
        default: return StatusBadge(symbol: "circle", text: state, tint: .neutral)
        }
    }

    /// Backup health — icon + text.
    public static func backup(healthy: Bool) -> StatusBadge {
        healthy
            ? StatusBadge(symbol: "externaldrive.fill.badge.checkmark", text: "Backup healthy", tint: .ok)
            : StatusBadge(symbol: "externaldrive.fill.badge.exclamationmark", text: "Backup unhealthy", tint: .bad)
    }

    /// The audit-anchor state — icon + text.
    public static func anchor(ok: Bool?, source: String?) -> StatusBadge {
        if source == "sqlite-only" {
            return StatusBadge(symbol: "exclamationmark.shield", text: "Anchor degraded (sqlite-only)", tint: .warn)
        }
        switch ok {
        case .some(true): return StatusBadge(symbol: "checkmark.shield.fill", text: "Anchor OK", tint: .ok)
        case .some(false): return StatusBadge(symbol: "xmark.shield.fill", text: "Anchor failed", tint: .bad)
        case .none: return StatusBadge(symbol: "shield", text: "Anchor unknown", tint: .neutral)
        }
    }
}

public enum DashboardPresentation {
    /// The "as of <hello.at>" label for snapshot-only fields — never fabricated between hellos.
    public static func asOfLabel(_ snapshotAsOf: String) -> String {
        snapshotAsOf.isEmpty ? "as of (awaiting first hello)" : "as of \(ControlSafeText.plain(snapshotAsOf))"
    }

    /// Render a snapshot-only integer field: its value, or an explicit "as of" placeholder when absent —
    /// NEVER a fabricated `0`.
    public static func snapshotOnly(_ value: Int?, snapshotAsOf: String) -> String {
        guard let value else { return asOfLabel(snapshotAsOf) }
        return "\(value) (\(asOfLabel(snapshotAsOf)))"
    }
}

extension StatusTint {
    /// The advisory color. Meaning is carried by symbol + text; this is decoration that reads in both
    /// light and dark appearances (system semantic colors adapt automatically).
    var color: Color {
        switch self {
        case .ok: return .green
        case .warn: return .orange
        case .bad: return .red
        case .neutral: return .secondary
        }
    }
}
