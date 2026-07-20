import Foundation

// MARK: - Daemon reachability

/// A daemon's reachability. `notInstalled` is DERIVED, never guessed: the daemon is unreachable AND its
/// `socketPath` does not exist on disk (a read-only `stat` — no socket is ever opened). A present-but-
/// refusing socket is `unreachable`, not `notInstalled`.
public enum ReachState: Equatable, Sendable {
    case reachable
    case unreachable
    case notInstalled
}

public struct DaemonReachability: Equatable, Sendable {
    public var broker: ReachState
    public var egress: ReachState
    public init(broker: ReachState = .unreachable, egress: ReachState = .unreachable) {
        self.broker = broker
        self.egress = egress
    }
}

// MARK: - UI signals

/// A transition-derived UI signal (banner / badge / empty-state). Pure data — the UI layer (Phase 6)
/// renders these; the router never touches a view.
public enum UISignal: Equatable, Sendable {
    /// Daemon reachability changed; carries the full current reachability.
    case reachability(DaemonReachability)
    /// The ledger attached — a fresh `hello` with `ledger.attached == true`.
    case attached
    /// The ledger is detached (a detached `hello`/`heartbeat`). Not an error — the stream runs detached.
    case detachedLedger
    /// A mid-stream ledger fault (`watch.error(source:"ledger")`): a transient re-attach state awaiting
    /// the next fresh `hello`.
    case reattaching
    /// The audit anchor is degraded (`anchorSource:"sqlite-only"` — broker unreachable for the anchor).
    case anchorDegraded(source: String)
    /// Backup health changed; `false` paints a banner but NEVER blocks the stream.
    case backupHealth(healthy: Bool)
    /// A daemon is not installed (no socket on disk, never reachable) — a distinct empty state pointing
    /// at the provisioning runbook, NOT a fatal error.
    case serviceNotInstalled(daemon: String)
}

// MARK: - TransitionRouter

/// Turns decoded `WatchEvent`s into UI signals for the daemon/detach/degraded surfaces. Transition-only
/// and stateful across events (it remembers the last reachability + attach state so it can emit a signal
/// only on an actual change). It opens no socket — `notInstalled` is derived from a read-only stat.
public struct TransitionRouter: Sendable {
    private var reachability = DaemonReachability()
    private var attached: Bool?
    /// Injected file-existence probe (read-only stat). Defaults to the real filesystem; tests override.
    private let socketExists: @Sendable (String) -> Bool

    public init(socketExists: (@Sendable (String) -> Bool)? = nil) {
        self.socketExists = socketExists ?? { FileManager.default.fileExists(atPath: $0) }
    }

    public mutating func apply(_ event: WatchEvent) -> [UISignal] {
        switch event {
        case .hello(let hello):
            return applyHello(hello)
        case .heartbeat(let hb):
            return applyAttach(hb.ledger.attached)
        case .daemon(let d):
            return applyDaemon(name: d.daemon, reachable: d.reachable, socketPath: d.socketPath)
        case .backup(let b):
            return [.backupHealth(healthy: b.healthy)]
        case .watchError(let e):
            // A ledger-source error is a transient vault-vanish: enter re-attach, await a fresh hello.
            // Invalidate the cached attach state so the awaited fresh `attached` hello RE-EMITS `.attached`
            // (clearing `reattaching` for consumers). Without this, a same-ledger re-attach would find
            // `attached == true` still cached and emit nothing, stranding the UI in `reattaching`.
            if e.source == "ledger" {
                attached = nil
                return [.reattaching]
            }
            return []
        default:
            return []
        }
    }

    // MARK: - Per-event

    private mutating func applyHello(_ hello: HelloPayload) -> [UISignal] {
        var signals: [UISignal] = []
        // Reachability from the snapshot's daemon probes (a hello re-baselines it).
        let daemons = hello.snapshot.daemons
        signals += applyDaemon(name: "broker", reachable: daemons.broker.reachable,
                               socketPath: daemons.broker.socketPath, coalesce: true)
        signals += applyDaemon(name: "egress", reachable: daemons.egress.reachable,
                               socketPath: daemons.egress.socketPath, coalesce: true)
        // A single reachability signal after both probes (the hello re-baseline).
        signals.append(.reachability(reachability))

        // Attach state.
        signals += applyAttach(hello.ledger.attached)

        // Degraded anchor — snapshot-only, present only on an attached hello.
        if let anchorSource = hello.snapshot.audit?.anchorSource, anchorSource == "sqlite-only" {
            signals.append(.anchorDegraded(source: anchorSource))
        }
        return signals
    }

    private mutating func applyAttach(_ isAttached: Bool) -> [UISignal] {
        guard attached != isAttached else { return [] }
        attached = isAttached
        return [isAttached ? .attached : .detachedLedger]
    }

    /// Updates one daemon's reachability. When `coalesce` is true (inside a hello re-baseline) it only
    /// mutates state and returns any `notInstalled` empty-state signal, deferring the single
    /// `.reachability` emit to the caller.
    private mutating func applyDaemon(name: String, reachable: Bool, socketPath: String,
                                      coalesce: Bool = false) -> [UISignal] {
        let newState: ReachState
        if reachable {
            newState = .reachable
        } else {
            // Unreachable AND no socket on disk ⇒ not installed; present-but-refusing ⇒ unreachable.
            newState = socketExists(socketPath) ? .unreachable : .notInstalled
        }

        let changed: Bool
        switch name {
        case "broker": changed = reachability.broker != newState; reachability.broker = newState
        case "egress": changed = reachability.egress != newState; reachability.egress = newState
        default: return []
        }

        var signals: [UISignal] = []
        if newState == .notInstalled, changed {
            signals.append(.serviceNotInstalled(daemon: name))
        }
        if !coalesce, changed {
            signals.append(.reachability(reachability))
        }
        return signals
    }

    /// The current reachability (for the UI to read on focus).
    public var currentReachability: DaemonReachability { reachability }
}
