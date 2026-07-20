import XCTest
@testable import ConsoleCore

private func validator(_ json: String) throws -> SchemaValidator {
    try SchemaValidator(schema: Data(json.utf8))
}

final class SchemaValidatorTests: XCTestCase {
    func assertValid(_ schema: String, _ instance: String, _ msg: String = "", file: StaticString = #filePath, line: UInt = #line) {
        do {
            let r = try validator(schema).validate(Data(instance.utf8))
            XCTAssertTrue(r.isValid, "\(msg): expected valid, got \(r.errors)", file: file, line: line)
        } catch { XCTFail("schema build failed: \(error)", file: file, line: line) }
    }

    func assertInvalid(_ schema: String, _ instance: String, _ msg: String = "", file: StaticString = #filePath, line: UInt = #line) {
        do {
            let r = try validator(schema).validate(Data(instance.utf8))
            XCTAssertFalse(r.isValid, "\(msg): expected invalid, got valid", file: file, line: line)
        } catch { XCTFail("schema build failed: \(error)", file: file, line: line) }
    }

    func testType() {
        assertValid(#"{"type":"string"}"#, #""hi""#)
        assertInvalid(#"{"type":"string"}"#, "42")
        assertValid(#"{"type":"integer"}"#, "7")
        assertInvalid(#"{"type":"integer"}"#, "7.5")
        assertValid(#"{"type":"number"}"#, "7.5")
        assertValid(#"{"type":"boolean"}"#, "true")
        assertInvalid(#"{"type":"boolean"}"#, "1") // 1 is not a boolean
        assertValid(#"{"type":"null"}"#, "null")
        assertValid(#"{"type":["string","null"]}"#, "null")
    }

    func testRequiredAndProperties() {
        let s = #"{"type":"object","properties":{"a":{"type":"integer"}},"required":["a"]}"#
        assertValid(s, #"{"a":1}"#)
        assertInvalid(s, #"{}"#, "missing required")
        assertInvalid(s, #"{"a":"x"}"#, "wrong prop type")
    }

    func testAdditionalAndUnevaluatedProperties() {
        assertInvalid(#"{"type":"object","properties":{"a":{}},"additionalProperties":false}"#, #"{"a":1,"b":2}"#)
        assertValid(#"{"type":"object","properties":{"a":{}},"additionalProperties":false}"#, #"{"a":1}"#)
        assertInvalid(#"{"type":"object","properties":{"a":{}},"unevaluatedProperties":false}"#, #"{"a":1,"b":2}"#)
    }

    func testEnumConst() {
        assertValid(#"{"enum":["x","y"]}"#, #""x""#)
        assertInvalid(#"{"enum":["x","y"]}"#, #""z""#)
        assertValid(#"{"const":1}"#, "1")
        assertInvalid(#"{"const":1}"#, "2")
        assertInvalid(#"{"const":true}"#, "1") // bool const not matched by number
    }

    func testNumericBounds() {
        assertValid(#"{"minimum":0,"maximum":10}"#, "5")
        assertInvalid(#"{"minimum":0}"#, "-1")
        assertInvalid(#"{"maximum":10}"#, "11")
    }

    func testStringConstraintsSemanticNegatives() {
        assertInvalid(#"{"type":"string","minLength":3}"#, #""hi""#, "too short")
        assertValid(#"{"type":"string","minLength":3}"#, #""hii""#)
        assertInvalid(#"{"type":"string","maxLength":2}"#, #""hii""#, "too long")
        assertInvalid(#"{"type":"string","pattern":"^p256:"}"#, #""ed25519:abc""#, "pattern violation")
        assertValid(#"{"type":"string","pattern":"^p256:"}"#, #""p256:abc""#)
    }

    func testArrayConstraintsSemanticNegatives() {
        assertInvalid(#"{"type":"array","minItems":2}"#, "[1]")
        assertInvalid(#"{"type":"array","maxItems":1}"#, "[1,2]")
        assertValid(#"{"type":"array","items":{"type":"integer"}}"#, "[1,2,3]")
        assertInvalid(#"{"type":"array","items":{"type":"integer"}}"#, #"[1,"x"]"#, "bad array item")
    }

    func testPatternProperties() {
        let s = #"{"type":"object","patternProperties":{"^n":{"type":"integer"}},"additionalProperties":false}"#
        assertValid(s, #"{"num":1}"#)
        assertInvalid(s, #"{"num":"x"}"#)
        assertInvalid(s, #"{"other":1}"#, "unmatched key rejected by additionalProperties")
    }

    func testApplicators() {
        assertValid(#"{"allOf":[{"type":"integer"},{"minimum":0}]}"#, "5")
        assertInvalid(#"{"allOf":[{"type":"integer"},{"minimum":0}]}"#, "-1")
        assertValid(#"{"anyOf":[{"type":"string"},{"type":"integer"}]}"#, "5")
        assertInvalid(#"{"anyOf":[{"type":"string"},{"type":"integer"}]}"#, "true")
        assertValid(#"{"oneOf":[{"type":"string"},{"type":"integer"}]}"#, "5")
        assertInvalid(#"{"oneOf":[{"minimum":0},{"maximum":10}]}"#, "5", "matches both ⇒ not exactly one")
        assertValid(#"{"not":{"type":"string"}}"#, "5")
        assertInvalid(#"{"not":{"type":"string"}}"#, #""x""#)
    }

    func testIfThenElse() {
        let s = #"""
        {"type":"object",
         "properties":{"kind":{"type":"string"},"n":{"type":"integer"}},
         "if":{"properties":{"kind":{"const":"a"}},"required":["kind"]},
         "then":{"required":["n"]}}
        """#
        assertValid(s, #"{"kind":"a","n":1}"#)
        assertInvalid(s, #"{"kind":"a"}"#, "then requires n")
        assertValid(s, #"{"kind":"b"}"#, "else branch: n not required")
    }

    func testUnevaluatedWithApplicators() {
        // A then-branch property counts as evaluated, so unevaluatedProperties:false permits it.
        let s = #"""
        {"type":"object","unevaluatedProperties":false,
         "properties":{"kind":{}},
         "allOf":[{"if":{"properties":{"kind":{"const":"a"}},"required":["kind"]},
                   "then":{"properties":{"extra":{"type":"integer"}}}}]}
        """#
        assertValid(s, #"{"kind":"a","extra":3}"#, "extra evaluated via then")
        assertInvalid(s, #"{"kind":"a","extra":3,"bogus":1}"#, "bogus never evaluated")
    }

    func testLocalRef() {
        let s = ##"{"$defs":{"pos":{"type":"integer","minimum":0}},"$ref":"#/$defs/pos"}"##
        assertValid(s, "3")
        assertInvalid(s, "-1")
    }

    // MARK: - Numeric precision boundary (wing finding: Double coercion collides > 2^53)

    /// Two distinct integers above 2^53 must NOT be treated as equal by const/enum/echoed equality.
    /// 9007199254740993 (2^53+1) and 9007199254740992 (2^53) are the same `Double`.
    func testConstIntegerPrecisionBoundary() {
        assertValid(#"{"const":9007199254740993}"#, "9007199254740993")
        assertInvalid(#"{"const":9007199254740993}"#, "9007199254740992",
                      "2^53+1 vs 2^53 must not collide under const")
    }

    func testEnumIntegerPrecisionBoundary() {
        assertValid(#"{"enum":[9007199254740993]}"#, "9007199254740993")
        assertInvalid(#"{"enum":[9007199254740993]}"#, "9007199254740992")
    }

    func testBoundsIntegerPrecisionBoundary() {
        // minimum 2^53+1: 2^53 is below it and must be rejected, not seen as equal.
        assertInvalid(#"{"minimum":9007199254740993}"#, "9007199254740992")
        assertValid(#"{"minimum":9007199254740993}"#, "9007199254740993")
    }

    /// JSONValue must preserve large integers losslessly so echoed-challenge equality can't be fooled.
    func testJSONValuePreservesLargeIntegers() throws {
        let a = try JSONDecoder().decode(JSONValue.self, from: Data("9007199254740993".utf8))
        let b = try JSONDecoder().decode(JSONValue.self, from: Data("9007199254740992".utf8))
        XCTAssertEqual(a, .integer(9007199254740993))
        XCTAssertNotEqual(a, b, "distinct integers above 2^53 must stay distinct in JSONValue")
    }

    // A huge integral value validates as `type: integer` (zero fractional part per JSON Schema).
    func testHugeIntegralPassesIntegerType() {
        assertValid(#"{"type":"integer"}"#, "100000000000000000000000000000001",
                    "a >Int64 integral value is a valid integer")
    }

    // A huge value WITH a fractional part must NOT be classified integer. A `Double` round-trip would
    // round it to an integral double and wrongly pass; the `Decimal`-based check must reject it.
    func testHugeFractionalFailsIntegerType() {
        assertInvalid(#"{"type":"integer"}"#, "100000000000000000000000000000000.5",
                      "a huge fractional value must not be misclassified as integer")
    }

    // A pathological length bound far beyond Int must not trap (`Int(Double)` overflow); it is ignored.
    func testAbsurdMaxLengthDoesNotTrap() {
        assertValid(#"{"type":"string","maxLength":1e308}"#, "\"hello\"",
                    "an out-of-range maxLength bound is ignored, never a crash")
    }

    func testWatchSchemaExamplesRoundTrip() throws {
        let data = try TestSupport.contractSchema("watch.schema.json")
        let v = try SchemaValidator(schema: data)
        let obj = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        let examples = obj["examples"] as! [Any]
        for (i, ex) in examples.enumerated() {
            let line = try JSONSerialization.data(withJSONObject: ex)
            XCTAssertTrue(v.validate(line).isValid, "watch example \(i) should validate: \(v.validate(line).errors)")
        }
    }
}
