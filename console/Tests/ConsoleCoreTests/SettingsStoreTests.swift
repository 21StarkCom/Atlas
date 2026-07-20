import XCTest
@testable import ConsoleCore

/// P4-Task-2 — the `Settings` blob, the corrupt/absent load distinction, and the schema-derived
/// `WatchOptionPolicy`.
final class SettingsStoreTests: XCTestCase {

    private func freshDefaults() -> (UserDefaults, String) {
        let suite = "com.atlas.console.tests.\(UUID().uuidString)"
        let ud = UserDefaults(suiteName: suite)!
        addTeardownBlock { UserDefaults.standard.removePersistentDomain(forName: suite) }
        return (ud, suite)
    }

    // MARK: - SettingsStore

    func testFreshInstallReturnsDefaultsNoNotice() {
        let (ud, _) = freshDefaults()
        let store = SettingsStore(defaults: ud)
        let load = store.load()
        XCTAssertEqual(load.settings, .defaults)
        XCTAssertNil(load.notice)
        // Defaults are deterministic: every optional nil, .env, .resume.
        XCTAssertNil(load.settings.atlasRoot)
        XCTAssertNil(load.settings.pollMs)
        XCTAssertEqual(load.settings.egressCapabilityKeySource, .env)
        XCTAssertEqual(load.settings.resumeMode, .resume)
    }

    func testCorruptBlobReturnsDefaultsPlusResetNotice() {
        let (ud, _) = freshDefaults()
        let key = "com.atlas.console.settings"
        ud.set(Data("{ not valid json".utf8), forKey: key)
        let store = SettingsStore(defaults: ud, key: key)
        let load = store.load()
        XCTAssertEqual(load.settings, .defaults, "corrupt ⇒ defaults, never invented values")
        XCTAssertEqual(load.notice, .resetFromCorrupt, "the reset is surfaced, never a silent crash")
    }

    func testWrongTypeStoredValueIsCorruptNotAbsent() {
        // A present-but-wrong-type value (a String, not Data) must be treated as corruption — NOT
        // conflated with an absent key. `data(forKey:)` returns nil for both, so presence is checked via
        // `object(forKey:)` first.
        let (ud, _) = freshDefaults()
        let key = "com.atlas.console.settings"
        ud.set("i am not settings data", forKey: key)
        let store = SettingsStore(defaults: ud, key: key)
        let load = store.load()
        XCTAssertEqual(load.settings, .defaults)
        XCTAssertEqual(load.notice, .resetFromCorrupt, "a wrong-type stored value is surfaced as corrupt")
    }

    func testPersistenceRoundTrip() {
        let (ud, _) = freshDefaults()
        let store = SettingsStore(defaults: ud)
        var s = Settings.defaults
        s.atlasRoot = "/checkout"
        s.pollMs = 750
        s.heartbeatSeconds = 45
        s.egressCapabilityKeySource = .keychain
        s.resumeMode = .replayAll
        store.save(s)
        XCTAssertEqual(store.load().settings, s)
        XCTAssertNil(store.load().notice)
    }

    func testResolutionInputsMapping() {
        var s = Settings.defaults
        s.atlasRoot = "/root"
        s.brainPathOverride = "/b"
        s.signerPathOverride = "/s"
        let inputs = s.resolutionInputs()
        XCTAssertEqual(inputs.atlasRoot, "/root")
        XCTAssertEqual(inputs.brainPathOverride, "/b")
        XCTAssertEqual(inputs.signerPathOverride, "/s")
    }

    // MARK: - WatchOptionPolicy (schema-derived)

    func testPolicyBoundsFromRealSchema() throws {
        let schema = try TestSupport.contractSchema("watch.schema.json")
        let policy = try WatchOptionPolicy(watchSchema: schema)
        XCTAssertEqual(policy.defaultPollMs, 500)
        XCTAssertEqual(policy.defaultHeartbeatSeconds, 30)
        XCTAssertTrue(policy.validatePollMs(100))
        XCTAssertTrue(policy.validatePollMs(10000))
        XCTAssertFalse(policy.validatePollMs(99), "below the schema range")
        XCTAssertFalse(policy.validatePollMs(10001), "above the schema range")
        XCTAssertTrue(policy.validateHeartbeatSeconds(5))
        XCTAssertTrue(policy.validateHeartbeatSeconds(300))
        XCTAssertFalse(policy.validateHeartbeatSeconds(4))
        XCTAssertFalse(policy.validateHeartbeatSeconds(301))
    }

