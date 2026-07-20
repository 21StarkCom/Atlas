import Foundation

// P5-Task-1 — authorizable-op discovery + schema-driven routing.
//
// The authorizable-op set is derived at RUNTIME from the registry `privilege` field (never a
// hardcoded list). Turning a member into a working invocation goes through a schema-driven
// `OperationDescriptor` (operands + kinds from `x-atlas-contract`) plus a Console-owned
// `OperandSourceMap` (the focused-UI-vs-operator mapping the CLI schemas do not carry). Resolving
// operands yields an immutable `BoundInvocation` — the single argv authority for one flow, from which
// BOTH the export argv and the authorize argv derive, so AuthorizeRetry's "exact same argv" guarantee
// holds by construction.

/// The set of authorization-required commands, discovered from the bound registry.
public enum AuthorizableOpSet {
    /// Scan `commands.json`'s `privilege` field. Membership = `privilege == "privileged"`. Never a
    /// hardcoded list — a newly-privileged command appears here the moment the registry says so.
    public static func derive(from bundle: ContractBundle) -> Set<String> {
        Set(bundle.commands.filter { $0.privilege == "privileged" }.map(\.name))
    }
}

/// Where an operand's value comes from in the Console UI. The CLI schemas expose no operand `source`
/// field, so this mapping is Console-owned (`OperandSourceMap`), drift-guarded, and retired when atlas
/// ships an operand `source` field on `x-atlas-contract`.
public enum OperandSource: Sendable, Equatable {
    /// Pre-filled from the currently-focused object; the associated string names the `FocusContext`
    /// field key.
    case focusedObject(String)
    /// Entered by the operator as a form input; keyed in the `entry` dict by the operand name. For a
    /// boolean switch the operator supplies a truthy string (`"true"`/`"1"`/`"yes"`) to set it.
    case operatorEntry
    /// A Console-pinned literal (never operator/focus supplied): the privileged flow ALWAYS carries this
    /// operand with this value. For a boolean switch a truthy constant means the switch is always on
    /// (e.g. `purge --apply`, which the Console only ever drives in its mutating, broker-authorized form).
    case constant(String)
}

/// How an operand rides argv.
public enum OperandKind: Sendable, Equatable {
    /// A positional operand at the given position among positionals (0-based).
    case positional(Int)
    /// A value-flag (`--resolution <…>` → `.flag("--resolution")`).
    case flag(String)
    /// A boolean switch flag that rides argv as a bare token with NO value (`--apply` → `.boolean("--apply")`).
    case boolean(String)
}

/// Whether an operand must resolve, may be omitted, or participates in an exactly-one-of group.
public enum OperandRequirement: Sendable, Equatable {
    /// Must resolve to a present value; absence ⇒ `RoutingError.missingOperand`.
    case required
    /// Omitted from argv when absent (the CLI owns its default).
    case optional
    /// Belongs to a named cardinality group; EXACTLY ONE operand in the group must be present, else
    /// `RoutingError.cardinality`. (E.g. `purge`'s `--note`/`--source`/`--data-category` selectors, or
    /// `graduation migrate`'s `--apply`/`--rollback` direction.)
    case oneOf(String)
}

/// The Console-owned binding for one operand: where its value comes from + how required it is. Kind is
/// NOT stored here — it is derived from the command schema at descriptor time (`operandKinds`).
public struct OperandBinding: Sendable, Equatable {
    public let source: OperandSource
    public let requirement: OperandRequirement
    public init(_ source: OperandSource, _ requirement: OperandRequirement = .required) {
        self.source = source
        self.requirement = requirement
    }
}

/// One routed operand: its name (schema-derived, `<>`-stripped), argv shape, UI source, and requirement.
public struct Operand: Sendable, Equatable {
    public let name: String
    public let kind: OperandKind
    public let source: OperandSource
    public let requirement: OperandRequirement
    public init(name: String, kind: OperandKind, source: OperandSource, requirement: OperandRequirement = .required) {
        self.name = name
        self.kind = kind
        self.source = source
        self.requirement = requirement
    }
}

