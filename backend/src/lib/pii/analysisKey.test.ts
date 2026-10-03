import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { analysisKeyFor } from "./analysisKey";

const UUID_V5 = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const base = { versionId: "2a5fc88a-9ea0-4042-99fd-a54425bd7a45", text: "Ivan Horvat podnosi žalbu.", language: "hr" };

describe("analysisKeyFor", () => {
    it("is a stable UUID for the same version, text and language", () => {
        const a = analysisKeyFor(base);
        const b = analysisKeyFor({ ...base });
        assert.equal(a, b);
        assert.match(a, UUID_V5);
    });

    it("changes when the text changes in place (same version id)", () => {
        assert.notEqual(analysisKeyFor(base), analysisKeyFor({ ...base, text: base.text + " " }));
    });

    it("changes with the language and with the version id", () => {
        assert.notEqual(analysisKeyFor(base), analysisKeyFor({ ...base, language: "en" }));
        assert.notEqual(
            analysisKeyFor(base),
            analysisKeyFor({ ...base, versionId: "b3a21ab2-b2e3-4873-9db8-60a7e8ae228a" }),
        );
    });
});
