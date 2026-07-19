import Foundation

/// The signer challenge shape (§7.1). `runId`/`targetCommit` are optional per op; every other field
/// is required. Transcribed — there is no standalone schema and it cannot be imported from
/// `@atlas/contracts`.
public struct AuthorizationChallenge: Decodable, Equatable, Sendable {
    public let schemaVersion: Int
    public let op: String
    public let runId: String?
    public let targetCommit: String?
    public let canonicalBaseCommit: String
    public let intendedEffect: [String: JSONValue]
    public let nonce: String
    public let expiresAt: String
    public let signingPayload: String
    public let payloadCanonicalization: String
}

/// The signer response shape (§7.2). Echoes the full challenge so the broker verifies the signature
/// over the exact bytes the signer saw.
public struct AuthorizationResponse: Decodable, Equatable, Sendable {
    public let schemaVersion: Int
    public let challenge: AuthorizationChallenge
    public let signature: String // "p256:…" (SP-3) or "ed25519:…"
    public let signerId: String
}

/// Strict, negative-tested validator for the signer challenge/response. Carries every §7.1/§7.2
/// required field (incl. `schemaVersion`, `payloadCanonicalization`) and recursively validates the
/// echoed response challenge against the challenge shape and the committed fields.
public struct SignerContractValidator {
    private let challengeValidator: SchemaValidator
    private let responseValidator: SchemaValidator

    public init() {
        // These schemas are transcribed constants — construction cannot fail; force-try is intentional.
        challengeValidator = try! SchemaValidator(schema: Data(Self.challengeSchemaJSON.utf8))
        responseValidator = try! SchemaValidator(schema: Data(Self.responseSchemaJSON.utf8))
    }

    public func validateChallenge(_ data: Data) -> ValidationResult {
        challengeValidator.validate(data)
    }

    /// Validates the response shape, then recursively checks the echoed `challenge` equals the
    /// committed challenge (any mutated committed field fails).
    public func validateResponse(_ data: Data, echoing challenge: AuthorizationChallenge) -> ValidationResult {
        let shape = responseValidator.validate(data)
        if case .invalid = shape { return shape }
        let decoded: AuthorizationResponse
        do {
            decoded = try JSONDecoder().decode(AuthorizationResponse.self, from: data)
        } catch {
            return .invalid([ValidationError(path: "$", reason: "response failed to decode: \(error)")])
        }
        if decoded.challenge != challenge {
            return .invalid([ValidationError(path: "$.challenge", reason: "echoed challenge does not match the committed challenge")])
        }
        return .valid
    }

    // MARK: - Transcribed schemas (§7.1 / §7.2 + §7.4 + SP-3 p256 extension)
    //
    // Faithfully mirrors `@atlas/contracts` `authorization.ts` / `primitives.ts` (the byte-identity
    // seam mirror of §7): `schemaVersion` is the literal `1` (not "≥1"); ids/commits/nonces/timestamps
    // carry their exact patterns; `intendedEffect` is the §7.4 discriminated union, not an open object.

    /// Primitive patterns, transcribed from `packages/contracts/src/primitives.ts`.
    private enum P {
        static let commit = #"^[0-9a-f]{40}$"#                                  // CommitHash (SHA-1, 40 hex)
        static let ulid = #"^[0-7][0-9A-HJKMNP-TV-Z]{25}$"#                     // Ulid (ids.ts ULID_RE)
        static let nonce = #"^[0-9a-f]{32}$"#                                   // Nonce (128-bit hex)
        // Doubled backslashes: this string is interpolated verbatim into JSON text, where `\d` is an
        // invalid escape — `\\d` is the valid JSON escape that parses back to the `\d` the regex needs.
        static let rfc3339ms = #"^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$"# // Rfc3339Ms
        static let sha256 = #"^sha256:"#                                        // Sha256Digest (lenient body)
        static let signature = #"^(p256|ed25519):.+"#                           // Ed25519Sig + SP-3 p256:
    }

