import XCTest
@testable import ConsoleCore

private struct Sample: Decodable, Equatable {
    let id: String
    let count: Int
}

final class SchemaDecodeTests: XCTestCase {
    private let schema = #"""
    {"type":"object","unevaluatedProperties":false,
     "required":["id","count"],
     "properties":{"id":{"type":"string","minLength":1},"count":{"type":"integer","minimum":0}}}
    """#

    func testValidRoundTrips() throws {
        let v = try SchemaValidator(schema: Data(schema.utf8))
        let decoded = try v.decode(Sample.self, from: Data(#"{"id":"a","count":3}"#.utf8))
        XCTAssertEqual(decoded, Sample(id: "a", count: 3))
    }

    func testInvalidRejectedBeforeDecode() throws {
        let v = try SchemaValidator(schema: Data(schema.utf8))
        // count is negative — fails the schema, must throw before decode.
        XCTAssertThrowsError(try v.decode(Sample.self, from: Data(#"{"id":"a","count":-1}"#.utf8))) { err in
            XCTAssertTrue(err is SchemaValidationFailure)
        }
        // extra property rejected by unevaluatedProperties:false.
        XCTAssertThrowsError(try v.decode(Sample.self, from: Data(#"{"id":"a","count":1,"x":2}"#.utf8)))
    }
}
