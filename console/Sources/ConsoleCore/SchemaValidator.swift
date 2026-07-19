import Foundation

public struct ValidationError: Equatable, Sendable {
    public let path: String
    public let reason: String
    public init(path: String, reason: String) {
        self.path = path
        self.reason = reason
    }
}

public enum ValidationResult: Equatable, Sendable {
    case valid
    case invalid([ValidationError])

    public var isValid: Bool { if case .valid = self { return true } else { return false } }
    public var errors: [ValidationError] { if case .invalid(let e) = self { return e } else { return [] } }
}

/// Thrown by the typed-wrapper decode path when the instance fails schema validation before decode.
public struct SchemaValidationFailure: Error, Equatable {
    public let errors: [ValidationError]
}

/// A strict, runtime JSON-Schema (draft 2020-12 subset) validator. Constraint values are read from
/// the schema bytes at runtime — the Console hardcodes no shape. Covers exactly the keyword set the
/// atlas contract schemas use, including the applicator keywords and `unevaluatedProperties`.
public struct SchemaValidator {
    private let rootSchema: [String: Any]

    /// The keywords this engine implements. `SchemaKeywordCoverageTests` asserts every keyword any
    /// bound schema uses is a member.
    public static let implementedKeywords: Set<String> = [
        "type", "required", "properties", "additionalProperties", "unevaluatedProperties",
        "enum", "const", "minimum", "maximum", "minItems", "maxItems", "patternProperties",
        "items", "minLength", "maxLength", "pattern",
        "allOf", "anyOf", "oneOf", "not", "if", "then", "else", "$ref",
    ]

    /// Annotation / structural keywords that carry no validation semantics — ignored by the coverage gate.
    /// `$dynamicRef`/`$dynamicAnchor` are deliberately ABSENT: they carry real validation semantics this
    /// engine does not implement, so a schema using them must FAIL the coverage inventory rather than
    /// silently false-pass. If the atlas schemas ever adopt them, implement the semantics + a coverage
    /// negative, don't allowlist them here.
    public static let ignoredKeywords: Set<String> = [
        "$schema", "$id", "$defs", "$anchor", "$comment", "$vocabulary",
        "definitions", "title", "description", "examples", "default", "deprecated", "readOnly", "writeOnly",
        "x-atlas-contract",
    ]

    public init(schema: Data) throws {
        let obj = try JSONSerialization.jsonObject(with: schema, options: [.fragmentsAllowed])
        guard let dict = obj as? [String: Any] else {
            throw SchemaValidationFailure(errors: [ValidationError(path: "", reason: "schema root is not an object")])
        }
        self.rootSchema = dict
    }

    public func validate(_ instance: Data) -> ValidationResult {
        let value: Any
        do {
            value = try JSONSerialization.jsonObject(with: instance, options: [.fragmentsAllowed])
        } catch {
            return .invalid([ValidationError(path: "", reason: "instance is not valid JSON: \(error)")])
        }
        var errors: [ValidationError] = []
        _ = check(rootSchema, value, "$", &errors, depth: 0)
        return errors.isEmpty ? .valid : .invalid(errors)
    }

    /// Typed-wrapper path: validate strictly, then decode. Rejects an invalid instance before decode.
    public func decode<T: Decodable>(
        _ type: T.Type,
        from data: Data,
        using decoder: JSONDecoder = JSONDecoder()
    ) throws -> T {
        switch validate(data) {
        case .valid:
            return try decoder.decode(T.self, from: data)
        case .invalid(let errs):
            throw SchemaValidationFailure(errors: errs)
        }
    }

    // MARK: - Keyword inventory (for the coverage gate)

    /// The set of keyword keys appearing at schema-object positions anywhere in `schema`.
    public static func collectKeywords(in schema: Data) throws -> Set<String> {
        let obj = try JSONSerialization.jsonObject(with: schema, options: [.fragmentsAllowed])
        var used = Set<String>()
        collectKeywords(obj, into: &used)
        return used
    }

    private static func collectKeywords(_ node: Any, into used: inout Set<String>) {
        guard let dict = node as? [String: Any] else { return }
        for (key, value) in dict {
            used.insert(key)
            switch key {
            case "properties", "patternProperties", "$defs", "definitions":
                if let sub = value as? [String: Any] {
                    for (_, v) in sub { collectKeywords(v, into: &used) }
                }
            case "items", "additionalProperties", "unevaluatedProperties", "not", "if", "then", "else":
                collectKeywords(value, into: &used)
            case "allOf", "anyOf", "oneOf":
                if let arr = value as? [Any] {
                    for v in arr { collectKeywords(v, into: &used) }
                }
            default:
                break // scalar or data (const/enum/examples/required/type/…) — do not descend
            }
        }
    }

