// Quick test: does the docx library correctly handle Croatian characters?
const { Document, Paragraph, TextRun, Packer, HeadingLevel } = require("docx");
const fs = require("fs");

async function test() {
    const FONT = "Times New Roman";
    const SIZE = 22;

    const testText = "Prodavatelj izjavljuje i jamči da je jedini i isključivi vlasnik Nekretnine, te da Nekretnina nije opterećena nikakvim dužnostima, založnim pravima, služnostima.";

    console.log("Input text:", testText);
    console.log("Input chars:", [...testText].map(c => `${c}(${c.charCodeAt(0).toString(16)})`).join(" "));

    const doc = new Document({
        sections: [{
            children: [
                new Paragraph({
                    heading: HeadingLevel.TITLE,
                    children: [new TextRun({ text: "TEST DOKUMENT", font: FONT, size: SIZE, bold: true })],
                }),
                new Paragraph({
                    spacing: { after: 120 },
                    children: [new TextRun({ text: testText, font: FONT, size: SIZE })],
                }),
            ],
        }],
    });

    const buf = await Packer.toBuffer(doc);
    console.log("\nBuffer length:", buf.length);
    console.log("Buffer.byteOffset:", buf.byteOffset);
    console.log("Buffer.buffer.byteLength:", buf.buffer.byteLength);
    console.log("MISMATCH:", buf.buffer.byteLength !== buf.byteLength ? "YES — buf.buffer is BIGGER!" : "No");

    // Write to file for inspection
    fs.writeFileSync("/tmp/test_croatian.docx", buf);
    console.log("\nWrote /tmp/test_croatian.docx — open in Word to check characters");

    // Also test the buf.buffer path (what the actual code does)
    const fromBufBuffer = Buffer.from(buf.buffer);
    fs.writeFileSync("/tmp/test_croatian_bufbuffer.docx", fromBufBuffer);
    console.log("Wrote /tmp/test_croatian_bufbuffer.docx — this uses buf.buffer (potentially buggy path)");
    console.log("Size difference:", fromBufBuffer.length - buf.length, "bytes");

    // Extract XML to check encoding
    const JSZip = require("jszip");
    const zip = await JSZip.loadAsync(buf);
    const docXml = await zip.file("word/document.xml").async("string");
    
    // Find the test text in XML
    const idx = docXml.indexOf("jamč");
    if (idx >= 0) {
        console.log("\n✅ Found 'jamč' in document.xml at position", idx);
        console.log("Context:", docXml.substring(idx - 20, idx + 80));
    } else {
        console.log("\n❌ 'jamč' NOT found in document.xml!");
        // Search for partial
        const idx2 = docXml.indexOf("jam");
        if (idx2 >= 0) {
            console.log("Found 'jam' at", idx2, "context:", docXml.substring(idx2 - 10, idx2 + 60));
        }
    }
}

test().catch(console.error);