/// A schema-driven descriptor for one authorizable command. `operands` is derived from the command's
/// `x-atlas-contract` args/flags intersected with the op's `OperandSourceMap` entry.
public struct OperationDescriptor: Sendable, Equatable {
    public let command: String
    public let operands: [Operand]
    public init(command: String, operands: [Operand]) {
        self.command = command
        self.operands = operands
    }
}

/// The focused-object context an Action surface pre-fills operands from (e.g. the selected run's id).
public struct FocusContext: Sendable, Equatable {
    public let fields: [String: String]
    public init(fields: [String: String] = [:]) { self.fields = fields }
}

/// An immutable, fully-resolved invocation — the single argv authority for one privileged flow. Both
/// the export and authorize argv derive from `argv`, so their byte-identity (apart from the trailing
/// flag) is structural.
public struct BoundInvocation: Sendable, Equatable {
    public let op: String
    /// Fully-resolved argv: `[…commandTokens, …positionals, …flagPairs, "--json"]`. ALWAYS carries
    /// `--json` — `brain` emits the JSON error envelope only when `--json` is sniffed; without it every
    /// `authz.*` branch would return human text the flow can't interpret.
    public let argv: [String]
    /// The resolved operand values by name — used by the Display consistency gate (challenge.runId /
    /// targetCommit ↔ operand equality) without re-parsing argv.
    public let operands: [String: String]

    public init(op: String, argv: [String], operands: [String: String] = [:]) {
        self.op = op
        self.argv = argv
        self.operands = operands
    }

    public var exportArgv: [String] { argv + ["--export-challenge"] }
    public func authorizeArgv(authorizationPath: URL) -> [String] {
        argv + ["--authorization", authorizationPath.path]
    }
}

/// Errors raised while routing an authorizable op.
public enum RoutingError: Error, Equatable, Sendable {
    /// The op is not routable — no descriptor (not a registry-`privileged` op, no schema, no
    /// `OperandSourceMap` entry, or any drift between the schema's non-reserved operands and the map's
    /// keys). Surfaced as the explicit "unsupported privileged command" state; never a half-built invocation.
    case unsupportedPrivilegedCommand(String)
    /// A required operand had no resolved value.
    case missingOperand(op: String, operand: String)
    /// An exactly-one-of cardinality group was violated (zero or more-than-one present).
    case cardinality(op: String, group: String, present: [String])
}

/// The Console-owned focused-UI-vs-operator source map, keyed op → operand-name → source. Covers
/// EXACTLY the production `authorizableOps` set (drift-guarded by `operandSourceMapCoversAuthorizableOps`).
/// Recorded in the spec's `ssot` exception list; retired when atlas ships an operand `source` field.
public enum OperandSourceMap {
    public static let production: [String: [String: OperandBinding]] = [
        "db restore": ["backupRef": .init(.operatorEntry, .required)],
        "git approve": ["runId": .init(.focusedObject("runId"), .required)],
        "git rollback": ["runId": .init(.focusedObject("runId"), .required)],
        // Exactly one direction; both are boolean switches the operator picks between.
        "graduation migrate": [
            "apply": .init(.operatorEntry, .oneOf("direction")),
            "rollback": .init(.operatorEntry, .oneOf("direction")),
        ],
        // Exactly one selector; `--apply` is Console-pinned on — the Console only drives the mutating,
        // broker-authorized purge (a preview is not a privileged flow).
        "purge": [
            "note": .init(.operatorEntry, .oneOf("selector")),
            "source": .init(.operatorEntry, .oneOf("selector")),
            "data-category": .init(.operatorEntry, .oneOf("selector")),
            "apply": .init(.constant("true"), .required),
        ],
        // `--reveal` is an optional operator toggle (metadata vs. full content).
        "quarantine inspect": [
            "opaqueId": .init(.focusedObject("opaqueId"), .required),
            "reveal": .init(.operatorEntry, .optional),
        ],
        // `--resolution <release|discard>` is a REQUIRED disposition.
        "quarantine resolve": [
            "opaqueId": .init(.focusedObject("opaqueId"), .required),
            "resolution": .init(.operatorEntry, .required),
        ],
        "source trust promote": ["sourceId": .init(.focusedObject("sourceId"), .required)],
        "source trust revoke": ["sourceId": .init(.focusedObject("sourceId"), .required)],
    ]
}

