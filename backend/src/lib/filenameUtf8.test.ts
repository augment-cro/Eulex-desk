import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { generatedDocumentFilename } from "./filenameUtf8.js";

describe("generatedDocumentFilename", () => {
    it("keeps Croatian letters (the old ASCII filter dropped them)", () => {
        assert.equal(
            generatedDocumentFilename("Očitovanje na tužbu", "docx"),
            "Očitovanje na tužbu.docx",
        );
        assert.equal(
            generatedDocumentFilename("Đurđevac — Šibenik: žalba", "docx"),
            "Đurđevac Šibenik žalba.docx",
        );
    });

    it("drops characters that are unsafe in a filename or header", () => {
        assert.equal(generatedDocumentFilename('Šteta/naknada "hitno"?', "docx"), "Šteta naknada hitno.docx");
        assert.equal(generatedDocumentFilename("../../etc/passwd", "docx"), "etc passwd.docx");
    });

    it("falls back to 'document' and caps the stem at 64 characters", () => {
        assert.equal(generatedDocumentFilename("  ...  ", "docx"), "document.docx");
        assert.equal(generatedDocumentFilename("", "docx"), "document.docx");
        const long = generatedDocumentFilename("Č".repeat(80), "xlsx");
        assert.equal(long, `${"Č".repeat(64)}.xlsx`);
    });
});