    // MARK: - Core recursion

    /// Validates `instance` against `schema`, returns the set of property names evaluated at this
    /// object level (for `unevaluatedProperties` annotation propagation).
    private func check(_ schema: Any, _ instance: Any, _ path: String, _ errors: inout [ValidationError], depth: Int) -> Set<String> {
        if depth > 256 {
            errors.append(ValidationError(path: path, reason: "schema recursion too deep"))
            return []
        }
        if let boolSchema = schema as? Bool {
            if !boolSchema { errors.append(ValidationError(path: path, reason: "schema is `false` — nothing valid here")) }
            return []
        }
        guard let s = schema as? [String: Any] else { return [] }
        var evaluated = Set<String>()

        // $ref (local pointer) — applies alongside sibling keywords.
        if let ref = s["$ref"] as? String {
            if let target = resolveRef(ref) {
                evaluated.formUnion(check(target, instance, path, &errors, depth: depth + 1))
            } else {
                errors.append(ValidationError(path: path, reason: "unresolvable $ref \(ref)"))
            }
        }

        if let t = s["type"] { checkType(t, instance, path, &errors) }

        if let c = s["const"], !Self.jsonEqual(c, instance) {
            errors.append(ValidationError(path: path, reason: "const mismatch"))
        }
        if let e = s["enum"] as? [Any], !e.contains(where: { Self.jsonEqual($0, instance) }) {
            errors.append(ValidationError(path: path, reason: "value not in enum"))
        }

        // Numbers — compared via Decimal so bounds hold exactly above 2^53 (Double would collide).
        if let n = Self.asDecimal(instance) {
            if let m = Self.asDecimal(s["minimum"]), n < m {
                errors.append(ValidationError(path: path, reason: "below minimum \(m)"))
            }
            if let m = Self.asDecimal(s["maximum"]), n > m {
                errors.append(ValidationError(path: path, reason: "above maximum \(m)"))
            }
        }

        // Strings
        if let str = instance as? String {
            let len = str.unicodeScalars.count
            if let ml = Self.asInt(s["minLength"]), len < ml {
                errors.append(ValidationError(path: path, reason: "shorter than minLength \(ml)"))
            }
            if let ml = Self.asInt(s["maxLength"]), len > ml {
                errors.append(ValidationError(path: path, reason: "longer than maxLength \(ml)"))
            }
            if let pat = s["pattern"] as? String, !Self.regexMatches(pat, str) {
                errors.append(ValidationError(path: path, reason: "does not match pattern \(pat)"))
            }
        }

        // Arrays
        if let arr = instance as? [Any] {
            if let mi = Self.asInt(s["minItems"]), arr.count < mi {
                errors.append(ValidationError(path: path, reason: "fewer than minItems \(mi)"))
            }
            if let ma = Self.asInt(s["maxItems"]), arr.count > ma {
                errors.append(ValidationError(path: path, reason: "more than maxItems \(ma)"))
            }
            if let items = s["items"] {
                for (i, el) in arr.enumerated() {
                    _ = check(items, el, "\(path)[\(i)]", &errors, depth: depth + 1)
                }
            }
        }

        // Objects
        if let obj = instance as? [String: Any] {
            var ownMatched = Set<String>()
            if let props = s["properties"] as? [String: Any] {
                for (k, sub) in props {
                    if let v = obj[k] {
                        ownMatched.insert(k)
                        _ = check(sub, v, "\(path).\(k)", &errors, depth: depth + 1)
                    }
                }
            }
            if let pp = s["patternProperties"] as? [String: Any] {
                for (pat, sub) in pp {
                    for (k, v) in obj where Self.regexMatches(pat, k) {
                        ownMatched.insert(k)
                        _ = check(sub, v, "\(path).\(k)", &errors, depth: depth + 1)
                    }
                }
            }
            if let ap = s["additionalProperties"] {
                for (k, v) in obj where !ownMatched.contains(k) {
                    ownMatched.insert(k)
                    if let allowed = ap as? Bool {
                        if !allowed {
                            errors.append(ValidationError(path: "\(path).\(k)", reason: "additional property not allowed"))
                        }
                    } else {
                        _ = check(ap, v, "\(path).\(k)", &errors, depth: depth + 1)
                    }
                }
            }
            evaluated.formUnion(ownMatched)

            if let req = s["required"] as? [Any] {
                for case let r as String in req where obj[r] == nil {
                    errors.append(ValidationError(path: path, reason: "missing required property '\(r)'"))
                }
            }
        }

        // In-place applicators (contribute annotations for unevaluatedProperties).
        if let all = s["allOf"] as? [Any] {
            for sub in all { evaluated.formUnion(check(sub, instance, path, &errors, depth: depth + 1)) }
        }
        if let any = s["anyOf"] as? [Any] {
            var matched = false
            var matchedEval = Set<String>()
            for sub in any {
                var subErrors: [ValidationError] = []
                let ev = check(sub, instance, path, &subErrors, depth: depth + 1)
                if subErrors.isEmpty { matched = true; matchedEval.formUnion(ev) }
            }
            if matched { evaluated.formUnion(matchedEval) } else {
                errors.append(ValidationError(path: path, reason: "no anyOf branch matched"))
            }
        }
        if let one = s["oneOf"] as? [Any] {
            var matchCount = 0
            var matchedEval = Set<String>()
            for sub in one {
                var subErrors: [ValidationError] = []
                let ev = check(sub, instance, path, &subErrors, depth: depth + 1)
                if subErrors.isEmpty { matchCount += 1; matchedEval.formUnion(ev) }
            }
            if matchCount == 1 { evaluated.formUnion(matchedEval) } else {
                errors.append(ValidationError(path: path, reason: "oneOf matched \(matchCount) branches (expected exactly 1)"))
            }
        }
        if let notS = s["not"] {
            var subErrors: [ValidationError] = []
            _ = check(notS, instance, path, &subErrors, depth: depth + 1)
            if subErrors.isEmpty {
                errors.append(ValidationError(path: path, reason: "instance must NOT match the 'not' schema"))
            }
        }
        if let ifS = s["if"] {
            var ifErrors: [ValidationError] = []
            let ifEval = check(ifS, instance, path, &ifErrors, depth: depth + 1)
            if ifErrors.isEmpty {
                evaluated.formUnion(ifEval)
                if let thenS = s["then"] {
                    evaluated.formUnion(check(thenS, instance, path, &errors, depth: depth + 1))
                }
            } else if let elseS = s["else"] {
                evaluated.formUnion(check(elseS, instance, path, &errors, depth: depth + 1))
            }
        }

        // unevaluatedProperties — after all in-place applicators have contributed.
        if let up = s["unevaluatedProperties"], let obj = instance as? [String: Any] {
            for (k, v) in obj where !evaluated.contains(k) {
                evaluated.insert(k)
                if let allowed = up as? Bool {
                    if !allowed {
                        errors.append(ValidationError(path: "\(path).\(k)", reason: "unevaluated property not allowed"))
                    }
                } else {
                    _ = check(up, v, "\(path).\(k)", &errors, depth: depth + 1)
                }
            }
        }

        return evaluated
    }

