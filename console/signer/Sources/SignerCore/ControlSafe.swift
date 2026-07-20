import Foundation

/// Renders challenge-derived strings so no control/format/separator scalar can
/// erase or rewrite the surrounding approval summary — the signer analogue of the
/// Console's `ControlSafeText` (SP-2). Every threat-relevant scalar becomes a
/// visible `<U+XXXX>` token; the text is NEVER truncated. Unsafe is decided by
/// Unicode general category, **fail-closed**: Cc (control, incl. C0/DEL/C1), Cf
/// (format, incl. the bidi overrides/isolates, ZWJ/ZWNJ, BOM, soft hyphen, the
/// TAG block), Zl (line separator), Zp (paragraph separator), plus pinned
/// U+180E. So an attacker-influenced field value (a path, a label) rendered in
/// the summary cannot smuggle an ANSI escape, a CR, or a bidi flip.
public enum ControlSafe {
    public static func render(_ s: String) -> String {
        var out = ""
        out.reserveCapacity(s.count)
        for scalar in s.unicodeScalars {
            if isUnsafe(scalar) {
                out += String(format: "<U+%04X>", scalar.value)
            } else {
                out.unicodeScalars.append(scalar)
            }
        }
        return out
    }

    static func isUnsafe(_ scalar: Unicode.Scalar) -> Bool {
        if scalar.value == 0x180E { return true } // MONGOLIAN VOWEL SEPARATOR (pinned)
        switch scalar.properties.generalCategory {
        case .control, .format, .lineSeparator, .paragraphSeparator:
            return true
        default:
            return false
        }
    }
}
