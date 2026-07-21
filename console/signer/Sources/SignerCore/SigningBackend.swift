import Foundation
import CryptoKit
#if canImport(LocalAuthentication)
import LocalAuthentication
#endif

/// A freshly generated key: the persisted blob (SE-wrapped ciphertext for the
/// enclave backend; the raw key for the software backend) plus its SPKI PEM.
public struct GeneratedKey: Sendable {
    public let blob: Data
    public let publicKeyPEM: String
}

/// The crypto + presence seam. Abstracted so a **software `P256.Signing.PrivateKey`**
/// substitutes for the Secure Enclave in unit tests / CI (no SEP, no biometry),
/// while production uses the real enclave-born, biometry-gated key. The signer's
/// non-OS logic (parse → re-derive → refuse → display → emit) is identical either
/// way; only this backend differs.
public protocol SigningBackend: Sendable {
    /// Create a new signing key under this backend's access policy, returning its
    /// blob + SPKI PEM. On the enclave backend this fires a Touch ID prompt
    /// (proving the gate). Throws `SignerError` on failure.
    func generate() throws -> GeneratedKey

    /// Reconstruct the key from `blob` and produce a **DER** ECDSA-SHA256
    /// signature over `payload`, gated on a single presence ceremony described by
    /// `reason`. Throws `SignerError(.cancelled)` on user-cancel / biometry-fail
    /// and `SignerError(.keyInvalidated)` when the key was invalidated by biometry
    /// re-enrollment. The context is armed once and discarded after the one signature.
    func signDER(blob: Data, payload: Data, reason: String) throws -> Data
}

/// Turn a CryptoKit P-256 public key into an SPKI PEM (the enrollment interchange
/// form — `-----BEGIN PUBLIC KEY-----`), matching `openssl pkey -pubout` / Node's
/// `createPublicKey` PEM branch.
func spkiPEM(_ key: P256.Signing.PublicKey) -> String {
    if #available(macOS 14.0, *) {
        return key.pemRepresentation + (key.pemRepresentation.hasSuffix("\n") ? "" : "\n")
    } else {
        // derRepresentation is the SPKI DER; wrap it as PEM by hand.
        let b64 = key.derRepresentation.base64EncodedString(options: [.lineLength64Characters, .endLineWithLineFeed])
        return "-----BEGIN PUBLIC KEY-----\n\(b64)\n-----END PUBLIC KEY-----\n"
    }
}

/// A pure-software backend for tests + CI. Persists the raw private key as the
/// "blob"; there is NO enclave and NO biometry (the `reason` is ignored). NEVER
/// used in production — the CLI wires the enclave backend by default.
public struct SoftwareSigningBackend: SigningBackend {
    public init() {}

    public func generate() throws -> GeneratedKey {
        let key = P256.Signing.PrivateKey()
        return GeneratedKey(blob: key.rawRepresentation, publicKeyPEM: spkiPEM(key.publicKey))
    }

    public func signDER(blob: Data, payload: Data, reason _: String) throws -> Data {
        let key: P256.Signing.PrivateKey
        do {
            key = try P256.Signing.PrivateKey(rawRepresentation: blob)
        } catch {
            throw SignerError(.internalFault, "software key blob unreadable: \(error)")
        }
        let sig = try key.signature(for: payload)
        return sig.derRepresentation
    }
}

#if canImport(LocalAuthentication)
/// The production backend: a `SecureEnclave.P256.Signing.PrivateKey` under
/// `.privateKeyUsage | .biometryCurrentSet` (Touch ID; invalidated on fingerprint
/// re-enrollment). The blob is the SE-wrapped `dataRepresentation` — inert off
/// this Mac's enclave. Never exercised in CI (macOS runners are VMs with no SEP);
/// live-verified on the operator's Mac only.
public struct SecureEnclaveSigningBackend: SigningBackend {
    public init() {}

    private func accessControl() throws -> SecAccessControl {
        var err: Unmanaged<CFError>?
        guard
            let ac = SecAccessControlCreateWithFlags(
                nil,
                kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
                [.privateKeyUsage, .biometryCurrentSet],
                &err
            )
        else {
            throw SignerError(.internalFault, "SecAccessControlCreateWithFlags failed: \(String(describing: err))")
        }
        return ac
    }

    public func generate() throws -> GeneratedKey {
        guard SecureEnclave.isAvailable else {
            throw SignerError(.internalFault, "Secure Enclave is not available on this machine")
        }
        do {
            let key = try SecureEnclave.P256.Signing.PrivateKey(accessControl: try accessControl())
            return GeneratedKey(blob: key.dataRepresentation, publicKeyPEM: spkiPEM(key.publicKey))
        } catch {
            throw SignerError(.internalFault, "Secure Enclave keygen failed: \(error)")
        }
    }

