import Foundation

// MARK: - Egress key source

/// Where the operator's egress capability key is read from for the two minting commands (`query`,
/// `index eval`). Both are read-only to the Console — it never writes / provisions the key.
public enum EgressKeySource: String, Codable, Sendable, Equatable, CaseIterable {
    /// Inherited from the launching shell's environment (`ATLAS_EGRESS_CAPABILITY_KEY`). A Finder/Dock
    /// launch does not inherit shell exports, so `keychain` is the Finder-launch path.
    case env
    /// Read (never written) from a pre-provisioned keychain generic-password item.
    case keychain
}

// MARK: - Settings

/// The flat Console settings blob, persisted in `UserDefaults`. Every override is optional — an absent
/// override falls back to the binary-resolution order (`atlasRoot`) or omits the CLI flag entirely
/// (`pollMs`/`heartbeatSeconds`), letting the CLI own its default.
public struct Settings: Codable, Sendable, Equatable {
    public var atlasRoot: String?
    public var brainPathOverride: String?
    public var signerPathOverride: String?
    /// A privilege-drop launcher for `brain` (#298) — an absolute path that re-execs brain as
    /// `atlas-agent` so the operator-run Console can reach the broker on a multi-identity install. The
    /// contract bundle still binds from `atlasRoot`. Optional ⇒ absent decodes to `nil` on older blobs.
    public var brainLauncher: String?
    public var pollMs: Int?
    public var heartbeatSeconds: Int?
    public var egressCapabilityKeySource: EgressKeySource
    public var resumeMode: ResumeMode

    public init(
        atlasRoot: String? = nil,
        brainPathOverride: String? = nil,
        signerPathOverride: String? = nil,
        brainLauncher: String? = nil,
        pollMs: Int? = nil,
        heartbeatSeconds: Int? = nil,
        egressCapabilityKeySource: EgressKeySource = .env,
        resumeMode: ResumeMode = .resume
    ) {
        self.atlasRoot = atlasRoot
        self.brainPathOverride = brainPathOverride
        self.signerPathOverride = signerPathOverride
        self.brainLauncher = brainLauncher
        self.pollMs = pollMs
        self.heartbeatSeconds = heartbeatSeconds
        self.egressCapabilityKeySource = egressCapabilityKeySource
        self.resumeMode = resumeMode
    }

    /// The deterministic fresh-install value: every optional `nil`, `.env`, `.resume`. A fresh install
    /// and a corrupt blob both resolve to exactly this — never invented values.
    public static let defaults = Settings()
}

extension Settings {
    /// Maps the settings blob into Phase 1's dependency-free `ResolutionInputs` (so Phase 1 never
    /// consumes the Settings store directly).
    public func resolutionInputs() -> ResolutionInputs {
        ResolutionInputs(
            atlasRoot: atlasRoot,
            brainPathOverride: brainPathOverride,
            signerPathOverride: signerPathOverride,
            brainLauncher: brainLauncher
        )
    }
}

// MARK: - WatchOptionPolicy

/// The `--poll-ms` / `--heartbeat-seconds` bounds + defaults, DERIVED at runtime from the bound
/// `watch.schema.json`'s `x-atlas-contract.flags` table — never hardcoded here. The CLI owns the SSOT;
/// the Console reads the `constraint` range (`"100..10000"`) and `default` off each flag so a range
/// change in the schema tracks automatically (proved by `SettingsStoreTests` mutating a fixture range).
public struct WatchOptionPolicy: Sendable, Equatable {
    public let pollMsRange: ClosedRange<Int>
    public let heartbeatSecondsRange: ClosedRange<Int>
    public let defaultPollMs: Int
    public let defaultHeartbeatSeconds: Int

    /// Raised when the schema's flag table lacks a flag / range the policy needs — fail closed rather
    /// than fabricate a bound.
    public enum PolicyError: Error, Equatable, Sendable {
        case missingFlag(String)
        case malformedConstraint(flag: String, value: String)
        case missingFlagTable
    }

    public init(watchSchema: Data) throws {
        guard let root = try? JSONSerialization.jsonObject(with: watchSchema) as? [String: Any],
              let contract = root["x-atlas-contract"] as? [String: Any],
              let flags = contract["flags"] as? [[String: Any]] else {
            throw PolicyError.missingFlagTable
        }

        let poll = try Self.flag("--poll-ms", in: flags)
        let heartbeat = try Self.flag("--heartbeat-seconds", in: flags)

        self.pollMsRange = try Self.range(from: poll, flag: "--poll-ms")
        self.heartbeatSecondsRange = try Self.range(from: heartbeat, flag: "--heartbeat-seconds")
        self.defaultPollMs = try Self.defaultValue(from: poll, flag: "--poll-ms")
        self.defaultHeartbeatSeconds = try Self.defaultValue(from: heartbeat, flag: "--heartbeat-seconds")
    }

