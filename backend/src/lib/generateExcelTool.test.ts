import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { Storage } from "@google-cloud/storage";
import * as XLSX from "xlsx";
import {
    GENERATE_EXCEL_TOOL,
    TOOLS,
    runToolCalls,
    type DocIndex,
    type DocStore,
    type ToolCall,
} from "./chatTools.js";

// generate_excel through the real tool dispatcher: validation errors reach
// the model, a valid call stores an .xlsx document (GCS and the database
// are faked) and announces it like generate_docx does.

type Row = Record<string, unknown>;

/** The slice of the Supabase query builder generate_* uses. */
function fakeDb() {
    const inserted: { table: string; row: Row }[] = [];
    const updated: { table: string; row: Row }[] = [];
    let id = 0;
    const db = {
        from(table: string) {
            return {
                insert(row: Row) {
                    inserted.push({ table, row });
                    const newId = `${table}-${++id}`;
                    return {
                        select: () => ({
                            single: async () => ({ data: { id: newId }, error: null }),
                        }),
                    };
                },
                update(row: Row) {
                    updated.push({ table, row });
                    return { eq: async () => ({ error: null }) };
                },
            };
        },
    };
    return { db, inserted, updated };
}

function call(args: unknown): ToolCall {
    return {
        id: "tc-excel",
        function: { name: "generate_excel", arguments: JSON.stringify(args) },
    };
}

async function run(args: unknown) {
    const events: Record<string, unknown>[] = [];
    const write = (s: string) => {
        for (const line of s.split("\n"))
            if (line.startsWith("data: ")) events.push(JSON.parse(line.slice(6)));
    };
    const fake = fakeDb();
    const docStore: DocStore = new Map();
    const docIndex: DocIndex = {
        "doc-0": { document_id: "existing", filename: "Ugovor.pdf" },
    };
    const out = await runToolCalls(
        [call(args)],
        docStore,
        "user-1",
        fake.db as unknown as Parameters<typeof runToolCalls>[3],
        write,
        undefined,
        undefined,
        docIndex,
        undefined,
        "project-1",
    );
    const result = out.toolResults[0] as { content: string };
    return { out, events, result, docStore, docIndex, ...fake };
}

const uploads: { key: string; bytes: Buffer; contentType: string }[] = [];
let restoreBucket: (() => void) | null = null;
const prevSecret = process.env.DOWNLOAD_SIGNING_SECRET;

before(() => {
    process.env.DOWNLOAD_SIGNING_SECRET = "test-secret";
    const original = Storage.prototype.bucket;
    Storage.prototype.bucket = function () {
        return {
            file: (key: string) => ({
                save: async (bytes: Buffer, opts: { contentType: string }) => {
                    uploads.push({ key, bytes, contentType: opts.contentType });
                },
            }),
        } as unknown as ReturnType<Storage["bucket"]>;
    };
    restoreBucket = () => {
        Storage.prototype.bucket = original;
    };
});

after(() => {
    restoreBucket?.();
    if (prevSecret === undefined) delete process.env.DOWNLOAD_SIGNING_SECRET;
    else process.env.DOWNLOAD_SIGNING_SECRET = prevSecret;
});

describe("generate_excel tool", () => {
    it("is offered with a strict schema", () => {
        assert.ok(TOOLS.some((t) => t.function.name === "generate_excel"));
        const fn = GENERATE_EXCEL_TOOL.function;
        assert.equal(fn.strict, true);
        assert.deepEqual(fn.parameters.required, ["title", "sheets"]);
        assert.equal(fn.parameters.additionalProperties, false);
        const sheet = fn.parameters.properties.sheets.items;
        assert.equal(sheet.additionalProperties, false);
        assert.deepEqual(sheet.properties.columns.items.properties.type.enum, [
            "text",
            "number",
            "date",
            "currency",
            "percent",
        ]);
    });

    it("returns an actionable error and writes nothing for a malformed request", async () => {
        const before = uploads.length;
        const { result, events, inserted } = await run({
            title: "Rokovi",
            sheets: [{ name: "S", columns: [{ header: "a", type: "text" }], rows: [["x", "y"]] }],
        });
        assert.match(result.content, /^ERROR: Sheet "S", data row 1 has 2 values but the sheet has 1 columns/);
        assert.equal(events.length, 0);
        assert.equal(inserted.length, 0);
        assert.equal(uploads.length, before);

        const empty = await run({ title: "Rokovi", sheets: [] });
        assert.match(empty.result.content, /^ERROR: The sheets array is empty or missing/);
    });

    it("stores a typed workbook as a document and announces it", async () => {
        const { out, events, result, docStore, docIndex, inserted, updated } = await run({
            title: "Popis ugovora — Šibenik ⟦PII:PERSON_1⟧",
            sheets: [
                {
                    name: "Ugovori",
                    columns: [
                        { header: "Strana", type: "text" },
                        { header: "Iznos", type: "currency" },
                        { header: "Rok", type: "date" },
                    ],
                    rows: [
                        ["Alfa d.o.o.", "1250.50", "2026-03-31"],
                        ["Beta d.d.", "nije poznato", "31. 12. 2026."],
                    ],
                },
            ],
        });

        // Stored bytes: an xlsx SheetJS reads with typed values.
        const upload = uploads[uploads.length - 1];
        assert.match(upload.key, /^generated\/user-1\/[0-9a-f]{32}\/generated\.xlsx$/);
        assert.equal(
            upload.contentType,
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        );
        const ws = XLSX.read(upload.bytes).Sheets.Ugovori;
        assert.deepEqual([ws.B2.t, ws.B2.v], ["n", 1250.5]);
        assert.deepEqual([ws.C3.t, ws.C3.w], ["n", "31.12.2026."]);
        assert.deepEqual([ws.B3.t, ws.B3.v], ["s", "nije poznato"]);

        // A first-class document: diacritics kept, placeholder dropped.
        const docRow = inserted.find((i) => i.table === "documents")!.row;
        assert.equal(docRow.filename, "Popis ugovora Šibenik.xlsx");
        assert.equal(docRow.file_type, "xlsx");
        assert.equal(docRow.project_id, "project-1");
        const versionRow = inserted.find((i) => i.table === "document_versions")!.row;
        assert.equal(versionRow.source, "generated");
        assert.equal(versionRow.storage_path, upload.key);
        assert.deepEqual(updated[0].row, { current_version_id: "document_versions-2" });

        // Streamed like generate_docx: start, then the card.
        assert.deepEqual(events[0], { type: "doc_created_start", filename: "Popis ugovora Šibenik.xlsx" });
        assert.equal(events[1].type, "doc_created");
        assert.equal(events[1].document_id, "documents-1");
        assert.equal(events[1].version_number, 1);
        assert.match(String(events[1].download_url), /^\/download\//);
        assert.equal(out.docsCreated.length, 1);

        // Readable in the same turn under the next free label.
        assert.equal(docIndex["doc-1"].document_id, "documents-1");
        assert.deepEqual(docStore.get("doc-1"), {
            storage_path: upload.key,
            file_type: "xlsx",
            filename: "Popis ugovora Šibenik.xlsx",
        });

        // The model gets the label, the sheets and the warnings — no link.
        const payload = JSON.parse(result.content);
        assert.equal(payload.doc_id, "doc-1");
        assert.deepEqual(payload.sheets, [{ name: "Ugovori", columns: 3, rows: 2 }]);
        assert.match(payload.warnings[0], /column "Iznos" \(currency\).*kept as text: B3\./);
        assert.equal(payload.download_url, undefined);
        assert.equal(payload.storage_path, undefined);
    });
});
