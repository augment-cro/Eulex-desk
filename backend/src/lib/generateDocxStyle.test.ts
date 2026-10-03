import { describe, it } from "node:test";
import assert from "node:assert/strict";
import JSZip from "jszip";
import { buildGeneratedDocx, docxColumnWidths } from "./chatTools.js";
import { DOCX_PALETTE } from "./docxPalette.js";

// generate_docx: the model's status emoji as small pastel dots, and the calm
// eulex.ai styling (Georgia in ink, warm hairline borders, paper header fill).

async function docxFile(sections: unknown[], title: string, file: string) {
    const buf = await buildGeneratedDocx(title, sections);
    return (await JSZip.loadAsync(buf)).file(file)!.async("string");
}

const documentXml = (sections: unknown[], title = "Izvještaj") =>
    docxFile(sections, title, "word/document.xml");

/** The runs of the XML as { text, color, size, font, bold }. */
function runs(xml: string) {
    return [...xml.matchAll(/<w:r>(.*?)<\/w:r>/g)].map(([, r]) => ({
        text: [...r.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((m) => m[1]).join(""),
        color: r.match(/<w:color w:val="([0-9A-F]{6})"/)?.[1],
        size: r.match(/<w:sz w:val="(\d+)"/)?.[1],
        font: r.match(/<w:rFonts w:ascii="([^"]+)"/)?.[1],
        bold: /<w:b\/>/.test(r),
    }));
}

const isDot = (r: { text: string }) => r.text === "●" || r.text === "○";

describe("generate_docx — status tokens", () => {
    it("splits runs on the tokens: a small pastel dot (○ for ⚪), the text around it in ink", async () => {
        const xml = await documentXml([
            { heading: "Razina upozorenja: 🔴 STOP", level: 1, content: "Sažetak: 🟡️ REVIEW, ⚪ nedovoljno, 🔵 procjena, 🟢 STANDARD" },
        ]);
        assert.doesNotMatch(xml, /🔴|🟡|🔵|⚪|🟢|️/u);
        const all = runs(xml);
        const dots = all.filter((r) => r.text === "●" || r.text === "○");
        assert.deepEqual(
            dots.map((d) => [d.text, d.color]),
            [
                ["●", DOCX_PALETTE.status.problem],
                ["●", DOCX_PALETTE.status.gap],
                ["○", DOCX_PALETTE.status.insufficient],
                ["●", DOCX_PALETTE.status.assessment],
                ["●", DOCX_PALETTE.status.clear],
            ],
        );
        // ≈ 72 % of the text around them: the 15 pt heading, the 12 pt body.
        assert.deepEqual(dots.map((d) => [d.size, d.font]), [
            ["22", "Arial"],
            ["17", "Arial"],
            ["17", "Arial"],
            ["17", "Arial"],
            ["17", "Arial"],
        ]);
        const heading = all.filter((r) => r.text.includes("Razina") || r.text === " STOP");
        assert.deepEqual(heading.map((r) => [r.text, r.color]), [
            ["1. Razina upozorenja: ", DOCX_PALETTE.ink],
            [" STOP", DOCX_PALETTE.ink],
        ]);
    });

    it("a table: dot-only header and cells keep a full-height line; borders, fill and padding in the EULEX style", async () => {
        const xml = await documentXml([
            {
                table: {
                    headers: ["Kontrola", "🔴", "Napomena"],
                    rows: [["AA-20", "🟢", "Nema procjene učinka na temeljna prava."]],
                },
            },
        ]);
        const all = runs(xml);
        const dotIdx = all.findIndex((r) => r.text === "●");
        assert.equal(all[dotIdx].color, DOCX_PALETTE.status.problem);
        assert.deepEqual([all[dotIdx + 1].text, all[dotIdx + 1].size], [" ", "21"]);
        assert.match(xml, /<w:shd w:fill="F3EEE3" w:color="auto" w:val="clear"\/>/);
        assert.match(xml, /<w:top w:val="single" w:color="CFC7B6" w:sz="4"\/>/);
        assert.match(xml, /<w:insideH w:val="single" w:color="CFC7B6" w:sz="4"\/>/);
        assert.doesNotMatch(xml, /w:color="auto" w:sz="4"/, "no black default table borders");
        assert.match(xml, /<w:tcMar><w:top w:type="dxa" w:w="60"\/>/);
        assert.doesNotMatch(xml, /w:val="000000"/);
        // Real grid widths across the text width, the status column narrow.
        const grid = [...xml.matchAll(/<w:gridCol w:w="(\d+)"\/>/g)].map((m) => Number(m[1]));
        assert.equal(grid.reduce((a, b) => a + b, 0), 9026);
        assert.ok(grid[1] < grid[0] && grid[0] < grid[2]);
    });
});