    public func signDER(blob: Data, payload: Data, reason: String) throws -> Data {
        // Pre-arm exactly one LAContext with the approval summary as the reason,
        // so the SYSTEM auth sheet names what is approved, then bind it to the key.
        let context = LAContext()
        context.localizedReason = reason
        do {
            let key = try SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: blob, authenticationContext: context)
            let sig = try key.signature(for: payload)
            context.invalidate() // discard after the single signature (§6 / §9)
            return sig.derRepresentation
        } catch let e as CryptoKitError {
            context.invalidate()
            throw mapCryptoError(e)
        } catch {
            context.invalidate()
            throw mapNSError(error as NSError)
        }
    }

    private func mapCryptoError(_ e: CryptoKitError) -> SignerError {
        SignerError(.cancelled, "signing failed (biometry cancelled or failed): \(e)")
    }

    private func mapNSError(_ e: NSError) -> SignerError {
        // errSecAuthFailed / invalidated-key ⇒ exit 5 (re-enrollment rotation),
        // LAError user-cancel/biometry-fail ⇒ exit 4.
        if e.domain == NSOSStatusErrorDomain, e.code == Int(errSecAuthFailed) {
            return SignerError(.keyInvalidated, keyInvalidatedHint)
        }
        if e.domain == LAError.errorDomain {
            switch LAError.Code(rawValue: e.code) {
            case .biometryNotEnrolled, .biometryNotAvailable, .invalidContext:
                return SignerError(.keyInvalidated, keyInvalidatedHint)
            default:
                // `localizedDescription` alone is uselessly generic — every LAError
                // renders "Authentication canceled." A `systemCancel` when the prompt
                // could not even be presented (SP-3 P6 #297: closed-clamshell mode,
                // no Touch ID sensor) is indistinguishable from a user cancel without
                // the code name + `NSDebugDescription`, which names the real cause.
                return SignerError(.cancelled, "authentication cancelled or failed: \(laDetail(e))")
            }
        }
        return SignerError(.cancelled, "signing failed: \(laDetail(e))")
    }
}

/// The LAError code → name map for operator-legible diagnostics. Kept exhaustive
/// for the codes `sign` can plausibly surface; unknowns fall through to nil.
func laCodeName(_ code: Int) -> String? {
    switch LAError.Code(rawValue: code) {
    case .some(.authenticationFailed): return "authenticationFailed"
    case .some(.userCancel): return "userCancel"
    case .some(.userFallback): return "userFallback"
    case .some(.systemCancel): return "systemCancel"
    case .some(.passcodeNotSet): return "passcodeNotSet"
    case .some(.biometryNotAvailable): return "biometryNotAvailable"
    case .some(.biometryNotEnrolled): return "biometryNotEnrolled"
    case .some(.biometryLockout): return "biometryLockout"
    case .some(.appCancel): return "appCancel"
    case .some(.invalidContext): return "invalidContext"
    case .some(.notInteractive): return "notInteractive"
    default: return nil
    }
}

/// A useful one-line rendering of an LAError/NSError for the exit stderr line: the
/// LAError case name (so `systemCancel` is distinguishable from a real `userCancel`),
/// the localized description, and `NSDebugDescription` when it carries the actual
/// cause the localized string hides (SP-3 P6 #297 — e.g. "Touch ID is not available
/// in closed clamshell mode"). No challenge-derived bytes flow through here.
func laDetail(_ e: NSError) -> String {
    var parts: [String] = []
    if e.domain == LAError.errorDomain, let name = laCodeName(e.code) { parts.append("\(name):") }
    parts.append(e.localizedDescription)
    if let dbg = e.userInfo[NSDebugDescriptionErrorKey] as? String, !dbg.isEmpty, dbg != e.localizedDescription {
        parts.append("— \(dbg)")
    }
    return parts.joined(separator: " ")
}

/// The exit-5 stderr runbook pointer (spec §7.3): rotate + re-enroll.
let keyInvalidatedHint =
    "the Secure-Enclave key was invalidated by a biometry (fingerprint) change. Recover: "
    + "`atlas-signer keygen --force` (mints the next -vN), then "
    + "`sudo provisioning/enroll-signer.sh --pubkey <new.pem> --signer-id <new-id> --alg p256 --presence` "
    + "and `--revoke` the old id (docs/install.md §signer re-enrollment)."
#endif
