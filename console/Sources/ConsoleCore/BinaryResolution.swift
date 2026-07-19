import Foundation

public enum BinaryKind: Sendable, Equatable { case brain, signer }

/// Dependency-free resolution inputs — Phase 1 owns this type; Phase 4's `Settings` maps INTO it
/// (`Settings.resolutionInputs()`), so P1 never consumes the not-yet-built Settings store.
public struct ResolutionInputs: Sendable, Equatable {
    public let atlasRoot: String?
    public let brainPathOverride: String?
    public let signerPathOverride: String?
    public init(atlasRoot: String? = nil, brainPathOverride: String? = nil, signerPathOverride: String? = nil) {
        self.atlasRoot = atlasRoot
        self.brainPathOverride = brainPathOverride
        self.signerPathOverride = signerPathOverride
    }
}

/// A resolved, probed subprocess contract. `launch` is the argv (possibly `[node, bin.js]`); its
/// `[0]` is always absolute by construction. `contractAnchor` is the atlas checkout entry, resolved
/// separately from the launch executable.
public struct ResolvedBinary: Sendable {
    public let launch: [String]
    public let contractAnchor: URL
    public let baseEnv: [String: String]
    public let bundle: ContractBundle
}

/// Environment-variable names Console reads during resolution.
public enum ResolutionEnv {
    public static let atlasRoot = "ATLAS_ROOT"
    public static let brainPath = "ATLAS_BRAIN_PATH"
    public static let signerPath = "ATLAS_SIGNER_PATH"
}

public enum BinaryResolution {
    /// The repo-layout default signer path, relative to the bound checkout root: the SP-3
    /// `console/signer` SwiftPM package's release build product (`atlas-signer`), never the package dir.
    public static let defaultSignerRelativePath = "console/signer/.build/release/atlas-signer"

    /// The probe timeout — 10 s by default (plan §P1-Task-5). Injectable so tests can exercise the
    /// timeout path without a real 10 s wait; production callers use the default.
    public static let defaultProbeTimeout: Duration = .seconds(10)

    /// Resolve a binary by the first-hit-wins order (settings → env var → repo-layout default), bind
    /// the contract bundle from the resolved brain's own checkout, and probe. A source that hits but
    /// fails its probe becomes a `BlockingResolutionError` naming the path — never a fallthrough.
    ///
    /// Signer resolution REQUIRES `brainAnchor` — the `contractAnchor` from the already-resolved brain.
    /// The bundle/checkout the signer is bound to is derived exclusively from that anchor (never an
    /// independently-chosen `atlasRoot`), so a brain from checkout A can never be paired with a
    /// signer/root from checkout B. Callers resolve brain FIRST, then pass `resolved.contractAnchor`.
    public static func resolve(
        _ kind: BinaryKind,
        inputs: ResolutionInputs,
        env: [String: String],
        runner: ProcessRunner,
        brainAnchor: URL? = nil,
        probeTimeout: Duration = defaultProbeTimeout
    ) async throws -> ResolvedBinary {
        switch kind {
        case .brain:
            return try await resolveBrain(inputs: inputs, env: env, runner: runner, probeTimeout: probeTimeout)
        case .signer:
            guard let brainAnchor else {
                throw BlockingResolutionError(
                    path: "atlas-signer",
                    remediation: "signer resolution requires the already-resolved brain contractAnchor (brainAnchor). Resolve `.brain` first and pass its `contractAnchor`."
                )
            }
            return try await resolveSigner(inputs: inputs, env: env, runner: runner, brainAnchor: brainAnchor, probeTimeout: probeTimeout)
        }
    }

    // MARK: - brain

