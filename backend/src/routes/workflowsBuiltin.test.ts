import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import request from "supertest";
import { builtinWorkflowsHandler } from "./workflows.js";
import {
    __setPromptPackForTests,
    __resetPromptPackForTests,
    GENERIC_PROMPT_BLOCKS,
} from "../lib/seams/promptPack.js";

/**
 * GET /workflows/builtin — built-in workflow packs from the governance
 * prompt-pack cache. The handler is tested directly (requireAuth needs a
 * live DB); the router wires it behind requireAuth. NON-proprietary
 * fixture entries only.
 */

const FIXTURE_PACKS = [
    {
        id: "builtin-fixture-assistant",
        user_id: null,
        is_system: true,
        created_at: "",
        title: "Fixture Assistant WF",
        type: "assistant",
        practice: "General",
        prompt_md: "## Fixture assistant prompt",
        columns_config: null,
    },
    {
        id: "builtin-fixture-tabular",
        user_id: null,
        is_system: true,
        created_at: "",
        title: "Fixture Tabular WF",
        type: "tabular",
        practice: "General",
        prompt_md: null,
        columns_config: [{ index: 0, name: "Col", prompt: "Fixture column prompt" }],
    },
];

function makeApp() {
    const app = express();
    app.get("/workflows/builtin", builtinWorkflowsHandler);
    return app;
}

describe("GET /workflows/builtin", () => {
    beforeEach(() => __resetPromptPackForTests());
    afterEach(() => __resetPromptPackForTests());

    it("returns [] when no prompt pack is loaded (standalone posture)", async () => {
        const res = await request(makeApp()).get("/workflows/builtin").expect(200);
        assert.deepEqual(res.body, []);
    });

    it("returns the pack's workflow entries verbatim, rich shape intact", async () => {
        __setPromptPackForTests({
            version: 5,
            blocks: GENERIC_PROMPT_BLOCKS,
            workflow_packs: FIXTURE_PACKS,
            enrichment_prompt: "",
        });
        const res = await request(makeApp()).get("/workflows/builtin").expect(200);
        assert.deepEqual(res.body, FIXTURE_PACKS);
        // rich fields pass through untouched
        const tabular = res.body[1] as {
            prompt_md: string | null;
            columns_config: { prompt: string }[];
        };
        assert.equal(tabular.columns_config[0].prompt, "Fixture column prompt");
        assert.equal(tabular.prompt_md, null);
    });
});
