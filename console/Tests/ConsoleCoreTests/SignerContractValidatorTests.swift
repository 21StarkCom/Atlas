import XCTest
@testable import ConsoleCore

final class SignerContractValidatorTests: XCTestCase {
    // #272: the example challenge is ANCHORED to the SP-3 `atlas-signer` package's
    // committed golden vectors (`console/signer/.../signing-payload-vectors.json`,
    // themselves generated from the broker's buildSigningPayload) — so upstream
    // contract drift in the signer source breaks this Console gate, instead of an
    // inline copy that could silently diverge. Force-try: the fixture is committed;
    // its absence/corruption is a hard test failure, which is the point.
    private lazy var challengeJSON: String = try! TestSupport.signerGoldenChallenge()

    private func responseJSON(signature: String = "ed25519:1f8a3caa0", challenge: String? = nil) -> String {
        """
        {
          "schemaVersion": 1,
          "challenge": \(challenge ?? challengeJSON),
          "signature": "\(signature)",
          "signerId": "atlas-approver-hsm-01"
        }
        """
    }

    private let v = SignerContractValidator()

    private func challenge() throws -> AuthorizationChallenge {
        try JSONDecoder().decode(AuthorizationChallenge.self, from: Data(challengeJSON.utf8))
    }

    func testChallengePositive() {
        XCTAssertTrue(v.validateChallenge(Data(challengeJSON.utf8)).isValid)
    }

    func testResponsePositive() throws {
        let c = try challenge()
        let r = v.validateResponse(Data(responseJSON(signature: "p256:aabbcc").utf8), echoing: c)
        XCTAssertTrue(r.isValid, "\(r.errors)")
    }

    func testMissingSchemaVersionFails() {
        var obj = try! JSONSerialization.jsonObject(with: Data(challengeJSON.utf8)) as! [String: Any]
        obj.removeValue(forKey: "schemaVersion")
        let data = try! JSONSerialization.data(withJSONObject: obj)
        XCTAssertFalse(v.validateChallenge(data).isValid)
    }

    func testMissingPayloadCanonicalizationFails() {
        var obj = try! JSONSerialization.jsonObject(with: Data(challengeJSON.utf8)) as! [String: Any]
        obj.removeValue(forKey: "payloadCanonicalization")
        let data = try! JSONSerialization.data(withJSONObject: obj)
        XCTAssertFalse(v.validateChallenge(data).isValid)
    }

    func testMalformedSignaturePrefixFails() throws {
        let c = try challenge()
        let r = v.validateResponse(Data(responseJSON(signature: "rsa:deadbeef").utf8), echoing: c)
        XCTAssertFalse(r.isValid, "unknown signature prefix must fail")
    }

    func testEchoedChallengeMutationFails() throws {
        let c = try challenge()
        // Mutate a committed field (targetCommit) in the echoed challenge.
        var mutated = try JSONSerialization.jsonObject(with: Data(challengeJSON.utf8)) as! [String: Any]
        mutated["targetCommit"] = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
        let mutatedStr = String(decoding: try JSONSerialization.data(withJSONObject: mutated), as: UTF8.self)
        let r = v.validateResponse(Data(responseJSON(challenge: mutatedStr).utf8), echoing: c)
        XCTAssertFalse(r.isValid, "mutated echoed challenge must fail the recursive check")
    }

    func testChallengeRejectsUnknownProperty() {
        var obj = try! JSONSerialization.jsonObject(with: Data(challengeJSON.utf8)) as! [String: Any]
        obj["surprise"] = true
        let data = try! JSONSerialization.data(withJSONObject: obj)
        XCTAssertFalse(v.validateChallenge(data).isValid, "unevaluatedProperties:false rejects unknown keys")
    }

    // MARK: - Faithful-transcription negatives (wing finding: strict shapes, not "nonempty string")

    private func mutatedChallenge(_ f: (inout [String: Any]) -> Void) -> Data {
        var obj = try! JSONSerialization.jsonObject(with: Data(challengeJSON.utf8)) as! [String: Any]
        f(&obj)
        return try! JSONSerialization.data(withJSONObject: obj)
    }

