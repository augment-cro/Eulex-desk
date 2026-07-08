import { GoogleGenAI } from "@google/genai";

/**
 * PDF text extraction backed by Gemini's native multimodal document
 * understanding. This replaces the old `pdfjs-dist`-only path which
 * silently returned "" for scanned PDFs (image-based, no embedded
 * text layer), causing read_document / tabular review to hand the
 * downstream LLM an empty string.
 *
 * Why Gemini and not Vision OCR / Document AI / Tesseract:
 *   - Gemini understands PDFs natively (layout + tables + scans in
 *     one call), so we don't need a separate OCR pipeline plus a
 *     layout reconstruction step.
 *   - We already ship the @google/genai SDK and resolve a Gemini
 *     API key in userSettings, so no new dependency / secret.
 *   - Hrvatski dijakritici prolaze čisto (Tesseract ih lomi).
 *
 * The output is plain text segmented by `[Page N]` markers so it
 * is drop-in compatible with the existing extractPdfText flow used
 * by `read_document`. Callers that want Markdown-style page headers
 * (the tabular review path) pass `pageMarker: "heading"` to get
 * `## Page N` instead.
 */

// Inline data limit: the Gemini Developer API caps a single request
// at 20 MB total. We leave ~1 MB headroom for the prompt + response
// envelope. PDFs above this should be chunked or routed through the
// Files API; for now we surface a clear error so callers can fall
// back rather than silently dropping content.
const MAX_INLINE_PDF_BYTES = 19 * 1024 * 1024;

// Default model — Gemini 3 Flash Preview is the sweet spot for OCR
// on legal/contract PDFs: handles tables and Croatian dijakritike
// reliably without the cost of Pro tier. Callers may override.
export const DEFAULT_OCR_MODEL = "gemini-3-flash-preview";

export type PdfOcrOptions = {
    /** Override the Gemini API key. Falls back to GEMINI_API_KEY env. */
    apiKey?: string | null;
    /** Override the Gemini model. Defaults to gemini-3-flash-preview. */
    model?: string;
    /**
     * How to label page boundaries in the returned string.
     *   - "plain"   → `[Page N]\n...`  (default; matches read_document)
     *   - "heading" → `## Page N\n...` (matches tabular review)
     */
    pageMarker?: "plain" | "heading";
};

function buildPrompt(pageMarker: "plain" | "heading"): string {
    const marker =
        pageMarker === "heading"
            ? "## Page N (where N is the 1-indexed page number)"
            : "[Page N] (where N is the 1-indexed page number)";
    return [
        "You are an OCR / document extraction service.",
        "Extract ALL textual content from the attached PDF, preserving reading order.",
        "Rules:",
        `1. Begin every page with a marker on its own line: ${marker}.`,
        "2. Include every visible character — headings, paragraphs, list bullets, footnotes, page numbers, table contents, signature blocks, captions.",
        "3. Render tables as plain text with cells separated by ' | ' and rows on new lines. Do not invent column headers if none exist.",
        "4. Do NOT summarize, paraphrase, translate, or add commentary. Output the document text verbatim.",
        "5. Do NOT wrap the output in code fences or any other framing.",
        "6. If the PDF contains handwritten text, transcribe it as best you can; mark illegible runs as [illegible].",
        "7. Keep the original language exactly (Croatian stays Croatian, including č ć ž š đ).",
    ].join("\n");
}

/**
 * Extract a PDF's text content using Gemini multimodal. Returns the
 * extracted text on success, or an empty string on failure (the caller
 * decides whether to fall back to a different extractor or surface an
 * error). Throws only if the PDF exceeds the inline-data size limit;
 * everything else is caught and logged so a single bad document never
 * crashes the request.
 */
export async function extractPdfWithGemini(
    buf: ArrayBuffer,
    opts: PdfOcrOptions = {},
): Promise<string> {
    const byteLength = buf.byteLength;
    if (byteLength > MAX_INLINE_PDF_BYTES) {
        throw new Error(
            `PDF too large for inline Gemini OCR: ${byteLength} bytes (limit ${MAX_INLINE_PDF_BYTES}). ` +
                "Split the document or route through the Gemini Files API.",
        );
    }

    const apiKey = opts.apiKey?.trim() || process.env.GEMINI_API_KEY?.trim();
    if (!apiKey) {
        console.warn(
            "[pdfOcr] no Gemini API key available (neither user-supplied nor GEMINI_API_KEY env). Skipping OCR.",
        );
        return "";
    }

    const model = opts.model?.trim() || DEFAULT_OCR_MODEL;
    const pageMarker = opts.pageMarker ?? "plain";
    const ai = new GoogleGenAI({ apiKey });
    const base64 = Buffer.from(buf).toString("base64");

    const t0 = Date.now();
    try {
        const resp = await ai.models.generateContent({
            model,
            contents: [
                {
                    role: "user",
                    parts: [
                        {
                            inlineData: {
                                data: base64,
                                mimeType: "application/pdf",
                            },
                        },
                        { text: buildPrompt(pageMarker) },
                    ],
                },
            ],
            config: {
                // OCR is a deterministic transcription task — no
                // thinking budget needed, saves both tokens and
                // ~1-2s of latency per call.
                thinkingConfig: { thinkingBudget: 0 },
            },
        });
        const text = resp.text ?? "";
        console.log(
            `[pdfOcr] gemini extraction OK model=${model} bytes=${byteLength} chars=${text.length} ms=${Date.now() - t0}`,
        );
        return text;
    } catch (err) {
        console.error(
            `[pdfOcr] gemini extraction FAILED model=${model} bytes=${byteLength} ms=${Date.now() - t0}:`,
            err,
        );
        return "";
    }
}