    // MARK: - $ref resolution (local JSON pointers only)

    private func resolveRef(_ ref: String) -> Any? {
        guard ref.hasPrefix("#") else { return nil } // V1: local pointers only
        let pointer = String(ref.dropFirst())
        if pointer.isEmpty { return rootSchema }
        guard pointer.hasPrefix("/") else { return nil }
        let tokens = pointer.split(separator: "/", omittingEmptySubsequences: false).dropFirst().map {
            $0.replacingOccurrences(of: "~1", with: "/").replacingOccurrences(of: "~0", with: "~")
        }
        var current: Any = rootSchema
        for token in tokens {
            if let dict = current as? [String: Any], let next = dict[String(token)] {
                current = next
            } else if let arr = current as? [Any], let idx = Int(token), arr.indices.contains(idx) {
                current = arr[idx]
            } else {
                return nil
            }
        }
        return current
    }

    // MARK: - Type / value helpers

    private func checkType(_ t: Any, _ instance: Any, _ path: String, _ errors: inout [ValidationError]) {
        let types: [String]
        if let single = t as? String {
            types = [single]
        } else if let many = t as? [Any] {
            types = many.compactMap { $0 as? String }
        } else {
            return
        }
        guard !types.isEmpty else { return }
        if !types.contains(where: { Self.matchesType($0, instance) }) {
            errors.append(ValidationError(path: path, reason: "expected type \(types), got \(Self.typeName(instance))"))
        }
    }

