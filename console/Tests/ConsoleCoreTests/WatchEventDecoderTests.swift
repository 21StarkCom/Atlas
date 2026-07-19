import XCTest
@testable import ConsoleCore

final class WatchEventDecoderTests: XCTestCase {
    private func decoder() throws -> WatchEventDecoder {
        try WatchEventDecoder(schema: try TestSupport.contractSchema("watch.schema.json"))
    }

    /// The examples embedded in watch.schema.json, each serialized to one NDJSON line.
    private func exampleLines() throws -> [(event: String, line: Data)] {
        let schema = try TestSupport.contractSchema("watch.schema.json")
        let obj = try JSONSerialization.jsonObject(with: schema) as! [String: Any]
        let examples = obj["examples"] as! [[String: Any]]
        return try examples.map { ex in
            (ex["event"] as! String, try JSONSerialization.data(withJSONObject: ex))
        }
    }

    private func expectedCaseName(_ e: WatchEvent) -> String {
        switch e {
        case .hello: return "watch.hello"
        case .heartbeat: return "watch.heartbeat"
        case .watchError: return "watch.error"
        case .job: return "job"
        case .modelCall: return "model_call"
        case .audit: return "audit"
        case .backup: return "backup"
        case .daemon: return "daemon"
        case .unknown: return "<unknown>"
        }
    }

    func testDecodesEveryExampleWithZeroErrors() throws {
        let dec = try decoder()
        let lines = try exampleLines()
        // Cover all 8 event types incl. attached + detached hellos and both audit seq spaces.
        XCTAssertGreaterThanOrEqual(Set(lines.map(\.event)).count, 8, "examples cover all 8 event types")
        for (event, line) in lines {
            let decoded = try dec.decode(line)
            XCTAssertEqual(expectedCaseName(decoded), event, "line for `\(event)` decoded to the matching case")
        }
    }

    func testAttachedAndDetachedHelloBothDecode() throws {
        let dec = try decoder()
        let hellos = try exampleLines().filter { $0.event == "watch.hello" }
        XCTAssertEqual(hellos.count, 2, "one attached + one detached hello example")
        for (_, line) in hellos {
            guard case .hello(let p) = try dec.decode(line) else { return XCTFail("expected hello") }
            if p.ledger.attached {
                XCTAssertNotNil(p.snapshot.audit, "attached hello carries ledger-derived snapshot keys")
            } else {
                XCTAssertNil(p.snapshot.audit, "detached hello omits ledger-derived keys (never fabricated)")
                XCTAssertNil(p.resume, "detached hello omits resume")
            }
        }
    }

    func testTypedPayloadFieldsRoundTrip() throws {
        let dec = try decoder()
        for (event, line) in try exampleLines() {
            let decoded = try dec.decode(line)
            switch decoded {
            case .job(let j) where event == "job":
                XCTAssertEqual(j.state, "failed")
                XCTAssertEqual(j.lastError, "transient:egress-unreachable")
            case .modelCall(let m) where event == "model_call":
                XCTAssertEqual(m.provider, "gemini")
                XCTAssertEqual(m.inputTokens, 512)
            case .audit(let a) where event == "audit":
                XCTAssertFalse(a.runId.isEmpty)
            case .daemon(let d) where event == "daemon":
                XCTAssertEqual(d.previousReachable, true)
                XCTAssertEqual(d.reachable, false)
            default:
                break
            }
        }
    }

    /// The common envelope `at` timestamp is preserved on every typed payload (Phase 3 needs
    /// `snapshotAsOf = hello.at`), matching the envelope value across all schema examples.
    func testEnvelopeTimestampPreservedAcrossExamples() throws {
        let dec = try decoder()
        let schema = try TestSupport.contractSchema("watch.schema.json")
        let obj = try JSONSerialization.jsonObject(with: schema) as! [String: Any]
        let examples = obj["examples"] as! [[String: Any]]
        for ex in examples {
            let expectedAt = ex["at"] as! String
            let line = try JSONSerialization.data(withJSONObject: ex)
            let at: String?
            switch try dec.decode(line) {
            case .hello(let p): at = p.at
            case .heartbeat(let p): at = p.at
            case .watchError(let p): at = p.at
            case .job(let p): at = p.at
            case .modelCall(let p): at = p.at
            case .audit(let p): at = p.at
            case .backup(let p): at = p.at
            case .daemon(let p): at = p.at
            case .unknown: at = nil
            }
            XCTAssertEqual(at, expectedAt, "typed payload preserves the envelope `at` for \(ex["event"] as! String)")
        }
    }

    /// High-space audit rows (seq >= DB_EVENT_SEQ_BASE) still decode — routing them is Phase 3's job.
    func testHighSpaceAuditSeqDecodes() throws {
        let dec = try decoder()
        let highSpace = try exampleLines()
            .filter { $0.event == "audit" }
            .compactMap { try? dec.decode($0.line) }
            .compactMap { if case .audit(let a) = $0 { return a } else { return nil } }
        XCTAssertTrue(highSpace.contains { $0.seq >= ConsoleConstants.dbEventSeqBase },
                      "the db.* high-space audit example decodes with its full int64 seq")
    }

    // MARK: - Negatives

    private func mutatedAudit(_ mutate: (inout [String: Any]) -> Void) throws -> Data {
        let schema = try TestSupport.contractSchema("watch.schema.json")
        let obj = try JSONSerialization.jsonObject(with: schema) as! [String: Any]
        var audit = (obj["examples"] as! [[String: Any]]).first { $0["event"] as? String == "audit" }!
        mutate(&audit)
        return try JSONSerialization.data(withJSONObject: audit)
    }

