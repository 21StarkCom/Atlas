import SwiftUI
import ConsoleCore

// P6-Task-1 — the dashboard / jobs / audit-timeline / model-call surfaces, bound to the reducers.
// Every stateful indicator carries a redundant icon+text badge (no color-only encoding); snapshot-only
// fields are labelled "as of <hello.at>"; the audit timeline + model-call feed are list/table forms
// (no chart-only encoding). Detail-on-demand reads fire only on user focus/action, never a timer.

/// A reusable, accessibility-labelled status badge (icon + text; color is decoration only).
public struct StatusBadgeView: View {
    let badge: StatusBadge
    public init(_ badge: StatusBadge) { self.badge = badge }
    public var body: some View {
        Label {
            Text(badge.text)
        } icon: {
            Image(systemName: badge.symbol).foregroundStyle(badge.tint.color)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(badge.text)
    }
}

// MARK: - Dashboard

public struct DashboardView: View {
    let state: DashboardState
    let reachability: DaemonReachability
    public init(state: DashboardState, reachability: DaemonReachability = DaemonReachability()) {
        self.state = state
        self.reachability = reachability
    }

    public var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Text("Health").font(.title2).bold()
                    .accessibilityAddTraits(.isHeader)

                Grid(alignment: .leading, horizontalSpacing: 24, verticalSpacing: 10) {
                    row("Open runs", value: state.openRuns.map(String.init) ?? DashboardPresentation.asOfLabel(state.snapshotAsOf))
                    row("Jobs queued", value: state.jobs.map { String($0.queued) } ?? "—")
                    row("Jobs failed", value: state.jobs.map { String($0.failed) } ?? "—")
                    row("Quarantine", value: DashboardPresentation.snapshotOnly(state.quarantineCount, snapshotAsOf: state.snapshotAsOf))
                }

                if let backup = state.backup {
                    StatusBadgeView(StatusPresentation.backup(healthy: backup.healthy))
                    Text("Watermark \(backup.watermarkSeq)"
                        + (backup.coveredSeq.map { " · covered \($0) (\(DashboardPresentation.asOfLabel(state.snapshotAsOf)))" } ?? ""))
                        .font(.caption).foregroundStyle(.secondary)
                }

                if let audit = state.audit {
                    // `anchorOk`/`anchorSource` are SNAPSHOT-ONLY (held at the last hello, never live), so
                    // they must carry their "as of <hello.at>" provenance — visibly and to assistive tech —
                    // rather than reading as a current verdict. `headSeq` IS live-updated, so it does not.
                    StatusBadgeView(StatusPresentation.anchor(ok: audit.anchorOk, source: audit.anchorSource))
                        .accessibilityLabel(
                            "Audit anchor \(StatusPresentation.anchor(ok: audit.anchorOk, source: audit.anchorSource).text), "
                            + DashboardPresentation.asOfLabel(state.snapshotAsOf))
                    Text("Anchor \(DashboardPresentation.asOfLabel(state.snapshotAsOf))")
                        .font(.caption).foregroundStyle(.secondary)
                    Text("Audit head seq \(audit.headSeq)")
                        .font(.caption).foregroundStyle(.secondary)
                }

                Divider()
                Text("Daemons").font(.headline).accessibilityAddTraits(.isHeader)
                HStack(spacing: 24) {
                    daemon("Broker", reachability.broker)
                    daemon("Egress", reachability.egress)
                }
            }
            .padding()
        }
        .accessibilityLabel("Dashboard")
    }

    @ViewBuilder private func row(_ label: String, value: String) -> some View {
        GridRow {
            Text(label).foregroundStyle(.secondary)
            Text(value).accessibilityLabel("\(label): \(value)")
        }
    }

    @ViewBuilder private func daemon(_ name: String, _ state: ReachState) -> some View {
        VStack(alignment: .leading) {
            Text(name).font(.subheadline)
            StatusBadgeView(StatusPresentation.reachability(state))
        }
    }
}

// MARK: - Jobs list

