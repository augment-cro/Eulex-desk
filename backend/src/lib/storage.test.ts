import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateHeaderValue } from "node:http";
import { buildContentDisposition, sanitizeDispositionFilename } from "./storage.js";

describe("Content-Disposition with Croatian diacritics", () => {
    it("builds a header Node accepts for 'Očitovanje na tužbu.docx'", () => {
        const header = buildContentDisposition("attachment", "Očitovanje na tužbu.docx");
        // setHeader threw ERR_INVALID_CHAR here before the fix.
        assert.doesNotThrow(() => validateHeaderValue("Content-Disposition", header));
        assert.ok([...header].every((c) => c.charCodeAt(0) <= 0x7e), header);
        assert.equal(
            header,
            `attachment; filename="Ocitovanje na tuzbu.docx"; filename*=UTF-8''O%C4%8Ditovanje%20na%20tu%C5%BEbu.docx`,
        );
    });

    it("keeps the real name only in filename*", () => {
        const header = buildContentDisposition(
            "inline",
            "Podnesak tužiteljice - očitovanje na podnesak tuženika od 25.09.docx",
        );
        assert.doesNotThrow(() => validateHeaderValue("Content-Disposition", header));
        assert.match(header, /filename="Podnesak tuziteljice - ocitovanje na podnesak tuzenika od 25\.09\.docx"/);
        assert.match(header, /filename\*=UTF-8''Podnesak%20tu%C5%BEiteljice/);
    });

    it("maps đ/Đ, strips other accents and replaces what has no ASCII form", () => {
        assert.equal(sanitizeDispositionFilename("Đurđa žalba ČĆŠ.pdf"), "Durda zalba CCS.pdf");
        assert.equal(sanitizeDispositionFilename("Straße 日本.txt"), "Stra_e __.txt");
        assert.equal(sanitizeDispositionFilename('a"b\\c.docx'), "a_b_c.docx");
    });
});
