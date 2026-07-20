import Foundation

/// A faithful JSON value — the open representation of an `intendedEffect` field
/// set, so the signer can read every §7.4 variant without a rigid per-kind enum
/// and preserve `Int` vs `Double` vs `String` distinctly (so `tier: 3` renders as
/// `3`, never `3.0`, and a string `"3"` is never confused with a number).
public enum JSONValue: Decodable, Equatable, Sendable {
    case string(String)
    case int(Int)
    case double(Double)
    case bool(Bool)
    case null
    case array([JSONValue])
    case object([String: JSONValue])

    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() {
            self = .null
        } else if let b = try? c.decode(Bool.self) {
            self = .bool(b)
        } else if let i = try? c.decode(Int.self) {
            self = .int(i)
        } else if let d = try? c.decode(Double.self) {
            self = .double(d)
        } else if let s = try? c.decode(String.self) {
            self = .string(s)
        } else if let a = try? c.decode([JSONValue].self) {
            self = .array(a)
        } else if let o = try? c.decode([String: JSONValue].self) {
            self = .object(o)
        } else {
            throw DecodingError.dataCorruptedError(in: c, debugDescription: "unsupported JSON value")
        }
    }

    /// The string form, if this is a string.
    public var asString: String? { if case let .string(s) = self { return s }; return nil }
    /// The integer form, if this is an integer (never a lossy double coercion).
    public var asInt: Int? { if case let .int(i) = self { return i }; return nil }

    /// A stable, human-facing rendering for the approval summary (control-unsafe
    /// scalars are made visible by the caller via `ControlSafe`). Strings are
    /// quoted so `"true"` cannot be mistaken for the boolean `true` and a value
    /// cannot spoof structure.
    public var displayValue: String {
        switch self {
        case let .string(s): return "\"\(s)\""
        case let .int(i): return String(i)
        case let .double(d): return String(d)
        case let .bool(b): return b ? "true" : "false"
        case .null: return "null"
        case let .array(a): return "[" + a.map(\.displayValue).joined(separator: ", ") + "]"
        case let .object(o):
            return "{" + o.keys.sorted().map { "\($0): \(o[$0]!.displayValue)" }.joined(separator: ", ") + "}"
        }
    }
}
