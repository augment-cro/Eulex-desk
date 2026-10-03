import { describe, it } from "node:test";
import assert from "node:assert/strict";
import JSZip from "jszip";
import { applyTrackedEdits, extractDocxBodyText } from "./docxTrackedChanges.js";

// Tracker #94: the text the model reads (extractDocxBodyText) showed neither
// automatic numbering nor line breaks / tabs, and rebuilding a run touched by
// an edit silently dropped its w:br / w:tab elements.

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

async function docx(body: string, extra: { numbering?: string; styles?: string } = {}): Promise<Buffer> {
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
    if (extra.numbering) {
        zip.file("word/numbering.xml", `<?xml version="1.0" encoding="UTF-8"?><w:numbering xmlns:w="${W}">${extra.numbering}</w:numbering>`);
    }
    if (extra.styles) {
        zip.file("word/styles.xml", `<?xml version="1.0" encoding="UTF-8"?><w:styles xmlns:w="${W}">${extra.styles}</w:styles>`);
    }
    return zip.generateAsync({ type: "nodebuffer" });
}

const t = (s: string) => `<w:t xml:space="preserve">${s}</w:t>`;
const run = (...parts: string[]) => `<w:r>${parts.join("")}</w:r>`;
const para = (inner: string, pPr = "") => `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ""}${inner}</w:p>`;
const numPr = (numId: number, ilvl = 0) => `<w:numPr><w:ilvl w:val="${ilvl}"/><w:numId w:val="${numId}"/></w:numPr>`;

async function documentXml(bytes: Buffer): Promise<string> {
    return (await JSZip.loadAsync(bytes)).file("word/document.xml")!.async("string");
}

// "Članak %1." (space) → "%1.%2." (tab); a lowerLetter list "%1)" used by two
// w:num instances, the second restarting at 1; Heading1 linked to "Članak".
const NUMBERING = `
<w:abstractNum w:abstractNumId="0">
  <w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="Članak %1."/><w:suff w:val="space"/></w:lvl>
  <w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1.%2."/></w:lvl>
</w:abstractNum>
<w:abstractNum w:abstractNumId="1">
  <w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="lowerLetter"/><w:lvlText w:val="%1)"/></w:lvl>
</w:abstractNum>
<w:abstractNum w:abstractNumId="2">
  <w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val=""/></w:lvl>
</w:abstractNum>
<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
<w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>
<w:num w:numId="3"><w:abstractNumId w:val="1"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="1"/></w:lvlOverride></w:num>
<w:num w:numId="4"><w:abstractNumId w:val="2"/></w:num>`;

const STYLES = `
<w:style w:type="paragraph" w:styleId="Heading1"><w:pPr>${numPr(1, 0)}</w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="ClanakNaslov"><w:basedOn w:val="Heading1"/></w:style>`;

async function numberedDoc(): Promise<Buffer> {
    return docx(
        [
            para(run(t("Predmet ugovora")), numPr(1, 0)),
            para(run(t("Opis usluge")), numPr(1, 1)),
            para(run(t("Rok isporuke")), numPr(1, 1)),
            para(run(t("Cijena")), `<w:pStyle w:val="ClanakNaslov"/>`),
            para(run(t("Naknada je 10.000,00 EUR.")), numPr(1, 1)),
            para(run(t("prva stavka")), numPr(2)),
            para(run(t("druga stavka")), numPr(2)),
            para(run(t("nova lista")), numPr(3)),
            para(run(t("Bez broja")), numPr(0)),
            para(run(t("točka")), numPr(4)),
        ].join(""),
        { numbering: NUMBERING, styles: STYLES },
    );
}

describe("extractDocxBodyText — what the model reads (#94)", () => {
    it("shows automatic numbering labels in document order", async () => {
        const lines = (await extractDocxBodyText(await numberedDoc())).split("\n");
        assert.deepEqual(lines, [
            "Članak 1. Predmet ugovora",
            "1.1.\tOpis usluge",
            "1.2.\tRok isporuke",
            "Članak 2. Cijena",
            "2.1.\tNaknada je 10.000,00 EUR.",
            "a)\tprva stavka",
            "b)\tdruga stavka",
            "a)\tnova lista",
            "Bez broja",
            "•\ttočka",
        ]);
    });

    it("shows line breaks and tabs inside a paragraph", async () => {
        const bytes = await docx(
            para(run(t("U Zagrebu, 2026."), "<w:br/>", "<w:br/>", t("ZA NOSITELJA:"), "<w:tab/>", t("ZA PODUGOVARATELJA:"))),
        );
        assert.equal(await extractDocxBodyText(bytes), "U Zagrebu, 2026.\n\nZA NOSITELJA:\tZA PODUGOVARATELJA:");
    });
});

