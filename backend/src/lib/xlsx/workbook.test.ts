import { describe, it } from "node:test";
import assert from "node:assert/strict";
import JSZip from "jszip";
import * as XLSX from "xlsx";
import {
    EXCEL_LIMITS,
    NUMBER_FORMATS,
    WorkbookSpecError,
    buildXlsxWorkbook,
    columnLetters,
    normalizeWorkbookSpec,
    sanitizeSheetName,
} from "./workbook.js";
import { extractDocumentText } from "../documentText.js";

const NOW = new Date("2026-10-01T08:00:00Z");

async function build(input: { title?: unknown; sheets?: unknown }) {
    const spec = normalizeWorkbookSpec(input);
    const out = await buildXlsxWorkbook(spec, { now: NOW });
    const zip = await JSZip.loadAsync(out.bytes);
    const wb = XLSX.read(out.bytes, { cellNF: true, cellFormula: true });
    return { ...out, zip, wb };
}

const CONTRACTS = {
    title: "Popis ugovora — Šibenik",
    sheets: [
        {
            name: "Ugovori",
            columns: [
                { header: "Ugovorna strana", type: "text" },
                { header: "Datum", type: "date" },
                { header: "Iznos", type: "currency" },
                { header: "Kamata", type: "percent" },
                { header: "Rate", type: "number" },
                { header: "Napomena", type: "text", width: 40 },
            ],
            rows: [
                ["Alfa d.o.o.", "15. 6. 2020.", "1.234,56 €", "3,5 %", "12", "=SUM(A1:A9)"],
                ["Beta j.d.o.o.", "2021-03-31", "2.000,00", "12", "24", "+385 1 234 5678"],
                ["Čvor d.d.", "nepoznato", "n/a", "", "", "-provjeriti"],
                ["Delta", "", "", "", "", "@mention"],
            ],
        },
    ],
};

