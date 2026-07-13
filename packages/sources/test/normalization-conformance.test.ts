/**
 * `normalization-conformance.test` (Task 2.4) — the contract's fixture matrix per
 * format (`docs/specs/normalization-contract.md §5`), driven through the real
 * guard-enforced `normalize({ path, guard })` which parses INSIDE the sandbox worker
 * (D15) and scans raw + normalized bytes through the guard.
 *
 * The matrix is table-driven per format and covers EVERY applicable contract cell:
 * a valid UTF-8 document; the applicable BOM-prefixed encoding variant; an
 * `unsupported-encoding` input; a `signature-mismatch` (wrong-extension) input; an
 * oversize `too-large` input; the format-specific rejections (encrypted / scanned /
 * partial-extraction PDF, static-DOM script-inert HTML); adversarial HTML (entities,
 * quoted `>`, RCDATA, implicit close, exact anchors); adversarial PDF constructs
 * (CID/Type0 fonts, missing pages, comments, operands outside BT/ET, incremental
 * updates); and a DETERMINISM pair (same bytes ⇒ byte-identical `normalizedContentHash`,
 * proven by a double run). Genuinely inapplicable cells (binary-PDF charset encodings)
 * are documented against the contract JSON rather than silently omitted.
 *
 * SANDBOX DEPENDENCY: `normalize` now runs the untrusted parse in the sandbox worker, so
 * these cases require a supported host. On an unsupported host they SKIP (mirroring
 * `scan-before-persist.test`); a PROVISIONED CI host (`ATLAS_SANDBOX_REQUIRE=1`, or
 * `CI=true` on darwin) must support it — an unsupported report there is a hard failure,
 * never a green-skip.
 *
 * A no-op quarantine sink is injected into the guard: these fixtures are all clean, so
 * the guard never fires (the secret path is proven in `normalize.scans-before-return`).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PrePersistenceGuard, type QuarantineSink, type SecretFinding } from "@atlas/scan";
import {
  normalize,
  runInSandbox,
  selectBackend,
  EXTRACTOR_VERSION,
  NORMALIZER_VERSION,
  EXTRACTOR_PINS,
  LOCATOR_SCHEME,
  UnsupportedSourceError,
  IrregularSourceError,
  type NormalizeResult,
} from "../src/index.js";

const FIXTURES = fileURLToPath(new URL("../../../fixtures/inputs/", import.meta.url));
const fx = (name: string): string => join(FIXTURES, name);

/**
 * Synchronous sandbox-support probe (host primitives only, no worker launch) so the
 * describe blocks can gate at collection time. A provisioned CI host must support it.
 */
const BACKEND = selectBackend();
const SANDBOX_SUPPORTED = BACKEND !== null && BACKEND.probe().every((c) => c.available);
const REQUIRE_SUPPORTED =
  process.env.ATLAS_SANDBOX_REQUIRE === "1" || (process.env.CI === "true" && platform() === "darwin");
/** `describe` when the sandbox is available, else a loud-skipping `describe.skip`. */
const sandboxDescribe = SANDBOX_SUPPORTED ? describe : describe.skip;

/** A sink that must never be called by these clean fixtures — a call is a test failure. */
class NoopSink implements QuarantineSink {
  calls = 0;
  quarantine(_: { bytes: Uint8Array; origin: string; findings: readonly SecretFinding[] }): Promise<void> {
    this.calls++;
    return Promise.resolve();
  }
}

/** Fresh guard per call (the guard is stateless, but a fresh sink keeps assertions local). */
function freshGuard(): { guard: PrePersistenceGuard; sink: NoopSink } {
  const sink = new NoopSink();
  return { guard: new PrePersistenceGuard(sink), sink };
}

/** Normalize `path` with a fresh clean guard; assert the guard's sink never fired. */
async function run(path: string): Promise<NormalizeResult> {
  const { guard, sink } = freshGuard();
  const result = await normalize({ path, guard });
  expect(sink.calls).toBe(0);
  return result;
}

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

/**
 * The parse5 version that ACTUALLY resolves from `@atlas/sources` — read by resolving the
 * package entry and walking up to its own `package.json` (parse5's `exports` blocks a
 * direct `parse5/package.json` require, so we cannot import the manifest by subpath). This
 * is the real installed version, not a manifest range, so the pin assertion catches drift.
 */
function resolvedParse5Version(fromPackageJson: string): string {
  const req = createRequire(fromPackageJson);
  let dir = dirname(req.resolve("parse5"));
  for (;;) {
    const pj = join(dir, "package.json");
    if (existsSync(pj)) {
      const parsed = JSON.parse(readFileSync(pj, "utf8")) as { name?: string; version?: string };
      if (parsed.name === "parse5" && typeof parsed.version === "string") return parsed.version;
    }
    const parent = dirname(dir);
    if (parent === dir) throw new Error("could not resolve the installed parse5 package.json");
    dir = parent;
  }
}

let TMP: string;
beforeAll(() => {
  TMP = mkdtempSync(join(tmpdir(), "atlas-normconf-"));
});
afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

/** Write `bytes` to `<TMP>/name` and return its path. */
function write(name: string, bytes: Uint8Array): string {
  const p = join(TMP, name);
  writeFileSync(p, bytes);
  return p;
}

// ---------------------------------------------------------------------------
// Host-independent checks (no sandbox needed).
// ---------------------------------------------------------------------------