    /// §7.4 `intendedEffect`, discriminated on `kind` — the exact nine-variant union from `authorization.ts`.
    private static let intendedEffectJSON = """
    { "oneOf": [
      { "type":"object","unevaluatedProperties":false,"required":["kind","tier","changePlanDigest"],
        "properties":{"kind":{"const":"integrate"},"tier":{"enum":[1,2,3]},"changePlanDigest":{"type":"string","pattern":"\(P.sha256)"}} },
      { "type":"object","unevaluatedProperties":false,"required":["kind","revertCommit"],
        "properties":{"kind":{"const":"revert"},"revertCommit":{"type":"string","pattern":"\(P.commit)"}} },
      { "type":"object","unevaluatedProperties":false,"required":["kind","oldHead","replacementHead","scope"],
        "properties":{"kind":{"const":"erase"},"oldHead":{"type":"string","pattern":"\(P.commit)"},"replacementHead":{"type":"string","pattern":"\(P.commit)"},"scope":{"type":"string","minLength":1}} },
      { "type":"object","unevaluatedProperties":false,"required":["kind","backupRef","backupContentHash"],
        "properties":{"kind":{"const":"restore"},"backupRef":{"type":"string","minLength":1},"backupContentHash":{"type":"string","pattern":"\(P.sha256)"}} },
      { "type":"object","unevaluatedProperties":false,"required":["kind","fromGeneration","toGeneration","migrationPlanDigest"],
        "properties":{"kind":{"const":"graduate"},"fromGeneration":{"type":"integer","minimum":0},"toGeneration":{"type":"integer","minimum":0},"migrationPlanDigest":{"type":"string","pattern":"\(P.sha256)"}} },
      { "type":"object","unevaluatedProperties":false,"required":["kind","sourceOpaqueId","fromLevel","toLevel"],
        "properties":{"kind":{"const":"trust"},"sourceOpaqueId":{"type":"string","minLength":1},"fromLevel":{"type":"string","minLength":1},"toLevel":{"type":"string","minLength":1}} },
      { "type":"object","unevaluatedProperties":false,"required":["kind","latestLedgerSeq","acceptedRpoGap"],
        "properties":{"kind":{"const":"forceUnblock"},"latestLedgerSeq":{"type":"integer","minimum":0},"acceptedRpoGap":{"type":"integer","minimum":0}} },
      { "type":"object","unevaluatedProperties":false,"required":["kind","quarantineItemOpaqueId"],
        "properties":{"kind":{"const":"quarantineInspect"},"quarantineItemOpaqueId":{"type":"string","minLength":1}} },
      { "type":"object","unevaluatedProperties":false,"required":["kind","quarantineItemOpaqueId","resolution"],
        "properties":{"kind":{"const":"quarantineResolve"},"quarantineItemOpaqueId":{"type":"string","minLength":1},"resolution":{"enum":["release","discard"]}} }
    ] }
    """

    /// §7.1 `AuthorizationChallenge`. Reused inline as the echoed `challenge` in §7.2.
    private static let challengeSchemaJSON = """
    {
      "type": "object",
      "unevaluatedProperties": false,
      "required": ["schemaVersion", "op", "canonicalBaseCommit", "intendedEffect", "nonce", "expiresAt", "payloadCanonicalization", "signingPayload"],
      "properties": {
        "schemaVersion": { "const": 1 },
        "op": { "type": "string", "minLength": 1 },
        "runId": { "type": "string", "pattern": "\(P.ulid)" },
        "targetCommit": { "type": "string", "pattern": "\(P.commit)" },
        "canonicalBaseCommit": { "type": "string", "pattern": "\(P.commit)" },
        "intendedEffect": \(intendedEffectJSON),
        "nonce": { "type": "string", "pattern": "\(P.nonce)" },
        "expiresAt": { "type": "string", "pattern": "\(P.rfc3339ms)" },
        "payloadCanonicalization": { "type": "string", "minLength": 1 },
        "signingPayload": { "type": "string", "minLength": 1 }
      }
    }
    """

    /// §7.2 `AuthorizationResponse` — echoes the full §7.1 challenge shape.
    private static let responseSchemaJSON = """
    {
      "type": "object",
      "unevaluatedProperties": false,
      "required": ["schemaVersion", "challenge", "signature", "signerId"],
      "properties": {
        "schemaVersion": { "const": 1 },
        "challenge": \(challengeSchemaJSON),
        "signature": { "type": "string", "pattern": "\(P.signature)" },
        "signerId": { "type": "string", "minLength": 1 }
      }
    }
    """
}
