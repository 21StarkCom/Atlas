import XCTest
@testable import ConsoleCore

/// Wires `SystemProcessRunner.stream` → `WatchTransport` (the production `NDJSONFramer` → `WatchStreamParser`
/// pipeline) through a REAL subprocess pipe under adversarial chunking. This could only pass because
/// framing lives in `NDJSONFramer`, not in the spawn layer — a chunk-equals-line shortcut would fail here.
final class TransportFramingTests: XCTestCase {
    let runner = SystemProcessRunner()

    /// A shell script that emits `payload` in fixed-size byte chunks with a tiny sleep between each, so
    /// the pipe delivers separate reads that split both lines AND multi-byte scalars. Bytes are written
    /// via `printf '%b'` octal escapes so arbitrary bytes survive shell quoting.
    private func writeChunkedEmitter(_ dir: URL, payload: Data, chunkSize: Int) throws -> String {
        var body = ""
        var i = 0
        let bytes = [UInt8](payload)
        while i < bytes.count {
            let slice = bytes[i..<min(i + chunkSize, bytes.count)]
            let escaped = slice.map { String(format: "\\0%03o", $0) }.joined()
            body += "printf '%b' '\(escaped)'\nsleep 0.003\n"
            i += chunkSize
        }
        return try TestSupport.writeScript(dir, name: "emit-\(chunkSize).sh", body: body)
    }

