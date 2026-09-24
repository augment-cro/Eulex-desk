import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
    _resetDocumentTextForTesting,
    _setDocumentTextDepsForTesting,
    chatReadCharBudget,
    decodeText,
    extractDocumentText,
    formatDocumentPart,
    ocrCachePath,
    pdfPageMarkersToHeadings,
    splitTextIntoParts,
    textCachePathsFor,
} from "./documentText.js";

/**
 * A PDF whose pages' text layers say "Hello PDF" (xref rebuilt by pdf.js).
 * `pages` > 1 repeats the page object.
 */
function minimalPdf(pages = 1): Buffer {
    const stream = "BT /F1 12 Tf 20 100 Td (Hello PDF) Tj ET";
    const pageIds = Array.from({ length: pages }, (_, i) => 10 + i);
    return Buffer.from(
        [
            "%PDF-1.4",
            "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj",
            `2 0 obj << /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages} >> endobj`,
            ...pageIds.map(
                (id) =>
                    `${id} 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj`,
            ),
            `4 0 obj << /Length ${stream.length} >> stream`,
            stream,
            "endstream endobj",
            "5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj",
            "trailer << /Root 1 0 R >>",
            "%%EOF",
        ].join("\n"),
        "latin1",
    );
}

async function minimalDocx(): Promise<Buffer> {
    const { Document, Packer, Paragraph, HeadingLevel, TextRun } = await import("docx");
    const doc = new Document({
        sections: [
            {
                children: [
                    new Paragraph({ text: "Naslov", heading: HeadingLevel.HEADING_1 }),
                    new Paragraph({
                        children: [new TextRun({ text: "Očitovanje na tužbu", bold: true })],
                    }),
                ],
            },
        ],
    });
    return Packer.toBuffer(doc);
}

afterEach(() => _resetDocumentTextForTesting());