describe("contract constants + pins (host-independent)", () => {
  it("exposes each format's locatorScheme via the contract table", () => {
    expect(LOCATOR_SCHEME).toEqual({
      markdown: "char-offset",
      text: "char-offset",
      pdf: "pdf-page-span",
      html: "dom-anchor",
    });
  });

  it("provisioned CI hosts must support the sandbox (no green-skip of the matrix)", () => {
    if (REQUIRE_SUPPORTED && !SANDBOX_SUPPORTED) {
      throw new Error("[normalization-conformance] provisioned CI host must support the sandbox but does not");
    }
    expect(true).toBe(true);
  });

  it("PINS the parse5 extractor version — the RESOLVED package version must equal the pin", () => {
    // Ties EXTRACTOR_VERSION to the ACTUALLY-RESOLVED parse5 so an upgrade is a conscious
    // change (a new rendition identity), never silent drift (review hint: pin the extractor
    // lib). Asserting the range's textual lower bound is NOT enough — a floating `^8.0.1`
    // could resolve to a later 8.x that changes extraction without bumping extractorVersion
    // (wing round-3 finding 6). So we (a) read the version parse5 ACTUALLY resolves to and
    // (b) require the manifest pin through the workspace catalog (no floating range).
    const pkgUrl = fileURLToPath(new URL("../package.json", import.meta.url));
    const resolved = resolvedParse5Version(pkgUrl);
    expect(resolved).toBe(EXTRACTOR_PINS.parse5);
    // The manifest must reference the catalog (the single exact version source), not a range.
    const pkg = JSON.parse(readFileSync(pkgUrl, "utf8")) as { dependencies?: Record<string, string> };
    expect(pkg.dependencies?.parse5).toBe("catalog:");
  });

  it("binary-PDF charset cells are genuinely inapplicable (documented against the contract)", () => {
    // The contract fixes pdf.encodings = ["binary"]: there is no text charset to reject,
    // so the generic `unsupported-encoding` / BOM-variant cells do NOT apply to PDF. Its
    // analogues are the PDF-specific rejections (encrypted / no-extractable-text /
    // partial-extraction), all covered below. This asserts the omission is contract-driven.
    const contractMd = readFileSync(
      fileURLToPath(new URL("../../../docs/specs/normalization-contract.md", import.meta.url)),
      "utf8",
    );
    const block = /```json normalizationContract\n([\s\S]*?)\n```/.exec(contractMd);
    expect(block).not.toBeNull();
    const contract = JSON.parse(block![1]!) as { formats: { format: string; encodings: string[] }[] };
    const byFormat = new Map(contract.formats.map((f) => [f.format, f.encodings]));
    expect(byFormat.get("pdf")).toEqual(["binary"]);
    // The text formats + html DO carry text charsets (so their charset cells apply).
    for (const f of ["markdown", "text", "html"]) {
      expect(byFormat.get(f)!.some((e) => e.startsWith("utf-8"))).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Valid documents — one per format (committed fixtures).
// ---------------------------------------------------------------------------

sandboxDescribe("valid documents (one per format)", () => {
  it("markdown: preserves the source verbatim with the char-offset scheme", async () => {
    const r = await run(fx("sample.md"));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rendition.locatorScheme).toBe("char-offset");
    expect(r.rendition.contentId.canonicalMediaType).toBe("text/markdown");
    expect(r.rendition.extractorVersion).toBe(EXTRACTOR_VERSION);
    expect(r.rendition.normalizerVersion).toBe(NORMALIZER_VERSION);
    expect(r.rendition.text).toContain("# Sample Markdown Input");
    expect(r.rendition.gaps).toEqual([]);
    expect(r.rendition.normalizedContentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(r.rendition.sizeBytes).toBe(enc(r.rendition.text).length);
  });

  it("text: extracts plain text with the char-offset scheme", async () => {
    const r = await run(fx("sample.txt"));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rendition.locatorScheme).toBe("char-offset");
    expect(r.rendition.contentId.canonicalMediaType).toBe("text/plain");
    expect(r.rendition.text).toContain("Sample plain-text ingest input.");
  });

  it("pdf: extracts the text layer with the pdf-page-span scheme", async () => {
    const r = await run(fx("sample.pdf"));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rendition.locatorScheme).toBe("pdf-page-span");
    expect(r.rendition.contentId.canonicalMediaType).toBe("application/pdf");
    expect(r.rendition.text).toBe("Sample PDF ingest input for Atlas.");
  });

  it("html: extracts inert static-DOM text with the dom-anchor scheme", async () => {
    const r = await run(fx("sample.html"));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rendition.locatorScheme).toBe("dom-anchor");
    expect(r.rendition.contentId.canonicalMediaType).toBe("text/html");
    expect(r.rendition.text).toContain("An HTML ingest input for the DOM-anchor locator scheme");
    expect(r.rendition.text).toContain("alpha");
  });
});

// ---------------------------------------------------------------------------
// Encoding cells — valid BOM + unsupported-encoding (text formats + HTML).
// ---------------------------------------------------------------------------

sandboxDescribe("encodings", () => {
  const BODY = "# Heading\n\nBody text with a café. Line two.\n";

  it("markdown: a UTF-8 BOM decodes to the same text as the BOM-less bytes", async () => {
    const noBom = write("bom-none.md", enc(BODY));
    const withBom = write("bom-utf8.md", new Uint8Array([0xef, 0xbb, 0xbf, ...enc(BODY)]));
    const a = await run(noBom);
    const b = await run(withBom);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    // The BOM is stripped, so the decoded text (and its hash) is identical.
    expect(b.rendition.text).toBe(a.rendition.text);
    expect(b.rendition.normalizedContentHash).toBe(a.rendition.normalizedContentHash);
  });

  it("text: a UTF-16LE BOM document decodes to the expected text", async () => {
    const bytes = new Uint8Array([0xff, 0xfe, ...new Uint8Array(Buffer.from(BODY, "utf16le"))]);
    const r = await run(write("bom-utf16le.txt", bytes));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rendition.text).toBe(BODY);
  });

  it("markdown: an invalid UTF-8 byte sequence is unsupported-encoding", async () => {
    // "# " then 0x80 (a lone continuation byte): passes the coarse text-shape gate (no
    // NUL) but fails the FATAL decode — never a lossy U+FFFD "clean" rendition.
    const r = await run(write("bad-utf8.md", new Uint8Array([0x23, 0x20, 0x80, 0x41])));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.rejection.code).toBe("unsupported-encoding");
    expect(r.rejection.format).toBe("markdown");
  });

  it("text: an invalid UTF-8 byte sequence is unsupported-encoding", async () => {
    const r = await run(write("bad-utf8.txt", new Uint8Array([0x41, 0x80, 0x42])));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.rejection.code).toBe("unsupported-encoding");
    expect(r.rejection.format).toBe("text");
  });

  it("html: a UTF-8 BOM document decodes and extracts static-DOM text", async () => {
    const html = `<!doctype html><html><body><p>bom body text</p></body></html>`;
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...enc(html)]);
    const r = await run(write("bom.html", bytes));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rendition.text).toContain("bom body text");
  });

  it("html: a declared charset outside the accepted set is unsupported-encoding", async () => {
    const html = enc(`<!doctype html><html><head><meta charset="shift_jis"></head><body><p>hi</p></body></html>`);
    const r = await run(write("bad-charset.html", html));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.rejection.code).toBe("unsupported-encoding");
    expect(r.rejection.format).toBe("html");
  });

  it("html: windows-1252 declared bytes decode via the accepted set", async () => {
    // 0x92 is a Windows-1252 right single quote (’) — invalid UTF-8, valid cp1252.
    const bytes = new Uint8Array([
      ...enc(`<!doctype html><html><head><meta charset="windows-1252"></head><body><p>it`),
      0x92,
      ...enc(`s fine</p></body></html>`),
    ]);
    const r = await run(write("win1252.html", bytes));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rendition.text).toContain("it’s fine");
  });

  it("html: a bare charset= in inert <script> text does NOT reject valid UTF-8 (finding 5)", async () => {
    // The pre-fix fallback matched `charset=` ANYWHERE — here inside a <script> string — and
    // rejected this valid UTF-8 document as unsupported-encoding. Only a real <meta> counts.
    const html = `<!doctype html><html><head><script>var s = "charset=koi8-r";</script></head><body><p>café ok</p></body></html>`;
    const r = await run(write("script-charset.html", enc(html)));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rendition.text).toContain("café ok"); // decoded as UTF-8, not koi8-r
    expect(r.rendition.text).not.toContain("charset");
  });

  it("html: a </scripture>-style prefix tag does NOT close <script> and expose an inner charset meta", async () => {
    // RAWTEXT close must be an EXACT end-tag name + terminator: `</scripture>` is a prefix of
    // `</script` but must NOT close <script>, else the following inert <meta> would be read as
    // a real charset declaration and wrongly reject this valid UTF-8 document.
    const html = `<!doctype html><html><head><script>var s = "x</scripture> <meta charset=koi8-r>";</script></head><body><p>café ok</p></body></html>`;
    const r = await run(write("scripture-charset.html", enc(html)));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rendition.text).toContain("café ok"); // decoded as UTF-8, not koi8-r
  });

  it("html: a charset= inside an HTML comment does NOT reject valid UTF-8 (finding 5)", async () => {
    const html = `<!doctype html><html><head><!-- charset=koi8-r --></head><body><p>résumé ok</p></body></html>`;
    const r = await run(write("comment-charset.html", enc(html)));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rendition.text).toContain("résumé ok");
  });

  it("html: body prose containing charset= does NOT reject valid UTF-8 (finding 5)", async () => {
    const html = `<!doctype html><html><body><p>The header charset=koi8-r is legacy; this doc is UTF-8 café.</p></body></html>`;
    const r = await run(write("body-charset.html", enc(html)));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rendition.text).toContain("café");
  });

  it("html: charset= inside an UNRELATED <meta> attribute is NOT a declaration (round-2 finding)", async () => {
    // `<meta name="description" content="charset=koi8-r">` carries `charset=` inside the
    // `content` value of a description meta — NOT a charset declaration. The pre-fix code
    // matched `charset=` anywhere in a <meta> tag and wrongly rejected this valid UTF-8 doc.
    const html = `<!doctype html><html><head><meta name="description" content="charset=koi8-r"></head><body><p>café ok</p></body></html>`;
    const r = await run(write("meta-desc-charset.html", enc(html)));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rendition.text).toContain("café ok"); // decoded as UTF-8, not koi8-r
  });

  it("html: a '>' inside a quoted <meta> attribute does not truncate the charset (round-2 finding)", async () => {
    // The `content="a>b"` value carries a '>' that the pre-fix `[^>]*>` tag matcher treated
    // as the tag end — cutting off the trailing `charset` attribute, so the windows-1252
    // declaration was missed and the 0x92 byte failed a fatal UTF-8 decode. A quote-aware
    // parse keeps the whole tag, honours the charset, and decodes 0x92 → ’.
    const bytes = new Uint8Array([
      ...enc(`<!doctype html><html><head><meta content="a>b" charset="windows-1252"></head><body><p>it`),
      0x92,
      ...enc(`s fine</p></body></html>`),
    ]);
    const r = await run(write("quoted-gt-meta.html", bytes));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rendition.text).toContain("it’s fine");
  });

  it("html: a legacy http-equiv=Content-Type content charset is honoured (round-2 finding)", async () => {
    // The paired `http-equiv="Content-Type"` + `content="…; charset=windows-1252"` form IS a
    // real declaration (unlike a bare `content` charset), so 0x92 decodes as ’.
    const bytes = new Uint8Array([
      ...enc(`<!doctype html><html><head><meta http-equiv="Content-Type" content="text/html; charset=windows-1252"></head><body><p>it`),
      0x92,
      ...enc(`s fine</p></body></html>`),
    ]);
    const r = await run(write("http-equiv-charset.html", bytes));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rendition.text).toContain("it’s fine");
  });

  it("html: a <meta-widget> custom element is NOT a <meta> declaration (wing round-3 finding 1)", async () => {
    // `<meta-widget charset="koi8-r">` is a CUSTOM ELEMENT whose name merely STARTS with "meta".
    // A `/<meta\b/` global match reads it as a charset declaration (koi8-r ∉ accepted set ⇒ wrongly
    // rejected). The tokenizer-style scan requires the tag NAME to be exactly `meta`, so the char
    // after the name must be a tag-name terminator — `meta-widget` does not qualify.
    const html = `<!doctype html><html><head><meta-widget charset="koi8-r"></meta-widget></head><body><p>café ok</p></body></html>`;
    const r = await run(write("meta-widget-charset.html", enc(html)));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rendition.text).toContain("café ok"); // decoded as UTF-8, not koi8-r
  });

  it("html: a fake <meta> inside a quoted attribute value is NOT a declaration (wing round-3 finding 1)", async () => {
    // The `title="<meta charset='koi8-r'>"` value contains the TEXT of a meta tag, but it is data
    // inside a quoted attribute of <link>, not a real tag. A global text search finds the `<meta`
    // and wrongly rejects; a quote-aware tag scan consumes the whole <link> tag (the inner `<meta`
    // is part of its attribute value) and never treats it as a declaration.
    const html = `<!doctype html><html><head><link rel="x" title="<meta charset='koi8-r'>"></head><body><p>café ok</p></body></html>`;
    const r = await run(write("attr-fake-meta.html", enc(html)));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rendition.text).toContain("café ok"); // decoded as UTF-8, not koi8-r
  });

  it("html: a <meta> inside an UNCLOSED comment is NOT a declaration (wing round-3 finding 1)", async () => {
    // The comment is never terminated (`-->` absent), so a regex that strips only CLOSED comments
    // leaves the `<meta charset="koi8-r">` text exposed and wrongly rejects. The tokenizer scan
    // consumes an unterminated comment to end-of-input, so the fake meta is never seen.
    const html = `<!doctype html><html><body><p>café ok</p><!-- trailing <meta charset="koi8-r"> never closed`;
    const r = await run(write("unclosed-comment-charset.html", enc(html)));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rendition.text).toContain("café ok"); // decoded as UTF-8, not koi8-r
  });

  it("html: a <meta> inside RCDATA (<title>) is NOT a declaration (wing round-3 finding 1)", async () => {
    // `<title>` content is RCDATA (text, not markup), so a `<meta charset="koi8-r">` written inside
    // it is inert. The scan skips a raw-text element's content to its end tag, exactly as the real
    // tokenizer would, so the fake meta never counts as a declaration.
    const html = `<!doctype html><html><head><title>x <meta charset="koi8-r"> y</title></head><body><p>café ok</p></body></html>`;
    const r = await run(write("rcdata-title-charset.html", enc(html)));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rendition.text).toContain("café ok"); // decoded as UTF-8, not koi8-r
  });
});

