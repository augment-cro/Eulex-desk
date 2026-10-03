import { describe, it } from "node:test";
import assert from "node:assert/strict";
import zlib from "zlib";
import JSZip from "jszip";
import * as XLSX from "xlsx";
import {
    SPREADSHEET_MAX_UNCOMPRESSED_BYTES,
    SpreadsheetLimitError,
    assertZipWithinLimits,
    indexSpreadsheetText,
    normalizeCellRef,
    parseCellLocator,
    parseCsv,
    sniffCsvDelimiter,
    spreadsheetCellText,
    spreadsheetToText,
    splitSpreadsheetTextIntoParts,
} from "./spreadsheet.js";
import {
    extractDocumentText,
    resolveDocumentKind,
    sniffDocument,
    splitTextIntoParts,
    spreadsheetSheetNamesFor,
    spreadsheetViewXlsx,
} from "./documentText.js";

// ---------------------------------------------------------------------------
// Fixtures — built with SheetJS, never checked in
// ---------------------------------------------------------------------------

/** The spec's example workbook: merges, a hidden row, a comment, a formula. */
function contractsWorkbook(): XLSX.WorkBook {
    const ws = XLSX.utils.aoa_to_sheet([
        ["Ugovorna strana", "Datum", "Iznos (EUR)"],
        [
            "Alfa d.o.o.",
            // Croatian date format with unescaped dots — SheetJS's formatter
            // rejects it, Excel shows "14.05.2023.".
            { t: "n", v: 45060, z: "dd.mm.yyyy." },
            { t: "n", v: 1250000, z: "#,##0.00" },
        ],
        ["Beta d.d.", null, { t: "n", v: 300, z: "#,##0.00" }],
    ]);
    ws["A5"] = { t: "s", v: "Ukupno" };
    // A formula with its cached result: only the result may show.
    ws["C5"] = { t: "n", v: 1250300, f: "SUM(C2:C4)", z: "#,##0.00" };
    ws["!ref"] = "A1:C5";
    ws["!merges"] = [XLSX.utils.decode_range("A5:B5")];
    ws["!rows"] = [];
    ws["!rows"][2] = { hidden: true };
    ws["!cols"] = [{}, { hidden: true }];
    ws["C2"].c = [{ a: "BP", t: "Provjeriti s\nklijentom" }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Ugovori");
    XLSX.utils.book_append_sheet(
        wb,
        XLSX.utils.aoa_to_sheet([["Tajna napomena"]]),
        "Interno",
    );
    wb.Workbook = {
        Sheets: [
            { name: "Ugovori", Hidden: 0 },
            { name: "Interno", Hidden: 1 },
        ],
    };
    return wb;
}

function xlsxBytes(wb: XLSX.WorkBook = contractsWorkbook()): Buffer {
    return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

function xlsBytes(wb: XLSX.WorkBook = contractsWorkbook()): Buffer {
    return XLSX.write(wb, { type: "buffer", bookType: "biff8" }) as Buffer;
}

/** An OLE file with the given top-level streams (and optional nested ones). */
function oleBytes(streams: string[]): Buffer {
    const cfb = XLSX.CFB.utils.cfb_new();
    for (const path of streams)
        XLSX.CFB.utils.cfb_add(cfb, path, Buffer.from("x".repeat(600)));
    return Buffer.from(XLSX.CFB.write(cfb, { type: "buffer" }) as Uint8Array);
}

async function docxBytes(): Promise<Buffer> {
    const { Document, Packer, Paragraph } = await import("docx");
    return Packer.toBuffer(
        new Document({ sections: [{ children: [new Paragraph("Ugovor o najmu")] }] }),
    );
}

/** A tall one-sheet workbook for the parts tests. */
function tallSheetText(rows: number): string {
    const lines = ["## Sheet: Popis", "", "| Row | A | B |", "| --- | --- | --- |"];
    for (let r = 1; r <= rows; r++) lines.push(`| ${r} | Stavka ${r} | ${r * 10} |`);
    return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Sniffing
// ---------------------------------------------------------------------------

describe("sniffDocument / resolveDocumentKind", () => {
    it("tells an xlsx zip from a docx zip, and xls from doc among OLE files", async () => {
        assert.equal(sniffDocument(xlsxBytes()), "xlsx");
        assert.equal(sniffDocument(await docxBytes()), "docx");
        assert.equal(sniffDocument(xlsBytes()), "xls");
        assert.equal(sniffDocument(oleBytes(["WordDocument"])), "doc");
    });

    it("does not read a .doc with an embedded workbook as a spreadsheet", () => {
        const doc = oleBytes(["WordDocument", "ObjectPool/_1/Workbook"]);
        assert.equal(sniffDocument(doc), "doc");
        assert.equal(resolveDocumentKind("doc", doc), "doc");
    });

    it("keeps the historical reading of unknown zip / OLE under Word names", () => {
        assert.equal(resolveDocumentKind("docx", oleBytes(["Other"])), "doc");
        assert.equal(sniffDocument(oleBytes(["EncryptedPackage"])), "ole");
        // An encrypted xlsx is an OLE file: SheetJS says why it cannot read it.
        assert.equal(resolveDocumentKind("xlsx", oleBytes(["EncryptedPackage"])), "xls");
    });

    it("follows the bytes when a workbook and a Word file swap extensions", async () => {
        assert.equal(resolveDocumentKind("docx", xlsxBytes()), "xlsx");
        assert.equal(resolveDocumentKind("xlsx", await docxBytes()), "docx");
        assert.equal(resolveDocumentKind("xls", xlsxBytes()), "xlsx");
        assert.equal(resolveDocumentKind("xlsm", xlsxBytes()), "xlsx");
        assert.equal(resolveDocumentKind("csv", Buffer.from("a;b\n1;2")), "csv");
    });

    it("extracts a mislabelled workbook as spreadsheet text", async () => {
        const text = await extractDocumentText({ fileType: "docx", bytes: xlsxBytes(), flavor: "plain" });
        assert.match(text, /^## Sheet: Ugovori/);
    });
});

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

describe("spreadsheet text", () => {
    it("renders the spec's format: sheet heading, markers, Row column, letters", async () => {
        const text = await extractDocumentText({ fileType: "xlsx", bytes: xlsxBytes(), flavor: "plain" });
        assert.equal(
            text,
            [
                "## Sheet: Ugovori",
                'Hidden rows: 3 · Hidden columns: B · Comments: C2 "Provjeriti s klijentom"',
                "",
                "| Row | A | B | C |",
                "| --- | --- | --- | --- |",
                "| 1 | Ugovorna strana | Datum | Iznos (EUR) |",
                "| 2 | Alfa d.o.o. | 14.05.2023. | 1,250,000.00 |",
                "| 3 | Beta d.d. |  | 300.00 |",
                "| 5 | Ukupno ⟨merged A5:B5⟩ |  | 1,250,300.00 |",
                "",
                "## Sheet: Interno (hidden)",
                "",
                "| Row | A |",
                "| --- | --- |",
                "| 1 | Tajna napomena |",
            ].join("\n"),
        );
    });

    it("is the same text in the markdown (tabular) flavour", async () => {
        const plain = await extractDocumentText({ fileType: "xlsx", bytes: xlsxBytes(), flavor: "plain" });
        const md = await extractDocumentText({ fileType: "xlsx", bytes: xlsxBytes(), flavor: "markdown" });
        assert.equal(md, plain);
    });

    it("reads legacy .xls the same way", async () => {
        const text = await extractDocumentText({ fileType: "xls", bytes: xlsBytes(), flavor: "plain" });
        assert.match(text, /\| 2 \| Alfa d\.o\.o\. \| 14\.05\.2023\. \| 1,250,000\.00 \|/);
        assert.match(text, /## Sheet: Interno \(hidden\)/);
    });

    it("shows a formula's cached value and never the formula", async () => {
        const text = await extractDocumentText({ fileType: "xlsx", bytes: xlsxBytes(), flavor: "plain" });
        assert.match(text, /1,250,300\.00/);
        assert.doesNotMatch(text, /SUM\(/);
    });

    it("escapes pipes and flattens line breaks inside a cell", async () => {
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["a|b", "red 1\nred 2"]]), "S");
        const text = await extractDocumentText({ fileType: "xlsx", bytes: xlsxBytes(wb), flavor: "plain" });
        assert.match(text, /\| 1 \| a\\\|b \| red 1 red 2 \|/);
    });

    it("trims empty columns but keeps the real letters", async () => {
        const ws = XLSX.utils.aoa_to_sheet([["x"]]);
        ws["D1"] = { t: "s", v: "y" };
        ws["!ref"] = "A1:D1";
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, "S");
        const text = await extractDocumentText({ fileType: "xlsx", bytes: xlsxBytes(wb), flavor: "plain" });
        assert.match(text, /\| Row \| A \| D \|\n\| --- \| --- \| --- \|\n\| 1 \| x \| y \|/);
    });

    it("lists the sheet names as the structure tree", async () => {
        assert.deepEqual(await spreadsheetSheetNamesFor("xlsx", xlsxBytes()), ["Ugovori", "Interno"]);
        assert.deepEqual(await spreadsheetSheetNamesFor("csv", Buffer.from("a,b")), ["Sheet1"]);
        assert.equal(await spreadsheetSheetNamesFor("docx", await docxBytes()), null);
    });
});

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

describe("CSV", () => {
    it("sniffs ';' even when the amounts use a decimal comma", () => {
        assert.equal(sniffCsvDelimiter("Naziv;Iznos\nAlfa;1.250,00\nBeta;300,00\n"), ";");
        assert.equal(sniffCsvDelimiter("name,amount\nAlfa,1250\nBeta,300\n"), ",");
        assert.equal(sniffCsvDelimiter("a\tb\n1\t2\n"), "\t");
        assert.equal(sniffCsvDelimiter("sep=;\na,b;c\n"), ";");
    });

    it("parses quotes, escaped quotes and quoted delimiters/newlines as text", () => {
        assert.deepEqual(parseCsv('a,"b,c","say ""hi""\nthere",=1+1\r\n2,,3\n'), [
            ["a", "b,c", 'say "hi"\nthere', "=1+1"],
            ["2", "", "3"],
        ]);
    });

    it("decodes a Windows-1250 CSV and renders it as a sheet", async () => {
        // "Naziv;Iznos\nTvrtka čćđšž;1.250,00\n" in Windows-1250
        const bytes = Buffer.concat([
            Buffer.from("Naziv;Iznos\nTvrtka ", "latin1"),
            Buffer.from([0xe8, 0xe6, 0xf0, 0x9a, 0x9e]),
            Buffer.from(";1.250,00\n", "latin1"),
        ]);
        const text = await extractDocumentText({ fileType: "csv", bytes, flavor: "plain" });
        assert.equal(
            text,
            [
                "## Sheet: Sheet1",
                "",
                "| Row | A | B |",
                "| --- | --- | --- |",
                "| 1 | Naziv | Iznos |",
                "| 2 | Tvrtka čćđšž | 1.250,00 |",
            ].join("\n"),
        );
    });

    it("converts to an xlsx the viewer can load, with the same sheet name", async () => {
        const out = await spreadsheetViewXlsx("csv", Buffer.from("a;b\n1;2\n"));
        assert.equal(out.converted, true);
        assert.equal(sniffDocument(out.bytes), "xlsx");
        const wb = XLSX.read(out.bytes, { type: "buffer" });
        assert.deepEqual(wb.SheetNames, ["Sheet1"]);
        assert.equal(wb.Sheets.Sheet1["B2"].v, "2");
    });
});

// ---------------------------------------------------------------------------
// Viewer copy
// ---------------------------------------------------------------------------

describe("spreadsheetViewXlsx", () => {
    it("serves an xlsx package as stored", async () => {
        const bytes = xlsxBytes();
        const out = await spreadsheetViewXlsx("xlsm", bytes);
        assert.equal(out.converted, false);
        assert.equal(out.bytes, bytes);
    });

    it("refuses to hand a zip bomb to the browser", async () => {
        // A valid workbook plus one entry that inflates past the limit.
        const zip = await JSZip.loadAsync(xlsxBytes());
        zip.file("xl/media/bomb.bin", Buffer.alloc(SPREADSHEET_MAX_UNCOMPRESSED_BYTES + 1024));
        const bomb = await zip.generateAsync({
            type: "nodebuffer",
            compression: "DEFLATE",
            compressionOptions: { level: 9 },
        });
        await assert.rejects(spreadsheetViewXlsx("xlsx", bomb), SpreadsheetLimitError);
    });

    it("converts a workbook with an empty sheet", async () => {
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([]), "Prazno");
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([[1]]), "Puno");
        const out = await spreadsheetViewXlsx("xls", xlsBytes(wb));
        assert.deepEqual(XLSX.read(out.bytes, { type: "buffer" }).SheetNames, ["Prazno", "Puno"]);
        const text = await extractDocumentText({ fileType: "xls", bytes: xlsBytes(wb), flavor: "plain" });
        assert.match(text, /^## Sheet: Prazno\n\n\(no cell data\)\n\n## Sheet: Puno/);
    });

    it("converts legacy .xls to xlsx with cached values", async () => {
        const out = await spreadsheetViewXlsx("xls", xlsBytes());
        assert.equal(out.converted, true);
        const wb = XLSX.read(out.bytes, { type: "buffer", cellFormula: true });
        assert.deepEqual(wb.SheetNames, ["Ugovori", "Interno"]);
        assert.equal(wb.Sheets.Ugovori["C5"].v, 1250300);
        assert.equal(wb.Sheets.Ugovori["C5"].f, undefined);
    });
});

// ---------------------------------------------------------------------------
// Parts
// ---------------------------------------------------------------------------

describe("row-aware parts", () => {
    it("breaks between rows and repeats the sheet heading and letters in every part", () => {
        const text = tallSheetText(200);
        const budget = 1000;
        const parts = splitTextIntoParts(text, budget);
        assert.ok(parts.length > 3);
        const seenRows: number[] = [];
        for (const part of parts) {
            assert.ok(part.length <= budget, `part of ${part.length} > ${budget}`);
            assert.ok(part.startsWith("## Sheet: Popis\n\n| Row | A | B |\n| --- | --- | --- |\n"));
            for (const line of part.split("\n").slice(4)) {
                const m = /^\| (\d+) \| Stavka \1 \| \d+ \|$/.exec(line);
                assert.ok(m, `not a whole row: ${line}`);
                seenRows.push(Number(m[1]));
            }
        }
        assert.deepEqual(seenRows, Array.from({ length: 200 }, (_, i) => i + 1));
    });

    it("keeps the metadata line in the first part only and packs small sheets together", () => {
        const first = tallSheetText(60).replace("## Sheet: Popis\n", "## Sheet: Popis\nHidden rows: 4\n");
        const text = `${first}\n\n## Sheet: Mali\n\n| Row | A |\n| --- | --- |\n| 1 | jedan |`;
        const parts = splitSpreadsheetTextIntoParts(text, 700);
        assert.match(parts[0], /^## Sheet: Popis\nHidden rows: 4\n\n\| Row \|/);
        for (const p of parts.slice(1)) assert.doesNotMatch(p, /Hidden rows/);
        const last = parts[parts.length - 1];
        assert.match(last, /## Sheet: Popis[\s\S]*\n\n## Sheet: Mali\n\n\| Row \| A \|/);
    });

    it("slices a single row larger than a part as a last resort, within the budget", () => {
        const header = "## Sheet: S\n\n| Row | A |\n| --- | --- |";
        const longRow = `| 1 | ${"x".repeat(900)} |`;
        const parts = splitSpreadsheetTextIntoParts(`${header}\n${longRow}\n| 2 | kratko |`, 300);
        for (const p of parts) {
            assert.ok(p.length <= 300);
            assert.ok(p.startsWith(header));
        }
        const bodies = parts.map((p) => p.slice(header.length).replace(/^\n/, ""));
        assert.equal(bodies.join("\n").replace(/\n(?!\| 2 )/g, ""), `${longRow}\n| 2 | kratko |`);
    });

    it("leaves non-spreadsheet text to the page/paragraph splitter", () => {
        const text = `[Page 1]\n${"a".repeat(60)}\n[Page 2]\n${"b".repeat(60)}`;
        assert.equal(splitTextIntoParts(text, 80).length, 2);
    });
});

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

describe("limits", () => {
    async function bigEntryZip(size: number): Promise<Buffer> {
        const zip = new JSZip();
        zip.file("xl/workbook.xml", "<workbook/>");
        zip.file("xl/worksheets/sheet1.xml", Buffer.alloc(size, 0x20));
        return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
    }

    /** Patch every declared uncompressed size to 1 byte — a lying zip bomb. */
    function lieAboutSizes(buf: Buffer): Buffer {
        const out = Buffer.from(buf);
        for (let i = 0; i + 4 <= out.length; i++) {
            const sig = out.readUInt32LE(i);
            if (sig === 0x04034b50) out.writeUInt32LE(1, i + 22);
            else if (sig === 0x02014b50) out.writeUInt32LE(1, i + 24);
        }
        return out;
    }

    it("passes a normal workbook", async () => {
        await assertZipWithinLimits(xlsxBytes());
    });

    it("rejects a zip whose content inflates past the limit", async () => {
        const zip = await bigEntryZip(3_000_000);
        await assert.rejects(assertZipWithinLimits(zip, 1_000_000), SpreadsheetLimitError);
    });

    it("rejects it even when the headers lie about the sizes", async () => {
        const liar = lieAboutSizes(await bigEntryZip(3_000_000));
        await assert.rejects(assertZipWithinLimits(liar, 1_000_000), SpreadsheetLimitError);
    });

    it("counts overlapping entries (every entry pointing at the same data)", async () => {
        // Hand-built: one 400 kB deflate stream referenced by 5 entries.
        const data = zlib.deflateRawSync(Buffer.alloc(400_000, 0x41));
        const name = Buffer.from("xl/a.xml");
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(8, 8);
        local.writeUInt32LE(data.length, 18);
        local.writeUInt32LE(1, 22);
        local.writeUInt16LE(name.length, 26);
        const head = Buffer.concat([local, name, data]);
        const cds: Buffer[] = [];
        for (let n = 0; n < 5; n++) {
            const cd = Buffer.alloc(46);
            cd.writeUInt32LE(0x02014b50, 0);
            cd.writeUInt16LE(8, 10);
            cd.writeUInt32LE(data.length, 20);
            cd.writeUInt32LE(1, 24);
            cd.writeUInt16LE(name.length, 28);
            cd.writeUInt32LE(0, 42);
            cds.push(cd, name);
        }
        const cd = Buffer.concat(cds);
        const eocd = Buffer.alloc(22);
        eocd.writeUInt32LE(0x06054b50, 0);
        eocd.writeUInt16LE(5, 8);
        eocd.writeUInt16LE(5, 10);
        eocd.writeUInt32LE(cd.length, 12);
        eocd.writeUInt32LE(head.length, 16);
        const zip = Buffer.concat([head, cd, eocd]);
        await assertZipWithinLimits(zip, 2_100_000);
        await assert.rejects(assertZipWithinLimits(zip, 1_900_000), SpreadsheetLimitError);
    });

    it("refuses a workbook above the cell cap with a clear error", async () => {
        await assert.rejects(
            spreadsheetToText(
                { kind: "workbook", bytes: xlsxBytes() },
                { maxUncompressedBytes: 200 * 1024 * 1024, maxCells: 5 },
            ),
            (err: unknown) =>
                err instanceof SpreadsheetLimitError &&
                /Spreadsheet too large: \d+ cells, the limit is 5/.test(err.message),
        );
        await assert.rejects(
            spreadsheetToText({ kind: "csv", text: "a,b,c\n1,2,3\n" }, { maxUncompressedBytes: 1, maxCells: 4 }),
            SpreadsheetLimitError,
        );
    });
});

// ---------------------------------------------------------------------------
// Cell references and lookup
// ---------------------------------------------------------------------------

describe("cell references", () => {
    it("normalises A1 addresses and ranges", () => {
        assert.equal(normalizeCellRef(" c2 "), "C2");
        assert.equal(normalizeCellRef("$C$2"), "C2");
        assert.equal(normalizeCellRef("a214:b214"), "A214:B214");
        assert.equal(normalizeCellRef("C2:C2"), "C2");
        assert.equal(normalizeCellRef("Row 2"), null);
        assert.equal(normalizeCellRef("C0"), null);
        assert.equal(normalizeCellRef(3), null);
    });

    it("splits a Sheet!Cell locator", () => {
        assert.deepEqual(parseCellLocator(undefined, "Ugovori!C2"), { sheet: "Ugovori", cell: "C2" });
        assert.deepEqual(parseCellLocator(undefined, "'Moj list'!b7:c9"), { sheet: "Moj list", cell: "B7:C9" });
        assert.deepEqual(parseCellLocator("Ugovori", "C2"), { sheet: "Ugovori", cell: "C2" });
        assert.equal(parseCellLocator("Ugovori", "nije ćelija"), null);
        assert.equal(parseCellLocator(undefined, "C2"), null);
    });

    it("finds a cell's text, a range, a merged range and a covered cell", async () => {
        const text = await extractDocumentText({ fileType: "xlsx", bytes: xlsxBytes(), flavor: "plain" });
        const index = indexSpreadsheetText(text);
        assert.equal(spreadsheetCellText(index, "Ugovori", "C2"), "1,250,000.00");
        assert.equal(spreadsheetCellText(index, "Ugovori", "A2:C2"), "Alfa d.o.o. 14.05.2023. 1,250,000.00");
        assert.equal(spreadsheetCellText(index, "Ugovori", "A5:B5"), "Ukupno");
        assert.equal(spreadsheetCellText(index, "Ugovori", "B5"), "Ukupno");
        assert.equal(spreadsheetCellText(index, "Interno", "A1"), "Tajna napomena");
        assert.equal(spreadsheetCellText(index, "Interno (hidden)", "A1"), "Tajna napomena");
        assert.equal(spreadsheetCellText(index, "Nema", "A1"), null);
        assert.equal(spreadsheetCellText(index, "Ugovori", "Z99"), null);
    });

    it("reads cells across parts (the heading repeats per part)", () => {
        const parts = splitTextIntoParts(tallSheetText(100), 600);
        const index = indexSpreadsheetText(parts.join("\n\n"));
        assert.equal(spreadsheetCellText(index, "Popis", "A99"), "Stavka 99");
        assert.equal(spreadsheetCellText(index, "Popis", "B1"), "10");
    });
});
