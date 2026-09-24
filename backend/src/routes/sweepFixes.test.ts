import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateColumnsConfig } from "./workflows.js";
import { maskEmail } from "./chatShares.js";
import { parseEnrichedVariants } from "./chat.js";

// Unit coverage for the pure helpers added in the section bug sweep
// (issues #85, #98, #121). These guard the validation/parse/mask logic
// without needing a DB or network.

describe("validateColumnsConfig (#121)", () => {
    it("accepts null/undefined (no columns)", () => {
        assert.equal(validateColumnsConfig(null), null);
        assert.equal(validateColumnsConfig(undefined), null);
    });
    it("accepts a well-formed array", () => {
        assert.equal(
            validateColumnsConfig([
                { index: 0, name: "A", prompt: "p" },
                { index: 1, name: "B", prompt: "q", format: "text" },
            ]),
            null,
        );
    });
    it("rejects a non-array", () => {
        assert.ok(validateColumnsConfig({}));
        assert.ok(validateColumnsConfig("nope"));
    });
    it("rejects a non-numeric index", () => {
        assert.ok(validateColumnsConfig([{ index: "x", name: "A", prompt: "p" }]));
    });
    it("rejects a non-string name/prompt", () => {
        assert.ok(validateColumnsConfig([{ index: 0, name: {}, prompt: "p" }]));
        assert.ok(validateColumnsConfig([{ index: 0, name: "A", prompt: 5 }]));
    });
    it("rejects a non-object column item", () => {
        assert.ok(validateColumnsConfig([1, 2, 3]));
    });
});

describe("maskEmail (#98)", () => {
    it("masks the local part, keeps the domain", () => {
        assert.equal(maskEmail("bob@firm.hr"), "b***@firm.hr");
        assert.equal(maskEmail("a@x.com"), "a***@x.com");
    });
    it("never returns the full local part", () => {
        const masked = maskEmail("ana.horvat@example.com");
        assert.ok(!masked.includes("ana.horvat"));
        assert.ok(masked.endsWith("@example.com"));
    });
    it("handles malformed input safely", () => {
        assert.equal(maskEmail("notanemail"), "***");
        assert.equal(maskEmail("@x.com"), "***");
    });
});

describe("parseEnrichedVariants (#85)", () => {
    it("returns a single variant for a plain rewritten query", () => {
        const out = parseEnrichedVariants("Koje su obveze poslodavca?");
        assert.deepEqual(out, [
            { query: "Koje su obveze poslodavca?", why: "" },
        ]);
    });
    it("parses a fenced ```json improved_queries block into variants", () => {
        const fenced =
            '```json\n{ "improved_queries": [ ' +
            '{ "query": "Q1", "why": "W1" }, ' +
            '{ "query": "Q2", "why": "W2" } ] }\n```';
        const out = parseEnrichedVariants(fenced);
        assert.deepEqual(out, [
            { query: "Q1", why: "W1" },
            { query: "Q2", why: "W2" },
        ]);
    });
    it("parses an unfenced JSON object too", () => {
        const out = parseEnrichedVariants(
            '{"improved_queries":[{"query":"Q","why":""}]}',
        );
        assert.deepEqual(out, [{ query: "Q", why: "" }]);
    });
    it("accepts a bare array of strings", () => {
        const out = parseEnrichedVariants('["A", "B"]');
        assert.deepEqual(out, [
            { query: "A", why: "" },
            { query: "B", why: "" },
        ]);
    });
    it("returns null on unparseable JSON (never leaks raw braces)", () => {
        assert.equal(parseEnrichedVariants("{not json"), null);
        assert.equal(parseEnrichedVariants('{"improved_queries": "oops"}'), null);
        assert.equal(parseEnrichedVariants("```json\n{bad\n```"), null);
    });
});