// ---------------------------------------------------------------------------
// Signature mismatch (extension lie) — content signature first, extension second.
// ---------------------------------------------------------------------------

sandboxDescribe("signature-mismatch (extension lie)", () => {
  it("markdown: a .md whose bytes are binary (NUL) is signature-mismatch", async () => {
    const r = await run(write("lie.md", new Uint8Array([0x00, 0x01, 0x02, 0x00])));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.rejection.code).toBe("signature-mismatch");
    expect(r.rejection.format).toBe("markdown");
  });

  it("pdf: a .pdf whose bytes are not %PDF- is signature-mismatch", async () => {
    const r = await run(write("lie.pdf", enc("this is not a pdf at all")));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.rejection.code).toBe("signature-mismatch");
    expect(r.rejection.format).toBe("pdf");
  });

  it("html: a .html whose bytes are not HTML is signature-mismatch", async () => {
    const r = await run(write("lie.html", enc("plain prose, no doctype and no html tag")));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.rejection.code).toBe("signature-mismatch");
    expect(r.rejection.format).toBe("html");
  });

  it("text: a .txt with NUL bytes (binary) is signature-mismatch", async () => {
    const r = await run(write("binary.txt", new Uint8Array([0x00, 0x01, 0x02, 0x00])));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.rejection.code).toBe("signature-mismatch");
    expect(r.rejection.format).toBe("text");
  });
});

// ---------------------------------------------------------------------------
// Oversize (too-large) — per-format raw-byte ceiling (rejected before parse).
// ---------------------------------------------------------------------------

sandboxDescribe("too-large (per-format ceiling)", () => {
  it("markdown: an input over 5 MiB is too-large", async () => {
    const r = await run(write("huge.md", new Uint8Array(5 * 1024 * 1024 + 1).fill(0x41)));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.rejection.code).toBe("too-large");
    expect(r.rejection.format).toBe("markdown");
  });

  it("text: an input over 5 MiB is too-large", async () => {
    const r = await run(write("huge.txt", new Uint8Array(5 * 1024 * 1024 + 1).fill(0x41)));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.rejection.code).toBe("too-large");
    expect(r.rejection.format).toBe("text");
  });

  it("html: an input over 10 MiB is too-large (rejected before parse)", async () => {
    const r = await run(write("huge.html", new Uint8Array(10 * 1024 * 1024 + 1).fill(0x20)));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.rejection.code).toBe("too-large");
    expect(r.rejection.format).toBe("html");
  });

  it("pdf: an input over 50 MiB is too-large (rejected before read)", async () => {
    const r = await run(write("huge.pdf", new Uint8Array(50 * 1024 * 1024 + 1)));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.rejection.code).toBe("too-large");
    expect(r.rejection.format).toBe("pdf");
  });
});

// ---------------------------------------------------------------------------
// PDF-specific rejections: encrypted, scanned/image-only, partial-extraction, and
// adversarial constructs (CID fonts, missing pages, comments, outside-BT, incremental).
// ---------------------------------------------------------------------------