    /// The envelope `at` must be RFC-3339 ms UTC. A malformed timestamp is rejected at the envelope gate
    /// for BOTH a known event and an unknown (future) event — the gate runs before the union/unknown check.
    func testMalformedTimestampRejectedForKnownAndUnknownEvents() throws {
        let dec = try decoder()
        // Known event (hello) with a malformed `at`.
        let known = Data(#"{"v":1,"event":"watch.heartbeat","at":"2026-07-18 10:00:00"}"#.utf8)
        XCTAssertThrowsError(try dec.decode(known)) { err in
            guard case WatchDecodeError.malformedEnvelope = err else {
                return XCTFail("expected malformedEnvelope, got \(err)")
            }
        }
        // Unknown/future event with a malformed `at` — still rejected at the envelope gate, not tolerated.
        let unknown = Data(#"{"v":1,"event":"future.additive","at":"not-a-timestamp"}"#.utf8)
        XCTAssertThrowsError(try dec.decode(unknown)) { err in
            guard case WatchDecodeError.malformedEnvelope = err else {
                return XCTFail("expected malformedEnvelope for unknown event, got \(err)")
            }
        }
        // A well-formed `at` on an unknown event IS tolerated (→ .unknown), proving the timestamp is the
        // discriminator, not the event name.
        let goodUnknown = Data(#"{"v":1,"event":"future.additive","at":"2026-07-18T10:00:00.000Z"}"#.utf8)
        guard case .unknown = try dec.decode(goodUnknown) else {
            return XCTFail("a well-formed unknown event should decode to .unknown")
        }
    }

    func testRenamedRequiredFieldFailsDecode() throws {
        let dec = try decoder()
        let line = try mutatedAudit { a in a["seq"] = nil; a["sequence"] = 5 }
        XCTAssertThrowsError(try dec.decode(line)) { err in
            guard case WatchDecodeError.schemaInvalid(let event, _) = err else { return XCTFail("wrong error \(err)") }
            XCTAssertEqual(event, "audit")
        }
    }

    func testNullWhereContractOmitsFailsDecode() throws {
        let dec = try decoder()
        // The detached hello OMITS `resume`; a `null` there must fail (contract omits, never nulls).
        let schema = try TestSupport.contractSchema("watch.schema.json")
        let obj = try JSONSerialization.jsonObject(with: schema) as! [String: Any]
        var hello = (obj["examples"] as! [[String: Any]]).first {
            $0["event"] as? String == "watch.hello" && !(($0["ledger"] as! [String: Any])["attached"] as! Bool)
        }!
        hello["resume"] = NSNull()
        let line = try JSONSerialization.data(withJSONObject: hello)
        XCTAssertThrowsError(try dec.decode(line))
    }

    func testWrongTypeFailsDecode() throws {
        let dec = try decoder()
        let line = try mutatedAudit { a in a["seq"] = "not-an-int" }
        XCTAssertThrowsError(try dec.decode(line))
    }

    func testExtraPropertyFailsClosedUnion() throws {
        let dec = try decoder()
        // unevaluatedProperties:false — an unexpected key on a KNOWN event fails (not tolerated like an
        // unknown *event value*).
        let line = try mutatedAudit { a in a["surprise"] = true }
        XCTAssertThrowsError(try dec.decode(line))
    }

    func testNonJSONFailsDecode() throws {
        let dec = try decoder()
        XCTAssertThrowsError(try dec.decode(Data("not json".utf8))) { err in
            XCTAssertEqual(err as? WatchDecodeError, .notJSON)
        }
    }
}

final class UnknownEventToleranceTests: XCTestCase {
    func testUnknownEventDecodesToUnknownNeverCrashes() throws {
        let dec = try WatchEventDecoder(schema: try TestSupport.contractSchema("watch.schema.json"))
        let line = Data(#"{"v":1,"event":"watch.future","at":"2026-07-18T10:00:00.000Z"}"#.utf8)
        guard case .unknown(let raw) = try dec.decode(line) else {
            return XCTFail("an additive future event must decode to .unknown, not throw")
        }
        XCTAssertEqual(raw, line, "the raw line bytes are preserved verbatim")
    }

    func testUnknownEventWithExtraFieldsStillTolerated() throws {
        let dec = try WatchEventDecoder(schema: try TestSupport.contractSchema("watch.schema.json"))
        // A future event carrying fields the closed union would reject must still be tolerated — the
        // unknown-event path is checked BEFORE the closed line-union.
        let line = Data(#"{"v":1,"event":"quarantine","at":"2026-07-18T10:00:00.000Z","foo":{"bar":1}}"#.utf8)
        guard case .unknown = try dec.decode(line) else { return XCTFail("expected .unknown") }
    }

    func testMissingEnvelopeStillFails() throws {
        let dec = try WatchEventDecoder(schema: try TestSupport.contractSchema("watch.schema.json"))
        // No `v` — the envelope gate fails even for an otherwise-unknown event.
        let line = Data(#"{"event":"watch.future","at":"2026-07-18T10:00:00.000Z"}"#.utf8)
        XCTAssertThrowsError(try dec.decode(line)) { err in
            guard case WatchDecodeError.malformedEnvelope = err else { return XCTFail("wrong error \(err)") }
        }
    }
}
