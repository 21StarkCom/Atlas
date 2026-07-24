# `@atlas/sources` — md/txt/pdf/html normalizers

Turns a local file (`markdown`/`text`/`pdf`/`html`) into a deterministic
`NormalizedRendition` **or** a typed rejection. **v2 (#334): the parse runs IN-PROCESS.**
The v1 sandbox jail (Seatbelt/userns/seccomp/cgroup worker) and the scan-before-persist
guard died with the security architecture — see [`../../docs/adr/0003-retire-security-architecture.md`](../../docs/adr/0003-retire-security-architecture.md).
What survives is the deterministic normalization core: bounded read → signature check →
pure per-format extraction → pinned rendition identity.

**Accepted residual (ADR-0003, not mitigated).** Ingest is **unsandboxed and unscanned**.
A malicious or malformed document is parsed in-process with the operator's privileges; a
secret pasted into an ingested source persists unredacted. Externally sourced PDF/HTML
bytes stay untrusted and a parser exploit can reach the filesystem + the Gemini key. The
only control at the playground tier is the operator choosing what to ingest, on their own
machine, for their own vault. No technical boundary backstops that choice.

**SSOT:** [`../../docs/specs/normalization-contract.md`](../../docs/specs/normalization-contract.md)
— per-format signatures/limits, encodings, rejection codes, determinism, alt-text rules. The
code transcribes it and the conformance test parses its `normalizationContract` JSON block —
edit the spec first, then the code. (The V1 `sandbox-contract.md` is dead — that jail was retired;
it is revival material only, via the `v1-fortress` tag.)

**Deps:** `@atlas/contracts` (type-only DTOs, erased at compile) + `parse5` (HTML). The old
`@atlas/scan` dependency is gone. **Dependent:** only `apps/cli` (the `ingest` command calls
`normalize()`). **Build:** `tsc -p tsconfig.json` → `dist/`. **Test:** `vitest run --passWithNoTests`.

## Key files

**Detection + shared types**
- `src/formats.ts` — `SOURCE_FORMATS`, `CANONICAL_MEDIA_TYPE`, `MAX_BYTES` (md/txt 5 MiB, html 10 MiB,
  pdf 50 MiB), `signatureMatches` (`%PDF-` / `<!doctype html`|`<html` / `looksTextual`), and
  `decodeTextStrict` — the single FATAL UTF-8/UTF-16 decode seam (invalid ⇒ `unsupported-encoding`,
  never lossy `U+FFFD`).
- `src/types.ts` — `NormalizationRejection` + the 6-code `NormalizationRejectionCode` union
  (`unsupported-encoding` / `encrypted-source` / `no-extractable-text` / `signature-mismatch` /
  `too-large` / `partial-extraction`). A rejection is a VALUE, never a throw. (The sandbox seam types
  — limits, attestation, worker protocol, capability report — died with the jail.)

**Normalization (`src/normalize/`)**
- `index.ts` — `normalize({ path })` (the one public entry), `EXTRACTOR_VERSION`/`NORMALIZER_VERSION`
  (both `1`), `EXTRACTOR_PINS` (`parse5` + `atlas-pdf-1`), `LOCATOR_SCHEME`, `readSourceBounded`
  (single-fd, `O_RDONLY|O_NONBLOCK|O_NOCTTY`, regular-file-only), and the two usage errors
  `UnsupportedSourceError`/`IrregularSourceError` (both `exitCode 5`). Kept `async` so call sites are
  unchanged from the old guarded surface.
- `text.ts` (+ `markdown.ts` reuses it) — verbatim strict-decode; empty ⇒ `no-extractable-text`.
- `pdf.ts` — hand-rolled deterministic extractor using ONLY `node:zlib` (FlateDecode). Faithful-or-
  reject: rejects CID/Type0/Identity/`/Differences`/`/ToUnicode` fonts, unsupported filters, missing
  page-tree branches; resolves the ACTIVE trailer/`/Root`/xref chain; WinAnsi via a cp1252 map.
- `html.ts` — parse5 inert static-DOM extractor; drops `<script>/<style>/<template>/<noscript>`;
  charset only from a real `<meta>` via a tokenizer-style lexical scan; `dom-anchor` locators.
- `media.ts` — `classifyMedia` alt rules + the shared `NormalizeOutcome` type. `pins.ts` —
  `PARSE5_VERSION = "8.0.1"` (dependency-free, so the pin can be asserted without importing a parser).

## Public surface (`src/index.ts` barrel)

Format constants + `signatureMatches` + `decodeTextStrict` (+ `SourceFormat`/`TextEncoding`/
`StrictDecode`); `NormalizationRejection`/`NormalizationRejectionCode`; the `normalize()` API with
`EXTRACTOR_VERSION`/`NORMALIZER_VERSION`/`EXTRACTOR_PINS`/`LOCATOR_SCHEME`, the
`UnsupportedSourceError`/`IrregularSourceError` classes, and the `NormalizeInput`/`NormalizeResult` types.

**Deliberately NOT exported:** the raw per-format parsers (`normalize/{markdown,text,pdf,html}`) and
`classifyMedia`. `normalize()` is the ONE supported normalization entry — it owns signature-first
detection, the bounded read, the per-format ceiling, and the pinned rendition identity; a raw parser
would skip all of that. Don't re-export them.

## Invariants & guardrails

- **Signature first, extension second.** A `.pdf` whose bytes aren't `%PDF-` is `signature-mismatch`,
  never a guess (`signatureMatches` runs before the extractor).
- **Partial extraction is a rejection**, never truncated text as success. PDF is the heavy enforcer
  (`partial-extraction`); a text layer that is absent is `no-extractable-text`.
- **Determinism.** Identical bytes + identical extractor/normalizer versions ⇒ byte-identical
  `normalizedContentHash`. Bumping `EXTRACTOR_VERSION` mints a NEW rendition identity — never silent
  drift. The conformance test asserts the RESOLVED `parse5` equals `EXTRACTOR_PINS.parse5` AND the
  manifest uses `catalog:` (no floating range).
- **Rejection is a VALUE, throw is a usage error.** Everything in-contract (bad content of a supported
  format) is a typed `NormalizationRejection` (validation, exit 1). An unsupported extension
  (`UnsupportedSourceError`) or a non-regular file (`IrregularSourceError`) is a usage error (exit 5).
- **Bounded single-fd read (no TOCTOU).** `readSourceBounded` opens once (`O_NONBLOCK` so a swapped-in
  FIFO/device can't block the open), `fstat`s THAT descriptor (regular-file-only — never a FIFO/device/
  dir), refuses before allocation if the size already exceeds the ceiling, then reads at most
  `ceiling + 1` bytes; the `+1` overshoot catches growth after the fstat ⇒ `too-large`, never a
  truncated success.
- **Strict FATAL decode.** `decodeTextStrict` is the single seam both text/markdown normalizers consume:
  a leading BOM selects UTF-16LE/BE/UTF-8, and `{ fatal: true }` maps any invalid sequence (lone
  continuation byte, unpaired surrogate, odd-length UTF-16 body, …) to `unsupported-encoding` — never a
  lossy `U+FFFD` "clean" rendition. `looksTextual` is the coarse shape gate (text vs binary/lie);
  NUL-free-but-invalid byte soup passes it and is rejected `unsupported-encoding` downstream, by design.

## Gotchas & sharp edges

- **PDF is hand-rolled on purpose** — pdf.js would add a heavyweight dep + nondeterminism. Targets
  classic single-generation + append-update PDFs; xref STREAMS + multi-generation are outside V1.
  Anything it can't faithfully decode ⇒ `partial-extraction`.
- **PDF adversarial traps** (the `#73` decoy fixtures): resolve `/Root` + `/Encrypt` from the ACTIVE
  trailer/xref chain, not the first/last textual match — a literal `/Encrypt` in body text or a string
  value, a `>>` inside a trailer string, a `/En#63rypt` name escape, a freed-object `/Root`, an
  unreferenced same-number redefinition, and stale incremental catalogs all have regression rows.
- **HTML charset traps**: `charset=` in `<script>`/comment/RCDATA/body, `<meta-widget>`, a fake `<meta>`
  inside a quoted attr, an unclosed comment — none may read as a declaration; `metaCharset`'s lexical
  scan handles each. Accepted HTML encodings are utf-8 (±BOM) / iso-8859-1 / windows-1252 only; anything
  else (incl. a UTF-16/32 BOM or a declared charset outside the set) is `unsupported-encoding`.
- **`signatureMatches` is encoding-aware.** A valid UTF-16 BOM text is accepted (its ASCII code units
  carry `0x00` bytes that a raw-NUL heuristic would wrongly reject); a genuine NUL *character* or a
  replacement-dominated decode is binary-mislabeled-as-text and rejected.
- **Tests run unconditionally, on every host.** With the jail gone the conformance matrix no longer
  gates on a supported sandbox host — `normalize({ path })` is called directly. (Some in-source /
  in-test comments still say "worker"/"sandbox"; those are stale wording, not live behavior.)

## History (real PRs)

- **#73** (issue #30) — the normalizers this package still ships; 7 dispatched-review findings
  adjudicated (mandatory faithful-or-reject PDF, single-fd bounded read, quote-aware HTML charset,
  the PDF/HTML decoy hardening cited above).
- **#334** (ADR-0003) — retired the sandbox jail + the scan-before-persist guard. `normalize()` now
  parses in-process; `@atlas/scan`, the worker, the wire protocol, and the sandbox seam types were
  deleted. The V1 sandbox (built in #72) is revival-only, reachable via the `v1-fortress` tag.

## Open items

- **PDF xref streams + multi-generation objects** beyond the append-update convention are outside V1
  (classic `xref` tables only).
- **Auto-generated image alt descriptions are out of scope** (they'd be synthesis) — a meaningful image
  with no `alt` stays a durable `image-no-alt` gap, never an invented caption.
- The `atlas-pdf-1` generation is an in-repo string, not a resolvable library version — its pin is by
  convention (bump `EXTRACTOR_VERSION` on ANY behavioural change), unlike `parse5`, which the
  conformance test enforces against the resolved package.