sandboxDescribe("pdf format-specific rejections + adversarial constructs", () => {
  /** Assemble a minimal single-page PDF around `contentStream`, with `font` as /F1. */
  const pdf = (contentStream: string, opts?: { font?: string; kids?: string; append?: string }): string => {
    const font = opts?.font ?? "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
    const kids = opts?.kids ?? "[3 0 R]";
    const body = [
      "%PDF-1.4",
      "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj",
      `2 0 obj << /Type /Pages /Kids ${kids} /Count 1 >> endobj`,
      "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >> endobj",
      `4 0 obj ${font} endobj`,
      `5 0 obj << /Length ${contentStream.length} >>\nstream\n${contentStream}\nendstream\nendobj`,
      "trailer << /Size 6 /Root 1 0 R >>",
      "%%EOF",
    ].join("\n");
    return opts?.append ? body + "\n" + opts.append : body;
  };

  const ENCRYPTED = [
    "%PDF-1.4",
    "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj",
    "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj",
    "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 5 0 R >> endobj",
    "5 0 obj << /Length 0 >>\nstream\n\nendstream\nendobj",
    "9 0 obj << /Filter /Standard /V 2 /R 3 /O (xxxx) /U (yyyy) /P -44 >> endobj",
    "trailer << /Size 10 /Root 1 0 R /Encrypt 9 0 R >>",
    "%%EOF",
  ].join("\n");

  it("encrypted PDF ⇒ encrypted-source", async () => {
    const r = await run(write("encrypted.pdf", enc(ENCRYPTED)));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.rejection.code).toBe("encrypted-source");
  });

  it("scanned/image-only PDF (no text layer) ⇒ no-extractable-text", async () => {
    const r = await run(write("scanned.pdf", enc(pdf("0 0 100 100 re f"))));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.rejection.code).toBe("no-extractable-text");
  });

  it("a content stream that cannot be faithfully decoded ⇒ partial-extraction", async () => {
    const partial = pdf("").replace(
      "5 0 obj << /Length 0 >>\nstream\n\nendstream\nendobj",
      "5 0 obj << /Length 20 /Filter /FlateDecode >>\nstream\nNOT-VALID-DEFLATE!!!\nendstream\nendobj",
    );
    const r = await run(write("partial.pdf", enc(partial)));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.rejection.code).toBe("partial-extraction");
  });

  it("a CID/Type0 font (unmappable without a ToUnicode CMap) ⇒ partial-extraction", async () => {
    const cid = pdf("BT /F1 24 Tf 72 700 Td (unmappable) Tj ET", {
      font: "<< /Type /Font /Subtype /Type0 /BaseFont /X /Encoding /Identity-H >>",
    });
    const r = await run(write("cid.pdf", enc(cid)));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.rejection.code).toBe("partial-extraction");
  });

  it("a CID/Type0 font INHERITED from the /Pages node ⇒ partial-extraction (finding 4)", async () => {
    // The leaf /Page declares NO /Resources of its own; the Type0/Identity-H font lives on
    // the ancestor /Pages node and is INHERITED. A validator that only inspected the leaf
    // would see a font-less page and return corrupt Latin-1 text as success.
    const inherited = [
      "%PDF-1.4",
      "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj",
      "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 /Resources << /Font << /F1 4 0 R >> >> >> endobj",
      "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 5 0 R >> endobj",
      "4 0 obj << /Type /Font /Subtype /Type0 /BaseFont /X /Encoding /Identity-H >> endobj",
      "5 0 obj << /Length 40 >>\nstream\nBT /F1 24 Tf 72 700 Td (unmappable) Tj ET\nendstream\nendobj",
      "trailer << /Size 6 /Root 1 0 R >>",
      "%%EOF",
    ].join("\n");
    const r = await run(write("inherited-cid.pdf", enc(inherited)));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.rejection.code).toBe("partial-extraction");
  });

  it("a missing page-tree branch ⇒ partial-extraction (never silently dropped)", async () => {
    // /Kids references object 99 which has no body — a malformed branch.
    const missing = pdf("BT /F1 24 Tf 72 700 Td (hi) Tj ET", { kids: "[3 0 R 99 0 R]" });
    const r = await run(write("missing-page.pdf", enc(missing)));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.rejection.code).toBe("partial-extraction");
  });

  it("a % comment inside the content stream is not treated as visible text", async () => {
    const commented = pdf("BT /F1 24 Tf 72 700 Td (real text) Tj\n% (commented out) Tj\nET");
    const r = await run(write("comment.pdf", enc(commented)));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rendition.text).toBe("real text");
    expect(r.rendition.text).not.toContain("commented");
  });

  it("a string operand OUTSIDE BT/ET is not treated as visible text", async () => {
    const outside = pdf("(stray outside) Tj BT /F1 24 Tf 72 700 Td (inside text) Tj ET");
    const r = await run(write("outside-bt.pdf", enc(outside)));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rendition.text).toBe("inside text");
    expect(r.rendition.text).not.toContain("stray");
  });

  it("a clean PDF whose CONTENT mentions the literal /Encrypt is NOT encrypted-source (finding 1)", async () => {
    // `/Encrypt 9 0 R` appears only as shown text — NOT in the active trailer. The pre-fix
    // whole-document scan falsely rejected this clean PDF as encrypted-source.
    const clean = pdf("BT /F1 24 Tf 72 700 Td (see /Encrypt 9 0 R inside the body) Tj ET");
    const r = await run(write("literal-encrypt.pdf", enc(clean)));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rendition.text).toContain("/Encrypt 9 0 R");
  });

  it("an appended catalog/page-tree revision resolves the ACTIVE trailer's /Root, not a stale /Catalog (finding 2)", async () => {
    // The base defines catalog obj 1 → page 3 (STALE). An incremental section appends a NEW
    // catalog (obj 6) → page 8 (FRESH) and a new trailer whose /Root points at obj 6. The
    // pre-fix `findCatalog` returned the FIRST /Type /Catalog (obj 1) — stale page content.
    const base = [
      "%PDF-1.4",
      "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj",
      "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj",
      "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >> endobj",
      "4 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj",
      "5 0 obj << /Length 40 >>\nstream\nBT /F1 24 Tf 72 700 Td (STALE catalog page) Tj ET\nendstream\nendobj",
      "trailer << /Size 6 /Root 1 0 R >>",
      "%%EOF",
    ].join("\n");
    const append = [
      "6 0 obj << /Type /Catalog /Pages 7 0 R >> endobj",
      "7 0 obj << /Type /Pages /Kids [8 0 R] /Count 1 >> endobj",
      "8 0 obj << /Type /Page /Parent 7 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 9 0 R >> endobj",
      "9 0 obj << /Length 44 >>\nstream\nBT /F1 24 Tf 72 700 Td (FRESH catalog page) Tj ET\nendstream\nendobj",
      "trailer << /Size 10 /Root 6 0 R /Prev 0 >>",
      "%%EOF",
    ].join("\n");
    const r = await run(write("incremental-catalog.pdf", enc(base + "\n" + append)));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rendition.text).toBe("FRESH catalog page");
    expect(r.rendition.text).not.toContain("STALE");
  });

  it("an INDIRECT /Font whose entry is a Type0 font ⇒ partial-extraction (finding 3, no bypass)", async () => {
    // The page's /Font is itself an indirect reference (obj 6), whose entry /F1 references
    // the real Type0 font (obj 4). The pre-fix validator inspected obj 6 (a font dict, not a
    // font) and never followed to obj 4 — so an indirect Type0 font bypassed validation and
    // its bytes were decoded as corrupt Latin-1 text returned as success.
    const indirect = [
      "%PDF-1.4",
      "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj",
      "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj",
      "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font 6 0 R >> /Contents 5 0 R >> endobj",
      "6 0 obj << /F1 4 0 R >> endobj",
      "4 0 obj << /Type /Font /Subtype /Type0 /BaseFont /X /Encoding /Identity-H >> endobj",
      "5 0 obj << /Length 40 >>\nstream\nBT /F1 24 Tf 72 700 Td (unmappable) Tj ET\nendstream\nendobj",
      "trailer << /Size 7 /Root 1 0 R >>",
      "%%EOF",
    ].join("\n");
    const r = await run(write("indirect-type0.pdf", enc(indirect)));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.rejection.code).toBe("partial-extraction");
  });

  it("a WinAnsi font's non-ASCII byte decodes to correct Unicode, not corrupt Latin-1 (finding 3)", async () => {
    // Byte 0x92 (octal \222) is U+2019 (’) under WinAnsiEncoding but the Latin-1 control char
    // U+0092 under a raw byte→char decode. The pre-fix path returned the corrupt Latin-1 form
    // as success; the fix decodes WinAnsi strings through the cp1252 map.
    const winansi = pdf("BT /F1 24 Tf 72 700 Td (it\\222s fine) Tj ET", {
      font: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    });
    const r = await run(write("winansi.pdf", enc(winansi)));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rendition.text).toBe("it’s fine"); // correct curly apostrophe
    expect(r.rendition.text).not.toContain("\u0092"); // never the Latin-1 control char
  });

  it("an incremental update selects the LATEST object revision, not a stale one", async () => {
    // Object 5 is redefined by an appended incremental section — the later revision wins.
    const base = pdf("BT /F1 24 Tf 72 700 Td (STALE revision) Tj ET");
    const append = [
      "5 0 obj << /Length 40 >>\nstream\nBT /F1 24 Tf 72 700 Td (FRESH revision) Tj ET\nendstream\nendobj",
      "trailer << /Size 6 /Root 1 0 R /Prev 0 >>",
      "%%EOF",
    ].join("\n");
    const r = await run(write("incremental.pdf", enc(base + "\n" + append)));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rendition.text).toBe("FRESH revision");
    expect(r.rendition.text).not.toContain("STALE");
  });

  it("an active /Root that resolves to no object ⇒ partial-extraction, not a stale catalog (round-2 finding)", async () => {
    // The trailer's /Root points at obj 99 (no body). The pre-fix `resolveCatalog` fell back
    // to the first /Type /Catalog object (obj 1) and returned its page as success; once an
    // active /Root exists, that EXACT object must resolve to a catalog or it is a rejection.
    const bad = pdf("BT /F1 24 Tf 72 700 Td (hi) Tj ET").replace("/Root 1 0 R", "/Root 99 0 R");
    const r = await run(write("root-unresolved.pdf", enc(bad)));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.rejection.code).toBe("partial-extraction");
  });

  it("an active /Root pointing at a non-catalog object ⇒ partial-extraction (round-2 finding)", async () => {
    // /Root points at obj 4 — the font dictionary, not a catalog. Must reject, not fall back.
    const bad = pdf("BT /F1 24 Tf 72 700 Td (hi) Tj ET").replace("/Root 1 0 R", "/Root 4 0 R");
    const r = await run(write("root-noncatalog.pdf", enc(bad)));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.rejection.code).toBe("partial-extraction");
  });

  it("a declared /Font resource that is an unresolved indirect ref ⇒ partial-extraction (round-2 finding)", async () => {
    // /Resources /Font is an indirect ref to obj 7, which has NO body — a declared but
    // unresolved font resource. The pre-fix `?? ""` silently omitted it and decoded the page
    // as Latin-1 success; it must now reject.
    const doc = [
      "%PDF-1.4",
      "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj",
      "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj",
      "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font 7 0 R >> /Contents 5 0 R >> endobj",
      "5 0 obj << /Length 40 >>\nstream\nBT /F1 24 Tf 72 700 Td (hi) Tj ET\nendstream\nendobj",
      "trailer << /Size 8 /Root 1 0 R >>",
      "%%EOF",
    ].join("\n");
    const r = await run(write("font-resource-unresolved.pdf", enc(doc)));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.rejection.code).toBe("partial-extraction");
  });

  it("a /Font entry that is an unresolved indirect ref ⇒ partial-extraction (round-2 finding)", async () => {
    // /Font << /F1 4 0 R >> but obj 4 has no body — the declared font entry is unresolved.
    const doc = [
      "%PDF-1.4",
      "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj",
      "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj",
      "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >> endobj",
      "5 0 obj << /Length 40 >>\nstream\nBT /F1 24 Tf 72 700 Td (hi) Tj ET\nendstream\nendobj",
      "trailer << /Size 6 /Root 1 0 R >>",
      "%%EOF",
    ].join("\n");
    const r = await run(write("font-entry-unresolved.pdf", enc(doc)));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.rejection.code).toBe("partial-extraction");
  });

  it("content selecting a font absent from /Resources ⇒ partial-extraction (round-2 finding)", async () => {
    // /F2 is never declared; a Tf selecting it must reject rather than decode text under an
    // undefined resource font.
    const r = await run(write("undefined-font.pdf", enc(pdf("BT /F2 24 Tf 72 700 Td (mystery) Tj ET"))));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.rejection.code).toBe("partial-extraction");
  });

  it("non-ASCII text under a non-WinAnsi (unsupported) mapping ⇒ partial-extraction (round-2 finding)", async () => {
    // A MacRomanEncoding simple font: its 0x80–0xFF map is not implemented, so ASCII is
    // faithful but byte 0xE9 (\351) is NOT Latin-1 é — it must reject, not return corrupt
    // Unicode as success (the pre-fix path decoded all non-WinAnsi bytes as Latin-1).
    const doc = pdf("BT /F1 24 Tf 72 700 Td (caf\\351) Tj ET", {
      font: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /MacRomanEncoding >>",
    });
    const r = await run(write("macroman-nonascii.pdf", enc(doc)));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.rejection.code).toBe("partial-extraction");
  });

  it("a StandardEncoding font's ASCII text still extracts (no over-rejection of the ascii path)", async () => {
    // Regression guard for the round-2 non-WinAnsi change: an unsupported-map font whose shown
    // text is pure ASCII is still faithful and must succeed.
    const doc = pdf("BT /F1 24 Tf 72 700 Td (plain ascii) Tj ET", {
      font: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /StandardEncoding >>",
    });
    const r = await run(write("standard-ascii.pdf", enc(doc)));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rendition.text).toBe("plain ascii");
  });

  it("resolves the active trailer via the final startxref chain, not a later decoy trailer (round-2 finding)", async () => {
    // obj 1 (→ page 3) is the AUTHORITATIVE catalog; obj 6 (→ page 8) is a DECOY. The classic
    // xref section's trailer (/Root 1) is named by the final `startxref`; a DECOY textual
    // `trailer << /Root 6 … >>` sits AFTER %%EOF. A last-textual-trailer resolver would pick
    // the decoy (page 8); resolving from the startxref chain yields obj 1 (page 3).
    const pre =
      [
        "%PDF-1.4",
        "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj",
        "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj",
        "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >> endobj",
        "4 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj",
        "5 0 obj << /Length 44 >>\nstream\nBT /F1 24 Tf 72 700 Td (AUTHORITATIVE page) Tj ET\nendstream\nendobj",
        "6 0 obj << /Type /Catalog /Pages 7 0 R >> endobj",
        "7 0 obj << /Type /Pages /Kids [8 0 R] /Count 1 >> endobj",
        "8 0 obj << /Type /Page /Parent 7 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 9 0 R >> endobj",
        "9 0 obj << /Length 38 >>\nstream\nBT /F1 24 Tf 72 700 Td (DECOY page) Tj ET\nendstream\nendobj",
        "",
      ].join("\n"); // trailing "" → the joined string ends in "\n"
    const xref = "xref\n0 1\n0000000000 65535 f \ntrailer << /Size 10 /Root 1 0 R >>\n";
    const startOffset = pre.length; // latin1 decode ⇒ byte offset == char offset of `xref`
    const doc =
      pre + xref + `startxref\n${startOffset}\n%%EOF\n` + "trailer << /Size 10 /Root 6 0 R >>\n";
    const r = await run(write("startxref-chain.pdf", enc(doc)));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rendition.text).toBe("AUTHORITATIVE page");
    expect(r.rendition.text).not.toContain("DECOY");
  });

  it("a trailer /Encrypt appearing only inside a string value is NOT encrypted-source (round-2 finding)", async () => {
    // The active trailer's /Custom literal string contains the text "/Encrypt", but there is
    // no top-level /Encrypt key. Top-level-key parsing must not read the in-string text as an
    // encryption declaration (the pre-fix regex matched /Encrypt anywhere in the trailer).
    const doc = pdf("BT /F1 24 Tf 72 700 Td (hello) Tj ET").replace(
      "trailer << /Size 6 /Root 1 0 R >>",
      "trailer << /Size 6 /Root 1 0 R /Custom (contains /Encrypt but not a key) >>",
    );
    const r = await run(write("string-encrypt.pdf", enc(doc)));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rendition.text).toBe("hello");
  });

  it("a trailer string containing '>>' BEFORE /Encrypt does not truncate the dict — still encrypted (wing round-3 finding 2)", async () => {
    // The active trailer carries a literal-string value `(weird >> value)` whose bytes include
    // `>>` AHEAD of a real top-level /Encrypt key. A non-lexical `<<`/`>>` balancer closes the
    // dictionary at the in-string `>>`, DROPS the trailing /Encrypt, and mis-reports the
    // encrypted document as clean. The PDF-lexical readDict skips literal strings, so /Encrypt
    // is still read and the document is correctly rejected as encrypted-source.
    const doc = pdf("BT /F1 24 Tf 72 700 Td (hi) Tj ET").replace(
      "trailer << /Size 6 /Root 1 0 R >>",
      "trailer << /Size 6 /Info (weird >> value) /Encrypt 9 0 R /Root 1 0 R >>",
    );
    const r = await run(write("encrypt-after-string.pdf", enc(doc)));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.rejection.code).toBe("encrypted-source");
  });

  it("an /Encrypt key written with a #XX name escape (/En#63rypt) is still an encryption declaration (wing round-3 finding 2)", async () => {
    // A PDF name may write any character as `#` + two hex digits, so `/En#63rypt` (0x63 = 'c')
    // IS the name /Encrypt. A resolver that matched the literal token would miss it and treat
    // the encrypted document as clean; decoding the name escape catches the evasion.
    const doc = pdf("BT /F1 24 Tf 72 700 Td (hi) Tj ET").replace(
      "trailer << /Size 6 /Root 1 0 R >>",
      "trailer << /Size 6 /En#63rypt 9 0 R /Root 1 0 R >>",
    );
    const r = await run(write("encrypt-name-escape.pdf", enc(doc)));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.rejection.code).toBe("encrypted-source");
  });

  it("resolves /Root through the active xref chain, not a later same-number decoy definition (wing round-3 finding 3)", async () => {
    // obj 1 is DEFINED TWICE at different byte offsets: the REAL catalog (→ page 3, AUTHORITATIVE)
    // early, then an UNREFERENCED trailing redefinition (→ page 7/8, DECOY) that the xref table
    // never points at. A number-only, last-textual-wins object map returns the DECOY as obj 1 and
    // extracts stale page 8; resolving the exact (object, generation) at the xref's byte offset
    // proves the active revision and yields the real catalog (page 3).
    const head = "%PDF-1.4\n";
    const realCatalog = "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n"; // REAL, at a fixed offset
    const rest =
      "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n" +
      "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >> endobj\n" +
      "4 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj\n" +
      "5 0 obj << /Length 44 >>\nstream\nBT /F1 24 Tf 72 700 Td (AUTHORITATIVE page) Tj ET\nendstream\nendobj\n";
    const decoy =
      "1 0 obj << /Type /Catalog /Pages 7 0 R >> endobj\n" + // DECOY redefinition of obj 1 (not in xref)
      "7 0 obj << /Type /Pages /Kids [8 0 R] /Count 1 >> endobj\n" +
      "8 0 obj << /Type /Page /Parent 7 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 9 0 R >> endobj\n" +
      "9 0 obj << /Length 38 >>\nstream\nBT /F1 24 Tf 72 700 Td (DECOY page) Tj ET\nendstream\nendobj\n";
    const pre = head + realCatalog + rest + decoy;
    const rootOffset = head.length; // byte offset of the REAL `1 0 obj` (latin1 ⇒ byte == char offset)
    const xref =
      `xref\n0 2\n0000000000 65535 f \n${String(rootOffset).padStart(10, "0")} 00000 n \ntrailer << /Size 10 /Root 1 0 R >>\n`;
    const startOffset = pre.length;
    const doc = pre + xref + `startxref\n${startOffset}\n%%EOF\n`;
    const r = await run(write("root-xref-decoy.pdf", enc(doc)));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rendition.text).toBe("AUTHORITATIVE page");
    expect(r.rendition.text).not.toContain("DECOY");
  });

  it("a /Root object marked FREE in the active xref ⇒ partial-extraction, never a fallback catalog (wing round-3 finding 3)", async () => {
    // The trailer's /Root names obj 1, but the active xref marks obj 1 as a FREE slot ('f'). A
    // freed object cannot be the active catalog; its revision cannot be proven, so it is a
    // rejection rather than a fall-back to whatever /Type /Catalog text happens to be present.
    const head = "%PDF-1.4\n";
    const catalog = "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n";
    const rest =
      "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n" +
      "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >> endobj\n" +
      "4 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj\n" +
      "5 0 obj << /Length 30 >>\nstream\nBT /F1 24 Tf 72 700 Td (page) Tj ET\nendstream\nendobj\n";
    const pre = head + catalog + rest;
    const xref = `xref\n0 2\n0000000000 65535 f \n0000000000 00000 f \ntrailer << /Size 6 /Root 1 0 R >>\n`;
    const startOffset = pre.length;
    const doc = pre + xref + `startxref\n${startOffset}\n%%EOF\n`;
    const r = await run(write("root-freed.pdf", enc(doc)));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.rejection.code).toBe("partial-extraction");
  });

  it("an INDIRECT /Encoding object carrying /Differences is NOT treated as ASCII ⇒ partial-extraction (wing round-3 finding 4)", async () => {
    // The font's /Encoding is an indirect reference (obj 6) to an encoding dictionary with a
    // /Differences remap. The pre-fix validator inspected only the font body — which shows a
    // bare `/Encoding 6 0 R` matching no unsupported pattern — so the ASCII-range bytes decoded
    // as ASCII and returned INCORRECT text as success. Resolving the indirect encoding object
    // surfaces the /Differences and the page is correctly rejected.
    const doc = [
      "%PDF-1.4",
      "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj",
      "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj",
      "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >> endobj",
      "4 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding 6 0 R >> endobj",
      "6 0 obj << /Type /Encoding /Differences [65 /A 66 /B] >> endobj",
      "5 0 obj << /Length 40 >>\nstream\nBT /F1 24 Tf 72 700 Td (remap) Tj ET\nendstream\nendobj",
      "trailer << /Size 7 /Root 1 0 R >>",
      "%%EOF",
    ].join("\n");
    const r = await run(write("indirect-encoding-differences.pdf", enc(doc)));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.rejection.code).toBe("partial-extraction");
  });

  it("an INDIRECT /Encoding naming WinAnsi via /BaseEncoding decodes non-ASCII correctly (wing round-3 finding 4)", async () => {
    // The indirect encoding object declares /BaseEncoding /WinAnsiEncoding with no /Differences,
    // so it IS supported: resolving it must classify the font as WinAnsi (not blanket-reject),
    // decoding byte 0x92 (\222) to the curly apostrophe rather than raw Latin-1.
    const doc = [
      "%PDF-1.4",
      "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj",
      "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj",
      "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >> endobj",
      "4 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding 6 0 R >> endobj",
      "6 0 obj << /Type /Encoding /BaseEncoding /WinAnsiEncoding >> endobj",
      "5 0 obj << /Length 40 >>\nstream\nBT /F1 24 Tf 72 700 Td (it\\222s ok) Tj ET\nendstream\nendobj",
      "trailer << /Size 7 /Root 1 0 R >>",
      "%%EOF",
    ].join("\n");
    const r = await run(write("indirect-encoding-winansi.pdf", enc(doc)));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rendition.text).toBe("it’s ok");
  });

  it("WinAnsi decodes divergent bytes per the PDF map, not WHATWG windows-1252 (wing round-3 finding 5)", async () => {
    // Byte 0x80 → € (U+20AC); 0xA0 → SPACE (U+0020), NOT the NBSP U+00A0 TextDecoder yields;
    // 0xAD → HYPHEN (U+002D), NOT the soft hyphen U+00AD. These prove the PDF WinAnsi map is
    // used instead of TextDecoder("windows-1252"), whose output diverges for these codes.
    const winansi = (s: string): string =>
      pdf(`BT /F1 24 Tf 72 700 Td (${s}) Tj ET`, {
        font: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
      });
    const euro = await run(write("winansi-euro.pdf", enc(winansi("\\200"))));
    expect(euro.ok).toBe(true);
    if (!euro.ok) return;
    expect(euro.rendition.text).toBe("€");

    const nbsp = await run(write("winansi-a0.pdf", enc(winansi("a\\240b"))));
    expect(nbsp.ok).toBe(true);
    if (!nbsp.ok) return;
    expect(nbsp.rendition.text).toBe("a b"); // 0xA0 → space, not U+00A0
    expect(nbsp.rendition.text).not.toContain("\u00A0"); // never the NBSP U+00A0 TextDecoder yields

    const hyphen = await run(write("winansi-ad.pdf", enc(winansi("x\\255y"))));
    expect(hyphen.ok).toBe(true);
    if (!hyphen.ok) return;
    expect(hyphen.rendition.text).toBe("x-y"); // 0xAD → hyphen, not U+00AD
    expect(hyphen.rendition.text).not.toContain("­");
  });

  it("a byte UNDEFINED in WinAnsiEncoding (0x81) ⇒ partial-extraction, never a guessed control char (wing round-3 finding 5)", async () => {
    // 0x81 has no glyph in WinAnsiEncoding; TextDecoder("windows-1252") would emit the C1 control
    // U+0081. There is no faithful mapping, so the page is rejected rather than returned corrupt.
    const doc = pdf("BT /F1 24 Tf 72 700 Td (bad\\201byte) Tj ET", {
      font: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    });
    const r = await run(write("winansi-undefined.pdf", enc(doc)));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.rejection.code).toBe("partial-extraction");
  });
});

