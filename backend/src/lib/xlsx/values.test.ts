import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    MAX_CELL_CHARS,
    cellText,
    columnConvention,
    columnDayFirst,
    numberConvention,
    parseDate,
    parseNumber,
} from "./values.js";

const num = (
    raw: unknown,
    type: "number" | "currency" | "percent" = "number",
    conv: "dot" | "comma" | null = null,
) => parseNumber(raw, type, conv)?.value ?? null;

/** Excel serial for a calendar date (1900 date system). */
const serial = (y: number, m: number, d: number) =>
    (Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86_400_000;

describe("parseNumber — hr and en conventions", () => {
    it("reads canonical, English and Croatian numbers", () => {
        assert.equal(num("1234.56"), 1234.56);
        assert.equal(num("1,234.56"), 1234.56);
        assert.equal(num("1.234,56"), 1234.56);
        assert.equal(num("1.234.567"), 1234567);
        assert.equal(num("1,234,567"), 1234567);
        assert.equal(num("1 234 567,89"), 1234567.89);
        assert.equal(num("1 234,5"), 1234.5);
        assert.equal(num("1'234.50"), 1234.5);
        assert.equal(num("12,5"), 12.5);
        assert.equal(num("0,75"), 0.75);
        assert.equal(num(",5"), 0.5);
        assert.equal(num("42"), 42);
        assert.equal(num(42.5), 42.5);
    });

    it("reads signs, the Unicode minus and accounting parentheses", () => {
        assert.equal(num("-1.234,56"), -1234.56);
        assert.equal(num("−5"), -5);
        assert.equal(num("+7"), 7);
        assert.equal(num("(1.234,56)"), -1234.56);
        assert.equal(num("-0"), 0);
    });

    it("rejects what is not a number", () => {
        for (const raw of ["", "abc", "1.2.3", "12,34,5", "1 23", "n/a", "—", "1.", "0.123.456", "5 m²"]) {
            assert.equal(num(raw), null, raw);
        }
        assert.equal(num(Number.NaN), null);
        // A leading zero marks an identifier (OIB, account number).
        assert.equal(num("0123"), null);
        assert.equal(num("00,5"), null);
        assert.equal(num("0"), 0);
        assert.equal(num("0,5"), 0.5);
        // 16 significant digits would lose precision in Excel.
        assert.equal(num("1234567890123456"), null);
    });

    it("settles '1.234' from the column, else by type", () => {
        assert.equal(num("1.234", "number", "dot"), 1.234);
        assert.equal(num("1.234", "number", "comma"), 1234);
        assert.equal(num("1,234", "number", "comma"), 1.234);
        // No evidence: amounts and counts group thousands …
        assert.equal(num("1.500", "number"), 1500);
        assert.equal(num("1,500", "currency"), 1500);
        // … percentages have decimals.
        assert.equal(num("3,125", "percent"), 0.03125);
        assert.equal(num("3.125", "percent"), 0.03125);
    });

    it("reads EUR amounts and refuses other currencies", () => {
        assert.equal(num("1.234,56 €", "currency"), 1234.56);
        assert.equal(num("€1,234.56", "currency"), 1234.56);
        assert.equal(num("1234.56 EUR", "currency"), 1234.56);
        assert.equal(num("-€ 5", "currency"), null);
        assert.equal(num("€ -5", "currency"), -5);
        assert.equal(num("1.000 USD", "currency"), null);
        assert.equal(num("$100", "currency"), null);
        assert.equal(num("100 kn", "currency"), null);
        // A euro sign does not belong in a plain number column.
        assert.equal(num("100 €", "number"), null);
    });

    it("reads percentages as percentage points", () => {
        assert.equal(num("12.5", "percent"), 0.125);
        assert.equal(num("12,5 %", "percent"), 0.125);
        assert.equal(num("15%", "percent"), 0.15);
        assert.equal(num("0.5", "percent"), 0.005);
        assert.equal(num(15, "percent"), 0.15);
        assert.equal(num("15%", "number"), null);
    });
});

describe("number conventions", () => {
    it("detects the convention a value proves on its own", () => {
        assert.equal(numberConvention("1,234.56"), "dot");
        assert.equal(numberConvention("12.5"), "dot");
        assert.equal(numberConvention("1.234,56 €"), "comma");
        assert.equal(numberConvention("1.234.567"), "comma");
        assert.equal(numberConvention("1.234"), null);
        assert.equal(numberConvention("1234"), null);
    });

    it("takes the column's agreed convention, null when values disagree", () => {
        assert.equal(columnConvention(["1.234", "2.500,00", ""]), "comma");
        assert.equal(columnConvention(["1.234", "99.5"]), "dot");
        assert.equal(columnConvention(["1.234", "2,000"]), null);
        assert.equal(columnConvention(["1,5", "2.5"]), null);
    });
});

describe("parseDate", () => {
    it("reads ISO, Croatian and English dates", () => {
        const june15 = serial(2020, 6, 15);
        for (const raw of [
            "2020-06-15",
            "15. 6. 2020.",
            "15.06.2020.",
            "15.06.2020",
            "15/06/2020",
            "15. lipnja 2020.",
            "15. lipanj 2020.",
            "15 June 2020",
            "June 15, 2020",
            "15 Jun 2020",
        ]) {
            assert.deepEqual(parseDate(raw), { serial: june15, hasTime: false }, raw);
        }
        assert.equal(serial(2020, 6, 15), 43997);
        assert.equal(parseDate("1. studenoga 2021.")?.serial, serial(2021, 11, 1));
        assert.equal(parseDate("31. prosinca 2024.")?.serial, serial(2024, 12, 31));
    });

    it("keeps the time of day", () => {
        const d = parseDate("31.12.2024. 14:30");
        assert.equal(d?.hasTime, true);
        assert.equal(d?.serial, serial(2024, 12, 31) + (14 * 60 + 30) / 1440);
        assert.equal(parseDate("2024-12-31T14:30:00Z")?.serial, d?.serial);
        assert.equal(parseDate("31. 12. 2024. u 14:30")?.serial, d?.serial);
    });

    it("rejects impossible and out-of-range dates", () => {
        for (const raw of ["31.02.2021.", "2021-13-01", "15.6.20", "1899-12-31", "1900-02-28", "tomorrow", "15. smarch 2020.", "32/01/2020"]) {
            assert.equal(parseDate(raw), null, raw);
        }
        assert.equal(parseDate(43997), null);
    });

    it("reads slash dates day-first unless the column shows otherwise", () => {
        assert.equal(parseDate("03/04/2020")?.serial, serial(2020, 4, 3));
        assert.equal(parseDate("03/04/2020", false)?.serial, serial(2020, 3, 4));
        assert.equal(parseDate("12/31/2020")?.serial, serial(2020, 12, 31));
        assert.equal(columnDayFirst(["03/04/2020", "12/31/2020"]), false);
        assert.equal(columnDayFirst(["03/04/2020", "31/12/2020"]), true);
        assert.equal(columnDayFirst(["03/04/2020"]), null);
        assert.equal(columnDayFirst(["31/12/2020", "12/31/2020"]), null);
    });
});

describe("cellText", () => {
    it("drops characters XML cannot carry and normalises line breaks", () => {
        assert.deepEqual(cellText("a\u0000b\u0007c\r\nd\re"), {
            text: "abc\nd\ne",
            truncated: false,
        });
        assert.equal(cellText("x\uD800y")?.text, "xy");
        assert.equal(cellText("😀")?.text, "😀");
        assert.equal(cellText(null), null);
        assert.equal(cellText(""), null);
        assert.equal(cellText(12)?.text, "12");
    });

    it("cuts to Excel's cell limit without splitting a surrogate pair", () => {
        const long = "a".repeat(MAX_CELL_CHARS - 1) + "😀";
        const t = cellText(long)!;
        assert.equal(t.truncated, true);
        assert.equal(t.text.length, MAX_CELL_CHARS - 1);
    });
});
