import { describe, expect, it } from "vitest";
import { getModelProvider, isModelAvailable, type ApiKeys } from "./modelAvailability";

const serverClaude: ApiKeys = {
    claudeApiKey: null,
    geminiApiKey: null,
    openaiApiKey: null,
    mistralApiKey: null,
    serverKeys: { claude: true },
};

describe("model availability for ids the picker does not list", () => {
    it("derives the provider from the id", () => {
        expect(getModelProvider("claude-sonnet-5-5")).toBe("claude");
        expect(getModelProvider("claude-sonnet-5")).toBe("claude");
        expect(getModelProvider("gemini-3-flash-preview")).toBe("gemini");
        expect(getModelProvider("gpt-5.4-nano")).toBe("openai");
        expect(getModelProvider("mistral-small-latest")).toBe("mistral");
        expect(getModelProvider("no-such-model")).toBeNull();
    });

    it("lets the tabular default run on the server Claude key (Analize → Pokreni)", () => {
        // Returned false before: "Pokreni" silently did nothing (30. 9.).
        expect(isModelAvailable("claude-sonnet-5-5", serverClaude)).toBe(true);
        expect(isModelAvailable("claude-sonnet-5", serverClaude)).toBe(true);
        expect(isModelAvailable("gemini-3-flash-preview", serverClaude)).toBe(false);
    });
});