public struct JobsListView: View {
    let rows: [JobListRowState]
    /// The explicit read-on-focus refresh action (never a timer).
    var onRefresh: (() -> Void)?
    /// The last refresh failure, rendered so a failed read is visible rather than silently leaving stale
    /// rows on screen.
    var refreshError: String?
    public init(rows: [JobListRowState], onRefresh: (() -> Void)? = nil, refreshError: String? = nil) {
        self.rows = rows
        self.onRefresh = onRefresh
        self.refreshError = refreshError
    }

    public var body: some View {
        VStack(alignment: .leading) {
            HStack {
                Text("Jobs").font(.title2).bold().accessibilityAddTraits(.isHeader)
                Spacer()
                if let refreshError {
                    Text("Refresh failed: \(refreshError)")
                        .font(.caption).foregroundStyle(.red)
                        .accessibilityLabel("Jobs refresh failed: \(refreshError)")
                }
                if let onRefresh {
                    Button("Refresh", action: onRefresh)
                        .accessibilityLabel("Refresh jobs list")
                }
            }
            Table(rows) {
                TableColumn("Job") { Text(ControlSafeText.plain($0.jobId)) }
                TableColumn("Workflow") { Text(ControlSafeText.plain($0.workflow)) }
                TableColumn("State") { StatusBadgeView(StatusPresentation.jobState($0.state)) }
                TableColumn("Attempts") { Text("\($0.attempts)/\($0.maxAttempts)") }
            }
        }
        .padding()
        .accessibilityLabel("Jobs list")
    }
}

// MARK: - Audit timeline (list/table primary form — no chart-only encoding)

public struct AuditTimelineView: View {
    let rows: [AuditPayload]
    /// Selection → focus wiring: selecting a run row records it as the current focus (so the Actions
    /// surface can pre-fill the run-scoped operands). Never a timer; only a user selection.
    var onSelect: ((AuditPayload) -> Void)?
    @State private var selection: AuditPayload.ID?
    public init(rows: [AuditPayload], onSelect: ((AuditPayload) -> Void)? = nil) {
        self.rows = rows
        self.onSelect = onSelect
    }

    public var body: some View {
        VStack(alignment: .leading) {
            Text("Audit timeline").font(.title2).bold().accessibilityAddTraits(.isHeader)
            Table(rows, selection: $selection) {
                TableColumn("Seq") { Text("\($0.seq)") }
                TableColumn("Run") { Text(ControlSafeText.plain($0.runId)) }
                TableColumn("Event") { Text(ControlSafeText.plain($0.eventType)) }
                TableColumn("Time") { Text(ControlSafeText.plain($0.createdAt)) }
            }
            .onChange(of: selection) { _, newValue in
                guard let id = newValue, let row = rows.first(where: { $0.id == id }) else { return }
                onSelect?(row)
            }
        }
        .padding()
        .accessibilityLabel("Audit timeline")
    }
}

extension AuditPayload: Identifiable {
    public var id: Int { seq }
}

// MARK: - Model-call feed (live, insert-only, session-scoped)

public struct ModelCallFeedView: View {
    let calls: [ModelCallPayload]
    public init(calls: [ModelCallPayload]) { self.calls = calls }

    public var body: some View {
        VStack(alignment: .leading) {
            Text("Model calls").font(.title2).bold().accessibilityAddTraits(.isHeader)
            Table(calls) {
                TableColumn("Provider") { Text(ControlSafeText.plain($0.provider)) }
                TableColumn("Model") { Text(ControlSafeText.plain($0.model)) }
                TableColumn("Operation") { Text(ControlSafeText.plain($0.operation)) }
                TableColumn("Tokens") { Text("\($0.inputTokens)/\($0.outputTokens)") }
                TableColumn("Cost µ$") { Text("\($0.costMicros)") }
            }
        }
        .padding()
        .accessibilityLabel("Model-call feed")
    }
}

extension ModelCallPayload: Identifiable {
    public var id: String { callId }
}