// ---------------------------------------------------------------------------
// HTML static-DOM + media alt-text handling + adversarial parser cases.
// ---------------------------------------------------------------------------

sandboxDescribe("html static-DOM + media alt-text rules", () => {
  const SCRIPT_HTML = [
    "<!doctype html><html><body>",
    `<script>document.write("INJECTED-BY-SCRIPT"); alert(1);</script>`,
    "<style>.secret{content:'STYLE-LEAK'}</style>",
    "<p>Visible paragraph.</p>",
    `<img src="x.png" onerror="alert('xss')">`,
    `<img src="deco.png" alt="">`,
    `<img src="cat.png" alt="A ginger cat">`,
    "</body></html>",
  ].join("\n");

  it("drops <script>/<style> content (scripts inert) and keeps only visible text", async () => {
    const r = await run(write("script.html", enc(SCRIPT_HTML)));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rendition.text).toContain("Visible paragraph.");
    expect(r.rendition.text).not.toContain("INJECTED-BY-SCRIPT");
    expect(r.rendition.text).not.toContain("alert");
    expect(r.rendition.text).not.toContain("STYLE-LEAK");
  });

  it("preserves a meaningful alt verbatim, records decorative + no-alt gaps (through the sandbox)", async () => {
    const r = await run(write("media.html", enc(SCRIPT_HTML)));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Meaningful alt preserved verbatim as text.
    expect(r.rendition.text).toContain("A ginger cat");
    // Gaps: one image-no-alt (first img) + one image-decorative (alt="") — survive the
    // sandbox result path (wing round-2 finding 2).
    const kinds = r.rendition.gaps.map((g) => g.kind).sort();
    expect(kinds).toEqual(["image-decorative", "image-no-alt"]);
    const noAlt = r.rendition.gaps.find((g) => g.kind === "image-no-alt");
    expect(noAlt?.locator).toMatch(/^dom:.*\/img\[1\]$/);
  });
});

