import Foundation

public enum BinaryKind: Sendable, Equatable { case brain, signer }

/// Dependency-free resolution inputs — Phase 1 owns this type; Phase 4's `Settings` maps INTO it
/// (`Settings.resolutionInputs()`), so P1 never consumes the not-yet-built Settings store.
public struct ResolutionInputs: Sendable, Equatable {
    public let atlasRoot: String?
    public let brainPathOverride: String?
    public let signerPathOverride: String?
    /// A privilege-drop launcher for `brain` (#298). On a multi-identity install the Console runs as
    /// the operator, but `brain` must run as `atlas-agent` to reach the broker socket + capability key
    /// (the operator is normatively not in `atlas-git`). When set, this absolute path wraps the brain
    /// invocation (it re-execs `brain` as `atlas-agent`); the contract bundle is STILL bound from
    /// `atlasRoot`, so the exec identity is decoupled from the schema source. The signer is unaffected —
    /// it runs as the operator (its SE key lives in the operator's home, Touch-ID gated).
    public let brainLauncher: String?
    public init(atlasRoot: String? = nil, brainPathOverride: String? = nil, signerPathOverride: String? = nil, brainLauncher: String? = nil) {
        self.atlasRoot = atlasRoot
        self.brainPathOverride = brainPathOverride
        self.signerPathOverride = signerPathOverride
        self.brainLauncher = brainLauncher
    }
}

/// Why a `ResolvedBinary` could not be constructed — the structural invariants the resolver/probe
/// previously guaranteed, now enforced at the type boundary so no caller (production OR fixture) can mint
/// an unlaunchable or cross-checkout binding.
public enum ResolvedBinaryError: Error, Equatable, Sendable {
    /// `launch` was empty — there is nothing to exec.
    case emptyLaunch
    /// `launch[0]` was not absolute (`Foundation.Process` does no PATH expansion, so a relative token
    /// would fail to launch).
    case relativeLaunch(String)
    /// `contractAnchor` is not inside `bundle.checkoutRoot` — a binary paired with ANOTHER checkout's
    /// schemas. V1 forbids this cross-checkout pairing (the schemas would not describe this binary).
    case anchorOutsideCheckout(anchor: String, checkoutRoot: String)
}

/// A resolved, probed subprocess contract. `launch` is the argv (possibly `[node, bin.js]`); its
/// `[0]` is always absolute by construction. `contractAnchor` is the atlas checkout entry, resolved
/// separately from the launch executable.
public struct ResolvedBinary: Sendable {
    public let launch: [String]
    public let contractAnchor: URL
    public let baseEnv: [String: String]
    public let bundle: ContractBundle

    /// Validating initializer. The resolver's structural invariants — a non-empty, absolute `launch` and a
    /// `contractAnchor` that lives INSIDE the bound bundle's checkout — are enforced here, so a fixture (or
    /// any future caller) can never bypass the probe/binding guarantees to mint an empty/relative launch or
    /// pair a binary with a foreign checkout's schemas.
    public init(launch: [String], contractAnchor: URL, baseEnv: [String: String], bundle: ContractBundle) throws {
        guard let first = launch.first else { throw ResolvedBinaryError.emptyLaunch }
        guard first.hasPrefix("/") else { throw ResolvedBinaryError.relativeLaunch(first) }
        let anchor = contractAnchor.resolvingSymlinksInPath().standardizedFileURL.path
        let rootPath = bundle.checkoutRoot.resolvingSymlinksInPath().standardizedFileURL.path
        let rootWithSlash = rootPath.hasSuffix("/") ? rootPath : rootPath + "/"
        guard anchor == rootPath || anchor.hasPrefix(rootWithSlash) else {
            throw ResolvedBinaryError.anchorOutsideCheckout(anchor: anchor, checkoutRoot: rootPath)
        }
        self.launch = launch
        self.contractAnchor = contractAnchor
        self.baseEnv = baseEnv
        self.bundle = bundle
    }
}

