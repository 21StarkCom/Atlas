import Foundation

/// The on-disk signer config beside the key blob. Records the enrolled identity +
/// the fixed V1 access policy so `pubkey` can echo it and `keygen --force` can
/// derive the next `-vN`.
public struct SignerConfig: Codable, Equatable, Sendable {
    public var signerId: String
    public var accessPolicy: String
    public var createdAt: String
    public var publicKeyPem: String

    public init(signerId: String, accessPolicy: String, createdAt: String, publicKeyPem: String) {
        self.signerId = signerId
        self.accessPolicy = accessPolicy
        self.createdAt = createdAt
        self.publicKeyPem = publicKeyPem
    }
}

/// Owns the key blob + `config.json` under the operator's home
/// (`~/Library/Application Support/atlas-signer/`, dir `0700`, files `0600`). The
/// blob is an SE-wrapped ciphertext usable only by this Mac's enclave — perms are
/// defense-in-depth, not the boundary; it lives in the OPERATOR's home so the
/// agent UID cannot read it (satisfying "a key the agent process cannot read"
/// structurally). The base dir is injectable so tests use a throwaway location.
public struct KeyStore: Sendable {
    public let dir: URL
    public var blobPath: URL { dir.appendingPathComponent("approver.key") }
    public var configPath: URL { dir.appendingPathComponent("config.json") }

    public init(dir: URL? = nil) {
        if let dir {
            self.dir = dir
        } else {
            let appSupport = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            self.dir = appSupport.appendingPathComponent("atlas-signer", isDirectory: true)
        }
    }

    public var blobExists: Bool { FileManager.default.fileExists(atPath: blobPath.path) }

    public func loadConfig() throws -> SignerConfig {
        let data = try Data(contentsOf: configPath)
        return try JSONDecoder().decode(SignerConfig.self, from: data)
    }

    public func loadBlob() throws -> Data {
        try Data(contentsOf: blobPath)
    }

    /// Persist the blob + config with strict permissions (dir `0700`, files
    /// `0600`), creating the dir if needed. Overwrites only what the caller has
    /// already gated on `--force`.
    public func save(blob: Data, config: SignerConfig) throws {
        let fm = FileManager.default
        try fm.createDirectory(at: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        try setMode(dir, 0o700)
        try blob.write(to: blobPath, options: .atomic)
        try setMode(blobPath, 0o600)
        let cfg = try JSONEncoder.pretty.encode(config)
        try cfg.write(to: configPath, options: .atomic)
        try setMode(configPath, 0o600)
    }

    private func setMode(_ url: URL, _ mode: Int) throws {
        try FileManager.default.setAttributes([.posixPermissions: mode], ofItemAtPath: url.path)
    }
}

extension JSONEncoder {
    static var pretty: JSONEncoder {
        let e = JSONEncoder()
        e.outputFormatting = [.prettyPrinted, .sortedKeys]
        return e
    }
}
