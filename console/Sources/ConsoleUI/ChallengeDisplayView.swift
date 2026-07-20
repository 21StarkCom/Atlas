import SwiftUI
import CryptoKit
import ConsoleCore

// P6-Task-2 — the challenge-display modal. Renders the full §7 display set from the FROZEN in-memory
// challenge (never re-reading challenge.json): op, runId/targetCommit when present, canonicalBaseCommit,
// every intendedEffect field, expiresAt, and the SHA-256 of signingPayload. Every field is quoted,
// control/ANSI/RTL-override bytes are made visible, and every value is shown IN FULL — an over-long value
// is inspectable, never silently truncated, and no raw control byte reaches the view or its a11y label.

public enum ChallengePresentation {
    /// One rendered display field: a stable UNIQUE identity + a label + a control-safe, full-length value.
    /// `id` is deliberately SEPARATE from `label`: the label is control-safe display text that can
    /// COLLIDE (two distinct hostile intendedEffect keys can normalize to the same visible label), so
    /// using the label as SwiftUI identity would produce duplicate IDs and dropped rows. `id` is derived
    /// from the raw (pre-escape) key, which is unique within the challenge, so every row is distinct.
    public struct Field: Identifiable, Equatable, Sendable {
        public let id: String
        public let label: String
        public let value: String   // control-safe (see ControlSafeText.plain), never truncated
        public init(id: String, label: String, value: String) {
            self.id = id; self.label = label; self.value = value
        }
    }

    /// The SHA-256 of the signing payload, as `sha256:<hex>` — the operator verifies the digest prefix
    /// against the Touch ID prompt.
    public static func signingPayloadDigest(_ signingPayload: String) -> String {
        let digest = SHA256.hash(data: Data(signingPayload.utf8))
        return "sha256:" + digest.map { String(format: "%02x", $0) }.joined()
    }

    /// The full §7 display set, control-safe and full-length, in a stable order. Optional fields
    /// (`runId`/`targetCommit`) appear only when present.
    public static func fields(_ c: AuthorizationChallenge) -> [Field] {
        var out: [Field] = [Field(id: "op", label: "Operation", value: ControlSafeText.plain(c.op))]
        if let runId = c.runId { out.append(Field(id: "runId", label: "Run", value: ControlSafeText.plain(runId))) }
        if let target = c.targetCommit { out.append(Field(id: "targetCommit", label: "Target commit", value: ControlSafeText.plain(target))) }
        out.append(Field(id: "canonicalBaseCommit", label: "Canonical base commit", value: ControlSafeText.plain(c.canonicalBaseCommit)))
        for key in c.intendedEffect.keys.sorted() {
            // The top-level intendedEffect key is untrusted display data too — control-safe-escape it
            // before it lands in a label, so a hostile key cannot inject control bytes or spoof a
            // fake "Field: value" suffix into the rendered label. The row's IDENTITY, however, is the RAW
            // key (unique within the object) prefixed to avoid clashing with a fixed-field id — so two
            // distinct keys that escape to the SAME visible label still get distinct ids and neither row
            // is dropped as a duplicate.
            out.append(Field(id: "effect:\(key)",
                             label: "Effect · \(ControlSafeText.plain(key))",
                             value: ControlSafeText.plain(render(c.intendedEffect[key]!))))
        }
        out.append(Field(id: "expiresAt", label: "Expires at", value: ControlSafeText.plain(c.expiresAt)))
        out.append(Field(id: "payloadCanonicalization", label: "Payload canonicalization", value: ControlSafeText.plain(c.payloadCanonicalization)))
        out.append(Field(id: "signingPayloadSha256", label: "Signing payload SHA-256", value: signingPayloadDigest(c.signingPayload)))
        return out
    }

    /// A deterministic, TYPE-PRESERVING JSON rendering of an `intendedEffect` value (control-safety is
    /// applied by the caller). Strings are quoted, so a string `"true"` renders as `"true"` and is
    /// unambiguously distinct from the boolean `true`; a string `null` is distinct from JSON `null`; and
    /// a string carrying `,`/`{`/`}` delimiters cannot spoof array/object structure because those bytes
    /// live inside quotes (and the surrounding `ControlSafeText.plain` escapes any embedded quote). Nested
    /// structures are shown in full, object keys quoted + sorted for determinism.
    static func render(_ v: JSONValue) -> String {
        switch v {
        case .null: return "null"
        case .bool(let b): return b ? "true" : "false"
        case .integer(let i): return String(i)
        case .number(let d): return String(d)
        case .string(let s): return jsonString(s)
        case .array(let a): return "[" + a.map(render).joined(separator: ",") + "]"
        case .object(let o): return "{" + o.keys.sorted().map { "\(jsonString($0)):\(render(o[$0]!))" }.joined(separator: ",") + "}"
        }
    }

    /// A JSON string literal: wrap in quotes and backslash-escape `"`/`\`, so the quotes are unambiguous
    /// type markers. (Control bytes inside are made visible by the caller's `ControlSafeText.plain`.)
    private static func jsonString(_ s: String) -> String {
        var out = "\""
        for ch in s {
            if ch == "\\" { out += "\\\\" }
            else if ch == "\"" { out += "\\\"" }
            else { out.append(ch) }
        }
        out += "\""
        return out
    }
}

public struct ChallengeDisplayView: View {
    let challenge: AuthorizationChallenge
    var onConfirm: (() -> Void)?
    var onCancel: (() -> Void)?

    public init(challenge: AuthorizationChallenge, onConfirm: (() -> Void)? = nil, onCancel: (() -> Void)? = nil) {
        self.challenge = challenge
        self.onConfirm = onConfirm
        self.onCancel = onCancel
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Authorize privileged operation")
                .font(.title2).bold().accessibilityAddTraits(.isHeader)
            ScrollView {
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(ChallengePresentation.fields(challenge)) { field in
                        VStack(alignment: .leading, spacing: 2) {
                            Text(field.label).font(.caption).foregroundStyle(.secondary)
                            // `field.value` is ALREADY control-safe (built via `ControlSafeText.plain`),
                            // so wrap-quote it WITHOUT re-escaping — escaping exactly once.
                            Text(ControlSafeText.quoted(field.value))
                                .font(.system(.body, design: .monospaced))
                                .textSelection(.enabled)
                                .fixedSize(horizontal: false, vertical: true)  // full length, no truncation
                                .accessibilityLabel("\(field.label): \(field.value)")
                        }
                    }
                }
            }
            HStack {
                Button("Cancel") { onCancel?() }
                    .keyboardShortcut(.cancelAction)
                Spacer()
                Button("Confirm & sign") { onConfirm?() }
                    .keyboardShortcut(.defaultAction)
                    .accessibilityLabel("Confirm and sign the authorization challenge")
            }
        }
        .padding()
        .frame(minWidth: 480, minHeight: 360)
        .accessibilityLabel("Authorization challenge for \(ControlSafeText.plain(challenge.op))")
    }
}