describe("extractDocumentText — formats", () => {
    it("decodes UTF-8 text and drops a BOM", async () => {
        const text = await extractDocumentText({
            fileType: "txt",
            bytes: Buffer.from("﻿čćđšž", "utf8"),
            flavor: "plain",
        });
        assert.equal(text, "čćđšž");
    });

    it("decodes a Windows-1250 text file instead of producing replacement characters", () => {
        // č ć đ š ž in Windows-1250
        const cp1250 = Buffer.from([0xe8, 0xe6, 0xf0, 0x9a, 0x9e]);
        assert.equal(decodeText(cp1250), "čćđšž");
    });

    it("returns .txt text for the tabular (markdown) flavour too", async () => {
        // Tabular used to send .txt through mammoth, which throws on non-zip
        // bytes — every cell of a .txt row ended as an error.
        const text = await extractDocumentText({
            fileType: "txt",
            bytes: Buffer.from("Članak 1.", "utf8"),
            flavor: "markdown",
        });
        assert.equal(text, "Članak 1.");
    });

    it("extracts DOCX as accepted-view text (plain) and as markdown", async () => {
        const docx = await minimalDocx();
        const plain = await extractDocumentText({ fileType: "docx", bytes: docx, flavor: "plain" });
        assert.match(plain, /Očitovanje na tužbu/);
        const md = await extractDocumentText({ fileType: "docx", bytes: docx, flavor: "markdown" });
        assert.match(md, /^# Naslov/m);
        assert.match(md, /\*\*Očitovanje na tužbu\*\*/);
    });

    it("reads a '.doc' that is really a DOCX (renamed file) as DOCX", async () => {
        const docx = await minimalDocx();
        const text = await extractDocumentText({ fileType: "doc", bytes: docx, flavor: "markdown" });
        assert.match(text, /Očitovanje na tužbu/);
    });

    it("throws for bytes it cannot recognise under an unknown type", async () => {
        await assert.rejects(
            extractDocumentText({
                fileType: "xlsx",
                bytes: Buffer.from("not a document"),
                flavor: "plain",
            }),
            /Unreadable document/,
        );
    });
});

describe("extractDocumentText — PDF OCR and its persisted cache", () => {
    const storagePath = "documents/u1/d1/source.pdf";

    function stubDeps(opts: {
        ocr?: string | Error;
        cached?: string | null;
    }) {
        const calls = { ocr: 0, reads: [] as string[], writes: [] as [string, string][] };
        _setDocumentTextDepsForTesting({
            ocrPdf: async () => {
                calls.ocr++;
                if (opts.ocr instanceof Error) throw opts.ocr;
                return opts.ocr ?? "";
            },
            readCache: async (key) => {
                calls.reads.push(key);
                return opts.cached ?? null;
            },
            writeCache: async (key, text) => {
                calls.writes.push([key, text]);
            },
        });
        return calls;
    }

    it("OCRs once and persists the transcription next to the version", async () => {
        const calls = stubDeps({ ocr: "[Page 1]\nTekst ugovora" });
        const text = await extractDocumentText({
            fileType: "pdf",
            bytes: minimalPdf(),
            flavor: "plain",
            storagePath,
        });
        assert.equal(text, "[Page 1]\nTekst ugovora");
        assert.equal(calls.ocr, 1);
        assert.deepEqual(calls.writes, [[`${storagePath}.ocr-v1.txt`, "[Page 1]\nTekst ugovora"]]);
    });

    it("does not cache a transcription that stops before the last page", async () => {
        const calls = stubDeps({ ocr: "[Page 1]\nsamo prva stranica" });
        const text = await extractDocumentText({
            fileType: "pdf",
            bytes: minimalPdf(2),
            flavor: "plain",
            storagePath,
        });
        assert.equal(text, "[Page 1]\nsamo prva stranica");
        assert.equal(calls.writes.length, 0);
    });

    it("serves a cached transcription without calling OCR, in either flavour", async () => {
        const calls = stubDeps({ ocr: "never", cached: "[Page 1]\nIz cachea\n\n[Page 2]\nDruga" });
        const plain = await extractDocumentText({ fileType: "pdf", bytes: minimalPdf(), flavor: "plain", storagePath });
        const md = await extractDocumentText({ fileType: "pdf", bytes: minimalPdf(), flavor: "markdown", storagePath });
        assert.equal(calls.ocr, 0);
        assert.equal(plain, "[Page 1]\nIz cachea\n\n[Page 2]\nDruga");
        assert.equal(md, "## Page 1\nIz cachea\n\n## Page 2\nDruga");
        assert.equal(calls.writes.length, 0);
    });

    it("does not touch the cache for bytes that are not a stored version", async () => {
        const calls = stubDeps({ ocr: "[Page 1]\nx" });
        await extractDocumentText({ fileType: "pdf", bytes: minimalPdf(), flavor: "plain" });
        assert.deepEqual(calls.reads, []);
        assert.deepEqual(calls.writes, []);
    });

    it("falls back to the text layer when OCR cannot run (PDF over the inline limit) and caches nothing", async () => {
        const calls = stubDeps({ ocr: new Error("PDF too large for inline Gemini OCR") });
        const text = await extractDocumentText({ fileType: "pdf", bytes: minimalPdf(), flavor: "plain", storagePath });
        assert.match(text, /^\[Page 1\]\n.*Hello PDF/);
        assert.equal(calls.writes.length, 0);
    });

    it("falls back to the text layer when OCR returns nothing and caches nothing", async () => {
        const calls = stubDeps({ ocr: "" });
        const md = await extractDocumentText({ fileType: "pdf", bytes: minimalPdf(), flavor: "markdown", storagePath });
        assert.match(md, /^## Page 1\n.*Hello PDF/);
        assert.equal(calls.writes.length, 0);
    });

    it("derives the cache object from the version's storage path", () => {
        assert.equal(ocrCachePath(storagePath), `${storagePath}.ocr-v1.txt`);
        assert.deepEqual(textCachePathsFor(storagePath), [`${storagePath}.ocr-v1.txt`]);
    });
});

describe("page markers and parts", () => {
    it("turns [Page N] markers into ## Page N headings", () => {
        assert.equal(
            pdfPageMarkersToHeadings("[Page 1]\nA\n\n[Page 12]\nB [Page 3] inline"),
            "## Page 1\nA\n\n## Page 12\nB [Page 3] inline",
        );
    });

    it("returns short text as a single part", () => {
        assert.deepEqual(splitTextIntoParts("kratko", 100), ["kratko"]);
    });

    it("splits on page markers so every part starts at a page", () => {
        for (const marker of ["[Page", "## Page"]) {
            const text = `${marker} 1${marker === "[Page" ? "]" : ""}\n${"a".repeat(60)}\n${marker} 2${marker === "[Page" ? "]" : ""}\n${"b".repeat(60)}`;
            const parts = splitTextIntoParts(text, 80);
            assert.equal(parts.length, 2, marker);
            assert.ok(parts[0].startsWith(`${marker} 1`));
            assert.ok(parts[1].startsWith(`${marker} 2`));
        }
    });

    it("falls back to paragraphs, then hard slices, and never exceeds the budget", () => {
        const paragraphs = ["p".repeat(40), "q".repeat(40), "r".repeat(40)].join("\n\n");
        const byParagraph = splitTextIntoParts(paragraphs, 90);
        assert.equal(byParagraph.length, 2);
        const oneBlock = "x".repeat(250);
        const sliced = splitTextIntoParts(oneBlock, 100);
        assert.deepEqual(sliced.map((p) => p.length), [100, 100, 50]);
        for (const p of [...byParagraph, ...sliced]) assert.ok(p.length <= 100);
    });

    it("frames a part with its position and how to continue", () => {
        const parts = ["one", "two", "three"];
        const first = formatDocumentPart({ docLabel: "doc-2", parts, part: 1, totalChars: 900 });
        assert.match(first, /^\[Long document \(900 characters\) — showing part 1 of 3\.\]/);
        assert.match(first, /"doc_id": "doc-2", "part": 2/);
        const last = formatDocumentPart({ docLabel: "doc-2", parts, part: 3, totalChars: 900 });
        assert.match(last, /the end of the document/);
    });

    it("sizes chat reads by provider", () => {
        assert.equal(chatReadCharBudget("claude-sonnet-5"), 600_000);
        assert.equal(chatReadCharBudget("gemini-3-flash-preview"), 600_000);
        assert.equal(chatReadCharBudget("gpt-5.6-sol"), 400_000);
        assert.equal(chatReadCharBudget("mistral-large-latest"), 150_000);
        assert.equal(chatReadCharBudget("localllm-main"), 120_000);
        assert.equal(chatReadCharBudget(undefined), 120_000);
    });
});
