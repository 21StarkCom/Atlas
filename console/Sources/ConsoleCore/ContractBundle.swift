import Foundation

/// A row of the `commands.json` registry, enriched with `executionClass` (which lives in each
/// command schema's `x-atlas-contract`, not on the registry row). Consumed, never re-derived.
public struct CommandRow: Sendable, Equatable {
    public let name: String
    public let phase: String
    public let privilege: String
    public let executionClass: String
    public let idempotency: String
    public let implemented: Bool
}

/// A blocking resolution error: names the failing path + a remediation. There is no fallthrough to
/// the next source — a source that hits but fails becomes this state (plan §Fail-fast).
public struct BlockingResolutionError: Error, Equatable, Sendable {
    public let path: String
    public let remediation: String
    public init(path: String, remediation: String) {
        self.path = path
        self.remediation = remediation
    }
}

/// The bound contract artifacts, resolved from the atlas checkout that supplies the CLI entry point.
public struct ContractBundle: Sendable {
    /// The checkout root — the directory that contains `docs/specs/cli-contract/`.
    public let checkoutRoot: URL
    public let commands: [CommandRow]

    private let cliContractDir: URL
    private let schemaRefs: [String: String] // command name → repo-relative schema path

    public let watchSchema: Data
    public let errorEnvelopeSchema: Data

    /// Per-command `*.schema.json` bytes, read on demand.
    public func schema(for command: String) -> Data? {
        guard let rel = schemaRefs[command] else { return nil }
        return try? Data(contentsOf: checkoutRoot.appendingPathComponent(rel))
    }

    /// All per-command schema files as bytes, for the keyword-coverage walk.
    public func allCommandSchemas() -> [(command: String, data: Data)] {
        schemaRefs.compactMap { name, rel in
            guard let data = try? Data(contentsOf: checkoutRoot.appendingPathComponent(rel)) else { return nil }
            return (name, data)
        }
    }

    /// Walk up from the atlas CLI entry (`dist/bin.js`) / checkout for `docs/specs/cli-contract/commands.json`.
    /// Never walks from the launch executable (which may be `node`, outside the checkout).
    public static func resolve(fromAnchor anchor: URL) throws -> ContractBundle {
        // Canonicalize the anchor (resolve symlinks) before walking up: a symlinked `brain`/`bin.js`
        // must bind the contract bundle of the tree it PHYSICALLY lives in, not the tree the symlink
        // sits in — otherwise a binary from checkout A could bind schemas from checkout B.
        let canonical = anchor.resolvingSymlinksInPath()
        let startDir = canonical.hasDirectoryPath ? canonical : canonical.deletingLastPathComponent()
        var dir = startDir.standardizedFileURL
        let fm = FileManager.default
        while true {
            let commandsURL = dir.appendingPathComponent("docs/specs/cli-contract/commands.json")
            if fm.fileExists(atPath: commandsURL.path) {
                return try build(checkoutRoot: dir, commandsURL: commandsURL)
            }
            let parent = dir.deletingLastPathComponent().standardizedFileURL
            if parent.path == dir.path { break } // reached filesystem root
            dir = parent
        }
        throw BlockingResolutionError(
            path: anchor.path,
            remediation: "No docs/specs/cli-contract/commands.json found walking up from the CLI entry point. Point Atlas Console at an atlas checkout (set atlasRoot / ATLAS_ROOT), or install `brain` inside its repo layout."
        )
    }

    private static func build(checkoutRoot: URL, commandsURL: URL) throws -> ContractBundle {
        let cliContractDir = checkoutRoot.appendingPathComponent("docs/specs/cli-contract")
        let commandsData = try Data(contentsOf: commandsURL)
        let root = try JSONSerialization.jsonObject(with: commandsData) as? [String: Any]
        guard let root, let rows = root["commands"] as? [[String: Any]] else {
            throw BlockingResolutionError(path: commandsURL.path, remediation: "commands.json is malformed (missing `commands` array).")
        }

        var commands: [CommandRow] = []
        var refs: [String: String] = [:]
        for row in rows {
            guard let name = row["name"] as? String,
                  let schemaRef = row["schemaRef"] as? String,
                  let privilege = row["privilege"] as? String,
                  let idempotency = row["idempotency"] as? String,
                  let implemented = row["implemented"] as? Bool else {
                throw BlockingResolutionError(path: commandsURL.path, remediation: "commands.json row is missing a required field.")
            }
            let phase = Self.stringify(row["phase"])
            // executionClass lives in the command schema's x-atlas-contract, not on the registry row.
            // Every referenced schema MUST exist and carry a well-formed executionClass — a missing or
            // malformed schema fails the bundle closed here, rather than silently degrading to "unknown"
            // and letting an incomplete bundle pass the keyword-completeness gate downstream.
            let execClass = try Self.requireExecutionClass(command: name, schemaRef: schemaRef, checkoutRoot: checkoutRoot)
            commands.append(CommandRow(
                name: name, phase: phase, privilege: privilege,
                executionClass: execClass, idempotency: idempotency, implemented: implemented
            ))
            refs[name] = schemaRef
        }

        let watchURL = cliContractDir.appendingPathComponent("watch.schema.json")
        let errEnvURL = cliContractDir.appendingPathComponent("error-envelope.schema.json")
        guard let watchData = try? Data(contentsOf: watchURL) else {
            throw BlockingResolutionError(path: watchURL.path, remediation: "watch.schema.json is missing from the bound contract bundle.")
        }
        guard let errEnvData = try? Data(contentsOf: errEnvURL) else {
            throw BlockingResolutionError(path: errEnvURL.path, remediation: "error-envelope.schema.json is missing from the bound contract bundle.")
        }

        return ContractBundle(
            checkoutRoot: checkoutRoot,
            commands: commands.sorted { $0.name < $1.name },
            cliContractDir: cliContractDir,
            schemaRefs: refs,
            watchSchema: watchData,
            errorEnvelopeSchema: errEnvData
        )
    }

    /// Reads the referenced schema's `x-atlas-contract.executionClass`, failing the bundle closed on a
    /// missing/unreadable/malformed schema or an absent executionClass — never returning "unknown".
    private static func requireExecutionClass(command: String, schemaRef: String, checkoutRoot: URL) throws -> String {
        let url = checkoutRoot.appendingPathComponent(schemaRef)
        guard let data = try? Data(contentsOf: url) else {
            throw BlockingResolutionError(
                path: url.path,
                remediation: "commands.json references schema `\(schemaRef)` for command `\(command)`, but the file is missing or unreadable. The bound checkout is incomplete."
            )
        }
        guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw BlockingResolutionError(
                path: url.path,
                remediation: "schema `\(schemaRef)` for command `\(command)` is not a valid JSON object."
            )
        }
        guard let contract = obj["x-atlas-contract"] as? [String: Any],
              let ec = contract["executionClass"] as? String, !ec.isEmpty else {
            throw BlockingResolutionError(
                path: url.path,
                remediation: "schema `\(schemaRef)` for command `\(command)` is missing a required `x-atlas-contract.executionClass`."
            )
        }
        return ec
    }

    private static func stringify(_ v: Any?) -> String {
        if let s = v as? String { return s }
        if let n = v as? NSNumber { return n.stringValue }
        return ""
    }
}
