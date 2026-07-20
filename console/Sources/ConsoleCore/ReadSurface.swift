import Foundation

// P5-Task-5 — the runtime read-surface inventory + cadence/drift invariants that keep the Console
// honest. Nothing here is a prose list: the read surface is inventoried at runtime from the bound
// `ContractBundle` filtered by `executionClass`.

/// The read-only execution classes the Console may invoke on user focus/action (never a write path).
public enum ReadSurface {
    /// The three execution classes that make up the read surface: `read` + `audited-read` + `pure`.
    public static let readExecutionClasses: Set<String> = ["read", "audited-read", "pure"]

    /// The runtime-inventoried read surface — every command whose `executionClass` is read/audited-read/
    /// pure. The V1 count is 25 (17 read + 4 audited-read + 4 pure).
    public static func readCommands(_ bundle: ContractBundle) -> [CommandRow] {
        bundle.commands.filter { readExecutionClasses.contains($0.executionClass) }
    }

    /// The audited-read subset — commands that DO touch the ledger read-path and so must never run on a
    /// timer (`status`, `inspect`, `graduation audit`, `query`).
    public static func auditedReadCommands(_ bundle: ContractBundle) -> [CommandRow] {
        bundle.commands.filter { $0.executionClass == "audited-read" }
    }
}

/// The cadence guard: the ONLY periodic subprocess the Console ever schedules is `brain watch`. No
/// audited read runs on a timer — detail-on-demand reads are user-focus/action triggered only.
public enum CadencePolicy {
    /// The sole registered periodic task's command name.
    public static let periodicCommands: Set<String> = ["watch"]

    /// True iff `command` is allowed to be scheduled on a timer. Only `watch` qualifies.
    public static func isPeriodicAllowed(_ command: String) -> Bool {
        periodicCommands.contains(command)
    }
}

/// The one production surface through which a periodic (timer-driven) subprocess is registered. This is
/// NOT an unused constant checked against itself — it is the enforcement seam: any component that wants a
/// recurring spawn MUST route through `register`, which REFUSES every command but `watch`. So a future
/// timer that tried to spawn an audited read (`status`/`inspect`/`graduation audit`/`query`) would throw
/// here rather than quietly writing `run.readonly` ledger rows on a cadence. `spawns` is the audit of
/// what was actually admitted — the sole entry can only ever be `watch`.
public struct PeriodicScheduler: Sendable {
    public enum SchedulingError: Error, Equatable, Sendable {
        /// `command` is not on the cadence allowlist (only `watch` is periodic-eligible).
        case notPeriodicAllowed(String)
    }

    /// The commands admitted as periodic tasks, in registration order. Only `watch` can ever appear.
    public private(set) var registered: [String] = []

    public init() {}

    /// Admit `command` as a periodic task, or throw `notPeriodicAllowed`. Fail-closed: only `watch` passes.
    public mutating func register(command: String) throws {
        guard CadencePolicy.isPeriodicAllowed(command) else {
            throw SchedulingError.notPeriodicAllowed(command)
        }
        registered.append(command)
    }
}

/// The egress-minting drift guard. `Console`'s `EgressMintingCommands` is a temporary mirror of
/// `apps/cli/CLAUDE.md` until an authoritative `mintsEgressCapability` field lands on the schemas'
/// `x-atlas-contract`; once it exists, `egressMintingCommandsFromSchemas` returns the authoritative set
/// and the drift test fails if the mirror disagrees.
public enum EgressMintingDrift {
    /// The Console-owned mirror (SSOT: `Constants.egressMintingCommands`).
    public static var mirror: Set<String> { ConsoleConstants.egressMintingCommands }

    /// The authoritative set derived from the schemas' `x-atlas-contract.mintsEgressCapability`, or
    /// `nil` while no schema carries the field (⇒ the drift test asserts the mirror only, and records
    /// that the authoritative field is not yet present).
    public static func fromSchemas(_ bundle: ContractBundle) -> Set<String>? {
        var found = false
        var out: Set<String> = []
        for (command, data) in bundle.allCommandSchemas() {
            guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let contract = obj["x-atlas-contract"] as? [String: Any] else { continue }
            if let mints = contract["mintsEgressCapability"] as? Bool {
                found = true
                if mints { out.insert(command) }
            }
        }
        return found ? out : nil
    }
}
