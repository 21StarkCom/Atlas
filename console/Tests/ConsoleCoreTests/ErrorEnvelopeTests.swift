import XCTest
@testable import ConsoleCore

final class ErrorEnvelopeTests: XCTestCase {
    private func parser() throws -> ErrorEnvelopeParser {
        try ErrorEnvelopeParser(schema: try TestSupport.contractSchema("error-envelope.schema.json"))
    }

    /// The examples embedded in error-envelope.schema.json, by `code`.
    private func example(_ code: String) throws -> Data {
        let schema = try TestSupport.contractSchema("error-envelope.schema.json")
        let obj = try JSONSerialization.jsonObject(with: schema) as! [String: Any]
        let ex = (obj["examples"] as! [[String: Any]]).first { $0["code"] as? String == code }!
        return try JSONSerialization.data(withJSONObject: ex)
    }

    func testParsesEverySchemaExample() throws {
        let p = try parser()
        let schema = try TestSupport.contractSchema("error-envelope.schema.json")
        let obj = try JSONSerialization.jsonObject(with: schema) as! [String: Any]
        for ex in obj["examples"] as! [[String: Any]] {
            let data = try JSONSerialization.data(withJSONObject: ex)
            XCTAssertNoThrow(try p.parse(data), "example `\(ex["code"] ?? "?")` parses")
        }
    }

    /// Retry decisions read `retryable` (+ `retryAfterMs`), never the numeric exit code.
    func testRetryDrivesOffFlagsNotExitCode() throws {
        let p = try parser()
        let retryable = try p.parse(example("locked:vault-maintenance"))
        XCTAssertTrue(retryable.retryable)
        let notRetryable = try p.parse(example("usage"))
        XCTAssertFalse(notRetryable.retryable)

        // retryAfterMs is provider-directed timing, independent of the boolean gate.
        let withDelay = Data(#"{"code":"rate_limit","message":"slow down","hint":"","retryable":true,"retryAfterMs":1500}"#.utf8)
        let parsed = try p.parse(withDelay)
        XCTAssertEqual(parsed.retryAfterMs, 1500)
        XCTAssertTrue(parsed.retryable)
    }

    /// The nominal exit `7` is the batch aggregate — ignored for a single-command envelope, whose
    /// retryability rides the flags above.
    func testEnumeratedSevenIsIgnoredForSingleEnvelope() {
        XCTAssertEqual(BrainExit.interpret(7), .aggregateRetryExhausted)
    }

    /// Structured remediation is read from `details` by field — never by parsing `message`/`hint`.
    func testDetailsReadStructuredNeverParseMessage() throws {
        let p = try parser()
        let cfg = try p.parse(example("config-invalid"))
        XCTAssertEqual(cfg.details?["field"], .string("sqlite.ledger_backup.keep"))
        if case .object(let loc)? = cfg.details?["location"] {
            XCTAssertEqual(loc["file"], .string("brain.config.yaml"))
            XCTAssertEqual(loc["line"], .integer(12))
        } else {
            XCTFail("expected a structured location object")
        }

        // Code-specific keys beyond the common field/path/location are read the same structured way.
        let locked = try p.parse(example("locked:vault-maintenance"))
        XCTAssertEqual(locked.details?["scope"], .string("vault-maintenance"))
        XCTAssertEqual(locked.details?["holderPid"], .integer(44122))
    }

    /// Nested `errors[]` follow the schema's `nestedError` shape (only code/message required); they
    /// decode with defaulted hint/retryable rather than failing a schema-valid envelope.
    func testNestedErrorsDecode() throws {
        let p = try parser()
        let batch = try p.parse(example("validation"))
        XCTAssertEqual(batch.errors?.count, 2)
        XCTAssertEqual(batch.errors?.first?.code, "validation")
        XCTAssertEqual(batch.errors?.first?.hint, "", "nested hint defaults when the contract omits it")
        XCTAssertEqual(batch.errors?.first?.retryable, false)
    }

    func testRunIdSurfacedWhenPresent() throws {
        let p = try parser()
        let authz = try p.parse(example("authz.presence_unverified"))
        XCTAssertEqual(authz.runId, "01J9Z8Q7M2N3P4R5S6T7V8W9XA")
    }

    /// A malformed envelope (missing a top-level required field) fails at the schema gate before decode.
    func testMalformedEnvelopeRejected() throws {
        let p = try parser()
        let missingRetryable = Data(#"{"code":"x","message":"m","hint":"h"}"#.utf8)
        XCTAssertThrowsError(try p.parse(missingRetryable))
    }
}
