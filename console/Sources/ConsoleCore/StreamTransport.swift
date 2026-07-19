import Foundation

/// One framed line's meaning. The stream is NDJSON event lines terminated (on startup failure or a
/// mid-stream fatal fault) by the sole non-event line: the standard error envelope. A line carrying the
/// `v:1`/`event` envelope is an event (decoded, or `.unknown` for an additive future type); a line
/// lacking it is parsed as the terminal error envelope (never decode-failed) and surfaced to the
/// supervisor for retryable-vs-terminal classification.
public enum StreamItem: Equatable, Sendable {
    case event(WatchEvent)
    case terminalEnvelope(ErrorEnvelope)
}

/// Errors the transport classifier raises.
public enum StreamParseError: Error, Equatable {
    /// A framed line was neither valid JSON nor an object.
    case notJSONObject
    /// A line lacked the `event` envelope and failed to parse as the error envelope too.
    case unclassifiable(String)
    /// A blank / whitespace-only line. The stream contract is strict one-JSON-object-per-line, so a
    /// blank line is a contract mismatch, not a tolerated no-op.
    case blankLine
}

/// The transport adapter that wires framed lines to their typed meaning: `WatchEventDecoder` for event
/// lines, `ErrorEnvelopeParser` for the sole terminal envelope line. Discriminates by the presence of
/// the `event` key (every event line carries it; the error envelope never does).
public struct WatchStreamParser: @unchecked Sendable {
    // @unchecked: composed of read-only validators/decoders (see `WatchEventDecoder`); safe to share.
    private let decoder: WatchEventDecoder
    private let envelopeParser: ErrorEnvelopeParser

    public init(watchSchema: Data, errorEnvelopeSchema: Data) throws {
        self.decoder = try WatchEventDecoder(schema: watchSchema)
        self.envelopeParser = try ErrorEnvelopeParser(schema: errorEnvelopeSchema)
    }

    /// Classifies one complete framed line. The stream contract is strict one-JSON-object-per-line: a
    /// blank / whitespace-only line is a contract mismatch and is REJECTED (`StreamParseError.blankLine`),
    /// never silently skipped.
    public func classify(_ line: Data) throws -> StreamItem {
        // Blank / whitespace-only line — a contract mismatch, not a tolerated no-op.
        if line.allSatisfy({ $0 == 0x20 || $0 == 0x09 || $0 == 0x0D || $0 == 0x0A }) {
            throw StreamParseError.blankLine
        }
        guard let obj = try? JSONSerialization.jsonObject(with: line, options: [.fragmentsAllowed]),
              let dict = obj as? [String: Any] else {
            throw StreamParseError.notJSONObject
        }
        if dict["event"] != nil {
            return .event(try decoder.decode(line))
        }
        // The sole non-event line: the terminal error envelope.
        do {
            return .terminalEnvelope(try envelopeParser.parse(line))
        } catch {
            throw StreamParseError.unclassifiable("\(error)")
        }
    }
}

/// The PRODUCTION transport adapter: wires a `StreamHandle`'s raw byte chunks through `NDJSONFramer`
/// (byte-level line framing + UTF-8 reassembly across chunk boundaries) into `WatchStreamParser`,
/// yielding a `StreamItem` sequence. This is the one place `StreamHandle.bytes` → framing → typed
/// items is composed; `WatchSupervisor` (Phase 4) consumes it, never re-implementing framing. Framing
/// living in `NDJSONFramer` (a value type) is what lets the adversarial-chunking integration test
/// (`TransportFramingTests`) prove correctness against a real pipe.
public struct WatchTransport {
    private let parser: WatchStreamParser

    public init(watchSchema: Data, errorEnvelopeSchema: Data) throws {
        self.parser = try WatchStreamParser(watchSchema: watchSchema, errorEnvelopeSchema: errorEnvelopeSchema)
    }

    public init(parser: WatchStreamParser) {
        self.parser = parser
    }

    /// Consumes `handle.bytes` and yields each framed line's classified `StreamItem`, in order. A
    /// classification failure (malformed line, blank line, unclassifiable non-event line) or a stream
    /// read error is surfaced to the consumer via the thrown stream — never swallowed.
    public func items(from handle: StreamHandle) -> AsyncThrowingStream<StreamItem, Error> {
        items(fromBytes: handle.bytes)
    }

    /// The framing pipeline over any raw-byte chunk source (a `StreamHandle`'s stream, or a test feed).
    /// Buffers partial lines and reassembles split multi-byte scalars via `NDJSONFramer`.
    public func items(fromBytes bytes: AsyncThrowingStream<Data, Error>) -> AsyncThrowingStream<StreamItem, Error> {
        let parser = self.parser
        return AsyncThrowingStream { continuation in
            let task = Task {
                var framer = NDJSONFramer()
                do {
                    for try await chunk in bytes {
                        for line in framer.push(chunk) {
                            continuation.yield(try parser.classify(line))
                        }
                    }
                    if let tail = framer.finish() {
                        continuation.yield(try parser.classify(tail))
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }
}