describe("generate_docx — type", () => {
    const sections = [
        { heading: "Sažetak", level: 1, content: "Tekst odlomka.\n- stavka popisa" },
        { heading: "Nalazi", level: 2, table: { headers: ["Kontrola", "Status"], rows: [["AA-20", "🟢 STANDARD"]] } },
        { heading: "Detalj", level: 3, content: "Još teksta." },
    ];

    it("Georgia everywhere (the dots in Arial), never Times New Roman or Sentient", async () => {
        const xml = await documentXml(sections, "Izvještaj o usklađenosti");
        const fonts = new Set(runs(xml).filter((r) => !isDot(r)).map((r) => r.font));
        assert.deepEqual([...fonts], ["Georgia"]);
        assert.doesNotMatch(xml, /Times New Roman|Sentient/);
        const styles = await docxFile(sections, "Izvještaj", "word/styles.xml");
        assert.doesNotMatch(styles, /Times New Roman|Sentient/);
        // The document default: Georgia 12 pt in ink, ≈1.15 line spacing.
        const defaults = styles.match(/<w:docDefaults>.*?<\/w:docDefaults>/s)?.[0] ?? "";
        assert.match(defaults, /w:ascii="Georgia"/);
        assert.match(defaults, /<w:sz w:val="24"\/>/);
        assert.match(defaults, /<w:color w:val="32270D"\/>/);
        assert.match(defaults, /<w:spacing w:line="276"\/>/);
        for (const id of ["Title", "Heading1", "Heading2", "Heading3", "Heading4"]) {
            const style = styles.match(new RegExp(`<w:style [^>]*w:styleId="${id}".*?</w:style>`, "s"))?.[0] ?? "";
            assert.match(style, /w:ascii="Georgia"/, id);
        }
    });

    it("sizes: title 20 pt regular as given, headings 15 / 13 / 12 pt bold, body 12 pt, tables 10.5 pt", async () => {
        const all = runs(await documentXml(sections, "Izvještaj o usklađenosti"));
        const by = (text: string) => all.find((r) => r.text === text)!;
        assert.deepEqual(by("Izvještaj o usklađenosti"), {
            text: "Izvještaj o usklađenosti", color: "32270D", size: "40", font: "Georgia", bold: false,
        });
        assert.deepEqual([by("1. Sažetak").size, by("1. Sažetak").bold], ["30", true]);
        assert.deepEqual([by("1.1. Nalazi").size, by("1.1. Nalazi").bold], ["26", true]);
        assert.deepEqual([by("1.1.1. Detalj").size, by("1.1.1. Detalj").bold], ["24", true]);
        assert.equal(by("Tekst odlomka.").size, "24");
        assert.equal(by("stavka popisa").size, "24");
        assert.deepEqual([by("Kontrola").size, by("Kontrola").bold], ["21", true]);
        assert.deepEqual([by("AA-20").size, by("AA-20").bold], ["21", false]);
        assert.equal(all.find(isDot)?.size, "15");
    });
});

describe("docxColumnWidths", () => {
    it("weights columns by their longest line, clamped to 4–40 characters plus padding, summing to the total", () => {
        assert.deepEqual(docxColumnWidths(["A", "B"], [["x", "y"]], 1000), [500, 500]);
        const w = docxColumnWidths(["Kontrola", "🔴", "Napomena"], [["AA-20", "🟢", "x".repeat(200)]], 9026);
        assert.equal(w.reduce((a, b) => a + b, 0), 9026);
        assert.deepEqual(w, [1556, 933, 6537]); // weights 8+2 : 4+2 : 40+2
        assert.deepEqual(docxColumnWidths(["a"], [[undefined as unknown as string]], 100), [100]);
    });
});
