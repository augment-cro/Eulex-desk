/**
 * Document text extraction — one implementation for every consumer.
 *
 * The same extraction used to live in four places (chat read_document,
 * two tabular call sites, the PII preview) and drifted apart: tabular sent
 * .doc and .txt through mammoth, which only reads DOCX, so every cell
 * errored; and a PDF above Gemini's inline limit threw instead of falling
 * back to its text layer.
 *
 * Two flavours, because consumers need different shapes of the SAME text:
 *   - "plain"    — chat read_document / find_in_document / fetch_documents
 *                  and the PII preview. PDF pages are marked `[Page N]`;
 *                  DOCX is the accepted-view body text that edit_document
 *                  anchors its edits against.
 *   - "markdown" — tabular review. PDF pages are `## Page N` headings (the
 *                  chunker and `[[page:N||quote:…]]` citations key on them);
 *                  DOCX keeps headings, bold and lists via mammoth HTML.
 *
 * PDF OCR runs once per document version: Gemini's transcription (~35 s per
 * call on average in production, and ~40 % of calls re-read a PDF that was
 * already transcribed) is persisted next to the version's bytes and reused
 * by every later read, in either flavour. The cache object shares the
 * version's storage prefix and is deleted with it (`textCachePathsFor`).
 */

import path from "path";
import { extractPdfWithGemini } from "./pdfOcr";
import { extractDocxBodyText } from "./docxTrackedChanges";
import { normalizeDocxZipPaths } from "./convert";
import { downloadFile, uploadFile } from "./storage";
import { providerForModel } from "./llm/models";

export type TextFlavor = "plain" | "markdown";

/** Bump to invalidate every persisted OCR transcription. */
const OCR_CACHE_VERSION = 1;

const STANDARD_FONT_DATA_URL = (() => {
    try {
        const pkgPath = require.resolve("pdfjs-dist/package.json");
        return path.join(path.dirname(pkgPath), "standard_fonts") + path.sep;
    } catch {
        return undefined;
    }
})();

// ---------------------------------------------------------------------------
// Dependencies (overridable in tests)
// ---------------------------------------------------------------------------

interface DocumentTextDeps {
    ocrPdf: (buf: ArrayBuffer, apiKey: string | null) => Promise<string>;
    readCache: (key: string) => Promise<string | null>;
    writeCache: (key: string, text: string) => Promise<void>;
}

function defaultDeps(): DocumentTextDeps {
    return {
        ocrPdf: (buf, apiKey) =>
            extractPdfWithGemini(buf, { apiKey, pageMarker: "plain" }),
        readCache: async (key) => {
            const raw = await downloadFile(key);
            return raw ? Buffer.from(raw).toString("utf8") : null;
        },
        writeCache: async (key, text) => {
            const buf = Buffer.from(text, "utf8");
            await uploadFile(
                key,
                buf.buffer.slice(
                    buf.byteOffset,
                    buf.byteOffset + buf.byteLength,
                ) as ArrayBuffer,
                "text/plain; charset=utf-8",
            );
        },
    };
}

let deps: DocumentTextDeps = defaultDeps();

/** Test hook — override individual dependencies. */
export function _setDocumentTextDepsForTesting(
    partial: Partial<DocumentTextDeps>,
): void {
    deps = { ...deps, ...partial };
}

/** Test hook — restore real dependencies. */
export function _resetDocumentTextForTesting(): void {
    deps = defaultDeps();
}

// ---------------------------------------------------------------------------
// Persisted OCR cache
// ---------------------------------------------------------------------------

/** Where a version's OCR transcription is persisted. */
export function ocrCachePath(storagePath: string): string {
    return `${storagePath}.ocr-v${OCR_CACHE_VERSION}.txt`;
}

/**
 * Derived objects stored next to a version's bytes. Every code path that
 * deletes a version's `storage_path` must delete these too.
 */
