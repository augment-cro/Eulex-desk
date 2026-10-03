import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    MAX_PLAN_STEPS,
    UPDATE_PLAN_TOOL,
    offersPlanTool,
    parsePlanSteps,
    planAck,
    planSummaryLine,
} from "./plan.js";
import { enrichWithPriorEvents, runToolCalls, type ToolCall } from "./chatTools.js";

describe("update_plan — validation", () => {
    it("accepts a plan: titles and notes on one line, empty notes dropped", () => {
        const parsed = parsePlanSteps({
            steps: [
                { title: "Pročitaj  dokument\n", status: "done", note: "  " },
                { title: "Provjeri AA-20", status: "in_progress", note: "čeka\nprilog" },
                { title: "Izradi izvještaj", status: "pending" },
                { title: "Potpis", status: "blocked", note: "nedostaje ovlaštenje" },
            ],
        });
        assert.deepEqual(parsed, {
            ok: true,
            steps: [
                { title: "Pročitaj dokument", status: "done" },
                { title: "Provjeri AA-20", status: "in_progress", note: "čeka prilog" },
                { title: "Izradi izvještaj", status: "pending" },
                { title: "Potpis", status: "blocked", note: "nedostaje ovlaštenje" },
            ],
        });
    });

    it("clips over-long text instead of refusing it", () => {
        const parsed = parsePlanSteps({
            steps: [{ title: "x".repeat(300), status: "pending", note: "y".repeat(500) }],
        });
        assert.ok(parsed.ok);
        if (!parsed.ok) return;
        assert.equal(parsed.steps[0].title.length, 120);
        assert.ok(parsed.steps[0].title.endsWith("…"));
        assert.equal(parsed.steps[0].note?.length, 200);
    });

    it("refuses a missing or empty list, too many steps, a step without a title or with an unknown status", () => {
        assert.equal(parsePlanSteps({}).ok, false);
        assert.equal(parsePlanSteps({ steps: [] }).ok, false);
        const many = Array.from({ length: MAX_PLAN_STEPS + 1 }, (_, i) => ({ title: `k${i}`, status: "pending" }));
        assert.deepEqual(parsePlanSteps({ steps: many }), {
            ok: false,
            error: "a plan has at most 20 steps (got 21)",
        });
        assert.deepEqual(parsePlanSteps({ steps: [{ status: "done" }] }), {
            ok: false,
            error: "step 1 has no title",
        });
        assert.deepEqual(parsePlanSteps({ steps: [{ title: "a", status: "pending" }, { title: "b", status: "finished" }] }), {
            ok: false,
            error: "step 2 has an unknown status (use pending, in_progress, done, blocked)",
        });
    });

    it("the tool schema offers exactly the four statuses; the ack counts done steps", () => {
        const items = UPDATE_PLAN_TOOL.function.parameters.properties.steps.items;
        assert.deepEqual(items.properties.status.enum, ["pending", "in_progress", "done", "blocked"]);
        assert.equal(
            planAck([
                { title: "a", status: "done" },
                { title: "b", status: "pending" },
            ]),
            "Plan updated (1/2 done).",
        );
    });
});

describe("update_plan — offered only where a task or workflow is in play", () => {
    it("with a selected workflow or an active context that has tasks; not in an ordinary chat", () => {
        const sys = (tasks?: unknown[]) => ({
            id: "c1", instructions_md: "", sources: [], level: "system" as const,
            tasks: tasks as never,
        });
        const task = { id: "RT-10", name: "Provjera", summary: "…", status: "ready", prompt_md: "1. …" };
        assert.equal(offersPlanTool(undefined, undefined), false);
        assert.equal(offersPlanTool(false, [sys()]), false);
        assert.equal(offersPlanTool(true, []), true);
        assert.equal(offersPlanTool(false, [sys([task])]), true);
    });
});

describe("update_plan — through the tool dispatcher", () => {
    async function run(args: unknown) {
        const events: Record<string, unknown>[] = [];
        const write = (s: string) => {
            for (const line of s.split("\n"))
                if (line.startsWith("data: ")) events.push(JSON.parse(line.slice(6)));
        };
        const call: ToolCall = {
            id: "tc-plan",
            function: { name: "update_plan", arguments: JSON.stringify(args) },
        };
        const out = await runToolCalls(
            [call],
            new Map(),
            "user-1",
            {} as Parameters<typeof runToolCalls>[3],
            write,
        );
        return { out, events, result: out.toolResults[0] as { tool_call_id: string; content: string } };
    }

    it("streams plan_updated, returns it for the answer's events and acks the model", async () => {
        const { out, events, result } = await run({
            steps: [
                { title: "Pročitaj dokument", status: "done" },
                { title: "Provjeri AA-20", status: "in_progress" },
            ],
        });
        const event = {
            type: "plan_updated",
            steps: [
                { title: "Pročitaj dokument", status: "done" },
                { title: "Provjeri AA-20", status: "in_progress" },
            ],
        };
        assert.deepEqual(events, [event]);
        assert.deepEqual(out.plansUpdated, [event]);
        assert.deepEqual(result, { role: "tool", tool_call_id: "tc-plan", content: "Plan updated (1/2 done)." });
    });

    it("a refused plan streams nothing and tells the model why", async () => {
        const { out, events, result } = await run({ steps: [{ title: "a", status: "later" }] });
        assert.deepEqual(events, []);
        assert.deepEqual(out.plansUpdated, []);
        assert.match(result.content, /^update_plan refused: step 1 has an unknown status/);
    });
});

describe("update_plan — the next turn sees the latest plan", () => {
    it("the tool-activity summary carries the previous answer's latest plan only", async () => {
        const stored = [
            { type: "plan_updated", steps: [{ title: "Pročitaj dokument", status: "in_progress" }] },
            { type: "content", text: "…" },
            {
                type: "plan_updated",
                steps: [
                    { title: "Pročitaj dokument", status: "done" },
                    { title: "Provjeri AA-20", status: "blocked", note: "nedostaje prilog" },
                ],
            },
        ];
        const chain = {
            select: () => chain,
            eq: () => chain,
            order: () => chain,
            limit: async () => ({ data: [{ content: stored }] }),
        };
        const db = { from: () => chain } as unknown as Parameters<typeof enrichWithPriorEvents>[2];
        const out = await enrichWithPriorEvents(
            [
                { role: "user", content: "Provjeri ugovor" },
                { role: "assistant", content: "Nedostaje prilog." },
            ],
            "chat-1",
            db,
            {},
        );
        const expected = planSummaryLine([
            { title: "Pročitaj dokument", status: "done" },
            { title: "Provjeri AA-20", status: "blocked", note: "nedostaje prilog" },
        ]);
        assert.equal(
            expected,
            "- update_plan (latest): 1. Pročitaj dokument [done]; 2. Provjeri AA-20 [blocked: nedostaje prilog]",
        );
        assert.equal(
            out[1].content,
            `Nedostaje prilog.\n\n[Tool activity in your previous turn]\n${expected}`,
        );
    });
});
