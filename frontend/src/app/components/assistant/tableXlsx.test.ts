import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import {
    inferColumns,
    parseDateLike,
    parseNumberLike,
    safeSheetName,
    tableNodeToRows,
    tableToXlsx,
    type HastNode,
} from "./tableXlsx";

const text = (value: string): HastNode => ({ type: "text", value });
const el = (tagName: string, ...children: HastNode[]): HastNode => ({
    type: "element",
    tagName,
    children,
});
const row = (cell: "th" | "td", ...cells: (string | HastNode[])[]) =>
    el(
        "tr",
        ...cells.map((c) =>
            el(cell, ...(typeof c === "string" ? [text(c)] : c)),
        ),
    );

/** The hast react-markdown hands the `table` component. */
const TABLE = el(
    "table",
    el("thead", row("th", "Ugovorna strana", "Iznos", "Datum", "Kamata", "Napomena")),
    el(
        "tbody",
        row(
            "td",
            [text("Alfa "), el("strong", text("d.o.o."))],
            "1.234,56 €",
            "15. 6. 2020.",
            "3,5 %",
            [text("vidi "), el("code", text("§0§")), text(" čl. 5.")],
        ),
        row("td", "Beta d.d.", "2.000", "2021-03-31", "12 %", "=SUM(A1:A9)"),
        row("td", "Gama", "", "", "", [text("prvi"), el("br"), text("drugi")]),
    ),
);

describe("tableNodeToRows", () => {
    it("reads header and body text, dropping citation pills", () => {
        expect(tableNodeToRows(TABLE)).toEqual([
            ["Ugovorna strana", "Iznos", "Datum", "Kamata", "Napomena"],
            ["Alfa d.o.o.", "1.234,56 €", "15. 6. 2020.", "3,5 %", "vidi čl. 5."],
            ["Beta d.d.", "2.000", "2021-03-31", "12 %", "=SUM(A1:A9)"],
            ["Gama", "", "", "", "prvi\ndrugi"],
        ]);
    });
});

describe("parsing", () => {
    it("reads hr and en numbers, EUR amounts and percentages", () => {
        expect(parseNumberLike("1.234,56")?.value).toBe(1234.56);
        expect(parseNumberLike("1,234.56")?.value).toBe(1234.56);
        expect(parseNumberLike("1 234,5")?.value).toBe(1234.5);
        expect(parseNumberLike("-7")?.value).toBe(-7);
        expect(parseNumberLike("1.234,56 €")).toMatchObject({ value: 1234.56, kind: "currency" });
        expect(parseNumberLike("12,5 %")).toMatchObject({ value: 0.125, kind: "percent" });
        for (const raw of ["abc", "1.2.3", "100 USD", "0123", "12345678901234", "5 m²"]) {
            expect(parseNumberLike(raw), raw).toBeNull();
        }
    });

    it("reads ISO and Croatian dates only", () => {
        const june15 = new Date(Date.UTC(2020, 5, 15));
        expect(parseDateLike("2020-06-15")).toEqual(june15);
        expect(parseDateLike("15. 6. 2020.")).toEqual(june15);
        expect(parseDateLike("15.06.2020")).toEqual(june15);
        expect(parseDateLike("31.02.2021.")).toBeNull();
        expect(parseDateLike("June 15, 2020")).toBeNull();
    });

    it("types a column only when every value agrees", () => {
        const cols = inferColumns(
            [
                ["1.234", "1.500,00", "x", "2020", "15%"],
                ["2.500", "", "1", "2021", "3"],
            ],
            5,
        );
        expect(cols.map((c) => c.kind)).toEqual(["number", "number", "text", "number", "text"]);
        // "1.500,00" proves the comma convention for its column only.
        expect(cols[0].values).toEqual([1234, 2500]);
        expect(cols[1].values).toEqual([1500, null]);
    });

    it("settles '1.234' from the column's other values", () => {
        expect(inferColumns([["1.234"], ["0.5"]], 1)[0].values).toEqual([1.234, 0.5]);
        expect(inferColumns([["1.234"], ["2,5"]], 1)[0].values).toEqual([1234, 2.5]);
    });

    it("sanitises the sheet name", () => {
        expect(safeSheetName("Q1: [draft]/v2?")).toBe("Q1 draft v2");
        expect(safeSheetName("")).toBe("Sheet1");
        expect(safeSheetName("x".repeat(40))).toHaveLength(31);
    });
});

describe("tableToXlsx", () => {
    it("writes typed cells, a frozen filterable header and no formulas", async () => {
        const buf = await tableToXlsx(tableNodeToRows(TABLE), "Tablica");
        const wb = new ExcelJS.Workbook();
        await wb.xlsx.load(buf);
        const ws = wb.getWorksheet("Tablica")!;

        expect(ws.getRow(1).values).toEqual([
            undefined,
            "Ugovorna strana",
            "Iznos",
            "Datum",
            "Kamata",
            "Napomena",
        ]);
        expect(ws.getCell("A1").font?.bold).toBe(true);
        expect(ws.views[0]).toMatchObject({ state: "frozen", ySplit: 1 });
        expect(ws.autoFilter).toBeTruthy();

        expect(ws.getCell("B2").value).toBe(1234.56);
        // Written as #,##0.00\ "€"; exceljs drops the escape when reading.
        expect(ws.getCell("B2").numFmt).toMatch(/^#,##0\.00\\? "€"$/);
        expect(ws.getCell("B3").value).toBe(2000);
        expect(ws.getCell("C2").value).toEqual(new Date(Date.UTC(2020, 5, 15)));
        expect(ws.getCell("C2").numFmt).toMatch(/^dd\\?\.mm\\?\.yyyy\\?\.$/);
        expect(ws.getCell("D2").value).toBe(0.035);
        expect(ws.getCell("D2").numFmt).toBe("0.00%");
        expect(ws.getCell("A2").value).toBe("Alfa d.o.o.");
        expect(ws.getCell("E4").value).toBe("prvi\ndrugi");
        expect(ws.getCell("B4").value).toBeNull();

        // Formula-like text is stored as text.
        const f = ws.getCell("E3");
        expect(f.value).toBe("=SUM(A1:A9)");
        expect(f.type).toBe(ExcelJS.ValueType.String);
        expect(f.formula).toBeUndefined();
    });
});

describe("tableToXlsx — further sheets", () => {
    it("adds each extra sheet in the same style; a repeated name gets a number", async () => {
        const buf = await tableToXlsx([["A"], ["1"]], "Nalazi", [
            { sheetName: "Odluke i Checker", rows: [["ID", "Tema"], ["CHK-U1-Q1", "Uloga"]] },
            { sheetName: "nalazi", rows: [["x"]] },
        ]);
        const wb = new ExcelJS.Workbook();
        await wb.xlsx.load(buf);
        expect(wb.worksheets.map((w) => w.name)).toEqual(["Nalazi", "Odluke i Checker", "nalazi (2)"]);
        const ws = wb.getWorksheet("Odluke i Checker")!;
        expect(ws.getRow(1).font?.bold).toBe(true);
        expect(ws.getCell("A2").value).toBe("CHK-U1-Q1");
        expect(ws.autoFilter).toBeTruthy();
    });
});
