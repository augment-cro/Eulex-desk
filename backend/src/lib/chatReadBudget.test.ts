import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { documentPartForModel } from "./chatTools.js";

// read_document serves long documents in parts instead of returning text
// that overflows the model's context (or silently truncating it).
describe("documentPartForModel", () => {
    const pages = Array.from({ length: 6 }, (_, i) => `[Page ${i + 1}]\n${"x".repeat(90)}`).join("\n\n");

    it("returns a document that fits the budget unchanged", () => {
        assert.equal(documentPartForModel("kratki tekst", "doc-0", undefined, 1000), "kratki tekst");
    });

    it("returns part 1 by default, framed with the part count and how to continue", () => {
        const out = documentPartForModel(pages, "doc-3", undefined, 250);
        assert.match(out, /showing part 1 of 3/);
        assert.match(out, /\[Page 1\]/);
        assert.doesNotMatch(out, /\[Page 3\]/);
        assert.match(out, /"doc_id": "doc-3", "part": 2/);
    });

    it("returns the requested part and clamps out-of-range requests", () => {
        assert.match(documentPartForModel(pages, "doc-3", 2, 250), /showing part 2 of 3[\s\S]*\[Page 3\]/);
        assert.match(documentPartForModel(pages, "doc-3", 99, 250), /showing part 3 of 3[\s\S]*end of the document/);
        assert.match(documentPartForModel(pages, "doc-3", "nonsense", 250), /showing part 1 of 3/);
    });

    it("passes read-failure sentinels through untouched", () => {
        assert.equal(
            documentPartForModel("Document could not be read.", "doc-0", 2, 5),
            "Document could not be read.",
        );
    });
});