export function textCachePathsFor(storagePath: string): string[] {
    return [ocrCachePath(storagePath)];
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

type ContentKind = "pdf" | "docx" | "doc" | "txt";

function toBuffer(bytes: ArrayBuffer | Buffer): Buffer {
    return Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
}

function toArrayBuffer(buf: Buffer): ArrayBuffer {
    return buf.buffer.slice(
        buf.byteOffset,
        buf.byteOffset + buf.byteLength,
    ) as ArrayBuffer;
}

const OLE_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

function sniff(buf: Buffer): ContentKind | null {
    // The PDF header may sit anywhere in the first KiB.
    if (buf.subarray(0, 1024).includes("%PDF-")) return "pdf";
    if (buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04)
        return "docx";
    if (buf.subarray(0, 8).equals(OLE_MAGIC)) return "doc";
    return null;
}

/**
 * Which extractor to run. The declared type wins, except where the bytes
 * say otherwise in a way we know how to read: a ".doc" that is really a
 * zip (renamed DOCX) or a ".docx" that is really an OLE file. Unknown
 * types fall back to sniffing; null means unreadable.
 */
function resolveKind(fileType: string, buf: Buffer): ContentKind | null {
    const sniffed = sniff(buf);
    switch (fileType) {
        case "pdf":
            return sniffed === "docx" || sniffed === "doc" ? sniffed : "pdf";
        case "txt":
            return "txt";
        case "doc":
            return sniffed === "docx" ? "docx" : "doc";
        case "docx":
            return sniffed === "doc" ? "doc" : "docx";
        default:
            return sniffed;
    }
}

/**
 * Extract a stored document's text. Throws when the bytes cannot be read
 * at all (corrupt file, unknown format); callers map that to their own
 * "could not be read" response.
 *
 * `storagePath` — the version's storage path; enables the persisted OCR
 * cache for PDFs. Omit it for bytes that are not a stored version.
 */
export async function extractDocumentText(params: {
    fileType: string | null | undefined;
    bytes: ArrayBuffer | Buffer;
    flavor: TextFlavor;
    geminiApiKey?: string | null;
    storagePath?: string | null;
}): Promise<string> {
    const buf = toBuffer(params.bytes);
    const fileType = (params.fileType ?? "").toLowerCase();
    const kind = resolveKind(fileType, buf);
    if (kind !== fileType && fileType) {
        console.warn(
            `[documentText] declared file_type="${fileType}" read as "${kind ?? "unknown"}"`,
        );
    }
    switch (kind) {
        case "pdf": {
            const plain = await pdfPlainText(
                buf,
                params.geminiApiKey ?? null,
                params.storagePath ?? null,
            );
            return params.flavor === "markdown"
                ? pdfPageMarkersToHeadings(plain)
                : plain;
        }
        case "docx":
            return params.flavor === "markdown"
                ? docxMarkdown(buf)
                : docxPlainText(buf);
        case "doc": {
            const WordExtractor = (await import("word-extractor")).default;
            const doc = await new WordExtractor().extract(buf);
            return doc.getBody();
        }
        case "txt":
            return decodeText(buf);
        default:
            throw new Error(
                `Unreadable document: file_type="${fileType || "(none)"}" and no recognizable content`,
            );
    }
}

async function pdfPlainText(
    buf: Buffer,
    apiKey: string | null,
    storagePath: string | null,
): Promise<string> {
    const cacheKey = storagePath ? ocrCachePath(storagePath) : null;
    if (cacheKey) {
        const cached = await deps.readCache(cacheKey).catch(() => null);
        if (cached && cached.trim()) {
            console.log(
                `[documentText] OCR cache hit chars=${cached.length}`,
            );
            return cached;
        }
    }

    let ocr = "";
    try {
        ocr = await deps.ocrPdf(toArrayBuffer(buf), apiKey);
    } catch (err) {
        // Above Gemini's inline-request limit. The text layer is still
        // readable; a scanned PDF this large needs the Files API route.
        console.warn(
            `[documentText] Gemini OCR not attempted: ${err instanceof Error ? err.message : String(err)} — using the PDF text layer`,
        );
    }
    if (ocr.trim()) {
        if (cacheKey) {
            // Persist only a transcription that reaches the last page — a
            // long PDF can hit the model's output limit, and a truncated
            // text must not be pinned to this version forever.
            const pages = await pdfPageCount(buf);
            const lastMarked = lastPageMarker(ocr);
            if (pages !== null && lastMarked < pages) {
                console.warn(
                    `[documentText] OCR covered ${lastMarked}/${pages} pages — not cached`,
                );
            } else {
                void deps
                    .writeCache(cacheKey, ocr)
                    .catch((err) =>
                        console.warn(
                            `[documentText] OCR cache write failed: ${err instanceof Error ? err.message : String(err)}`,
                        ),
                    );
            }
        }
        return ocr;
    }

    console.warn(
        "[documentText] Gemini OCR returned nothing, falling back to pdfjs-dist",
    );
    // Deliberately NOT cached: an OCR outage must not pin the weaker
    // text-layer result to this version forever.
    return pdfTextLayer(buf);
}

async function pdfTextLayer(buf: Buffer): Promise<string> {
    try {
        const pdfjsLib = await import(
            "pdfjs-dist/legacy/build/pdf.mjs" as string
        );
        const pdf = await (
            pdfjsLib as unknown as {
                getDocument: (opts: unknown) => {
                    promise: Promise<{
                        numPages: number;
                        getPage: (n: number) => Promise<{
                            getTextContent: () => Promise<{
                                items: { str?: string }[];
                            }>;
                        }>;
                    }>;
                };
            }
        ).getDocument({
            data: new Uint8Array(buf),
            standardFontDataUrl: STANDARD_FONT_DATA_URL,
        }).promise;
        const parts: string[] = [];
        for (let i = 1; i <= pdf.numPages; i++) {
            const page = await pdf.getPage(i);
            const textContent = await page.getTextContent();
            parts.push(
                `[Page ${i}]\n${textContent.items.map((it) => it.str ?? "").join(" ")}`,
            );
        }
        return parts.join("\n\n");
    } catch {
        return "";
    }
}

/** Highest `[Page N]` marker in an OCR transcription (0 when none). */
function lastPageMarker(text: string): number {
    let max = 0;
    for (const m of text.matchAll(/^[ \t]*\[Page (\d+)\]/gm))
        max = Math.max(max, Number(m[1]));
    return max;
}

async function pdfPageCount(buf: Buffer): Promise<number | null> {
    try {
        const pdfjsLib = await import(
            "pdfjs-dist/legacy/build/pdf.mjs" as string
        );
        const pdf = await (
            pdfjsLib as unknown as {
                getDocument: (opts: unknown) => {
                    promise: Promise<{ numPages: number }>;
                };
            }
        ).getDocument({ data: new Uint8Array(buf) }).promise;
        return pdf.numPages;
    } catch {
        return null;
    }
}

/** `[Page N]` page markers → `## Page N` headings (the tabular shape). */
export function pdfPageMarkersToHeadings(text: string): string {
    return text.replace(/^[ \t]*\[Page (\d+)\]/gm, "## Page $1");
}

async function docxPlainText(buf: Buffer): Promise<string> {
    const normalized = await normalizeDocxZipPaths(buf);
    try {
        // Same flattening as the edit_document matcher, so the model sees
        // exactly the characters it can anchor an edit against.
        const text = await extractDocxBodyText(normalized);
        if (text) return text;
    } catch (err) {
        console.warn(
            `[documentText] accepted-view DOCX extractor failed, falling back to mammoth: ${err instanceof Error ? err.message : String(err)}`,
        );
    }
    const mammoth = await import("mammoth");
    const { value } = await mammoth.extractRawText({ buffer: normalized });
    return value;
}

async function docxMarkdown(buf: Buffer): Promise<string> {
    const mammoth = await import("mammoth");
    const normalized = await normalizeDocxZipPaths(buf);
    const { value: html } = await mammoth.convertToHtml({
        buffer: normalized,
    });
    return html
        .replace(
            /<h([1-6])[^>]*>(.*?)<\/h\1>/gi,
            (_, l, t) => "#".repeat(Number(l)) + " " + t + "\n\n",
        )
        .replace(/<strong[^>]*>(.*?)<\/strong>/gi, "**$1**")
        .replace(/<li[^>]*>(.*?)<\/li>/gi, "- $1\n")
        .replace(/<p[^>]*>(.*?)<\/p>/gi, "$1\n\n")
        .replace(/<[^>]+>/g, "")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

/**
 * Plain-text bytes → string. UTF-8 first; bytes that are not valid UTF-8
 * are decoded as Windows-1250, the legacy encoding of Croatian text files
 * (č ć đ š ž), instead of turning into replacement characters.
 */
export function decodeText(buf: Buffer): string {
    let text: string;
    try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(buf);
    } catch {
        text = new TextDecoder("windows-1250").decode(buf);
    }
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

// ---------------------------------------------------------------------------
// Sizing: splitting long text into model-sized parts
// ---------------------------------------------------------------------------

/**
 * Split text into parts of at most `budget` characters. Parts follow page
 * markers when the text has them (`## Page N` or `[Page N]`, so page
 * numbers and citations stay globally correct), otherwise paragraph
 * breaks; a single segment larger than the budget is sliced. Deterministic:
 * the same text and budget always yield the same parts.
 */
export function splitTextIntoParts(text: string, budget: number): string[] {
    if (text.length <= budget) return [text];

    // Last-resort split for a single segment larger than the budget
    // (a paragraph/page that alone exceeds it) — plain slices.
    const hardSplit = (seg: string): string[] => {
        const out: string[] = [];
        for (let i = 0; i < seg.length; i += budget)
            out.push(seg.slice(i, i + budget));
        return out;
    };

    const pageSegments = text.split(/\n(?=(?:## Page \d|\[Page \d))/);
    const segments =
        pageSegments.length > 1 ? pageSegments : text.split(/\n\n+/);

    const parts: string[] = [];
    let current = "";
    const flush = () => {
        if (current.trim()) parts.push(current);
        current = "";
    };
    for (const seg of segments) {
        const pieces = seg.length > budget ? hardSplit(seg) : [seg];
        for (const piece of pieces) {
            if (current && current.length + piece.length + 2 > budget) flush();
            current = current ? `${current}\n\n${piece}` : piece;
        }
    }
    flush();
    return parts;
}

/**
 * Character budget for what ONE chat tool call may return from documents
 * (a read_document result, or everything one fetch_documents call returns).
 * Chat shares the context window with the system prompt, the conversation
 * and other reads, so this is ~20–40 % of the provider's window at ~3 chars
 * per token (Croatian legal text tokenizes worse than English). Longer
 * documents are served in parts — never silently truncated.
 */
export function chatReadCharBudget(model: string | null | undefined): number {
    if (!model || model.startsWith("localllm")) return 120_000;
    let provider: ReturnType<typeof providerForModel>;
    try {
        provider = providerForModel(model);
    } catch {
        return 120_000;
    }
    switch (provider) {
        case "claude":
            return 600_000; // 1M-token context (Sonnet 5, Opus 4.8)
        case "gemini":
            return 600_000; // 1M-token context
        case "openai":
            return 400_000; // 400k-token context
        case "mistral":
            return 150_000; // 128k-token context
        default:
            return 120_000;
    }
}

/**
 * The model-facing result of reading one part of a long document. The
 * header and footer tell the model it is partial and exactly how to
 * continue, so it never mistakes part 1 for the whole document.
 */
export function formatDocumentPart(args: {
    docLabel: string;
    parts: string[];
    part: number;
    totalChars: number;
}): string {
    const { docLabel, parts, part, totalChars } = args;
    const n = parts.length;
    const header = `[Long document (${totalChars} characters) — showing part ${part} of ${n}.]`;
    const footer =
        part < n
            ? `[End of part ${part} of ${n}. To continue, call read_document with {"doc_id": "${docLabel}", "part": ${part + 1}}. To locate a specific passage without reading every part, use find_in_document.]`
            : `[End of part ${n} of ${n} — the end of the document.]`;
    return `${header}\n\n${parts[part - 1]}\n\n${footer}`;
}
