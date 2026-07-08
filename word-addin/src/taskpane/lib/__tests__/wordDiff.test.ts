import { describe, it, expect } from "vitest";
import { tokenize, diffWords, isTrivialDiff } from "../wordDiff";

describe("tokenize", () => {
    it("splits on any whitespace and drops empties", () => {
        expect(tokenize("  the  quick\tbrown\nfox ")).toEqual([
            "the",
            "quick",
            "brown",
            "fox",
        ]);
    });

    it("keeps trailing punctuation attached to the word", () => {
        expect(tokenize("clause, here")).toEqual(["clause,", "here"]);
    });

    it("returns an empty array for whitespace-only input", () => {
        expect(tokenize("   ")).toEqual([]);
    });
});

describe("diffWords", () => {
    it("marks everything kept when the sequences are identical", () => {
        const ops = diffWords(["a", "b", "c"], ["a", "b", "c"]);
        expect(ops).toHaveLength(3);
        expect(ops.every((o) => o.type === "keep")).toBe(true);
    });

    it("represents a one-word change as a delete + insert", () => {
        const ops = diffWords(["the", "red", "car"], ["the", "blue", "car"]);
        expect(ops.filter((o) => o.type === "keep")).toHaveLength(2);
        expect(ops.find((o) => o.type === "delete")?.text).toBe("red");
        expect(ops.find((o) => o.type === "insert")?.text).toBe("blue");
    });

    it("handles a pure insertion (old side empty)", () => {
        const ops = diffWords([], ["a", "b"]);
        expect(ops.map((o) => o.type)).toEqual(["insert", "insert"]);
        expect(ops.map((o) => o.newIndex)).toEqual([0, 1]);
    });

    it("handles a pure deletion (new side empty)", () => {
        const ops = diffWords(["a", "b"], []);
        expect(ops.map((o) => o.type)).toEqual(["delete", "delete"]);
    });

    it("ops applied left-to-right reconstruct the new sequence", () => {
        const oldT = ["alpha", "beta", "gamma", "delta"];
        const newT = ["alpha", "gamma", "epsilon", "delta"];
        const ops = diffWords(oldT, newT);
        const rebuilt: string[] = [];
        for (const op of ops) {
            if (op.type === "keep" || op.type === "insert") rebuilt.push(op.text);
        }
        expect(rebuilt).toEqual(newT);
    });
});

describe("isTrivialDiff", () => {
    it("is trivial for very short sequences", () => {
        const o = ["a", "b"];
        const n = ["a", "c"];
        expect(isTrivialDiff(o, n, diffWords(o, n))).toBe(true);
    });

    it("is trivial for a full rewrite (low keep ratio)", () => {
        const o = "one two three four five six".split(" ");
        const n = "alpha beta gamma delta epsilon zeta".split(" ");
        expect(isTrivialDiff(o, n, diffWords(o, n))).toBe(true);
    });

    it("is NOT trivial for a small edit inside a long sentence", () => {
        const o =
            "the parties agree that the contract shall remain in full force".split(
                " ",
            );
        const n =
            "the parties agree that the contract shall remain in partial force".split(
                " ",
            );
        expect(isTrivialDiff(o, n, diffWords(o, n))).toBe(false);
    });
});