/// Binds an authorizable op + UI-supplied operand values into a `BoundInvocation`.
public struct OperationRouter: Sendable {
    private let bundle: ContractBundle
    private let operandSourceMap: [String: [String: OperandBinding]]

    public init(bundle: ContractBundle, operandSourceMap: [String: [String: OperandBinding]] = OperandSourceMap.production) {
        self.bundle = bundle
        self.operandSourceMap = operandSourceMap
    }

    /// The schema-driven descriptor for an op, or `nil` (⇒ unsupported-privileged-command surface).
    /// Fails closed on ANY of: (a) the op is not a registry-`privileged` command (never route a shared
    /// command through the privileged flow — the descriptor authority is the registry, not the map); (b)
    /// no bound command schema; (c) no `OperandSourceMap` entry; (d) EXACT-EQUALITY drift — the set of the
    /// schema's NON-RESERVED operands (positionals + value flags + boolean switches, minus the
    /// flow-reserved/preview flags) must equal the map's key set EXACTLY. A map entry naming a
    /// non-schema operand (map→schema) OR any schema operand — required OR optional, positional OR flag —
    /// absent from the map (schema→map) fails closed, so a stale map can never silently omit an operand
    /// (route a shared command, drop an optional positional, or ignore a newly-added value/boolean flag).
    public func descriptor(for op: String) -> OperationDescriptor? {
        // (a) registry privilege membership — never a shared command, never a hardcoded list.
        guard bundle.commands.first(where: { $0.name == op })?.privilege == "privileged" else { return nil }
        guard let sourceEntry = operandSourceMap[op] else { return nil }
        guard let schema = bundle.schema(for: op) else { return nil }
        let kinds = Self.operandKinds(schema: schema)

        // (d) EXACT equality between all non-reserved schema operands and the map's keys — bidirectional.
        guard Set(kinds.keys) == Set(sourceEntry.keys) else { return nil }

        var operands: [Operand] = []
        for (name, binding) in sourceEntry {
            guard let kind = kinds[name] else { return nil }
            operands.append(Operand(name: name, kind: kind, source: binding.source, requirement: binding.requirement))
        }

        // Stable order: positionals by index first, then flags (value + boolean) by flag token.
        operands.sort { a, b in
            switch (a.kind, b.kind) {
            case let (.positional(i), .positional(j)): return i < j
            case (.positional, _): return true
            case (_, .positional): return false
            default: return Self.flagToken(a.kind) < Self.flagToken(b.kind)
            }
        }
        return OperationDescriptor(command: op, operands: operands)
    }

