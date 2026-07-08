import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { healthPayload } from "./health";
import {
    __setPromptPackForTests,
    __resetPromptPackForTests,
    GENERIC_PROMPT_BLOCKS,
} from "./seams/promptPack";

describe("healthPayload", () => {
    afterEach(() => __resetPromptPackForTests());

    it("exposes the build git SHA when set", () => {
        assert.deepEqual(healthPayload({ BUILD_GIT_SHA: "abc123" }), {
            ok: true,
            sha: "abc123",
            promptPackVersion: null,
        });
    });
    it("returns sha:null when unset or empty (manual builds without git context)", () => {
        assert.deepEqual(healthPayload({}), { ok: true, sha: null, promptPackVersion: null });
        assert.deepEqual(healthPayload({ BUILD_GIT_SHA: "" }), {
            ok: true,
            sha: null,
            promptPackVersion: null,
        });
    });
    it("pins the active prompt-pack version when a pack is loaded", () => {
        __setPromptPackForTests({
            version: 42,
            blocks: GENERIC_PROMPT_BLOCKS,
            workflow_packs: [],
            enrichment_prompt: "",
        });
        assert.equal(healthPayload({}).promptPackVersion, 42);
    });
});