describe("buildXlsxWorkbook", () => {
    it("writes typed cells SheetJS reads back with their formats", async () => {
        const { wb, report } = await build(CONTRACTS);
        assert.deepEqual(wb.SheetNames, ["Ugovori"]);
        const ws = wb.Sheets.Ugovori;
        assert.equal(ws["!ref"], "A1:F5");

        // Header row.
        assert.deepEqual(
            ["A1", "B1", "C1", "D1", "E1", "F1"].map((r) => ws[r].v),
            ["Ugovorna strana", "Datum", "Iznos", "Kamata", "Rate", "Napomena"],
        );

        // Typed values.
        assert.equal(ws.A2.t, "s");
        assert.equal(ws.A4.v, "Čvor d.d.");
        assert.deepEqual([ws.B2.t, ws.B2.v, ws.B2.z, ws.B2.w], ["n", 43997, NUMBER_FORMATS.date, "15.06.2020."]);
        assert.equal(ws.B3.v, 44286);
        assert.deepEqual([ws.C2.t, ws.C2.v, ws.C2.z], ["n", 1234.56, NUMBER_FORMATS.currency]);
        assert.equal(ws.C3.v, 2000);
        assert.deepEqual([ws.D2.t, ws.D2.v, ws.D2.z], ["n", 0.035, NUMBER_FORMATS.percentDecimal]);
        assert.equal(ws.D3.v, 0.12);
        assert.deepEqual([ws.E2.t, ws.E2.v, ws.E2.z], ["n", 12, NUMBER_FORMATS.integerPlain]);

        // Unreadable values stay text and are reported; empty cells stay empty.
        assert.deepEqual([ws.B4.t, ws.B4.v], ["s", "nepoznato"]);
        assert.deepEqual([ws.C4.t, ws.C4.v], ["s", "n/a"]);
        assert.equal(ws.B5, undefined);
        assert.equal(ws.E4, undefined);
        assert.equal(report.warnings.length, 2);
        assert.match(report.warnings[0], /column "Datum" \(date\): 1 value\(s\) could not be read as dates and were kept as text: B4\./);
        assert.match(report.warnings[1], /column "Iznos" \(currency\).*: C4\./);
        assert.deepEqual(report.sheets, [{ name: "Ugovori", columns: 6, rows: 4 }]);
    });

    it("never writes a formula — formula-like text stays text", async () => {
        const { wb, zip } = await build(CONTRACTS);
        const ws = wb.Sheets.Ugovori;
        for (const [ref, text] of [
            ["F2", "=SUM(A1:A9)"],
            ["F3", "+385 1 234 5678"],
            ["F4", "-provjeriti"],
            ["F5", "@mention"],
        ] as const) {
            assert.equal(ws[ref].t, "s", ref);
            assert.equal(ws[ref].v, text, ref);
            assert.equal(ws[ref].f, undefined, ref);
        }
        const sheetXml = await zip.file("xl/worksheets/sheet1.xml")!.async("string");
        assert.doesNotMatch(sheetXml, /<f[ >]/);
        // Formula-like text carries quotePrefix (style 3), plain text does not.
        assert.match(sheetXml, /<c r="F2" s="3" t="inlineStr">/);
        assert.match(sheetXml, /<c r="A2" s="2" t="inlineStr">/);
        const styles = await zip.file("xl/styles.xml")!.async("string");
        assert.match(styles, /quotePrefix="1"/);
    });

    it("freezes and filters the header row, sets widths and formats", async () => {
        const { zip, wb } = await build(CONTRACTS);
        const sheetXml = await zip.file("xl/worksheets/sheet1.xml")!.async("string");
        assert.match(sheetXml, /<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"\/>/);
        assert.match(sheetXml, /<autoFilter ref="A1:F5"\/>/);
        assert.match(sheetXml, /<col min="6" max="6" width="40.00" customWidth="1"\/>/);
        assert.deepEqual(wb.Sheets.Ugovori["!autofilter"], { ref: "A1:F5" });

        const workbookXml = await zip.file("xl/workbook.xml")!.async("string");
        assert.match(workbookXml, /<definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">'Ugovori'!\$A\$1:\$F\$5<\/definedName>/);

        const styles = await zip.file("xl/styles.xml")!.async("string");
        assert.match(styles, /<numFmt numFmtId="164" formatCode="dd\\\.mm\\\.yyyy\\\."\/>/);
        assert.match(styles, /<numFmt numFmtId="166" formatCode="#,##0\.00\\ &quot;€&quot;"\/>/);
        // Header: bold font, fill, wrap.
        assert.match(styles, /<font><b\/>/);
        assert.match(styles, /<xf numFmtId="0" fontId="1" fillId="2" borderId="1"[^>]*><alignment vertical="center" wrapText="1"\/><\/xf>/);
        // Header cells use the header style.
        assert.match(sheetXml, /<c r="A1" s="1" t="inlineStr">/);
    });

    it("picks integer vs decimal formats per column and keeps date-times", async () => {
        const { wb } = await build({
            title: "t",
            sheets: [
                {
                    name: "S",
                    columns: [
                        { header: "Int", type: "number" },
                        { header: "Dec", type: "number" },
                        { header: "Pct", type: "percent" },
                        { header: "When", type: "date" },
                        { header: "Year", type: "number" },
                    ],
                    rows: [
                        ["1", "1", "15", "31.12.2024. 14:30", "2020"],
                        ["12.000", "2,5", "20%", "1. 1. 2025.", "2026"],
                    ],
                },
            ],
        });
        const ws = wb.Sheets.S;
        assert.equal(ws.A2.z, NUMBER_FORMATS.integer);
        assert.equal(ws.A3.v, 12000);
        assert.equal(ws.A3.w, "12,000");
        // Years and small counts: no thousands separator.
        assert.equal(ws.E2.z, NUMBER_FORMATS.integerPlain);
        assert.equal(ws.E2.w, "2020");
        assert.equal(ws.B3.z, NUMBER_FORMATS.decimal);
        assert.equal(ws.B3.v, 2.5);
        assert.equal(ws.C2.z, NUMBER_FORMATS.percentInteger);
        assert.equal(ws.C3.v, 0.2);
        assert.equal(ws.D2.z, NUMBER_FORMATS.dateTime);
        assert.equal(ws.D2.w, "31.12.2024. 14:30");
        assert.equal(ws.D3.z, NUMBER_FORMATS.date);
    });

    it("is read by the read_document extractor with Excel's display values", async () => {
        const { bytes } = await build(CONTRACTS);
        const text = await extractDocumentText({ fileType: "xlsx", bytes, flavor: "plain" });
        assert.match(text, /^## Sheet: Ugovori/);
        assert.match(text, /\| 2 \| Alfa d\.o\.o\. \| 15\.06\.2020\. \| 1,234\.56 € \| 3\.50% \| 12 \| =SUM\(A1:A9\) \|/);
    });

    it("keeps diacritics, line breaks and XML-special characters intact", async () => {
        const { wb } = await build({
            title: "Č",
            sheets: [
                {
                    name: "Š & <Ž>",
                    columns: [{ header: "Tekst \"x\"", type: "text" }],
                    rows: [["Čćžšđ & <b>\nnovi red '1'"], ["  razmak  "]],
                },
            ],
        });
        assert.deepEqual(wb.SheetNames, ["Š & <Ž>"]);
        const ws = wb.Sheets["Š & <Ž>"];
        assert.equal(ws.A1.v, 'Tekst "x"');
        assert.equal(ws.A2.v, "Čćžšđ & <b>\nnovi red '1'");
        assert.equal(ws.A3.v, "  razmak  ");
    });

    it("writes a header-only sheet (a template to fill in)", async () => {
        const { wb } = await build({
            title: "t",
            sheets: [{ name: "Rokovi", columns: [{ header: "Rok", type: "date" }], rows: [] }],
        });
        assert.equal(wb.Sheets.Rokovi["!ref"], "A1");
        assert.equal(wb.Sheets.Rokovi.A1.v, "Rok");
    });
});

describe("normalizeWorkbookSpec", () => {
    it("sanitises sheet names and makes them unique", () => {
        const spec = normalizeWorkbookSpec({
            title: "t",
            sheets: [
                { name: "Q1: [draft]/v2?", columns: [{ header: "a", type: "text" }], rows: [] },
                { name: "q1 draft v2", columns: [{ header: "a", type: "text" }], rows: [] },
                { name: "A".repeat(40), columns: [{ header: "a", type: "text" }], rows: [] },
                { name: "A".repeat(40), columns: [{ header: "a", type: "text" }], rows: [] },
                { name: "", columns: [{ header: "a", type: "text" }], rows: [] },
                { name: "History", columns: [{ header: "a", type: "text" }], rows: [] },
            ],
        });
        assert.deepEqual(
            spec.sheets.map((s) => s.name),
            ["Q1 draft v2", "q1 draft v2 (2)", "A".repeat(31), `${"A".repeat(27)} (2)`, "Sheet5", "History (1)"],
        );
        assert.equal(spec.sheets[0].requestedName, "Q1: [draft]/v2?");
        assert.equal(spec.sheets[4].requestedName, null);
        for (const s of spec.sheets) assert.ok(s.name.length <= 31);
    });

    it("strips apostrophes at the ends of a sheet name", () => {
        assert.equal(sanitizeSheetName("'Ugovori'", "x"), "Ugovori");
        assert.equal(sanitizeSheetName("O'Brien", "x"), "O'Brien");
    });

    it("pads short rows and refuses long ones", () => {
        const spec = normalizeWorkbookSpec({
            sheets: [{ name: "S", columns: [{ header: "a", type: "text" }, { header: "b", type: "text" }], rows: [["x"]] }],
        });
        assert.deepEqual(spec.sheets[0].rows, [["x", null]]);
        assert.equal(spec.title, "workbook");
        assert.throws(
            () =>
                normalizeWorkbookSpec({
                    sheets: [{ name: "S", columns: [{ header: "a", type: "text" }], rows: [["x"], ["y", "z"]] }],
                }),
            (e: unknown) =>
                e instanceof WorkbookSpecError &&
                /Sheet "S", data row 2 has 2 values but the sheet has 1 columns/.test(e.message),
        );
    });

    it("rejects empty and malformed sheets with an actionable error", () => {
        const cases: unknown[] = [
            undefined,
            [],
            [{ name: "S", columns: [], rows: [] }],
            [{ name: "S", columns: [{ header: "a", type: "text" }], rows: "x" }],
            [{ name: "S", columns: [{ header: "a", type: "text" }], rows: ["x"] }],
            ["not a sheet"],
        ];
        for (const sheets of cases) {
            assert.throws(() => normalizeWorkbookSpec({ sheets }), WorkbookSpecError, JSON.stringify(sheets));
        }
    });

    it("writes an unknown column type as text and says so", () => {
        const spec = normalizeWorkbookSpec({
            sheets: [{ name: "S", columns: [{ header: "a", type: "money" }], rows: [] }],
        });
        assert.equal(spec.sheets[0].columns[0].type, "text");
        assert.match(spec.warnings[0], /unknown type "money"/);
    });

    it("enforces the size caps", () => {
        const col = { header: "a", type: "text" };
        assert.throws(
            () =>
                normalizeWorkbookSpec({
                    sheets: Array.from({ length: EXCEL_LIMITS.maxSheets + 1 }, (_, i) => ({ name: `S${i}`, columns: [col], rows: [] })),
                }),
            /the limit is 50/,
        );
        assert.throws(
            () =>
                normalizeWorkbookSpec({
                    sheets: [{ name: "S", columns: Array(EXCEL_LIMITS.maxColumns + 1).fill(col), rows: [] }],
                }),
            /201 columns; the limit is 200/,
        );
        assert.throws(
            () =>
                normalizeWorkbookSpec({
                    sheets: [{ name: "S", columns: [col], rows: Array(EXCEL_LIMITS.maxRowsPerSheet + 1).fill(["x"]) }],
                }),
            /10,001 rows; the limit is 10,000 per sheet/,
        );
        assert.throws(
            () =>
                normalizeWorkbookSpec({
                    sheets: Array.from({ length: 3 }, (_, i) => ({
                        name: `S${i}`,
                        columns: Array(100).fill(col),
                        rows: Array(700).fill(Array(100).fill("x")),
                    })),
                }),
            /too large: more than 200,000 cells/,
        );
    });
});

describe("columnLetters", () => {
    it("maps indices to Excel letters", () => {
        assert.deepEqual([0, 25, 26, 51, 701, 702].map(columnLetters), ["A", "Z", "AA", "AZ", "ZZ", "AAA"]);
    });
});
