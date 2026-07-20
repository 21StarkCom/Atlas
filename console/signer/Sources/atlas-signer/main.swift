import Foundation
import SignerCore

// The thin production wiring: the real Secure-Enclave backend, the operator-home
// key store, real stdin/stdout/stderr, the system clock + hostname. All logic
// lives in `SignerCore.SignerCLI`; this only maps its `SignExit` to `exit()`.

func systemHostname() -> String {
    // The short host (before the first dot), lowercased — a stable per-device tag.
    let full = ProcessInfo.processInfo.hostName
    let short = full.split(separator: ".").first.map(String.init)?.lowercased()
    return (short?.isEmpty == false ? short : nil) ?? "mac"
}

let stderrHandle = FileHandle.standardError

let cli = SignerCLI(
    backend: SecureEnclaveSigningBackend(),
    store: KeyStore(),
    hostname: systemHostname(),
    now: { Date() },
    readStdin: { FileHandle.standardInput.readDataToEndOfFile() },
    writeStdout: { FileHandle.standardOutput.write($0) },
    writeStderr: { stderrHandle.write(Data($0.utf8)) }
)

let code = cli.run(Array(CommandLine.arguments.dropFirst()))
exit(code.rawValue)
