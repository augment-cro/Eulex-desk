import { describe, it } from "node:test";
import assert from "node:assert/strict";
import JSZip from "jszip";
import { applyTrackedEdits, extractDocxBodyText } from "./docxTrackedChanges.js";

/** Runs whose entire text looks numeric to a naive XML parser. */
const NUMERIC_RUNS = ["10.000", "2.500", "1.000", "12.10", "007", "2026.", "1e3", "0x1A"];

/** A minimal DOCX: one paragraph per numeric run, plus an editable sentence. */
async function docxWithNumericRuns(): Promise<Buffer> {
    const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
    const para = (runs: string[]) =>
        `<w:p>${runs.map((t) => `<w:r><w:t xml:space="preserve">${t}</w:t></w:r>`).join("")}</w:p>`;
    const body = [
        para(["Iznos: ", ...NUMERIC_RUNS.slice(0, 1), " EUR"]),
        ...NUMERIC_RUNS.map((t) => para([t])),
        para(["Rok isporuke je 30 dana."]),
    ].join("");
    const zip = new JSZip();
    zip.file(
        "[Content_Types].xml",
        '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    );
    zip.file(
        "_rels/.rels",
        '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    );
    zip.file(
        "word/document.xml",
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="${W}"><w:body>${body}</w:body></w:document>`,
    );
    return zip.generateAsync({ type: "nodebuffer" });
}

describe("docxTrackedChanges — numeric-looking run text stays verbatim", () => {
    it("extractDocxBodyText keeps every numeric run as written", async () => {
        const text = await extractDocxBodyText(await docxWithNumericRuns());
        const lines = text.split("\n");
        assert.equal(lines[0], "Iznos: 10.000 EUR");
        for (const t of NUMERIC_RUNS) assert.ok(lines.includes(t), `missing "${t}" in:\n${text}`);
    });

    it("applyTrackedEdits does not rewrite untouched numeric runs", async () => {
        const result = await applyTrackedEdits(await docxWithNumericRuns(), [
            {
                find: "30",
                replace: "60",
                context_before: "Rok isporuke je ",
                context_after: " dana.",
            },
        ]);
        assert.deepEqual(result.errors, []);
        assert.equal(result.changes.length, 1);

        const xml = await (await JSZip.loadAsync(result.bytes))
            .file("word/document.xml")!
            .async("string");
        for (const t of NUMERIC_RUNS) {
            assert.ok(xml.includes(`>${t}</w:t>`), `run "${t}" was rewritten`);
        }
        const text = await extractDocxBodyText(result.bytes);
        assert.ok(text.includes("Iznos: 10.000 EUR"));
        assert.ok(text.includes("Rok isporuke je 60 dana."));
    });
});