sandboxDescribe("html adversarial parser cases (standards-conformant inert parse)", () => {
  it("decodes uppercase-hex, decimal, and named entities (a real DOM decode, not a subset)", async () => {
    // &#X41; (uppercase-X hex) the prior tokenizer missed; &#66; decimal; &euro; named.
    const html = `<!doctype html><html><body><p>&#X41;&#66;&euro;&amp;</p></body></html>`;
    const r = await run(write("entities.html", enc(html)));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rendition.text).toContain("AB€&");
  });

  it("does NOT terminate a tag at a quoted '>' inside an attribute value", async () => {
    // The prior tokenizer ended the tag at the first '>', truncating this attribute and
    // mis-parsing the rest. A conformant parser keeps the img a single element.
    const html = `<!doctype html><html><body><img alt="a > b closing"><p>after</p></body></html>`;
    const r = await run(write("quoted-gt.html", enc(html)));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rendition.text).toContain("a > b closing"); // the whole alt survived
    expect(r.rendition.text).toContain("after");
    // Exactly one image (with a meaningful alt) — the quoted '>' did not split the tag.
    expect(r.rendition.gaps).toEqual([]);
  });

  it("treats RCDATA (<textarea>) content as literal text, not markup", async () => {
    const html = `<!doctype html><html><body><textarea>&lt;b&gt; not <i>italic</i></textarea></body></html>`;
    const r = await run(write("rcdata.html", enc(html)));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // The entity resolves and the "<i>" is literal RCDATA text (not an element).
    expect(r.rendition.text).toContain("<b> not <i>italic</i>");
  });

  it("applies implicit tag closing (tree construction), e.g. <li> auto-closes <li>", async () => {
    const html = `<!doctype html><html><body><ul><li>one<li>two<li>three</ul></body></html>`;
    const r = await run(write("implicit-close.html", enc(html)));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rendition.text).toContain("one");
    expect(r.rendition.text).toContain("two");
    expect(r.rendition.text).toContain("three");
  });

  it("produces exact, deterministic DOM anchors for nested images", async () => {
    const html = `<!doctype html><html><body><div><p><img src="a.png"></p></div><img src="b.png"></body></html>`;
    const r = await run(write("anchors.html", enc(html)));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const locators = r.rendition.gaps.map((g) => g.locator).sort();
    expect(locators).toEqual(["dom:/html[1]/body[1]/div[1]/p[1]/img[1]", "dom:/html[1]/body[1]/img[1]"]);
  });
});

