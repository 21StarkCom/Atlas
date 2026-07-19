import XCTest
@testable import ConsoleCore

final class SchemaKeywordCoverageTests: XCTestCase {
    /// Walk every schema in the bound contract bundle; fail on any keyword the validator does not implement.
    func testEveryBoundSchemaKeywordIsImplemented() throws {
        let bundle = try TestSupport.realBundle()
        var schemas: [(String, Data)] = [
            ("watch.schema.json", bundle.watchSchema),
            ("error-envelope.schema.json", bundle.errorEnvelopeSchema),
        ]
        schemas.append(contentsOf: bundle.allCommandSchemas().map { ($0.command, $0.data) })

        let known = SchemaValidator.implementedKeywords.union(SchemaValidator.ignoredKeywords)
        var unimplemented = Set<String>()
        for (name, data) in schemas {
            let used = try SchemaValidator.collectKeywords(in: data)
            let missing = used.subtracting(known)
            if !missing.isEmpty {
                unimplemented.formUnion(missing)
                XCTFail("schema \(name) uses unimplemented keyword(s): \(missing.sorted())")
            }
        }
        XCTAssertTrue(unimplemented.isEmpty, "unimplemented keywords across bundle: \(unimplemented.sorted())")
    }

    /// Unsupported *semantic* keywords must FAIL the inventory, not be silently allowlisted. `$dynamicRef`
    /// and `$dynamicAnchor` carry validation semantics this engine does not implement.
    func testDynamicKeywordsAreNotSilentlyIgnored() throws {
        let known = SchemaValidator.implementedKeywords.union(SchemaValidator.ignoredKeywords)
        XCTAssertFalse(known.contains("$dynamicRef"), "$dynamicRef must not be treated as known/ignorable")
        XCTAssertFalse(known.contains("$dynamicAnchor"), "$dynamicAnchor must not be treated as known/ignorable")

        let schema = ##"{"type":"object","properties":{"x":{"$dynamicRef":"#meta"}}}"##
        let used = try SchemaValidator.collectKeywords(in: Data(schema.utf8))
        let missing = used.subtracting(known)
        XCTAssertTrue(missing.contains("$dynamicRef"),
                      "a schema using $dynamicRef must surface it as an unimplemented keyword, failing the coverage gate")
    }

    /// The applicator-heavy real schemas construct and validate their own examples (exercises allOf/if/then/else).
    func testApplicatorHeavySchemasValidateExamples() throws {
        for name in ["query.schema.json", "purge.schema.json", "index-repair.schema.json"] {
            let data = try TestSupport.contractSchema(name)
            let v = try SchemaValidator(schema: data)
            let obj = try JSONSerialization.jsonObject(with: data) as! [String: Any]
            guard let examples = obj["examples"] as? [Any] else {
                XCTFail("\(name) has no examples"); continue
            }
            for (i, ex) in examples.enumerated() {
                let inst = try JSONSerialization.data(withJSONObject: ex)
                let r = v.validate(inst)
                XCTAssertTrue(r.isValid, "\(name) example \(i) should validate: \(r.errors)")
            }
        }
    }

    /// Semantic negatives on the purge schema: a conditionally-required field missing fails; a
    /// forbidden extra property under unevaluatedProperties:false fails.
    func testPurgeSemanticNegatives() throws {
        let data = try TestSupport.contractSchema("purge.schema.json")
        let v = try SchemaValidator(schema: data)
        let obj = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        let examples = obj["examples"] as! [[String: Any]]

        // Take the valid "applied/ordinary" example and drop a then-branch required field.
        var applied = examples.first { ($0["mode"] as? String) == "applied" }!
        applied.removeValue(forKey: "erasedClasses") // required when mode == applied
        let missingRequired = try JSONSerialization.data(withJSONObject: applied)
        XCTAssertFalse(v.validate(missingRequired).isValid, "applied purge missing erasedClasses must fail")

        // Take the valid preview example and add a forbidden extra property.
        var preview = examples.first { ($0["mode"] as? String) == "preview" }!
        preview["bogusField"] = 123
        let extraProp = try JSONSerialization.data(withJSONObject: preview)
        XCTAssertFalse(v.validate(extraProp).isValid, "unevaluated property must fail under unevaluatedProperties:false")

        // history-rewrite requires challengeBinding.oldHead + replacementHead.
        var histBad = examples.first { ($0["erasureClass"] as? String) == "history-rewrite" }!
        var binding = histBad["challengeBinding"] as! [String: Any]
        binding.removeValue(forKey: "oldHead")
        histBad["challengeBinding"] = binding
        let histData = try JSONSerialization.data(withJSONObject: histBad)
        XCTAssertFalse(v.validate(histData).isValid, "history-rewrite without oldHead must fail the then-branch required")
    }
}
