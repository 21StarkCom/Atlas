import XCTest
@testable import ConsoleCore

final class ExitInterpreterTests: XCTestCase {
    /// The two namespaces are DISJOINT: the same numeric code carries different meaning per table, and
    /// the enums are distinct types so a cross-table lookup is a compile error, not a runtime bug.
    func testSameNumberDistinctMeaningAcrossTables() {
        XCTAssertEqual(BrainExit(rawValue: 2), .config)
        XCTAssertEqual(SignerExit(rawValue: 2), .malformed)
        // Same raw value, different types — you cannot compare or assign across them.
        XCTAssertEqual(BrainExit.config.rawValue, SignerExit.malformed.rawValue)
    }

    func testBrainInterpretationCoversTableAggregateAndUnknown() {
        XCTAssertEqual(BrainExit.interpret(0), .known(.ok))
        XCTAssertEqual(BrainExit.interpret(6), .known(.actionRequired))
        // 7 is the jobs-run batch aggregate — ignored as a normal single-command code.
        XCTAssertEqual(BrainExit.interpret(7), .aggregateRetryExhausted)
        XCTAssertEqual(BrainExit.interpret(42), .unrecognized(42))
    }

    func testSignerInterpretationCoversTableAndUnknown() {
        XCTAssertEqual(SignerExit.interpret(0), .known(.signed))
        XCTAssertEqual(SignerExit.interpret(5), .known(.keyInvalidated))
        // The signer table caps at 5 — no 6/7 in this namespace.
        XCTAssertEqual(SignerExit.interpret(6), .unrecognized(6))
        XCTAssertEqual(SignerExit.interpret(7), .unrecognized(7))
    }
}
