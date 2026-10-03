import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as XLSX from "xlsx";
import { SpreadsheetLimitError, spreadsheetToText } from "./spreadsheet.js";
import {
    spreadsheetSheetNamesOffThread,
    spreadsheetTextOffThread,
    spreadsheetXlsxOffThread,
} from "./spreadsheetThread.js";

/** A two-sheet workbook, written by SheetJS in the requested format. */
function workbookBytes(bookType: XLSX.BookType): Buffer {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
        wb,
        XLSX.utils.aoa_to_sheet([
            ["Ugovorna strana", "Iznos"],
            ["Alfa d.o.o.", 1250000],
        ]),
        "Ugovori",
    );
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["x"]]), "Drugi");
    return XLSX.write(wb, { type: "buffer", bookType }) as Buffer;
}

describe("spreadsheet reads in a worker thread", () => {
    it("returns the same text as the inline reader", async () => {
        const input = { kind: "workbook" as const, bytes: workbookBytes("xlsx") };
        assert.equal(
            await spreadsheetTextOffThread(input),
            await spreadsheetToText(input),
        );
    });

    it("leaves the caller's bytes intact (copied, never transferred)", async () => {
        const bytes = workbookBytes("xlsx");
        const before = Buffer.from(bytes);
        await spreadsheetTextOffThread({ kind: "workbook", bytes });
        assert.ok(bytes.equals(before));
    });

    it("lists sheet names and converts a legacy .xls to .xlsx", async () => {
        const xls = { kind: "workbook" as const, bytes: workbookBytes("biff8") };
        assert.deepEqual(await spreadsheetSheetNamesOffThread(xls), [
            "Ugovori",
            "Drugi",
        ]);
        const out = await spreadsheetXlsxOffThread(xls);
        assert.equal(out.subarray(0, 2).toString("latin1"), "PK");
        assert.deepEqual(XLSX.read(out).SheetNames, ["Ugovori", "Drugi"]);
    });

    it("reads CSV text in the worker too", async () => {
        const text = await spreadsheetTextOffThread({
            kind: "csv",
            text: "Strana;Iznos\nAlfa d.o.o.;1.250.000,00\n",
        });
        assert.match(text, /^## Sheet: Sheet1/);
        assert.match(text, /\| 2 \| Alfa d\.o\.o\. \| 1\.250\.000,00 \|/);
    });

    it("keeps SpreadsheetLimitError across the thread boundary", async () => {
        await assert.rejects(
            spreadsheetTextOffThread(
                { kind: "workbook", bytes: workbookBytes("xlsx") },
                { maxUncompressedBytes: 200 * 1024 * 1024, maxCells: 1 },
            ),
            SpreadsheetLimitError,
        );
    });

    it("terminates a read that runs past its timeout", async () => {
        const csv = Array.from({ length: 20_000 }, (_, i) => `r${i};a;b;c`).join("\n");
        await assert.rejects(
            spreadsheetTextOffThread({ kind: "csv", text: csv }, undefined, {
                timeoutMs: 1,
            }),
            (err: unknown) =>
                err instanceof SpreadsheetLimitError &&
                /took too long/.test(err.message),
        );
    });

    it("reports a corrupt workbook as an error and keeps serving", async () => {
        // A zip local header with no central directory behind it.
        const corrupt = Buffer.concat([
            Buffer.from([0x50, 0x4b, 0x03, 0x04]),
            Buffer.alloc(64),
        ]);
        await assert.rejects(
            spreadsheetTextOffThread({ kind: "workbook", bytes: corrupt }),
            /Corrupt zip/,
        );
        // The queue is not wedged by the failure.
        assert.match(
            await spreadsheetTextOffThread({
                kind: "workbook",
                bytes: workbookBytes("xlsx"),
            }),
            /^## Sheet: Ugovori/,
        );
    });

    it("runs jobs one at a time, in arrival order", async () => {
        const input = { kind: "workbook" as const, bytes: workbookBytes("xlsx") };
        const order: number[] = [];
        await Promise.all(
            [1, 2, 3].map((n) =>
                spreadsheetTextOffThread(input).then(() => order.push(n)),
            ),
        );
        assert.deepEqual(order, [1, 2, 3]);
    });
});