    static func matchesType(_ t: String, _ v: Any) -> Bool {
        switch t {
        case "null": return v is NSNull
        case "boolean": return asBool(v) != nil
        case "string": return (v as? String) != nil
        case "integer":
            // Integer iff the value has a zero fractional part. Test via `Decimal`, not a `Double`
            // round-trip: a huge fractional number (e.g. 1e30 + 0.5) coerces to an integral `Double`
            // and would be misclassified as an integer. `Decimal` keeps 38 significant digits, so the
            // fractional part survives the check.
            guard let dec = asDecimal(v) else { return false }
            var value = dec
            var rounded = Decimal()
            NSDecimalRound(&rounded, &value, 0, .plain)
            return rounded == dec
        case "number": return asNumber(v) != nil
        case "object": return (v as? [String: Any]) != nil
        case "array": return (v as? [Any]) != nil
        default: return true
        }
    }

    static func typeName(_ v: Any) -> String {
        if v is NSNull { return "null" }
        if asBool(v) != nil { return "boolean" }
        if asNumber(v) != nil { return "number" }
        if v is String { return "string" }
        if v is [Any] { return "array" }
        if v is [String: Any] { return "object" }
        return "unknown"
    }

    /// Distinguishes a genuine JSON boolean (CFBoolean) from a number.
    static func asBool(_ v: Any?) -> Bool? {
        guard let v else { return nil }
        if let n = v as? NSNumber, CFGetTypeID(n) == CFBooleanGetTypeID() {
            return n.boolValue
        }
        return nil
    }

    /// A JSON number as Double — never a boolean.
    static func asNumber(_ v: Any?) -> Double? {
        guard let v else { return nil }
        if asBool(v) != nil { return nil }
        if let n = v as? NSNumber { return n.doubleValue }
        if let d = v as? Double { return d }
        if let i = v as? Int { return Double(i) }
        return nil
    }

    static func asInt(_ v: Any?) -> Int? {
        guard let d = asNumber(v) else { return nil }
        // `Int(d)` traps when `d` is outside `Int`'s range; a length/count bound that large is never
        // meaningful, so clamp-reject instead of crashing on a pathological schema value.
        guard d.isFinite, d >= Double(Int.min), d <= Double(Int.max) else { return nil }
        return Int(d)
    }

    /// A JSON number as `Decimal` — preserves integers above 2^53 that `Double` collides. Never a boolean.
    static func asDecimal(_ v: Any?) -> Decimal? {
        guard let v, asBool(v) == nil else { return nil }
        if let n = v as? NSNumber { return n.decimalValue }
        if let d = v as? Double { return Decimal(d) }
        if let i = v as? Int { return Decimal(i) }
        return nil
    }

    static func regexMatches(_ pattern: String, _ str: String) -> Bool {
        guard let re = try? NSRegularExpression(pattern: pattern) else { return false }
        let range = NSRange(str.startIndex..<str.endIndex, in: str)
        return re.firstMatch(in: str, range: range) != nil
    }

    /// Deep JSON equality (numbers by value, booleans distinct from numbers).
    static func jsonEqual(_ a: Any, _ b: Any) -> Bool {
        if a is NSNull && b is NSNull { return true }
        if a is NSNull || b is NSNull { return false }
        if let ba = asBool(a), let bb = asBool(b) { return ba == bb }
        if asBool(a) != nil || asBool(b) != nil { return false }
        // Numbers compared via Decimal: distinct integers above 2^53 (equal as Double) stay distinct,
        // so const/enum/echoed-challenge equality can't be fooled by a precision-losing collision.
        if asNumber(a) != nil || asNumber(b) != nil {
            guard let da = asDecimal(a), let db = asDecimal(b) else { return false }
            return da == db
        }
        if let sa = a as? String, let sb = b as? String { return sa == sb }
        if let aa = a as? [Any], let ab = b as? [Any] {
            return aa.count == ab.count && zip(aa, ab).allSatisfy { jsonEqual($0, $1) }
        }
        if let da = a as? [String: Any], let db = b as? [String: Any] {
            guard da.count == db.count else { return false }
            for (k, v) in da {
                guard let ov = db[k], jsonEqual(v, ov) else { return false }
            }
            return true
        }
        return false
    }
}