    private static func resolveBrain(
        inputs: ResolutionInputs,
        env: [String: String],
        runner: ProcessRunner,
        probeTimeout: Duration
    ) async throws -> ResolvedBinary {
        // 1. settings override — a standalone in-checkout `brain` binary.
        if let override = inputs.brainPathOverride {
            return try await resolveStandaloneBrain(path: override, env: env, runner: runner, probeTimeout: probeTimeout)
        }
        // 2. env var.
        if let envPath = env[ResolutionEnv.brainPath] {
            return try await resolveStandaloneBrain(path: envPath, env: env, runner: runner, probeTimeout: probeTimeout)
        }
        // 3. repo-layout default: node <atlasRoot>/apps/cli/dist/bin.js.
        guard let atlasRoot = inputs.atlasRoot ?? env[ResolutionEnv.atlasRoot] else {
            throw BlockingResolutionError(
                path: "atlasRoot",
                remediation: "No brain override, no ATLAS_BRAIN_PATH, and no atlasRoot/ATLAS_ROOT. Set atlasRoot in Settings to point at your atlas checkout."
            )
        }
        let rootURL = URL(fileURLWithPath: atlasRoot).standardizedFileURL
        let binJs = rootURL.appendingPathComponent("apps/cli/dist/bin.js")
        guard FileManager.default.fileExists(atPath: binJs.path) else {
            throw BlockingResolutionError(
                path: binJs.path,
                remediation: "atlasRoot does not contain apps/cli/dist/bin.js. Run `pnpm -r build` in the atlas checkout, or fix atlasRoot."
            )
        }
        guard let nodeAbs = resolveOnPath("node", env: env) else {
            throw BlockingResolutionError(
                path: "node",
                remediation: "`node` not found on PATH (searched: \(env["PATH"] ?? "")). Install Node ≥ 24 or add it to PATH."
            )
        }
        let launch = [nodeAbs, binJs.path]
        let baseEnv = [ResolutionEnv.atlasRoot: atlasRoot]
        let bundle = try ContractBundle.resolve(fromAnchor: binJs)
        try await probeBrain(launch: launch, env: env, baseEnv: baseEnv, bundle: bundle, anchorPath: binJs.path, runner: runner, probeTimeout: probeTimeout)
        return ResolvedBinary(launch: launch, contractAnchor: binJs, baseEnv: baseEnv, bundle: bundle)
    }

    private static func resolveStandaloneBrain(
        path: String,
        env: [String: String],
        runner: ProcessRunner,
        probeTimeout: Duration
    ) async throws -> ResolvedBinary {
        let abs = try requireExecutable(path, kindLabel: "brain")
        let url = URL(fileURLWithPath: abs)
        let bundle = try ContractBundle.resolve(fromAnchor: url) // a standalone binary is itself the anchor
        try await probeBrain(launch: [abs], env: env, baseEnv: [:], bundle: bundle, anchorPath: abs, runner: runner, probeTimeout: probeTimeout)
        return ResolvedBinary(launch: [abs], contractAnchor: url, baseEnv: [:], bundle: bundle)
    }

    private static func probeBrain(
        launch: [String],
        env: [String: String],
        baseEnv: [String: String],
        bundle: ContractBundle,
        anchorPath: String,
        runner: ProcessRunner,
        probeTimeout: Duration
    ) async throws {
        // Probe with a `pure` command (no ledger row): `db status --json`. Never an audited read.
        var probeEnv = env
        for (k, v) in baseEnv { probeEnv[k] = v }
        // Probe from the bound checkout root, NOT the Console process's cwd: `brain` loads its config
        // relative to cwd (or an explicit --config), so a Finder-launched Console — whose cwd is `/`
        // or the app bundle — would otherwise fail config loading against a valid checkout.
        let req = SpawnRequest(
            executable: launch,
            arguments: ["db", "status", "--json"],
            cwd: bundle.checkoutRoot,
            environment: probeEnv,
            timeout: probeTimeout,
            command: "db status",
            commandSchema: bundle.schema(for: "db status")
        )
        let result: SpawnResult
        do {
            result = try await runner.run(req)
        } catch SpawnError.timedOut {
            throw BlockingResolutionError(path: anchorPath, remediation: "brain probe `db status --json` timed out after 10s. Check the broker/daemons are up, or re-check the brain path.")
        } catch {
            throw BlockingResolutionError(path: anchorPath, remediation: "brain probe failed to launch: \(error)")
        }
        guard result.exitCode == 0 else {
            throw BlockingResolutionError(path: anchorPath, remediation: "brain probe `db status --json` exited \(result.exitCode). stderr: \(shortText(result.stderr))")
        }
        guard let schema = bundle.schema(for: "db status") else {
            throw BlockingResolutionError(path: anchorPath, remediation: "bound contract bundle has no db-status schema; the checkout is incomplete.")
        }
        guard let validator = try? SchemaValidator(schema: schema), validator.validate(result.stdout).isValid else {
            throw BlockingResolutionError(path: anchorPath, remediation: "brain probe output failed db-status schema validation; the binary and contract bundle may be from different checkouts.")
        }
    }

    // MARK: - signer