sandboxDescribe("html inline whitespace + verbatim alt (wing round-3 findings 2 + 3)", () => {
  it("preserves the separator between inline siblings (whitespace-only text node not dropped)", async () => {
    // Finding 2: a whitespace-only #text node BETWEEN inline elements is a real word
    // boundary — dropping it produced "Helloworld".
    const html = `<!doctype html><html><body><span>Hello</span> <span>world</span></body></html>`;
    const r = await run(write("inline-space.html", enc(html)));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rendition.text).toBe("Hello world");
  });

  it("does NOT invent a separator between directly-adjacent inline siblings", async () => {
    const html = `<!doctype html><html><body><b>Hello</b><b>world</b></body></html>`;
    const r = await run(write("inline-adjacent.html", enc(html)));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rendition.text).toBe("Helloworld");
  });

  it("preserves multi-space inside a meaningful alt verbatim (not whitespace-collapsed)", async () => {
    // Finding 3: meaningful alt must survive exactly, so its internal double spaces stay.
    const html = `<!doctype html><html><body><p>x<img src="a.png" alt="a  b  c">y</p></body></html>`;
    const r = await run(write("verbatim-alt.html", enc(html)));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rendition.text).toContain("a  b  c"); // the two internal double-spaces intact
    expect(r.rendition.gaps).toEqual([]); // meaningful alt → no gap
  });

  it("treats a whitespace-only alt as meaningful (verbatim), NOT the decorative empty value", async () => {
    // Finding 3: `alt=" "` is not `alt=""` — it is an (unusual) meaningful value, preserved
    // verbatim, never reclassified as the decorative empty marker.
    const html = `<!doctype html><html><body><p>a<img src="w.png" alt="  ">b</p></body></html>`;
    const r = await run(write("ws-alt.html", enc(html)));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rendition.text).toBe("a  b"); // the two-space alt survives verbatim between a…b
    expect(r.rendition.gaps).toEqual([]); // NOT a decorative gap
  });
});