    /// Resolve operands into an immutable `BoundInvocation`. A descriptor-less op fails fast; a missing
    /// `required` operand throws `missingOperand`; an `oneOf` group with ≠1 present throws `cardinality`;
    /// an `optional` operand is omitted when absent (the CLI owns its default).
    public func bind(_ op: String, focus: FocusContext, entry: [String: String]) throws -> BoundInvocation {
        guard let descriptor = descriptor(for: op) else {
            throw RoutingError.unsupportedPrivilegedCommand(op)
        }
        let commandTokens = op.split(separator: " ").map(String.init)
        var positionals: [(index: Int, value: String)] = []
        var valueFlags: [(flag: String, value: String)] = []
        var booleans: [String] = []
        var resolved: [String: String] = [:]
        var groupPresence: [String: [String]] = [:] // group → present operand names

        for operand in descriptor.operands {
            // Resolve the raw supplied value for this operand.
            let raw: String?
            switch operand.source {
            case .focusedObject(let field): raw = focus.fields[field]
            case .operatorEntry: raw = entry[operand.name]
            case .constant(let value): raw = value
            }

            // Determine presence + the argv contribution by kind.
            var present = false
            switch operand.kind {
            case .positional(let idx):
                if let raw, !raw.isEmpty { positionals.append((idx, raw)); resolved[operand.name] = raw; present = true }
            case .flag(let flag):
                if let raw, !raw.isEmpty { valueFlags.append((flag, raw)); resolved[operand.name] = raw; present = true }
            case .boolean(let flag):
                if Self.isTruthy(raw) { booleans.append(flag); resolved[operand.name] = "true"; present = true }
            }

            switch operand.requirement {
            case .required:
                if !present { throw RoutingError.missingOperand(op: op, operand: operand.name) }
            case .optional:
                break
            case .oneOf(let group):
                if present { groupPresence[group, default: []].append(operand.name) }
                else { groupPresence[group, default: []] = groupPresence[group] ?? [] }
            }
        }

        // Every oneOf group must have EXACTLY one present operand.
        for (group, present) in groupPresence where present.count != 1 {
            throw RoutingError.cardinality(op: op, group: group, present: present.sorted())
        }

        var argv = commandTokens
        argv.append(contentsOf: positionals.sorted { $0.index < $1.index }.map(\.value))
        // Deterministic flag order: value-flags + booleans interleaved by flag token.
        let flagTokens: [(token: String, argvChunk: [String])] =
            valueFlags.map { ($0.flag, [$0.flag, $0.value]) } + booleans.map { ($0, [$0]) }
        for chunk in flagTokens.sorted(by: { $0.token < $1.token }) { argv.append(contentsOf: chunk.argvChunk) }
        argv.append("--json")
        return BoundInvocation(op: op, argv: argv, operands: resolved)
    }

    private static func flagToken(_ kind: OperandKind) -> String {
        switch kind {
        case .positional: return ""
        case .flag(let f), .boolean(let f): return f
        }
    }

    private static func isTruthy(_ raw: String?) -> Bool {
        guard let raw else { return false }
        return ["true", "1", "yes", "on"].contains(raw.lowercased())
    }

    /// Operand name → `OperandKind` from a command schema's `x-atlas-contract`. Positional names come
    /// from `args` (accepting either the `name` or `arg` key, `<>`-stripped) in declared order; value-flag
    /// operands come from `<…>`-bearing flags and boolean switches from `type:"boolean"` flags, both
    /// EXCLUDING the flow-reserved / preview flags (`--export-challenge`, `--authorization`,
    /// `--idempotency-key`, `--dry-run`) which the flow manages or forbids, not the operator.
    static func operandKinds(schema: Data) -> [String: OperandKind] {
        guard let obj = try? JSONSerialization.jsonObject(with: schema) as? [String: Any],
              let contract = obj["x-atlas-contract"] as? [String: Any] else { return [:] }
        var out: [String: OperandKind] = [:]
        if let args = contract["args"] as? [[String: Any]] {
            var idx = 0
            for arg in args {
                let raw = (arg["name"] as? String) ?? (arg["arg"] as? String)
                guard let raw else { continue }
                out[strip(raw)] = .positional(idx)
                idx += 1
            }
        }
        let reserved: Set<String> = ["--export-challenge", "--authorization", "--idempotency-key", "--dry-run"]
        if let flags = contract["flags"] as? [[String: Any]] {
            for f in flags {
                guard let decl = f["flag"] as? String else { continue }
                let base = decl.split(separator: " ", maxSplits: 1).first.map(String.init) ?? decl
                guard base.hasPrefix("--"), !reserved.contains(base) else { continue }
                let name = strip(String(base.dropFirst(2)))
                if decl.contains("<") {
                    out[name] = .flag(base)
                } else if (f["type"] as? String) == "boolean" {
                    out[name] = .boolean(base)
                }
            }
        }
        return out
    }

    /// Strip surrounding `<…>` and a leading `--`; `"<runId>"` → `"runId"`, `"data-category"` stays.
    private static func strip(_ raw: String) -> String {
        var s = raw
        if s.hasPrefix("<"), s.hasSuffix(">") { s = String(s.dropFirst().dropLast()) }
        return s
    }
}