describe("applyTrackedEdits — same view as the model (#94)", () => {
    const signature = () =>
        docx(
            para(
                run(t("Ovaj Ugovor sastavljen je u dva primjerka."), "<w:br/>", "<w:br/>", t("U Zagrebu, 2026.")) +
                    run("<w:tab/>", t("U Splitu, 2026.")),
            ),
        );

    it("keeps untouched line breaks and tabs of a run it rewrites", async () => {
        const result = await applyTrackedEdits(await signature(), [
            { find: "sastavljen", replace: "potpisan", context_before: "Ovaj Ugovor ", context_after: " je u dva" },
        ]);
        assert.deepEqual(result.errors, []);
        const xml = await documentXml(result.bytes);
        assert.equal(xml.match(/<w:br\/?>|<w:br><\/w:br>/g)?.length, 2, xml);
        assert.equal(
            await extractDocxBodyText(result.bytes),
            "Ovaj Ugovor potpisan je u dva primjerka.\n\nU Zagrebu, 2026.\tU Splitu, 2026.",
        );
    });

    it("matches a find copied across a line break", async () => {
        const result = await applyTrackedEdits(await signature(), [
            {
                find: "primjerka.\n\nU Zagrebu",
                replace: "primjerka.\n\nU Rijeci",
                context_before: "u dva ",
                context_after: ", 2026.",
            },
        ]);
        assert.deepEqual(result.errors, []);
        assert.equal(result.changes.length, 1);
        assert.equal(result.changes[0].deletedText, "Zagrebu");
        assert.equal(result.changes[0].insertedText, "Rijeci");
        assert.equal(
            await extractDocxBodyText(result.bytes),
            "Ovaj Ugovor sastavljen je u dva primjerka.\n\nU Rijeci, 2026.\tU Splitu, 2026.",
        );
    });

    it("deletes a line break as a tracked change", async () => {
        const result = await applyTrackedEdits(await signature(), [
            { find: "primjerka.\n\nU", replace: "primjerka. U", context_before: "u dva ", context_after: " Zagrebu" },
        ]);
        assert.deepEqual(result.errors, []);
        const xml = await documentXml(result.bytes);
        assert.match(xml, /<w:del [^>]*>(?:(?!<\/w:del>).)*<w:br/s);
        assert.equal(
            await extractDocxBodyText(result.bytes),
            "Ovaj Ugovor sastavljen je u dva primjerka. U Zagrebu, 2026.\tU Splitu, 2026.",
        );
    });

    it("keeps a page break's type when its run is rewritten", async () => {
        const bytes = await docx(para(run(t("Kraj članka."), '<w:br w:type="page"/>', t("Potpisi"))));
        const result = await applyTrackedEdits(bytes, [
            { find: "Kraj", replace: "Završetak", context_before: "", context_after: " članka." },
        ]);
        assert.deepEqual(result.errors, []);
        assert.match(await documentXml(result.bytes), /<w:br w:type="page"/);
    });

    it("accepts a find that starts with the numbering label without duplicating it", async () => {
        const result = await applyTrackedEdits(await numberedDoc(), [
            { find: "1.2.\tRok isporuke", replace: "1.2.\tRok isporuke i preuzimanja", context_before: "", context_after: "" },
        ]);
        assert.deepEqual(result.errors, []);
        assert.equal(result.changes[0].insertedText, " i preuzimanja");
        const lines = (await extractDocxBodyText(result.bytes)).split("\n");
        assert.equal(lines[2], "1.2.\tRok isporuke i preuzimanja");
    });

    it("uses the label as context", async () => {
        const result = await applyTrackedEdits(await numberedDoc(), [
            { find: "Cijena", replace: "Cijena i plaćanje", context_before: "Članak 2. ", context_after: "" },
        ]);
        assert.deepEqual(result.errors, []);
        assert.equal((await extractDocxBodyText(result.bytes)).split("\n")[3], "Članak 2. Cijena i plaćanje");
    });

    it("refuses to edit the automatic number itself", async () => {
        const result = await applyTrackedEdits(await numberedDoc(), [
            { find: "Članak 2. Cijena", replace: "Članak 3. Cijena", context_before: "", context_after: "" },
        ]);
        assert.equal(result.changes.length, 0);
        assert.equal(result.errors.length, 1);
        assert.match(result.errors[0].reason, /automatic Word numbering/);
    });
});
