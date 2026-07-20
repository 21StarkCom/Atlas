import SwiftUI
import ConsoleCore

// P6-Task-2 — banners, badges, and empty states. Each carries a redundant icon+text (no color-only),
// an accessibility label, and (for the retry/failed states) the transient diagnostics the contract
// requires surfaced (attempt / next-retry / exit / code / hint / stderr).

extension JobListRowState: Identifiable {
    public var id: String { jobId }
}

/// The watch-retry banner: attempt count, the next-retry wall-clock instant, and the last exit/code — all
/// rendered visibly AND in the accessibility label (none of the three transient diagnostics is dropped).
public struct RetryBanner: View {
    let attempt: Int
    let nextAtEpochMs: Int
    let lastCode: String
    public init(attempt: Int, nextAtEpochMs: Int, lastCode: String) {
        self.attempt = attempt; self.nextAtEpochMs = nextAtEpochMs; self.lastCode = lastCode
    }

    /// The next-retry instant as a local wall-clock time (`Int.max`/overflowed sentinel ⇒ "unknown").
    static func nextRetryText(_ epochMs: Int) -> String {
        guard epochMs != Int.max, epochMs > 0 else { return "unknown" }
        let date = Date(timeIntervalSince1970: Double(epochMs) / 1000.0)
        let fmt = DateFormatter()
        fmt.dateFormat = "HH:mm:ss"
        return fmt.string(from: date)
    }

    public var body: some View {
        let next = Self.nextRetryText(nextAtEpochMs)
        return Label {
            Text("Watch retrying — attempt \(attempt), next retry \(next), last: \(ControlSafeText.plain(lastCode))")
        } icon: {
            Image(systemName: "arrow.triangle.2.circlepath").foregroundStyle(.orange)
        }
        .padding(8)
        .background(.orange.opacity(0.12))
        .accessibilityLabel("Watch connection retrying, attempt \(attempt), next retry at \(next), last error \(ControlSafeText.plain(lastCode))")
    }
}

/// The backup-unhealthy → restore-required banner. Surfaced when the watch reports backup is unhealthy or
/// a restore event lands, pointing the operator at the privileged `db restore` flow.
public struct RestoreBanner: View {
    let watermarkSeq: Int?
    public init(watermarkSeq: Int? = nil) { self.watermarkSeq = watermarkSeq }
    public var body: some View {
        Label {
            VStack(alignment: .leading, spacing: 2) {
                Text("Backup unhealthy — restore required").font(.headline)
                if let seq = watermarkSeq {
                    Text("Ledger writes are blocked until the backup watermark catches up (at seq \(seq)). Use the Actions tab to run `db restore`.")
                        .font(.callout).foregroundStyle(.secondary)
                }
            }
        } icon: {
            Image(systemName: "externaldrive.badge.exclamationmark").foregroundStyle(.red)
        }
        .padding(8)
        .background(.red.opacity(0.12))
        .accessibilityElement(children: .combine)
        // Mirror the FULL visible content: the seq (to reconcile against `db status`) and the
        // Actions-tab/db-restore route must reach a screen-reader operator too.
        .accessibilityLabel(watermarkSeq.map {
            "Backup unhealthy, restore required. Ledger writes are blocked until the backup watermark catches up, at seq \($0). Use the Actions tab to run db restore."
        } ?? "Backup unhealthy, restore required. Ledger writes are blocked until the backup recovers. Use the Actions tab to run db restore.")
    }
}

/// The terminal watch-failed state: exit + code + hint + captured stderr — none discarded.
public struct WatchFailedView: View {
    let exit: Int32
    let code: String
    let hint: String?
    let stderr: String
    public init(exit: Int32, code: String, hint: String?, stderr: String) {
        self.exit = exit; self.code = code; self.hint = hint; self.stderr = stderr
    }
    public var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Label("Watch failed", systemImage: "bolt.horizontal.circle.fill")
                .foregroundStyle(.red).font(.headline)
                .accessibilityAddTraits(.isHeader)
            Text("Exit \(exit) · \(ControlSafeText.plain(code))")
            if let hint, !hint.isEmpty { Text("Hint: \(ControlSafeText.plain(hint))").foregroundStyle(.secondary) }
            if !stderr.isEmpty {
                Text("stderr").font(.caption).foregroundStyle(.secondary)
                ScrollView { Text(ControlSafeText.plain(stderr)).font(.system(.caption, design: .monospaced)) }
                    .frame(maxHeight: 120)
            }
        }
        .padding()
        .accessibilityLabel("Watch failed, exit \(exit), \(ControlSafeText.plain(code))")
    }
}

/// The distinct "service not installed" empty state (→ provisioning runbook), NOT a fatal error.
public struct ServiceNotInstalledView: View {
    let daemon: String
    public init(daemon: String) { self.daemon = daemon }
    public var body: some View {
        VStack(spacing: 8) {
            Image(systemName: "questionmark.circle").font(.largeTitle).foregroundStyle(.secondary)
            Text("\(ControlSafeText.plain(daemon)) service not installed")
                .font(.headline)
            Text("Install and load the Atlas daemons (see the provisioning runbook, PR #206), then relaunch.")
                .font(.callout).foregroundStyle(.secondary).multilineTextAlignment(.center)
        }
        .padding()
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(ControlSafeText.plain(daemon)) service not installed. See the provisioning runbook.")
    }
}

/// The quarantine badge (a count).
public struct QuarantineBadge: View {
    let count: Int
    public init(count: Int) { self.count = count }
    public var body: some View {
        Label("\(count) quarantined", systemImage: "lock.shield")
            .foregroundStyle(count > 0 ? .orange : .secondary)
            .accessibilityLabel("\(count) items quarantined")
    }
}

/// The evidence-retry badge (a count of enqueued retries).
public struct EvidenceRetryBadge: View {
    let count: Int
    public init(count: Int) { self.count = count }
    public var body: some View {
        Label("\(count) evidence retries", systemImage: "arrow.clockwise")
            .foregroundStyle(count > 0 ? .orange : .secondary)
            .accessibilityLabel("\(count) evidence retries enqueued")
    }
}
