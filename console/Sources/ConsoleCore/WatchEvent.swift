import Foundation

// MARK: - Event payloads
//
// One `Decodable`/`Equatable`/`Sendable` struct per SP-1 event type. Fields mirror the
// `watch.schema.json` union members verbatim; optional fields decode as Swift optionals — the
// contract omits, never nulls (a `null` where the contract omits is rejected by schema validation
// before decode, in `WatchEventDecoder`). Downstream reducers (Phase 3) consume these shapes.

/// The `ledger` sub-object shared by hello/heartbeat.
public struct LedgerInfo: Decodable, Equatable, Sendable {
    public let attached: Bool
    public let path: String
}

/// A single daemon reachability probe inside `hello.snapshot.daemons`.
public struct DaemonProbe: Decodable, Equatable, Sendable {
    public let socketPath: String
    public let reachable: Bool
}

/// The resume cursor checkpoint (`{auditHeadSeq}`). `-1` = nothing yet; run.* seqs start at 0.
public struct ResumeInfo: Decodable, Equatable, Sendable {
    public let auditHeadSeq: Int
}

/// The `--since-seq` replay descriptor, present only on a replay hello.
public struct ReplayInfo: Decodable, Equatable, Sendable {
    public let sinceSeq: Int
    public let events: Int
}

/// The watch `config` echo (`pollMs`/`heartbeatSeconds`).
public struct WatchConfig: Decodable, Equatable, Sendable {
    public let pollMs: Int
    public let heartbeatSeconds: Int
}

/// The `hello.snapshot` object. While `ledger.attached` is false only `daemons` is present — the
/// ledger-derived keys are absent (never fabricated zeros), hence every non-`daemons` field optional.
public struct WatchSnapshot: Decodable, Equatable, Sendable {
    public struct JobsCount: Decodable, Equatable, Sendable {
        public let queued: Int
        public let failed: Int
    }
    public struct BackupView: Decodable, Equatable, Sendable {
        public let watermarkSeq: Int
        public let coveredSeq: Int
        public let healthy: Bool
    }
    public struct AuditView: Decodable, Equatable, Sendable {
        public let headSeq: Int
        public let head: String
        public let anchorOk: Bool
        public let anchorSource: String
    }
    public struct Daemons: Decodable, Equatable, Sendable {
        public let broker: DaemonProbe
        public let egress: DaemonProbe
    }
    public let openRuns: [String: Int]?
    public let jobs: JobsCount?
    public let quarantineCount: Int?
    public let backup: BackupView?
    public let audit: AuditView?
    public let daemons: Daemons
}

public struct HelloPayload: Decodable, Equatable, Sendable {
    /// The common envelope timestamp (RFC-3339). Preserved so Phase-3 can set `snapshotAsOf = hello.at`.
    public let at: String
    public let pid: Int
    public let ledger: LedgerInfo
    public let snapshot: WatchSnapshot
    public let config: WatchConfig
    public let resume: ResumeInfo?
    public let replay: ReplayInfo?
}

public struct HeartbeatPayload: Decodable, Equatable, Sendable {
    /// The common envelope timestamp (RFC-3339).
    public let at: String
    public let ledger: LedgerInfo
    public let resume: ResumeInfo?
}

public struct WatchErrorPayload: Decodable, Equatable, Sendable {
    /// The common envelope timestamp (RFC-3339).
    public let at: String
    public let source: String
    public let code: String
    /// Free-text detail — arrives already C0/C1-escaped (JSON string escaping); display-safe as delivered.
    public let message: String
}

public struct JobPayload: Decodable, Equatable, Sendable {
    /// The common envelope timestamp (RFC-3339).
    public let at: String
    public let jobId: String
    public let workflow: String
    public let state: String
    public let attempts: Int
    public let maxAttempts: Int
    public let updatedAt: String
    public let nextRunAt: String?
    /// Free-text last-failure classification — arrives already C0/C1-escaped; display-safe as delivered.
    public let lastError: String?
}

