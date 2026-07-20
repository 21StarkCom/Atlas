import SwiftUI

// P6-Task-2 — control-character-safe rendering for every displayed challenge/audit field.
//
// A challenge or audit row is untrusted display data: it may embed raw C0/C1 control bytes, ANSI CSI
// escape sequences, or RTL-override glyphs that could spoof what the operator believes they are
// authorizing. `ControlSafeText` makes every such byte VISIBLE (as a `<U+XXXX>` token) rather than
// letting it reach the view or its accessibility label, and NEVER truncates — an over-long value is
// inspectable in full. The plain-string form feeds accessibility labels (which take `String`, not
// `AttributedString`) with the same guarantees.
public enum ControlSafeText {
    /// A rendered, control-safe `AttributedString`: the (raw) value is escaped, then wrapped in
    /// unambiguous JSON-style quotes. Every C0/C1/ANSI/RTL-override scalar becomes a visible `<U+XXXX>`
    /// token, and an embedded `"`/`\` is backslash-escaped so a value can NEVER visually terminate its
    /// own quote and spoof a following field. No truncation — the full value is shown.
    public static func render(_ raw: String) -> AttributedString {
        quoted(escape(raw))
    }

    /// Wrap an ALREADY-escaped (control-safe) string in JSON-style quotes, WITHOUT re-escaping. Callers
    /// that already hold a `plain(_:)` value (e.g. `ChallengePresentation.Field.value`) use this so the
    /// escaping is applied exactly once.
    public static func quoted(_ escaped: String) -> AttributedString {
        AttributedString("\"\(escaped)\"")
    }

    /// The plain (unquoted) control-safe string — for accessibility labels and announcements, which take
    /// a `String`. Same escaping (incl. `"`/`\`); no truncation.
    public static func plain(_ raw: String) -> String {
        escape(raw)
    }

    /// Replace every unsafe scalar with a visible `<U+XXXX>` token, and backslash-escape `"`/`\`. Unsafe =
    /// C0 (0x00–0x1F — even tab/newline are made visible so a multi-line spoof is obvious), DEL (0x7F), C1
    /// (0x80–0x9F), the RTL/LTR override + embedding + isolate bidi controls, and the zero-width joiners.
    /// The `\` escape is applied FIRST so an escaped quote's own backslash is not itself doubled.
    static func escape(_ raw: String) -> String {
        var out = ""
        out.reserveCapacity(raw.count)
        for scalar in raw.unicodeScalars {
            if isUnsafe(scalar) {
                out += token(scalar)
            } else if scalar == "\\" {
                out += "\\\\"
            } else if scalar == "\"" {
                out += "\\\""
            } else {
                out.unicodeScalars.append(scalar)
            }
        }
        return out
    }

    private static func isUnsafe(_ s: Unicode.Scalar) -> Bool {
        let v = s.value
        if v <= 0x1F { return true }            // C0 controls (incl. ESC 0x1B → the ANSI CSI lead-in)
        if v == 0x7F { return true }            // DEL
        if v >= 0x80 && v <= 0x9F { return true } // C1 controls
        switch v {
        // Visual line/paragraph breakers — NOT in C0, but they still create a fake field line in a
        // rendered value (U+0085 NEL, U+2028 line separator, U+2029 paragraph separator).
        case 0x0085, 0x2028, 0x2029:
            return true
        // Bidi overrides / embeddings / isolates / marks — the direction-spoofing set. U+061C (Arabic
        // letter mark) joins the LRM/RLM marks; U+2066–2069 are the isolates; U+202A–202E the
        // embeddings/overrides.
        case 0x061C, 0x200E, 0x200F,
             0x202A, 0x202B, 0x202C, 0x202D, 0x202E,
             0x2066, 0x2067, 0x2068, 0x2069:
            return true
        // Zero-width / invisible format controls that can hide or fabricate structure.
        case 0x200B, 0x200C, 0x200D,       // zero-width space / non-joiner / joiner
             0x2060, 0x2061, 0x2062, 0x2063, 0x2064, // word joiner + invisible math operators
             0x00AD,                       // soft hyphen (invisible, breaks words)
             0x180E,                       // Mongolian vowel separator (zero-width)
             0xFEFF:                       // BOM / zero-width no-break space
            return true
        default:
            return false
        }
    }

    private static func token(_ s: Unicode.Scalar) -> String {
        String(format: "<U+%04X>", s.value)
    }
}
