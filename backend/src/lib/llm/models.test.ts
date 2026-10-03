import test from "node:test";
import assert from "node:assert/strict";
import {
    CLAUDE_LOW_MODELS,
    CLAUDE_MID_MODELS,
    DEFAULT_TABULAR_MODEL,
    DEFAULT_TITLE_MODEL,
    resolveModel,
    standardEffort,
} from "./models";

test("Sonnet 5.5 replaces Sonnet 5 and Haiku 4.5 (2026-09-29)", () => {
    assert.equal(DEFAULT_TITLE_MODEL, "claude-sonnet-5-5");
    assert.equal(DEFAULT_TABULAR_MODEL, "claude-sonnet-5-5");
    assert.deepEqual([...CLAUDE_MID_MODELS], ["claude-sonnet-5-5"]);
    assert.deepEqual([...CLAUDE_LOW_MODELS], ["claude-sonnet-5-5"]);
});

test("stored and client-sent retired ids resolve forward to Sonnet 5.5", () => {
    // user_profiles.tabular_model still defaults to 'claude-sonnet-5' (migration 131).
    for (const id of ["claude-sonnet-5", "claude-sonnet-4-6", "claude-haiku-4-5"]) {
        assert.equal(resolveModel(id, "fallback"), "claude-sonnet-5-5", id);
    }
    assert.equal(resolveModel("claude-sonnet-5-5", "fallback"), "claude-sonnet-5-5");
    assert.equal(resolveModel("claude-opus-5-5", "fallback"), "claude-opus-5-5");
    assert.equal(resolveModel("no-such-model", "fallback"), "fallback");
});

test("xhigh and max are Claude levels: other providers get high", () => {
    assert.deepEqual(
        (["low", "medium", "high", "xhigh", "max", undefined] as const).map(standardEffort),
        ["low", "medium", "high", "high", "high", undefined],
    );
});
