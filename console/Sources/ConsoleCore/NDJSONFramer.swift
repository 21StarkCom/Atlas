import Foundation

/// Turns the raw-byte chunk stream (`StreamHandle.bytes`) into `\n`-terminated lines. Buffers partial
/// lines across chunks and, because it splits on the newline BYTE (0x0A) and never decodes UTF-8 until a
/// full line is assembled, a multi-byte UTF-8 scalar split across a chunk boundary is reconstructed for
/// free — the caller decodes the complete line's bytes. Hands out complete lines only.
public struct NDJSONFramer {
    /// Accumulated bytes not yet terminated by a newline (may hold a partial UTF-8 scalar prefix).
    private var buffer = Data()

    public init() {}

    /// Appends `chunk` and returns every complete (newline-terminated) line it now contains, in order.
    /// The trailing partial line (and any partial UTF-8 prefix) is retained for the next push. Empty
    /// chunks are tolerated (contribute no bytes, yield no lines).
    public mutating func push(_ chunk: Data) -> [Data] {
        guard !chunk.isEmpty else { return [] }
        buffer.append(chunk)
        var lines: [Data] = []
        while let nl = buffer.firstIndex(of: 0x0A) {
            // The line is the bytes before the newline (newline excluded); rebase the buffer past it.
            lines.append(Data(buffer[buffer.startIndex..<nl]))
            buffer = Data(buffer[buffer.index(after: nl)...])
        }
        return lines
    }

    /// Any complete trailing line lacking a final newline. Defensive: SP-1 flushes one line per
    /// newline-terminated write, so this is normally empty. Consumes the buffer.
    public mutating func finish() -> Data? {
        guard !buffer.isEmpty else { return nil }
        let out = buffer
        buffer.removeAll()
        return out
    }
}