    public func validatePollMs(_ v: Int) -> Bool { pollMsRange.contains(v) }
    public func validateHeartbeatSeconds(_ v: Int) -> Bool { heartbeatSecondsRange.contains(v) }

    /// Maps persisted `Settings` overrides into `WatchOptions`, enforcing the schema-derived bounds at the
    /// settings→argv boundary. A `Settings` blob is `Codable` from `UserDefaults`, so an out-of-range
    /// `pollMs`/`heartbeatSeconds` (a hand-edited plist, an older-schema value) would otherwise reach the
    /// CLI directly, bypassing the policy. An out-of-range override is DROPPED (the flag is omitted, so the
    /// CLI owns its default) rather than clamped — the Console never invents a value the operator did not
    /// choose. `nil` overrides pass through as omitted flags unchanged.
    public func watchOptions(from settings: Settings) -> WatchOptions {
        WatchOptions(
            pollMs: settings.pollMs.flatMap { validatePollMs($0) ? $0 : nil },
            heartbeatSeconds: settings.heartbeatSeconds.flatMap { validateHeartbeatSeconds($0) ? $0 : nil }
        )
    }

    // MARK: - Schema parsing

    /// Finds a flag row by its bare name; flag names in the schema carry an operand suffix
    /// (`"--poll-ms <n>"`), so match on the token before the first space.
    private static func flag(_ name: String, in flags: [[String: Any]]) throws -> [String: Any] {
        for f in flags {
            guard let raw = f["name"] as? String else { continue }
            let bare = raw.split(separator: " ", maxSplits: 1).first.map(String.init) ?? raw
            if bare == name { return f }
        }
        throw PolicyError.missingFlag(name)
    }

    /// Parses a `"low..high"` inclusive-range constraint.
    private static func range(from flag: [String: Any], flag name: String) throws -> ClosedRange<Int> {
        guard let constraint = flag["constraint"] as? String else {
            throw PolicyError.missingFlag(name)
        }
        let parts = constraint.components(separatedBy: "..")
        guard parts.count == 2,
              let low = Int(parts[0].trimmingCharacters(in: .whitespaces)),
              let high = Int(parts[1].trimmingCharacters(in: .whitespaces)),
              low <= high else {
            throw PolicyError.malformedConstraint(flag: name, value: constraint)
        }
        return low...high
    }

    private static func defaultValue(from flag: [String: Any], flag name: String) throws -> Int {
        guard let d = flag["default"] as? Int else { throw PolicyError.missingFlag(name) }
        return d
    }
}

// MARK: - SettingsStore

/// A load outcome — the settings plus how they were obtained, so the app can surface a "settings were
/// reset" notice without inventing values or crashing.
public struct SettingsLoad: Sendable, Equatable {
    public let settings: Settings
    public let notice: SettingsLoadNotice?
    public init(settings: Settings, notice: SettingsLoadNotice?) {
        self.settings = settings
        self.notice = notice
    }
}

/// A non-fatal load notice the `AppModel` mirrors into a dismissible banner.
public enum SettingsLoadNotice: Sendable, Equatable {
    /// The persisted blob was present but unreadable/corrupt; defaults were substituted.
    case resetFromCorrupt
}

/// Persists / loads `Settings` in a `UserDefaults` suite. `load()` distinguishes an ABSENT blob (⇒ pure
/// defaults, no notice) from a CORRUPT blob (⇒ defaults + `.resetFromCorrupt`) — it never throws and
/// never returns invented values.
public struct SettingsStore {
    private let defaults: UserDefaults
    private let key: String

    public init(defaults: UserDefaults = .standard, key: String = "com.atlas.console.settings") {
        self.defaults = defaults
        self.key = key
    }

    public func load() -> SettingsLoad {
        // Presence FIRST: `data(forKey:)` returns nil both for a truly-absent key AND for a present value
        // of the wrong type — conflating a fresh install with corruption. Check `object(forKey:)` for
        // presence, then require `Data`; a present-but-wrong-type value is corruption, not an absence.
        guard let stored = defaults.object(forKey: key) else {
            // Absent — a fresh install. Pure defaults, no notice.
            return SettingsLoad(settings: .defaults, notice: nil)
        }
        guard let data = stored as? Data else {
            // Present but not `Data` (a wrong-type stored value) — corrupt: defaults + reset notice.
            return SettingsLoad(settings: .defaults, notice: .resetFromCorrupt)
        }
        do {
            let settings = try JSONDecoder().decode(Settings.self, from: data)
            return SettingsLoad(settings: settings, notice: nil)
        } catch {
            // Present but corrupt — defaults + a surfaced reset notice, never a crash.
            return SettingsLoad(settings: .defaults, notice: .resetFromCorrupt)
        }
    }

    public func save(_ s: Settings) {
        guard let data = try? JSONEncoder().encode(s) else { return }
        defaults.set(data, forKey: key)
    }
}