    /// Proves the bounds are DERIVED from the schema, not a copied constant: a mutated fixture range
    /// changes what the policy accepts.
    func testPolicyTracksMutatedFixtureRange() throws {
        let schema = try TestSupport.contractSchema("watch.schema.json")
        var obj = try JSONSerialization.jsonObject(with: schema) as! [String: Any]
        var contract = obj["x-atlas-contract"] as! [String: Any]
        var flags = contract["flags"] as! [[String: Any]]
        for i in flags.indices {
            if let name = flags[i]["name"] as? String, name.hasPrefix("--poll-ms") {
                flags[i]["constraint"] = "200..300"
                flags[i]["default"] = 250
            }
        }
        contract["flags"] = flags
        obj["x-atlas-contract"] = contract
        let mutated = try JSONSerialization.data(withJSONObject: obj)

        let policy = try WatchOptionPolicy(watchSchema: mutated)
        XCTAssertEqual(policy.defaultPollMs, 250)
        XCTAssertFalse(policy.validatePollMs(100), "100 valid under the real range, rejected under the mutated one")
        XCTAssertTrue(policy.validatePollMs(250))
        XCTAssertFalse(policy.validatePollMs(301))
    }

    func testMissingFlagTableFailsClosed() {
        let noContract = Data(#"{"type":"object"}"#.utf8)
        XCTAssertThrowsError(try WatchOptionPolicy(watchSchema: noContract)) { err in
            XCTAssertEqual(err as? WatchOptionPolicy.PolicyError, .missingFlagTable)
        }
    }

    // MARK: - Flag omission contract

    func testAbsentOverrideOmitsFlags() {
        let argv = WatchSupervisor.watchArgs(resumeArg: .liveOnly,
                                             options: WatchOptions(pollMs: nil, heartbeatSeconds: nil))
        XCTAssertFalse(argv.contains("--poll-ms"), "absent override OMITS the flag (CLI owns its default)")
        XCTAssertFalse(argv.contains("--heartbeat-seconds"))
        XCTAssertEqual(argv, ["watch", "--json"])
    }

    func testPresentOverrideEmitsFlags() {
        let argv = WatchSupervisor.watchArgs(resumeArg: .sinceSeq(5),
                                             options: WatchOptions(pollMs: 750, heartbeatSeconds: 45))
        XCTAssertEqual(argv, ["watch", "--json", "--poll-ms", "750", "--heartbeat-seconds", "45", "--since-seq", "5"])
    }

    // MARK: - Settings → WatchOptions boundary is policy-validated (out-of-range dropped)

    func testWatchOptionsBoundaryValidatesPersistedValues() throws {
        // A Settings blob is Codable from UserDefaults, so out-of-range values can be persisted (a
        // hand-edited plist / an older-schema value). The settings→WatchOptions boundary must validate
        // against the schema-derived bounds and DROP an out-of-range value (omit the flag) rather than pass
        // it straight through to the CLI.
        let schema = try TestSupport.contractSchema("watch.schema.json")
        let policy = try WatchOptionPolicy(watchSchema: schema)

        // In-range values pass through untouched.
        var inRange = Settings.defaults
        inRange.pollMs = 750
        inRange.heartbeatSeconds = 45
        XCTAssertEqual(policy.watchOptions(from: inRange), WatchOptions(pollMs: 750, heartbeatSeconds: 45))

        // Out-of-range values are dropped ⇒ the flag is omitted ⇒ the CLI owns its default.
        var outOfRange = Settings.defaults
        outOfRange.pollMs = 99      // below the real 100..10000 range
        outOfRange.heartbeatSeconds = 301 // above the real 5..300 range
        XCTAssertEqual(policy.watchOptions(from: outOfRange), WatchOptions(pollMs: nil, heartbeatSeconds: nil))
        let argv = WatchSupervisor.watchArgs(resumeArg: .liveOnly, options: policy.watchOptions(from: outOfRange))
        XCTAssertFalse(argv.contains("--poll-ms"), "out-of-range poll dropped at the boundary")
        XCTAssertFalse(argv.contains("--heartbeat-seconds"), "out-of-range heartbeat dropped at the boundary")

        // nil overrides stay omitted.
        XCTAssertEqual(policy.watchOptions(from: .defaults), WatchOptions(pollMs: nil, heartbeatSeconds: nil))
    }

    func testWatchOptionsBoundaryTracksMutatedSchemaRange() throws {
        // The SAME persisted value is accepted under one schema range and rejected under a mutated one —
        // proving the boundary check is schema-DERIVED, not a copied constant.
        let schema = try TestSupport.contractSchema("watch.schema.json")
        var obj = try JSONSerialization.jsonObject(with: schema) as! [String: Any]
        var contract = obj["x-atlas-contract"] as! [String: Any]
        var flags = contract["flags"] as! [[String: Any]]
        for i in flags.indices {
            if let name = flags[i]["name"] as? String, name.hasPrefix("--poll-ms") {
                flags[i]["constraint"] = "200..300"
            }
        }
        contract["flags"] = flags
        obj["x-atlas-contract"] = contract
        let mutated = try JSONSerialization.data(withJSONObject: obj)

        var s = Settings.defaults
        s.pollMs = 100 // valid under the real 100..10000, INVALID under the mutated 200..300
        XCTAssertEqual(try WatchOptionPolicy(watchSchema: schema).watchOptions(from: s).pollMs, 100,
                       "accepted under the current schema range")
        XCTAssertNil(try WatchOptionPolicy(watchSchema: mutated).watchOptions(from: s).pollMs,
                     "dropped under the mutated schema range — bounds are derived, not hardcoded")
    }
}
