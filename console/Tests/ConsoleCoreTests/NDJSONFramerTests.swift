import XCTest
@testable import ConsoleCore

final class NDJSONFramerTests: XCTestCase {
    private func str(_ d: Data) -> String { String(decoding: d, as: UTF8.self) }

    func testLineSplitAcrossTwoPushes() {
        var f = NDJSONFramer()
        XCTAssertEqual(f.push(Data("abc".utf8)).count, 0, "no complete line yet")
        let lines = f.push(Data("def\n".utf8))
        XCTAssertEqual(lines.map(str), ["abcdef"])
    }

    func testMultipleLinesInOnePush() {
        var f = NDJSONFramer()
        let lines = f.push(Data("a\nb\nc\n".utf8))
        XCTAssertEqual(lines.map(str), ["a", "b", "c"])
    }

    func testTrailingPartialRetainedThenCompleted() {
        var f = NDJSONFramer()
        XCTAssertEqual(f.push(Data("first\nsec".utf8)).map(str), ["first"])
        XCTAssertEqual(f.push(Data("ond\n".utf8)).map(str), ["second"])
    }

    func testMultiByteScalarSplitAcrossBoundaryReassembled() {
        var f = NDJSONFramer()
        // "…" = U+2026 = E2 80 A6. Split the 3 bytes across two pushes, mid-scalar.
        XCTAssertEqual(f.push(Data([0x78, 0xE2])).count, 0)              // "x" + first byte of "…"
        let lines = f.push(Data([0x80, 0xA6, 0x0A]))                     // remaining 2 bytes + newline
        XCTAssertEqual(lines.count, 1)
        XCTAssertEqual(str(lines[0]), "x…", "the split UTF-8 scalar is reconstructed intact")
    }

    func testEmptyChunksTolerated() {
        var f = NDJSONFramer()
        XCTAssertEqual(f.push(Data()).count, 0)
        XCTAssertEqual(f.push(Data("hello".utf8)).count, 0)
        XCTAssertEqual(f.push(Data()).count, 0)
        XCTAssertEqual(f.push(Data("\n".utf8)).map(str), ["hello"])
    }

    func testFinishReturnsUnterminatedTail() {
        var f = NDJSONFramer()
        XCTAssertEqual(f.push(Data("done\ntail".utf8)).map(str), ["done"])
        XCTAssertEqual(f.finish().map(str), "tail")
        XCTAssertNil(f.finish(), "buffer consumed")
    }

    func testFinishNilWhenNoTail() {
        var f = NDJSONFramer()
        _ = f.push(Data("x\n".utf8))
        XCTAssertNil(f.finish())
    }
}