    private static func resolveSigner(
        inputs: ResolutionInputs,
        env: [String: String],
        runner: ProcessRunner,
        brainAnchor: URL,
        probeTimeout: Duration
    ) async throws -> ResolvedBinary {
        // The signer's checkout is derived EXCLUSIVELY from the brain's already-resolved contractAnchor —
        // never an independently-chosen atlasRoot. This is what enforces the same-checkout binding: the
        // bundle here is the SAME checkout the brain bound, so a brain from checkout A can never accept a
        // signer/root from checkout B.
        let bundle = try ContractBundle.resolve(fromAnchor: brainAnchor)
        let checkoutRoot = bundle.checkoutRoot

        // Source order: settings override → env var → repo-layout default.
        // The repo-layout default is the SP-3 signer's **build product**, not the package directory:
        // `console/signer` is a SwiftPM package, and its release executable lands at
        // `console/signer/.build/release/atlas-signer`. Resolving the directory itself would never be
        // an executable file and would fail closed at `requireExecutable` — the wrong path to name.
        let candidatePath: String
        if let override = inputs.signerPathOverride {
            candidatePath = override
        } else if let envPath = env[ResolutionEnv.signerPath] {
            candidatePath = envPath
        } else {
            candidatePath = checkoutRoot.appendingPathComponent(Self.defaultSignerRelativePath).path
        }

        let abs = try requireExecutable(candidatePath, kindLabel: "atlas-signer")
        // V1 same-checkout restriction: the signer MUST come from the brain-derived checkout.
        guard isPath(abs, within: checkoutRoot) else {
            throw BlockingResolutionError(
                path: abs,
                remediation: "atlas-signer path \(abs) is outside the brain-bound contract checkout \(checkoutRoot.path). V1 has no cross-checkout signer support; use the in-checkout signer or move your checkout."
            )
        }
        try await probeSigner(path: abs, cwd: checkoutRoot, env: env, runner: runner, probeTimeout: probeTimeout)
        // contractAnchor is the brain-derived anchor (same checkout as the bundle), not the signer path.
        return ResolvedBinary(launch: [abs], contractAnchor: brainAnchor, baseEnv: [:], bundle: bundle)
    }

    private static func probeSigner(path: String, cwd: URL, env: [String: String], runner: ProcessRunner, probeTimeout: Duration) async throws {
        // `atlas-signer pubkey` prints the SPKI PEM with no SE access — exit 0. Probe from the bound
        // checkout root, matching the brain probe, so a Finder-launched Console does not depend on cwd.
        let req = SpawnRequest(executable: [path], arguments: ["pubkey"], cwd: cwd, environment: env, timeout: probeTimeout, command: "atlas-signer pubkey")
        let result: SpawnResult
        do {
            result = try await runner.run(req)
        } catch SpawnError.timedOut {
            throw BlockingResolutionError(path: path, remediation: "atlas-signer probe `pubkey` timed out after 10s.")
        } catch {
            throw BlockingResolutionError(path: path, remediation: "atlas-signer probe failed to launch: \(error)")
        }
        guard result.exitCode == 0 else {
            throw BlockingResolutionError(path: path, remediation: "atlas-signer probe `pubkey` exited \(result.exitCode). stderr: \(shortText(result.stderr))")
        }
    }

    // MARK: - helpers

    /// Resolve a bare executable name to an absolute path via the given environment's PATH.
    /// `Foundation.Process` performs no PATH expansion, so this is how `launch[0]` becomes absolute.
    public static func resolveOnPath(_ name: String, env: [String: String]) -> String? {
        if name.hasPrefix("/") { return isExecutableFile(name) ? name : nil }
        let path = env["PATH"] ?? ""
        for entry in path.split(separator: ":", omittingEmptySubsequences: true) {
            let candidate = URL(fileURLWithPath: String(entry)).appendingPathComponent(name).path
            if isExecutableFile(candidate) { return candidate }
        }
        return nil
    }

    private static func requireExecutable(_ path: String, kindLabel: String) throws -> String {
        let abs = path.hasPrefix("/") ? path : URL(fileURLWithPath: path).standardizedFileURL.path
        guard isExecutableFile(abs) else {
            throw BlockingResolutionError(path: abs, remediation: "\(kindLabel) at \(abs) does not exist or is not executable.")
        }
        return abs
    }

    private static func isExecutableFile(_ path: String) -> Bool {
        var isDir: ObjCBool = false
        let fm = FileManager.default
        return fm.fileExists(atPath: path, isDirectory: &isDir) && !isDir.boolValue && fm.isExecutableFile(atPath: path)
    }

    private static func isPath(_ path: String, within root: URL) -> Bool {
        // Resolve symlinks on BOTH sides before the containment test. A lexical-only check (`standardized`)
        // lets an in-checkout symlink whose target lives in another checkout pass the same-checkout guard,
        // defeating the V1 cross-checkout restriction. `resolvingSymlinksInPath` canonicalizes to the real
        // on-disk location so containment reflects where the executable actually is.
        let p = URL(fileURLWithPath: path).resolvingSymlinksInPath().standardizedFileURL.path
        let r = root.resolvingSymlinksInPath().standardizedFileURL.path
        return p == r || p.hasPrefix(r.hasSuffix("/") ? r : r + "/")
    }

    private static func currentDir() -> URL {
        URL(fileURLWithPath: FileManager.default.currentDirectoryPath, isDirectory: true)
    }

    private static func shortText(_ data: Data) -> String {
        let s = String(decoding: data, as: UTF8.self)
        return s.count > 500 ? String(s.prefix(500)) + "…" : s
    }
}
