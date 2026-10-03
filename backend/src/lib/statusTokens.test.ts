import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { splitStatusTokens, statusDotGlyph, statusTokensAsGlyphs } from "./statusTokens.js";
import { cellText } from "./xlsx/values.js";

describe("status tokens (generated files)", () => {
    it("splits exactly the five tokens, with a following variation selector, next to any text", () => {
        assert.deepEqual(splitStatusTokens("Razina: 🔴 STOP"), ["Razina: ", { status: "problem", token: "🔴" }, " STOP"]);
        assert.deepEqual(splitStatusTokens("⚪️x🟢🟡🔵"), [
            { status: "insufficient", token: "⚪️" },
            "x",
            { status: "clear", token: "🟢" },
            { status: "gap", token: "🟡" },
            { status: "assessment", token: "🔵" },
        ]);
        assert.deepEqual(splitStatusTokens("🟠 ⚫ ✅"), ["🟠 ⚫ ✅"]);
        assert.equal(statusDotGlyph("insufficient"), "○");
        assert.equal(statusDotGlyph("problem"), "●");
    });

    it("Excel cells get a plain ● / ○ instead of the emoji", () => {
        assert.equal(statusTokensAsGlyphs("🔴 STOP · 🟡️ REVIEW · ⚪ ? · 🟢"), "● STOP · ● REVIEW · ○ ? · ●");
        assert.deepEqual(cellText("🔵 pravna procjena"), { text: "● pravna procjena", truncated: false });
    });
});