// ---------------------------------------------------------------------------
// Gaps survive the raw runInSandbox result (wing round-2 finding 2, launcher layer).
// ---------------------------------------------------------------------------

sandboxDescribe("runInSandbox surfaces validated gap metadata", () => {
  it("an HTML image with no alt yields an image-no-alt gap on the sandbox result", async () => {
    const base = mkdtempSync(join(tmpdir(), "atlas-gaps-"));
    try {
      const input = join(base, "img.html");
      writeFileSync(input, `<!doctype html><html><body><p>hi</p><img src="x.png"></body></html>`);
      const res = await runInSandbox({ inputPath: input, format: "html", denyReadRoots: [base] });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.gaps).toEqual([{ kind: "image-no-alt", locator: "dom:/html[1]/body[1]/img[1]" }]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// File-replacement race (wing round-3 finding 1) — the worker parses the exact scanned
// snapshot, NOT a re-opened mutable pathname, so a mid-flight replacement cannot slip
// unscanned bytes through under the wrong contentId.
// ---------------------------------------------------------------------------

sandboxDescribe("file-replacement race (scanned snapshot is authoritative)", () => {
  it("a mid-flight replacement of the source path never changes the rendition", async () => {
    const ORIGINAL = "ORIGINAL snapshot content - exactly the scanned bytes";
    const path = write("race.md", enc(ORIGINAL));
    const { guard, sink } = freshGuard();
    // Start normalize: it synchronously stat()s + reads the raw bytes BEFORE its first
    // await, so the snapshot is captured now. Deliberately do NOT await yet.
    const pending = normalize({ path, guard });
    // Replace the on-disk bytes before the confined worker opens its handle. A worker that
    // re-opened `path` (the pre-fix behaviour) would parse THIS replacement; the staged
    // snapshot must make that impossible.
    writeFileSync(path, enc("REPLACED later content - must never be parsed"));

    const r = await pending;
    expect(sink.calls).toBe(0);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // The rendition reflects the scanned snapshot, never the replacement.
    expect(r.rendition.text).toContain("ORIGINAL snapshot content");
    expect(r.rendition.text).not.toContain("REPLACED");
    // contentId commits to the snapshot's raw hash, not the replacement's.
    expect(r.rendition.contentId.rawContentHash).toBe(createHash("sha256").update(enc(ORIGINAL)).digest("hex"));
  });
});

// ---------------------------------------------------------------------------
// Determinism — same bytes + versions ⇒ byte-identical normalizedContentHash.
// ---------------------------------------------------------------------------

sandboxDescribe("determinism (double-run hash equality)", () => {
  for (const name of ["sample.md", "sample.txt", "sample.pdf", "sample.html"]) {
    it(`${name}: two runs produce a byte-identical rendition`, async () => {
      const a = await run(fx(name));
      const b = await run(fx(name));
      expect(a.ok && b.ok).toBe(true);
      if (!a.ok || !b.ok) return;
      expect(b.rendition.normalizedContentHash).toBe(a.rendition.normalizedContentHash);
      // The whole rendition is a pure function of bytes + versions.
      expect(b.rendition).toEqual(a.rendition);
    });
  }
});

// ---------------------------------------------------------------------------
// Usage: an unsupported extension is a usage error, not an in-contract rejection.
// ---------------------------------------------------------------------------

describe("unsupported source extension", () => {
  it("throws UnsupportedSourceError (exit 5) for an unknown extension", async () => {
    const dir = mkdtempSync(join(tmpdir(), "atlas-ext-"));
    try {
      const path = join(dir, "data.bin");
      writeFileSync(path, enc("whatever"));
      const { guard } = freshGuard();
      await expect(normalize({ path, guard })).rejects.toBeInstanceOf(UnsupportedSourceError);
    } finally {
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Non-regular-file source (finding 4) — the trusted read requires a regular file, so a
// swapped-in directory/FIFO/device is refused rather than unbounded-read.
// ---------------------------------------------------------------------------

describe("non-regular-file source (finding 4)", () => {
  it("throws IrregularSourceError (exit 5) when the source path is a directory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "atlas-irregular-"));
    try {
      // A DIRECTORY carrying a supported extension — opens fine but is not a regular file.
      const notAFile = join(dir, "source.md");
      mkdirSync(notAFile);
      const { guard } = freshGuard();
      await expect(normalize({ path: notAFile, guard })).rejects.toBeInstanceOf(IrregularSourceError);
    } finally {
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a writer-less FIFO WITHOUT blocking on open — bounded by killing a child process (wing round-3 finding 6)", async () => {
    // A reader `open(path, "r")` on a FIFO with no writer BLOCKS INDEFINITELY. The fix opens
    // `O_RDONLY | O_NONBLOCK`, so the open returns at once and `fstat` rejects the non-regular
    // file promptly (IrregularSourceError).
    //
    // Why a CHILD PROCESS, not Promise.race: `normalize()` reaches the SYNCHRONOUS `openSync`
    // in its function body BEFORE it returns its promise. A blocking open therefore hangs the
    // caller before `Promise.race` (and its timer) can even be constructed — the in-process
    // timeout can never fire, so it does not actually bound a blocking-open regression. We run
    // the probe in a child `node` process the parent can HARD-KILL on a timeout: if the open
    // blocks, the child never exits, the parent kills it, and the test fails; the fix makes the
    // child exit promptly having thrown IrregularSourceError.
    const dir = mkdtempSync(join(tmpdir(), "atlas-fifo-"));
    try {
      const fifo = join(dir, "source.md");
      execFileSync("mkfifo", [fifo]); // POSIX named pipe, no writer attached

      // The probe imports the BUILT module (as the sandbox worker is loaded) and calls the real
      // `normalize` open path. A minimal guard stub suffices — the irregular-file rejection
      // happens in `readSourceBounded` BEFORE the guard is ever consulted.
      const distIndex = pathToFileURL(fileURLToPath(new URL("../dist/index.js", import.meta.url))).href;
      const probe = [
        `import { normalize } from ${JSON.stringify(distIndex)};`,
        `const guard = { assertClean: async () => {}, quarantineRejection: async () => {} };`,
        `try {`,
        `  const r = await normalize({ path: process.argv[2], guard });`,
        `  process.stdout.write("RESOLVED:" + JSON.stringify(r && r.ok));`,
        `} catch (e) {`,
        `  process.stdout.write("THREW:" + ((e && e.name) || String(e)));`,
        `}`,
      ].join("\n");
      const probePath = join(dir, "fifo-probe.mjs");
      writeFileSync(probePath, probe);

      const child = spawn(process.execPath, [probePath, fifo], { stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      child.stdout.on("data", (d: Buffer) => (out += d.toString()));
      const outcome = await new Promise<{ timedOut: boolean; out: string }>((resolve) => {
        const timer = setTimeout(() => {
          child.kill("SIGKILL"); // the open blocked — terminate the hung child
          resolve({ timedOut: true, out });
        }, 5000);
        child.on("exit", () => {
          clearTimeout(timer);
          resolve({ timedOut: false, out });
        });
      });

      // If the open blocked, the child was still running at the deadline and we killed it.
      expect(outcome.timedOut).toBe(false);
      // The non-blocking open + fstat rejects the FIFO as a non-regular file.
      expect(outcome.out).toContain("THREW:IrregularSourceError");
    } finally {
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    }
  });
});
