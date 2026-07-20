import Foundation

/// base64url **without padding** — the exact encoding the broker uses
/// (`Buffer.toString("base64url")`) and expects to decode
/// (`Buffer.from(x, "base64url")`). CryptoKit / Foundation emit standard base64
/// (`+`/`/`, padded), so the signature body MUST be transcoded here or the
/// `p256:` string the broker decodes will not round-trip.
public enum Base64URL {
    /// Encode raw bytes as unpadded base64url.
    public static func encode(_ data: Data) -> String {
        var s = data.base64EncodedString()
        s = s.replacingOccurrences(of: "+", with: "-")
        s = s.replacingOccurrences(of: "/", with: "_")
        s = s.replacingOccurrences(of: "=", with: "")
        return s
    }

    /// Decode unpadded base64url back to raw bytes (nil on malformed input).
    public static func decode(_ s: String) -> Data? {
        var b = s.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while b.count % 4 != 0 { b += "=" }
        return Data(base64Encoded: b)
    }
}