public struct ModelCallPayload: Decodable, Equatable, Sendable {
    /// The common envelope timestamp (RFC-3339).
    public let at: String
    public let callId: String
    public let runId: String
    public let provider: String
    public let model: String
    public let operation: String
    public let inputTokens: Int
    public let outputTokens: Int
    public let costMicros: Int
    public let createdAt: String
}

public struct AuditPayload: Decodable, Equatable, Sendable {
    /// The common envelope timestamp (RFC-3339).
    public let at: String
    public let seq: Int
    public let runId: String
    public let eventType: String
    public let createdAt: String
    public let gitHead: String?
}

public struct BackupPayload: Decodable, Equatable, Sendable {
    /// The common envelope timestamp (RFC-3339).
    public let at: String
    public let watermarkSeq: Int
    public let healthy: Bool
    public let updatedAt: String
    public let lastBackupAt: String?
}

public struct DaemonPayload: Decodable, Equatable, Sendable {
    /// The common envelope timestamp (RFC-3339).
    public let at: String
    public let daemon: String
    public let socketPath: String
    public let reachable: Bool
    public let previousReachable: Bool
}

/// One decoded NDJSON stream line. The closed 8-case union plus `.unknown(raw:)` for an additive
/// future event value (spec §15: consumers MUST ignore unknown `event` values — they do not bump `v`).
public enum WatchEvent: Equatable, Sendable {
    case hello(HelloPayload)
    case heartbeat(HeartbeatPayload)
    case watchError(WatchErrorPayload)
    case job(JobPayload)
    case modelCall(ModelCallPayload)
    case audit(AuditPayload)
    case backup(BackupPayload)
    case daemon(DaemonPayload)
    /// An unrecognized `event` value — the raw line bytes, preserved verbatim.
    case unknown(raw: Data)
}

/// Failures the decoder raises. Distinct from `.unknown`, which is a *tolerated* value, not an error.
public enum WatchDecodeError: Error, Equatable {
    /// The line was not valid JSON.
    case notJSON
    /// The common envelope (`v:1`, `event` string, `at`) failed validation.
    case malformedEnvelope([ValidationError])
    /// A recognized `event` whose full line failed its union-member schema.
    case schemaInvalid(event: String, [ValidationError])
    /// The line passed schema validation but the typed decode failed (should not happen if the schema
    /// and the payload struct agree — surfaced rather than swallowed).
    case decodeFailed(event: String, String)
}

/// Decodes one NDJSON line into a `WatchEvent`. **Decode order — the unknown-event path is checked
/// before the closed union:** (1) parse JSON; (2) validate the common envelope only (`v`/`event`/`at`,
/// a subschema built from `watch.schema.json`'s shared `$defs`); (3) if `event` is a known case,
/// validate the full line against that union member and decode the typed payload; (4) if `event` is
/// unrecognized, return `.unknown(raw:)` WITHOUT applying the closed line-union (which would reject a
/// future additive event).
public struct WatchEventDecoder: @unchecked Sendable {
    // @unchecked: the stored `SchemaValidator`s hold an immutable `[String: Any]` schema tree (a
    // read-only JSON value the type system can't prove `Sendable`); every stored member is a `let` and
    // no mutable state is shared. No `JSONDecoder` is stored — `decode` constructs a fresh one per call,
    // so there is no shared-mutable-decoder thread-safety assumption.
    /// `event` value → union-member `$defs` key.
    private static let eventToMember: [String: String] = [
        "watch.hello": "hello",
        "watch.heartbeat": "heartbeat",
        "watch.error": "watchError",
        "job": "job",
        "model_call": "modelCall",
        "audit": "audit",
        "backup": "backup",
        "daemon": "daemon",
    ]

    private let envelopeValidator: SchemaValidator
    private let memberValidators: [String: SchemaValidator]

