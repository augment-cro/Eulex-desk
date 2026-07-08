import { describe, it, expect } from "vitest";
import {
    toContextSourceInputs,
    buildTranscript,
    MAX_TRANSCRIPT_CHARS,
} from "./saveAsContext";
import type { LegalSource, MikeMessage } from "../components/shared/types";

function src(over: Partial<LegalSource>): LegalSource {
    return {
        id: "@hr/zakon/123",
        scope: "@hr",
        title: "Zakon o radu",
        ...over,
    };
}

describe("toContextSourceInputs", () => {
    it("uses CELEX as the ref for EU sources and the stable id otherwise", () => {
        const out = toContextSourceInputs([
            src({ id: "@eu/celex/32016R0679", scope: "@eu", celex: "32016R0679", title: "GDPR" }),
            src({}),
        ]);
        expect(out.map((s) => s.ref)).toEqual(["32016R0679", "@hr/zakon/123"]);
        expect(out.every((s) => s.kind === "legal_instrument" && s.mode === "retrieved")).toBe(true);
    });

    it("dedupes by ref case-insensitively and appends the article label", () => {
        const out = toContextSourceInputs([
            src({ id: "@eu/1", scope: "@eu", celex: "32016R0679", title: "GDPR", articleLabel: "čl. 22" }),
            src({ id: "@eu/2", scope: "@eu", celex: "32016r0679", title: "GDPR" }),
        ]);
        expect(out).toHaveLength(1);
        expect(out[0].label).toBe("GDPR — čl. 22");
    });

    it("carries the citation through when present", () => {
        const out = toContextSourceInputs([src({ citation: "NN 93/14" })]);
        expect(out[0].citation).toBe("NN 93/14");
    });
});

describe("buildTranscript", () => {
    it("labels turns USER/AI and skips empty messages", () => {
        const messages: MikeMessage[] = [
            { role: "user", content: "Pitanje?" },
            { role: "assistant", content: "" },
            { role: "assistant", content: "Odgovor." },
        ];
        expect(buildTranscript(messages)).toBe("USER: Pitanje?\n\nAI: Odgovor.");
    });

    it("keeps the tail when the chat exceeds the cap", () => {
        const messages: MikeMessage[] = [
            { role: "user", content: "x".repeat(MAX_TRANSCRIPT_CHARS) },
            { role: "assistant", content: "FINAL" },
        ];
        const out = buildTranscript(messages);
        expect(out.length).toBe(MAX_TRANSCRIPT_CHARS);
        expect(out.endsWith("AI: FINAL")).toBe(true);
    });
});
