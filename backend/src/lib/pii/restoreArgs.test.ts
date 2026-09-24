import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    EMPTY_PLACEHOLDER_MAP,
    buildPlaceholderMap,
    restorePlaceholders,
    stripPlaceholders,
    type RestoreDeps,
} from "./restoreArgs.js";

const P1 = "⟦PII:PERSON_1⟧";
const P2 = "⟦PII:HR_OIB_2⟧";
const HALLUCINATED = "⟦PII:PERSON_9⟧";

/** A shield session that knows PERSON_1 and HR_OIB_2. */
function fakeShield(overrides: Partial<RestoreDeps> = {}) {
    const calls = { sessions: 0, deanonymize: [] as unknown[] };
    const known: Record<string, string> = { [P1]: "Ivan Horvat", [P2]: "12345678901" };
    const deps: RestoreDeps = {
        getSessionId: async () => {
            calls.sessions++;
            return "sess-1";
        },
        deanonymizeJson: async (_sessionId, data) => {
            calls.deanonymize.push(data);
            return {
                ok: true,
                data: (data as string[]).map((ph) => known[ph] ?? ph),
            };
        },
        ...overrides,
    };
    return { deps, calls };
}

describe("restorePlaceholders", () => {
    it("restores placeholders in nested tool arguments for the file", async () => {
        const { deps } = fakeShield();
        const args = {
            title: `Ugovor — ${P1}`,
            sections: [{ heading: "Stranke", content: `${P1}, OIB ${P2}, i ${P1}.` }],
        };
        const map = await restorePlaceholders(args, "chat-1", deps);
        assert.ok(map);
        assert.deepEqual(map.restore(args), {
            title: "Ugovor — Ivan Horvat",
            sections: [
                {
                    heading: "Stranke",
                    content: "Ivan Horvat, OIB 12345678901, i Ivan Horvat.",
                },
            ],
        });
    });

    it("masks restored values again in anything returned to the model", async () => {
        const { deps } = fakeShield();
        const map = await restorePlaceholders([`${P1} ${P2}`], "chat-1", deps);
        assert.ok(map);
        const errors = [
            { index: 0, reason: 'Could not locate find="Ivan Horvat, OIB 12345678901" in the document.' },
        ];
        assert.deepEqual(map.mask(errors), [
            { index: 0, reason: `Could not locate find="${P1}, OIB ${P2}" in the document.` },
        ]);
    });

    it("leaves a placeholder the session does not know as it is", async () => {
        const { deps } = fakeShield();
        const map = await restorePlaceholders({ t: `${HALLUCINATED} i ${P1}` }, "chat-1", deps);
        assert.ok(map);
        assert.deepEqual(map.restore({ t: `${HALLUCINATED} i ${P1}` }), {
            t: `${HALLUCINATED} i Ivan Horvat`,
        });
    });

    it("skips the shield entirely when there are no placeholders", async () => {
        const { deps, calls } = fakeShield();
        const map = await restorePlaceholders({ title: "Ugovor o zakupu" }, "chat-1", deps);
        assert.equal(map, EMPTY_PLACEHOLDER_MAP);
        assert.equal(calls.sessions, 0);
        assert.equal(calls.deanonymize.length, 0);
    });

    it("refuses (null) when placeholders cannot be resolved", async () => {
        const noSession = fakeShield({ getSessionId: async () => null });
        assert.equal(await restorePlaceholders({ t: P1 }, "chat-1", noSession.deps), null);

        const down = fakeShield({
            deanonymizeJson: async () => ({ ok: false, error: "sidecar down", status: 503 }),
        });
        assert.equal(await restorePlaceholders({ t: P1 }, "chat-1", down.deps), null);

        const malformed = fakeShield({
            deanonymizeJson: async () => ({ ok: true, data: { not: "an array" } }),
        });
        assert.equal(await restorePlaceholders({ t: P1 }, "chat-1", malformed.deps), null);
    });

    it("sends each distinct placeholder once", async () => {
        const { deps, calls } = fakeShield();
        await restorePlaceholders({ a: `${P1} ${P1}`, b: [P2, P1] }, "chat-1", deps);
        assert.deepEqual(calls.deanonymize, [[P1, P2]]);
    });
});

describe("buildPlaceholderMap / stripPlaceholders", () => {
    it("masks the longest original first", () => {
        const map = buildPlaceholderMap(
            new Map([
                ["⟦PII:PERSON_1⟧", "Ivan"],
                ["⟦PII:PERSON_2⟧", "Ivan Horvat"],
            ]),
        );
        assert.equal(map.mask("Ivan Horvat i Ivan"), "⟦PII:PERSON_2⟧ i ⟦PII:PERSON_1⟧");
    });

    it("strips placeholders from names the model will see again", () => {
        assert.equal(stripPlaceholders(`Ugovor ${P1} — nacrt`), "Ugovor  — nacrt");
    });
});
