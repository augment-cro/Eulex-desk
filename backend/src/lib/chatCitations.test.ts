import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractAnnotations, spreadsheetCitationNote } from "./chatTools.js";

// The chat <CITATIONS> block → `citation_data` annotations. Spreadsheet
// citations name a sheet and a cell instead of a page (contract shared
// with the frontend CitationQuote: `sheet` + `cell`, `page: null`).

const SHEET_TEXT = [
    "## Sheet: Ugovori",
    "",
    "| Row | A | B | C |",
    "| --- | --- | --- | --- |",
    "| 1 | Ugovorna strana | Datum | Iznos (EUR) |",
    "| 2 | Alfa d.o.o. | 14.05.2023. | 1,250,000.00 |",
    "| 3 | ALFA D.O.O. |  | 300.00 |",
].join("\n");

const DOC_INDEX = {
    "doc-0": {
        document_id: "d-xlsx",
        version_id: "v-xlsx",
        version_number: 1,
        filename: "Registar.xlsx",
    },
    "doc-1": {
        document_id: "d-pdf",
        version_id: "v-pdf",
        version_number: 2,
        filename: "Ugovor.pdf",
    },
} as unknown as Parameters<typeof extractAnnotations>[1];

function withCitations(citations: unknown[]): string {
    return `Odgovor [1] [2] [3].\n<CITATIONS>\n${JSON.stringify(citations)}\n</CITATIONS>`;
}

describe("extractAnnotations — spreadsheet (cell) citations", () => {
    it("emits sheet + cell and page null, verified against the cited cell", () => {
        const annotations = extractAnnotations(
            withCitations([
                { ref: 1, doc_id: "doc-0", sheet: "Ugovori", cell: "c2", quote: "1,250,000.00" },
                { ref: 2, doc_id: "doc-0", sheet: "Ugovori", cell: "A3", quote: "alfa d.o.o." },
                { ref: 3, doc_id: "doc-1", page: 4, quote: "Članak 5." },
            ]),
            DOC_INDEX,
            [],
            new Map([["doc-0", SHEET_TEXT]]),
        ) as Record<string, unknown>[];
        assert.deepEqual(annotations[0], {
            type: "citation_data",
            ref: 1,
            doc_id: "doc-0",
            document_id: "d-xlsx",
            version_id: "v-xlsx",
            version_number: 1,
            filename: "Registar.xlsx",
            page: null,
            sheet: "Ugovori",
            cell: "C2",
            quote: "1,250,000.00",
            verification: { status: "verified" },
        });
        // Repaired from the CITED cell (A3), not the first match (A2).
        assert.equal(annotations[1].quote, "ALFA D.O.O.");
        assert.deepEqual(annotations[1].verification, {
            status: "repaired",
            original_quote: "alfa d.o.o.",
        });
        // Page citations are unchanged: page kept, no sheet/cell, no
        // verification without the doc's text.
        assert.equal(annotations[2].page, 4);
        assert.equal("sheet" in annotations[2], false);
        assert.equal("verification" in annotations[2], false);
    });

    it("accepts Sheet!Cell in `cell` and ranges; drops an unusable locator", () => {
        const annotations = extractAnnotations(
            withCitations([
                { ref: 1, doc_id: "doc-0", cell: "Ugovori!$A$2:$C$2", quote: "Alfa d.o.o." },
                { ref: 2, doc_id: "doc-0", sheet: "Ugovori", cell: "red 2", quote: "x" },
            ]),
            DOC_INDEX,
        ) as Record<string, unknown>[];
        assert.equal(annotations.length, 1);
        assert.equal(annotations[0].sheet, "Ugovori");
        assert.equal(annotations[0].cell, "A2:C2");
        assert.equal(annotations[0].page, null);
    });
});

describe("spreadsheetCitationNote", () => {
    it("tells the model how to cite a spreadsheet it just read", () => {
        const note = spreadsheetCitationNote("doc-0", SHEET_TEXT);
        assert.match(note, /Citation note for doc-0: this document is a spreadsheet/);
        assert.match(note, /"doc_id": "doc-0", "sheet": /);
        assert.equal(spreadsheetCitationNote("doc-1", "[Page 1]\nTekst"), "");
    });
});

describe("extractAnnotations — document citation without a page (COIN demo #89)", () => {
    it("keeps a DOCX/text quote without a page on page 1 instead of dropping it", () => {
        const annotations = extractAnnotations(
            withCitations([{ ref: 1, doc_id: "doc-0", quote: "Alfa d.o.o." }]),
            DOC_INDEX,
        ) as Record<string, unknown>[];
        assert.equal(annotations.length, 1);
        assert.equal(annotations[0].page, 1);
    });
});

describe("extractAnnotations — documents of an active EULEX context", () => {
    const index = {
        ...DOC_INDEX,
        "doc-2": {
            document_id: "d-azop",
            version_id: "v-azop",
            version_number: 1,
            filename: "AZOP-Smjernice-za-razvoj-AI-sustava.pdf",
            read_only: true,
        },
    } as unknown as Parameters<typeof extractAnnotations>[1];

    it("flags a citation into a context document, and only that one", () => {
        const annotations = extractAnnotations(
            withCitations([
                { ref: 1, doc_id: "doc-2", page: 12, quote: "legitimni interes" },
                { ref: 2, doc_id: "doc-1", page: 1, quote: "Ugovor" },
            ]),
            index,
        ) as Record<string, unknown>[];
        assert.equal(annotations.length, 2);
        assert.equal(annotations[0].context, true);
        assert.equal(annotations[0].document_id, "d-azop");
        assert.equal(annotations[0].page, 12);
        assert.equal("context" in annotations[1], false);
    });
});