    /// The canonical NDJSON payload: several event lines (incl. a multi-byte message + an unknown event)
    /// then the sole terminal error-envelope line. Identical bytes across every delivery pattern.
    private func canonicalPayload() throws -> Data {
        let helloAttached = try firstExample(event: "watch.hello", attached: true)
        let auditRun = try firstExample(event: "audit", attached: nil)
        let multiByteError = Data(
            #"{"v":1,"event":"watch.error","at":"2026-07-18T10:01:00.000Z","source":"internal","code":"x","message":"café résumé …"}"#.utf8
        )
        let unknownEvent = Data(#"{"v":1,"event":"watch.future","at":"2026-07-18T10:02:00.000Z"}"#.utf8)
        let terminalEnvelope = Data(#"{"code":"internal","message":"fatal mid-stream fault","hint":"","retryable":false}"#.utf8)

        var payload = Data()
        for line in [helloAttached, auditRun, multiByteError, unknownEvent, terminalEnvelope] {
            payload.append(line)
            payload.append(0x0A)
        }
        return payload
    }

    /// Drives one delivery pattern (a chunk size) through a real subprocess pipe + the production
    /// `WatchTransport`, returning the classified item sequence and the child's exit code.
    private func drive(payload: Data, chunkSize: Int, bundle: ContractBundle) async throws -> (items: [StreamItem], exit: Int32) {
        let dir = TestSupport.tempDir()
        let script = try writeChunkedEmitter(dir, payload: payload, chunkSize: chunkSize)
        let req = SpawnRequest(
            executable: [script],
            arguments: [],
            cwd: dir,
            environment: ["PATH": "/usr/bin:/bin"]
        )
        let handle = try runner.stream(req)
        let transport = try WatchTransport(watchSchema: bundle.watchSchema, errorEnvelopeSchema: bundle.errorEnvelopeSchema)

        var items: [StreamItem] = []
        for try await item in transport.items(from: handle) {
            items.append(item)
        }
        let completion = await handle.completion()
        return (items, completion.exitCode)
    }

    /// The four required adversarial deliveries of IDENTICAL bytes must produce IDENTICAL StreamItem
    /// sequences: line split across reads (chunk 3), split multi-byte scalar (chunk 7 straddles the
    /// 2-byte `é`/3-byte `…`), byte-at-a-time (chunk 1, maximal splitting), and multiple lines per read
    /// (one giant chunk). The final line is the sole terminal envelope in every case.
    func testFourAdversarialDeliveriesProduceIdenticalSequences() async throws {
        let bundle = try TestSupport.realBundle()
        let payload = try canonicalPayload()

        let byteAtATime = try await drive(payload: payload, chunkSize: 1, bundle: bundle)
        let smallSplit = try await drive(payload: payload, chunkSize: 3, bundle: bundle)
        let scalarSplit = try await drive(payload: payload, chunkSize: 7, bundle: bundle)
        let oneBigRead = try await drive(payload: payload, chunkSize: payload.count, bundle: bundle)

        for run in [byteAtATime, smallSplit, scalarSplit, oneBigRead] {
            XCTAssertEqual(run.exit, 0)
        }
        // Equivalence: all four deliveries decode to the same ordered item sequence.
        XCTAssertEqual(smallSplit.items, byteAtATime.items, "3-byte chunks == byte-at-a-time")
        XCTAssertEqual(scalarSplit.items, byteAtATime.items, "7-byte chunks (scalar-splitting) == byte-at-a-time")
        XCTAssertEqual(oneBigRead.items, byteAtATime.items, "one giant read (multiple lines/read) == byte-at-a-time")

        assertCanonicalShape(byteAtATime.items)
    }

    /// The classic single-pattern assertion, retained: buffering, UTF-8 reconstruction, ordering,
    /// unknown-event tolerance, and sole-terminal-envelope recognition under scalar-splitting chunks.
    func testRealPipeFramingDecodeAndTerminalEnvelope() async throws {
        let bundle = try TestSupport.realBundle()
        let payload = try canonicalPayload()
        let run = try await drive(payload: payload, chunkSize: 7, bundle: bundle)
        XCTAssertEqual(run.exit, 0)
        assertCanonicalShape(run.items)
    }

    private func assertCanonicalShape(_ items: [StreamItem]) {
        // Five items in order: hello, audit, watch.error (UTF-8 reconstructed), unknown, terminal envelope.
        XCTAssertEqual(items.count, 5)
        guard case .event(.hello) = items[0] else { return XCTFail("item 0 should be hello") }
        guard case .event(.audit) = items[1] else { return XCTFail("item 1 should be audit") }
        guard case .event(.watchError(let e)) = items[2] else { return XCTFail("item 2 should be watch.error") }
        XCTAssertEqual(e.message, "café résumé …", "split multi-byte scalars reconstructed across pipe reads")
        guard case .event(.unknown) = items[3] else { return XCTFail("item 3 should be unknown-event tolerated") }
        guard case .terminalEnvelope(let env) = items[4] else { return XCTFail("item 4 should be the terminal envelope") }
        XCTAssertEqual(env.code, "internal")
        XCTAssertFalse(env.retryable)
    }

    /// A blank / whitespace-only line is a strict-contract mismatch: the parser rejects it, and the
    /// transport surfaces the rejection through the thrown stream rather than silently skipping it.
    func testBlankLineRejectedByTransport() async throws {
        let bundle = try TestSupport.realBundle()
        let hello = try firstExample(event: "watch.hello", attached: true)
        var payload = Data()
        payload.append(hello); payload.append(0x0A)
        payload.append(Data("   \t".utf8)); payload.append(0x0A) // whitespace-only line
        let dir = TestSupport.tempDir()
        let script = try writeChunkedEmitter(dir, payload: payload, chunkSize: 5)
        let req = SpawnRequest(executable: [script], arguments: [], cwd: dir, environment: ["PATH": "/usr/bin:/bin"])
        let handle = try runner.stream(req)
        let transport = try WatchTransport(watchSchema: bundle.watchSchema, errorEnvelopeSchema: bundle.errorEnvelopeSchema)

        var caught: Error?
        var seen: [StreamItem] = []
        do {
            for try await item in transport.items(from: handle) { seen.append(item) }
        } catch { caught = error }
        _ = await handle.completion()
        XCTAssertEqual(seen.count, 1, "the valid hello is delivered before the blank-line rejection")
        XCTAssertEqual(caught as? StreamParseError, .blankLine, "blank line rejected, not skipped")
    }

    /// Direct parser-level rejection of an empty line and a whitespace-only line (no subprocess).
    func testParserRejectsEmptyAndWhitespaceLines() throws {
        let bundle = try TestSupport.realBundle()
        let parser = try WatchStreamParser(watchSchema: bundle.watchSchema, errorEnvelopeSchema: bundle.errorEnvelopeSchema)
        for blank in [Data(), Data(" ".utf8), Data("  \t \r".utf8)] {
            XCTAssertThrowsError(try parser.classify(blank)) { err in
                XCTAssertEqual(err as? StreamParseError, .blankLine, "blank/whitespace line rejected, not skipped")
            }
        }
    }

    // MARK: - Helpers

    private func firstExample(event: String, attached: Bool?) throws -> Data {
        let schema = try TestSupport.contractSchema("watch.schema.json")
        let obj = try JSONSerialization.jsonObject(with: schema) as! [String: Any]
        let examples = obj["examples"] as! [[String: Any]]
        let match = examples.first { ex in
            guard ex["event"] as? String == event else { return false }
            guard let attached else { return true }
            let ledger = ex["ledger"] as? [String: Any]
            return (ledger?["attached"] as? Bool) == attached
        }!
        return try JSONSerialization.data(withJSONObject: match)
    }
}
