// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { parseOoxmlForChanges, formatTrackedChangesForLLM } from "../wordOoxml";

// Minimal WordprocessingML with one standalone insertion and a
// deletion + insertion in a second paragraph.
const OOXML = `<?xml version="1.0"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p>
      <w:ins w:author="Ana" w:date="2024-01-02T00:00:00Z"><w:r><w:t>inserted text</w:t></w:r></w:ins>
    </w:p>
    <w:p>
      <w:del w:author="Bob" w:date="2024-01-03T00:00:00Z"><w:r><w:delText>old text</w:delText></w:r></w:del>
      <w:ins w:author="Bob" w:date="2024-01-03T00:00:00Z"><w:r><w:t>new text</w:t></w:r></w:ins>
    </w:p>
  </w:body>
</w:document>`;

describe("parseOoxmlForChanges", () => {
    it("extracts insertions (w:t) with author and text", () => {
        const changes = parseOoxmlForChanges(OOXML);
        expect(
            changes.some(
                (c) =>
                    c.type === "insertion" &&
                    c.author === "Ana" &&
                    c.text === "inserted text",
            ),
        ).toBe(true);
        expect(
            changes.some(
                (c) =>
                    c.type === "insertion" &&
                    c.author === "Bob" &&
                    c.text === "new text",
            ),
        ).toBe(true);
    });

    it("extracts deletions from w:delText", () => {
        const changes = parseOoxmlForChanges(OOXML);
        expect(
            changes.some(
                (c) =>
                    c.type === "deletion" &&
                    c.author === "Bob" &&
                    c.text === "old text",
            ),
        ).toBe(true);
    });

    it("ignores revision marks with no textual content", () => {
        const empty = parseOoxmlForChanges(
            `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p></w:p></w:body></w:document>`,
        );
        expect(empty).toEqual([]);
    });
});

describe("formatTrackedChangesForLLM", () => {
    it("renders a human-readable block including authors", () => {
        const out = formatTrackedChangesForLLM(parseOoxmlForChanges(OOXML));
        expect(out).toContain("Tracked Changes");
        expect(out).toContain("Ana");
        expect(out).toContain("Bob");
    });

    it("returns an empty string for no changes", () => {
        expect(formatTrackedChangesForLLM([])).toBe("");
    });
});