    public init(schema: Data) throws {
        let root = try JSONSerialization.jsonObject(with: schema, options: [.fragmentsAllowed])
        guard let rootDict = root as? [String: Any],
              let defs = rootDict["$defs"] as? [String: Any] else {
            throw WatchDecodeError.malformedEnvelope([
                ValidationError(path: "", reason: "watch.schema.json has no $defs to bind against"),
            ])
        }

        // (2) Common-envelope subschema — built from the schema's shared `$defs` (v, at), not hardcoded.
        // `additionalProperties:true` so a full event line passes the envelope gate; the per-member
        // schema (step 3) enforces the closed shape.
        var envelope: [String: Any] = [
            "type": "object",
            "required": ["v", "event", "at"],
            "additionalProperties": true,
            "properties": [
                "v": defs["v"] ?? ["const": 1],
                "event": ["type": "string", "minLength": 1],
                // The contract's `$defs.at` is prose-only (`type:string`, "RFC-3339 ms UTC"). Make that
                // constraint executable so a malformed `at` is rejected for BOTH known and unknown events
                // (the envelope gate runs before the member/union check). Pattern: 2026-07-12T09:19:22.581Z.
                "at": [
                    "type": "string",
                    "pattern": #"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$"#,
                ] as [String: Any],
            ] as [String: Any],
        ]
        // Keep the $defs available in case the shared subschemas ever carry a local $ref.
        envelope["$defs"] = defs
        self.envelopeValidator = try SchemaValidator(schema: JSONSerialization.data(withJSONObject: envelope))

        // (3) One validator per union member: `{ "$ref": "#/$defs/<member>", "$defs": <all defs> }`
        // so the member's internal `#/$defs/...` references resolve.
        var validators: [String: SchemaValidator] = [:]
        for (event, member) in Self.eventToMember {
            let wrapper: [String: Any] = ["$ref": "#/$defs/\(member)", "$defs": defs]
            validators[event] = try SchemaValidator(schema: JSONSerialization.data(withJSONObject: wrapper))
        }
        self.memberValidators = validators
    }

    public func decode(_ line: Data) throws -> WatchEvent {
        // (1) parse JSON
        guard let obj = try? JSONSerialization.jsonObject(with: line, options: [.fragmentsAllowed]) else {
            throw WatchDecodeError.notJSON
        }
        // (2) validate the common envelope only
        if case .invalid(let errs) = envelopeValidator.validate(line) {
            throw WatchDecodeError.malformedEnvelope(errs)
        }
        guard let dict = obj as? [String: Any], let event = dict["event"] as? String else {
            throw WatchDecodeError.malformedEnvelope([
                ValidationError(path: "$.event", reason: "missing `event` discriminator"),
            ])
        }
        // (4) unknown-event tolerance — checked BEFORE the closed union.
        guard let validator = memberValidators[event] else {
            return .unknown(raw: line)
        }
        // (3) full union-member validation + typed decode.
        if case .invalid(let errs) = validator.validate(line) {
            throw WatchDecodeError.schemaInvalid(event: event, errs)
        }
        // Fresh decoder per call — no shared mutable `JSONDecoder` across concurrent `decode`s.
        let jsonDecoder = JSONDecoder()
        do {
            switch event {
            case "watch.hello": return .hello(try jsonDecoder.decode(HelloPayload.self, from: line))
            case "watch.heartbeat": return .heartbeat(try jsonDecoder.decode(HeartbeatPayload.self, from: line))
            case "watch.error": return .watchError(try jsonDecoder.decode(WatchErrorPayload.self, from: line))
            case "job": return .job(try jsonDecoder.decode(JobPayload.self, from: line))
            case "model_call": return .modelCall(try jsonDecoder.decode(ModelCallPayload.self, from: line))
            case "audit": return .audit(try jsonDecoder.decode(AuditPayload.self, from: line))
            case "backup": return .backup(try jsonDecoder.decode(BackupPayload.self, from: line))
            case "daemon": return .daemon(try jsonDecoder.decode(DaemonPayload.self, from: line))
            default: return .unknown(raw: line) // unreachable: memberValidators keys == eventToMember keys
            }
        } catch {
            throw WatchDecodeError.decodeFailed(event: event, "\(error)")
        }
    }
}
