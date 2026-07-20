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

    /// Replace every unsafe scalar with a visible `<U+XXXX>` token, and backslash-escape `"`/`\`.
    /// Unsafe is decided by Unicode general category (Cc/Cf/Zl/Zp — see `isUnsafe`), fail-closed, so
    /// every control, invisible-format, and line/paragraph-breaking scalar is tokenized — including
    /// ones an enumerated blocklist would miss (the TAG block, U+206A–206F, …).
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
        // FAIL-CLOSED by Unicode general category, not by enumeration: an enumerated blocklist misses
        // invisible format controls it never heard of (the TAG block U+E0001/U+E0020–E007F renders
        // zero-width and can hide a committed suffix in a displayed challenge value — the exact spoof
        // the spec's display-fidelity duty closes; likewise U+206A–206F, interlinear annotation, etc.).
        //   Cc — C0/DEL/C1 controls (incl. ESC, the ANSI CSI lead-in; tab/newline stay visible tokens
        //        so a multi-line spoof is obvious)
        //   Cf — every invisible format control: bidi overrides/embeddings/isolates/marks, zero-width
        //        joiners, soft hyphen, BOM, the TAG block, invisible math operators, …
        //   Zl/Zp — U+2028/U+2029, the visual line/paragraph breakers that fake a field line
        // plus U+180E (Mongolian vowel separator — its category has flip-flopped across Unicode
        // versions; pinned unsafe regardless, it renders zero-width). U+0085 NEL is already Cc.
        switch s.properties.generalCategory {
        case .control, .format, .lineSeparator, .paragraphSeparator:
            return true
        default:
            return s.value == 0x180E
        }
    }

    private static func token(_ s: Unicode.Scalar) -> String {
        String(format: "<U+%04X>", s.value)
    }
}
