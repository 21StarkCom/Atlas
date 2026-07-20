import SwiftUI
import ConsoleCore

// P6-Task-4 — the root scene content. Renders the app phase (probing / blocked / setup / running); in
// the running phase it presents the surfaces in a tabbed cockpit, overlays the control-plane banners,
// and drives the challenge modal from the mirrored flow state. Keyboard-drivable end to end.

public struct MainWindow: View {
    @Bindable var model: AppModel
    public init(model: AppModel) { self.model = model }

    public var body: some View {
        Group {
            switch model.phase {
            case .probing:
                ProgressView("Connecting to Atlas…")
                    .accessibilityLabel("Connecting to Atlas")
            case .setupNeeded:
                SetupNeededView(model: model)
            case .blocked(let reason, let path, let remediation):
                BlockedView(reason: reason, path: path, remediation: remediation)
            case .running:
                cockpit
            }
        }
        .task { await model.launch() }
        .frame(minWidth: 720, minHeight: 480)
    }

    private var cockpit: some View {
        VStack(spacing: 0) {
            bannerBar
            TabView {
                DashboardView(state: model.dashboard, reachability: model.banners.reachability)
                    .tabItem { Label("Dashboard", systemImage: "gauge") }
                JobsListView(rows: model.jobRows,
                             onRefresh: { Task { await model.refreshJobs() } },
                             refreshError: model.jobsError)
                    .tabItem { Label("Jobs", systemImage: "list.bullet.rectangle") }
                AuditTimelineView(rows: model.auditTimeline, onSelect: { model.selectAuditFocus($0) })
                    .tabItem { Label("Audit", systemImage: "clock.arrow.circlepath") }
                ModelCallFeedView(calls: model.modelCalls)
                    .tabItem { Label("Model calls", systemImage: "brain") }
                ActionsView(model: model)
                    .tabItem { Label("Actions", systemImage: "key.horizontal") }
                QueryView(model: model)
                    .tabItem { Label("Query", systemImage: "magnifyingglass") }
                SettingsView(model: model)
                    .tabItem { Label("Settings", systemImage: "gearshape") }
            }
        }
    }

    @ViewBuilder private var bannerBar: some View {
        VStack(alignment: .leading, spacing: 4) {
            // A corrupt persisted-settings blob was replaced by defaults at load. The composition root
            // requires this to be SURFACED and dismissible — it was previously stored on the model but
            // never rendered, so the operator silently ran on substituted defaults.
            if model.settingsNotice == .resetFromCorrupt {
                HStack {
                    Label("Settings were unreadable and have been reset to defaults.",
                          systemImage: "exclamationmark.triangle")
                        .accessibilityLabel("Settings were unreadable and have been reset to defaults")
                    Button("Dismiss") { model.dismissSettingsNotice() }
                        .accessibilityLabel("Dismiss settings reset notice")
                }
            }
            // Backup unhealthy OR a restore event ⇒ the restore-required surface (points at db restore).
            if model.banners.backupHealthy == false || model.banners.restoreObserved {
                RestoreBanner(watermarkSeq: model.dashboard.backup?.watermarkSeq)
            }
            if let q = model.dashboard.quarantineCount, q > 0 { QuarantineBadge(count: q) }
            if model.banners.evidenceRetryCount > 0 { EvidenceRetryBadge(count: model.banners.evidenceRetryCount) }
            if model.banners.reattaching {
                Label("Re-attaching to ledger…", systemImage: "arrow.triangle.2.circlepath")
                    .accessibilityLabel("Re-attaching to ledger")
            }
            if let src = model.banners.anchorDegradedSource {
                StatusBadgeView(StatusPresentation.anchor(ok: false, source: src))
            }
            ForEach(Array(model.banners.servicesNotInstalled).sorted(), id: \.self) { d in
                ServiceNotInstalledView(daemon: d)
            }
            switch model.supervisorState {
            case .retrying(let attempt, let nextAt, let code):
                RetryBanner(attempt: attempt, nextAtEpochMs: nextAt, lastCode: code)
            case .failed(let exit, let code, let hint, let stderr):
                WatchFailedView(exit: exit, code: code, hint: hint, stderr: stderr)
            case .contractMismatch(let stage, let stderr):
                WatchFailedView(exit: -1, code: "contract-mismatch:\(stage)", hint: nil, stderr: stderr)
            default:
                EmptyView()
            }
        }
        .padding(.horizontal)
    }
}

/// Blocking setup state: no atlasRoot/override/env — prompt for the checkout.
public struct SetupNeededView: View {
    @Bindable var model: AppModel
    public init(model: AppModel) { self.model = model }
    public var body: some View {
        VStack(spacing: 12) {
            Image(systemName: "folder.badge.questionmark").font(.largeTitle).foregroundStyle(.secondary)
            Text("Atlas checkout not configured").font(.headline)
            Text("Set the Atlas checkout root (or ATLAS_ROOT) so the Console can resolve `brain` and `atlas-signer`.")
                .multilineTextAlignment(.center).foregroundStyle(.secondary)
            SettingsView(model: model)
        }
        .padding()
        .accessibilityLabel("Atlas checkout not configured. Open settings to set the checkout root.")
    }
}

/// Blocking "unavailable" error state: naming the path + remediation (fail-fast, no fallthrough).
public struct BlockedView: View {
    let reason: String
    let path: String
    let remediation: String
    public init(reason: String, path: String, remediation: String) {
        self.reason = reason; self.path = path; self.remediation = remediation
    }
    public var body: some View {
        VStack(spacing: 10) {
            Image(systemName: "exclamationmark.triangle.fill").font(.largeTitle).foregroundStyle(.red)
            Text("Atlas unavailable").font(.headline).accessibilityAddTraits(.isHeader)
            Text(ControlSafeText.render(reason))
            if !path.isEmpty { Text(ControlSafeText.render(path)).font(.system(.caption, design: .monospaced)) }
            Text(ControlSafeText.render(remediation)).foregroundStyle(.secondary).multilineTextAlignment(.center)
        }
        .padding()
        .accessibilityElement(children: .combine)
        // The blocked contract NAMES the failing path — the label must carry it too, or a screen-reader
        // operator hears an unactionable remediation with no way to learn which path failed.
        .accessibilityLabel(path.isEmpty
            ? "Atlas unavailable: \(ControlSafeText.plain(reason)). \(ControlSafeText.plain(remediation))"
            : "Atlas unavailable: \(ControlSafeText.plain(reason)). Path \(ControlSafeText.plain(path)). \(ControlSafeText.plain(remediation))")
    }
}
