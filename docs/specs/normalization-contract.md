# Normalization contract (normative) — Atlas V1 Phase 2

**Owner task:** 2.0 · **Consumed by:** Task 2.4 (per-format normalizers) + Task 2.3 (worker). This
fixes, per supported format: the MIME signatures used for detection, the canonical media token, the
accepted encodings, the typed rejection codes, the determinism requirement, per-format size limits,
the conformance-fixture list, and the media alt-text rules. Normalizers implement this verbatim and
REQUIRE a `PrePersistenceGuard` (raw bytes scanned before parse, normalized output scanned before
return).

> Core rules. (1) Detection is by **content signature first**, extension second — a mismatch is a
> rejection, never a guess. (2) **Partial extraction is a rejection** — a normalizer returns a
> complete faithful rendition or a typed rejection; it never returns truncated text as success.
> (3) Output is **deterministic**: identical bytes + identical extractor/normalizer versions ⇒
> byte-identical `normalizedContentHash`.

## 1. Per-format contract

```json normalizationContract
{
  "version": 1,
  "extractorVersion": 1,
  "normalizerVersion": 1,
  "rejectionCodes": ["unsupported-encoding", "encrypted-source", "no-extractable-text", "signature-mismatch", "too-large", "partial-extraction"],
  "formats": [
    {
      "format": "markdown",
      "canonicalMediaType": "text/markdown",
      "extensions": [".md", ".markdown"],
      "mimeSignatures": ["utf8-text"],
      "encodings": ["utf-8", "utf-8-bom", "utf-16le-bom", "utf-16be-bom"],
      "locatorScheme": "char-offset",
      "maxBytes": 5242880
    },
    {
      "format": "text",
      "canonicalMediaType": "text/plain",
      "extensions": [".txt"],
      "mimeSignatures": ["utf8-text"],
      "encodings": ["utf-8", "utf-8-bom", "utf-16le-bom", "utf-16be-bom"],
      "locatorScheme": "char-offset",
      "maxBytes": 5242880
    },
    {
      "format": "pdf",
      "canonicalMediaType": "application/pdf",
      "extensions": [".pdf"],
      "mimeSignatures": ["%PDF-"],
      "encodings": ["binary"],
      "locatorScheme": "pdf-page-span",
      "maxBytes": 52428800
    },
    {
      "format": "html",
      "canonicalMediaType": "text/html",
      "extensions": [".html", ".htm"],
      "mimeSignatures": ["<!doctype html", "<html"],
      "encodings": ["utf-8", "utf-8-bom", "iso-8859-1", "windows-1252"],
      "locatorScheme": "dom-anchor",
      "maxBytes": 10485760
    }
  ]
}
```

Notes:

- `canonicalMediaType` is the stable token that composes into a `contentId`
  (`sha256:<rawContentHash>:<canonicalMediaType>`); it never changes for a format without a new
  extractor generation.
- `encodings` is the accepted set; a byte stream in any other encoding is rejected
  `unsupported-encoding`. Declared/detected BOM wins over a heuristic guess.
- `maxBytes` is the per-format raw-input ceiling; over it ⇒ `too-large` (config
  `sources.max_bytes.<format>` may lower, never raise beyond a hard cap).

## 2. Rejection codes (typed, exhaustive)

| Code | Exit | When |
|---|---|---|
| `unsupported-encoding` | 1 | the byte stream is not one of the format's accepted encodings |
| `encrypted-source` | 1 | the source is encrypted/password-protected (e.g. encrypted PDF) |
| `no-extractable-text` | 1 | a scanned/image-only PDF or an empty document yields no text layer |
| `signature-mismatch` | 1 | the content signature does not match the format (extension lie) |
| `too-large` | 1 | raw input exceeds the format's `maxBytes` |
| `partial-extraction` | 1 | extraction could not complete faithfully (never returned as success) |

A rejection is a value (`{ ok: false, rejection: {...} }`), not a throw. Example:

```json normalizationRejectionExample
{ "ok": false, "rejection": { "code": "encrypted-source", "format": "pdf", "detail": "password-protected document" } }
```

## 3. Determinism

- Same raw bytes + same `extractorVersion`/`normalizerVersion` ⇒ byte-identical normalized text and
  `normalizedContentHash` (proven by double-run hash equality in the conformance test).
- Normalization introduces no timestamps, locale-dependent formatting, hash-map iteration order, or
  other nondeterminism into the output.

## 4. Media alt-text rules (Phase 2 scope)

- Preserve a meaningful `alt` attribute verbatim on the represented media reference.
- `alt=""` (explicitly empty) marks the image DECORATIVE — recorded as a decorative gap, no text.
- A meaningful image with NO `alt` is recorded as a `RepresentedGap` (`kind: "image-no-alt"`) with a
  locator — a gap record, not fabricated text. **Auto-generated descriptions are out of Phase 2**
  (they would be synthesis; the Tier-3 gate applies when Phase 4 enables them).

Example rendition (success) with a gap:

```json normalizationRenditionExample
{
  "ok": true,
  "rendition": {
    "contentId": "sha256:aaaa:text/html",
    "extractorVersion": 1,
    "normalizerVersion": 1,
    "normalizedContentHash": "sha256:bbbb",
    "sizeBytes": 512,
    "locatorScheme": "dom-anchor",
    "text": "# Title\n\nBody text.",
    "gaps": [{ "kind": "image-no-alt", "locator": "dom:/html/body/img[1]" }]
  }
}
```

## 5. Conformance fixtures (Task 2.4 `normalization-conformance.test`)

Per format, the fixture matrix MUST include: a valid UTF-8 document; a BOM-prefixed encoding variant;
an `unsupported-encoding` input; a `signature-mismatch` input (wrong extension); an oversize
`too-large` input; and format-specific: encrypted PDF (`encrypted-source`), scanned/image-only PDF
(`no-extractable-text`), script-bearing HTML (static-DOM, scripts inert), and a determinism pair
(same bytes ⇒ identical hash). The scanner-adversarial `fixtures/inputs/secret-bearing.md` must yield
NO rendition and land in quarantine (`normalize.scans-before-return`).

## 6. Acceptance

- The conformance matrix is green for every format; determinism proven by double-run hash equality.
- Every rejection path returns its typed code (exit `1`), never a partial success.
