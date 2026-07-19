import Foundation

/// The single `brain` JSON error envelope (`error-envelope.schema.json`). Retry decisions read
/// `retryable` + `retryAfterMs`; structured remediation is read from `details` by field, never by
/// parsing `message`/`hint`.
///
/// `code`/`message`/`hint`/`retryable` are required at the top level (schema-enforced by
/// `ErrorEnvelopeParser` before decode). Nested items in `errors[]` follow the schema's `nestedError`
/// shape, which requires only `code`/`message` — so a custom `Decodable` defaults the two extra fields
/// there (`hint` → "", `retryable` → false). This is contract-honoring, not defensive: the schema
/// itself makes them optional inside `errors[]`.
public struct ErrorEnvelope: Decodable, Equatable, Sendable {
    public let code: String
    public let message: String
    public let hint: String
    public let retryable: Bool
    public let details: [String: JSONValue]?
    public let errors: [ErrorEnvelope]?
    public let retryAfterMs: Int?
    public let runId: String?
    public let jobId: String?

    private enum CodingKeys: String, CodingKey {
        case code, message, hint, retryable, details, errors, retryAfterMs, runId, jobId
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.code = try c.decode(String.self, forKey: .code)
        self.message = try c.decode(String.self, forKey: .message)
        // Optional inside `errors[]` (nestedError); always present at the top level (schema-required,
        // validated before decode). Default only ever applies to nested items.
        self.hint = try c.decodeIfPresent(String.self, forKey: .hint) ?? ""
        self.retryable = try c.decodeIfPresent(Bool.self, forKey: .retryable) ?? false
        self.details = try c.decodeIfPresent([String: JSONValue].self, forKey: .details)
        self.errors = try c.decodeIfPresent([ErrorEnvelope].self, forKey: .errors)
        self.retryAfterMs = try c.decodeIfPresent(Int.self, forKey: .retryAfterMs)
        self.runId = try c.decodeIfPresent(String.self, forKey: .runId)
        self.jobId = try c.decodeIfPresent(String.self, forKey: .jobId)
    }

    /// Direct memberwise init (for tests / synthesis).
    public init(
        code: String, message: String, hint: String, retryable: Bool,
        details: [String: JSONValue]? = nil, errors: [ErrorEnvelope]? = nil,
        retryAfterMs: Int? = nil, runId: String? = nil, jobId: String? = nil
    ) {
        self.code = code; self.message = message; self.hint = hint; self.retryable = retryable
        self.details = details; self.errors = errors
        self.retryAfterMs = retryAfterMs; self.runId = runId; self.jobId = jobId
    }
}

/// Strict `error-envelope.schema.json` parser: validate against the bound schema, then decode.
public struct ErrorEnvelopeParser {
    private let validator: SchemaValidator

    public init(schema: Data) throws {
        self.validator = try SchemaValidator(schema: schema)
    }

    public func parse(_ data: Data) throws -> ErrorEnvelope {
        try validator.decode(ErrorEnvelope.self, from: data)
    }
}