/// Environment-variable names Console reads during resolution.
public enum ResolutionEnv {
    public static let atlasRoot = "ATLAS_ROOT"
    public static let brainPath = "ATLAS_BRAIN_PATH"
    public static let brainLauncher = "ATLAS_BRAIN_LAUNCHER"
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
        // 0. privilege-drop launcher (#298): wraps brain to run it as atlas-agent while the Console
        // stays the operator. Bundle binds from atlasRoot (the launcher is outside the checkout), so
        // this is a DISTINCT mode from a standalone in-checkout binary — checked first when configured.
        if let launcher = inputs.brainLauncher ?? env[ResolutionEnv.brainLauncher] {
            return try await resolveLauncherBrain(launcher: launcher, inputs: inputs, env: env, runner: runner, probeTimeout: probeTimeout)
        }
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
        return try ResolvedBinary(launch: launch, contractAnchor: binJs, baseEnv: baseEnv, bundle: bundle)
    }

    /// Launcher mode (#298): `launch[0]` is a privilege-drop wrapper that re-execs brain as
    /// `atlas-agent`, but the contract bundle + anchor are bound from `atlasRoot`'s `apps/cli/dist/bin.js`
    /// (the launcher lives OUTSIDE the checkout — deriving the bundle from it would fail). The wrapper
    /// receives `ATLAS_ROOT` via `baseEnv` so it knows which checkout to run. The probe spawns the
    /// launcher end to end, so it verifies the privilege drop AND the broker reachability, not just a path.
    private static func resolveLauncherBrain(
        launcher: String,
        inputs: ResolutionInputs,
        env: [String: String],
        runner: ProcessRunner,
        probeTimeout: Duration
    ) async throws -> ResolvedBinary {
        let launcherAbs = try requireExecutable(launcher, kindLabel: "brain launcher")
        guard let atlasRoot = inputs.atlasRoot ?? env[ResolutionEnv.atlasRoot] else {
            throw BlockingResolutionError(
                path: "atlasRoot",
                remediation: "A brain launcher is configured but no atlasRoot/ATLAS_ROOT. The launcher runs brain as another identity, yet the Console still binds the contract bundle from the checkout — set atlasRoot to your atlas checkout."
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
        let launch = [launcherAbs]
        let baseEnv = [ResolutionEnv.atlasRoot: atlasRoot]
        let bundle = try ContractBundle.resolve(fromAnchor: binJs)
        try await probeBrain(launch: launch, env: env, baseEnv: baseEnv, bundle: bundle, anchorPath: binJs.path, runner: runner, probeTimeout: probeTimeout)
        return try ResolvedBinary(launch: launch, contractAnchor: binJs, baseEnv: baseEnv, bundle: bundle)
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
        return try ResolvedBinary(launch: [abs], contractAnchor: url, baseEnv: [:], bundle: bundle)
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
        // A probe is a non-egress spawn — strip any inherited egress capability key (ChildEnvironment).
        let probeEnv = ChildEnvironment.nonEgress(inherited: env, overlay: baseEnv)
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
        return try ResolvedBinary(launch: [abs], contractAnchor: brainAnchor, baseEnv: [:], bundle: bundle)
    }

    private static func probeSigner(path: String, cwd: URL, env: [String: String], runner: ProcessRunner, probeTimeout: Duration) async throws {
        // `atlas-signer pubkey` prints the SPKI PEM with no SE access — exit 0. Probe from the bound
        // checkout root, matching the brain probe, so a Finder-launched Console does not depend on cwd.
        // A signer probe is a non-egress spawn — strip any inherited egress capability key.
        let req = SpawnRequest(executable: [path], arguments: ["pubkey"], cwd: cwd, environment: ChildEnvironment.nonEgress(inherited: env), timeout: probeTimeout, command: "atlas-signer pubkey")
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