    func testSchemaVersionAboveOneFails() {
        XCTAssertFalse(v.validateChallenge(mutatedChallenge { $0["schemaVersion"] = 2 }).isValid,
                       "schemaVersion must be the literal 1, not merely ≥ 1")
    }

    func testMalformedCommitHashFails() {
        XCTAssertFalse(v.validateChallenge(mutatedChallenge { $0["canonicalBaseCommit"] = "nothex" }).isValid)
    }

    func testMalformedNonceFails() {
        XCTAssertFalse(v.validateChallenge(mutatedChallenge { $0["nonce"] = "too-short" }).isValid)
    }

    func testMalformedExpiresAtFails() {
        XCTAssertFalse(v.validateChallenge(mutatedChallenge { $0["expiresAt"] = "2026-07-12" }).isValid,
                       "expiresAt must be an RFC-3339 UTC ms timestamp")
    }

    func testMalformedRunIdFails() {
        XCTAssertFalse(v.validateChallenge(mutatedChallenge { $0["runId"] = "not-a-ulid" }).isValid)
    }

    func testIntendedEffectUnknownKindFails() {
        XCTAssertFalse(v.validateChallenge(mutatedChallenge {
            $0["intendedEffect"] = ["kind": "teleport", "tier": 3, "changePlanDigest": "sha256:abc"]
        }).isValid, "intendedEffect kind must be one of the §7.4 union")
    }

    func testIntendedEffectMissingUnionFieldFails() {
        XCTAssertFalse(v.validateChallenge(mutatedChallenge {
            $0["intendedEffect"] = ["kind": "integrate", "tier": 3] // missing changePlanDigest
        }).isValid)
    }

    func testIntendedEffectWrongTierFails() {
        XCTAssertFalse(v.validateChallenge(mutatedChallenge {
            $0["intendedEffect"] = ["kind": "integrate", "tier": 4, "changePlanDigest": "sha256:abc"]
        }).isValid, "tier is the enum 1|2|3")
    }

    func testIntendedEffectExtraPropertyFails() {
        XCTAssertFalse(v.validateChallenge(mutatedChallenge {
            $0["intendedEffect"] = ["kind": "integrate", "tier": 3, "changePlanDigest": "sha256:abc", "sneak": 1]
        }).isValid, "each union variant is closed (unevaluatedProperties:false)")
    }

    func testNonIntegrateEffectVariantValidates() {
        // A different op's effect (quarantineResolve) still validates the challenge shape.
        var obj = try! JSONSerialization.jsonObject(with: Data(challengeJSON.utf8)) as! [String: Any]
        obj["op"] = "quarantine resolve"
        obj["intendedEffect"] = ["kind": "quarantineResolve", "quarantineItemOpaqueId": "q1", "resolution": "release"]
        let data = try! JSONSerialization.data(withJSONObject: obj)
        XCTAssertTrue(v.validateChallenge(data).isValid, "quarantineResolve is a valid §7.4 variant")
    }

    // Nested-response equivalents: the echoed challenge is validated with the SAME strict shape.

    func testNestedResponseSchemaVersionAboveOneFails() throws {
        let c = try challenge()
        var mutated = try JSONSerialization.jsonObject(with: Data(challengeJSON.utf8)) as! [String: Any]
        mutated["schemaVersion"] = 2
        let mutatedStr = String(decoding: try JSONSerialization.data(withJSONObject: mutated), as: UTF8.self)
        let r = v.validateResponse(Data(responseJSON(challenge: mutatedStr).utf8), echoing: c)
        XCTAssertFalse(r.isValid, "echoed challenge with schemaVersion 2 must fail the nested shape")
    }

    func testNestedResponseMalformedIntendedEffectFails() throws {
        let c = try challenge()
        var mutated = try JSONSerialization.jsonObject(with: Data(challengeJSON.utf8)) as! [String: Any]
        mutated["intendedEffect"] = ["kind": "teleport"]
        let mutatedStr = String(decoding: try JSONSerialization.data(withJSONObject: mutated), as: UTF8.self)
        let r = v.validateResponse(Data(responseJSON(challenge: mutatedStr).utf8), echoing: c)
        XCTAssertFalse(r.isValid, "echoed challenge with a non-union intendedEffect must fail")
    }
}
