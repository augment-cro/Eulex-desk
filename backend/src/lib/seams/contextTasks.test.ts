import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    buildContextTasksCatalog,
    contextTaskWorkflowId,
    contextTasks,
    hasContextTasks,
    registerContextTasks,
    renderContextTaskPrompt,
    CONTEXT_TASKS_INSTRUCTION,
    TASK_PLAN_REMINDER,
} from "./contextTasks.js";
import { buildContextsSystemBlock, type ResolvedContext } from "./contextsRuntime.js";
import { DEFAULT_CONTEXTS_FOOTER } from "./promptPack.js";
import type { ContextTask } from "./contextsClient.js";
import type { WorkflowStore } from "../chatTools.js";

const CTX = "8f3c2a10-0000-4000-8000-000000000001";

const rt02: ContextTask = {
    id: "RT-02",
    name: "Klasifikacija UI sustava",
    summary: "Razvrstava sustav prema Aktu o umjetnoj inteligenciji.",
    status: "ready",
    prompt_md: "# RT-02\n1. Prikupi opis sustava.",
};
const rt10: ContextTask = {
    id: "RT-10",
    name: "Provjera usklađenosti dokumenta",
    name_i18n: { hr: "Provjera usklađenosti dokumenta", en: "Document compliance review" },
    summary: "Provjerava dokument\nprema zahtjevima AZOP-a.",
    inputs: { required: ["Dokument za provjeru"], optional: ["Sektor"] },
    checks: ["AZ po vrsti dokumenta", "AA-20 … AA-27"],
    output: { kind: "docx", name: "Izvještaj o usklađenosti" },
    done_when: ["Svaka provjera ima nalaz", "Izvještaj je izrađen"],
    status: "draft",
    prompt_md: "# RT-10 Provjera\n1. Pročitaj dokument.\n2. Provjeri AA-20.",
};

const sys = (over: Partial<ResolvedContext> = {}): ResolvedContext => ({
    id: CTX,
    instructions_md: "\n\n---\nEU AI GOVERNANCE\n---\n",
    sources: [],
    name: "EU AI Governance",
    level: "system",
    tasks: [rt02, rt10],
    ...over,
});

describe("context tasks — the catalog in the system prompt", () => {
    it("one line per task with its workflow id, drafts marked, then how to run one", () => {
        const catalog = buildContextTasksCatalog([sys()]);
        assert.equal(
            catalog,
            "TASKS OF THE ACTIVE CONTEXTS — only this catalog is here; a task's steps are loaded with read_workflow:\n" +
                `- RT-02 Klasifikacija UI sustava — Razvrstava sustav prema Aktu o umjetnoj inteligenciji. (workflow_id: ctx-${CTX}-RT-02)\n` +
                `- RT-10 Provjera usklađenosti dokumenta (draft) — Provjerava dokument prema zahtjevima AZOP-a. (workflow_id: ctx-${CTX}-RT-10)\n` +
                `${CONTEXT_TASKS_INSTRUCTION}\n`,
        );
        assert.ok(!catalog.includes("Pročitaj dokument"), "never the steps");
        assert.equal(buildContextTasksCatalog([sys()]), catalog, "deterministic");
    });

    it("is empty when no active context has tasks; personal contexts and malformed tasks bring none", () => {
        assert.equal(buildContextTasksCatalog([]), "");
        assert.equal(buildContextTasksCatalog([sys({ tasks: undefined })]), "");
        const personal = sys({ id: "p", level: "personal" });
        assert.deepEqual(contextTasks([personal]), []);
        const broken = sys({
            tasks: [
                { ...rt02, id: "rt-2" },
                { ...rt02, id: "RT-03", name: " " },
                { ...rt02, id: "RT-04", prompt_md: undefined },
                rt02,
                rt02,
            ],
        });
        assert.deepEqual(contextTasks([broken]).map((t) => t.task.id), ["RT-02"]);
        assert.equal(hasContextTasks([personal]), false);
        assert.equal(hasContextTasks([sys()]), true);
    });

    it("sits after the context blocks and before the footer; the block is unchanged without tasks", () => {
        const block = buildContextsSystemBlock([sys()]);
        const at = block.indexOf("TASKS OF THE ACTIVE CONTEXTS");
        assert.ok(block.indexOf("EU AI GOVERNANCE") < at);
        assert.ok(at < block.indexOf(DEFAULT_CONTEXTS_FOOTER));
        const plain = buildContextsSystemBlock([sys({ tasks: undefined })]);
        assert.ok(!plain.includes("TASKS OF THE ACTIVE CONTEXTS"));
        assert.ok(plain.endsWith(`---\n\n${DEFAULT_CONTEXTS_FOOTER}\n---\n`));
    });
});

describe("context tasks — the workflow store", () => {
    it("registers each task as ctx-<context>-<task> with its contract, steps and the plan reminder", () => {
        const store: WorkflowStore = new Map([["wf-1", { title: "Moj", prompt_md: "x" }]]);
        registerContextTasks(store, [sys()]);
        assert.deepEqual([...store.keys()], ["wf-1", `ctx-${CTX}-RT-02`, `ctx-${CTX}-RT-10`]);
        const wf = store.get(contextTaskWorkflowId(CTX, "RT-10"));
        assert.equal(wf?.title, "RT-10 Provjera usklađenosti dokumenta");
        assert.equal(wf?.prompt_md, renderContextTaskPrompt(rt10));
        assert.equal(
            renderContextTaskPrompt(rt10),
            [
                "TASK RT-10 — Provjera usklađenosti dokumenta (draft: still being prepared — say so to the user)",
                "Required inputs:",
                "- Dokument za provjeru",
                "Optional inputs:",
                "- Sektor",
                "Checks to run:",
                "- AZ po vrsti dokumenta",
                "- AA-20 … AA-27",
                "Output: docx — Izvještaj o usklađenosti",
                "Done when:",
                "- Svaka provjera ima nalaz",
                "- Izvještaj je izrađen",
                "",
                "---",
                "",
                "# RT-10 Provjera\n1. Pročitaj dokument.\n2. Provjeri AA-20.",
                "",
                "---",
                TASK_PLAN_REMINDER,
            ].join("\n"),
        );
        // A ready task without a contract: the title line, the steps, the reminder.
        assert.equal(
            renderContextTaskPrompt(rt02),
            `TASK RT-02 — Klasifikacija UI sustava\n\n---\n\n# RT-02\n1. Prikupi opis sustava.\n\n---\n${TASK_PLAN_REMINDER}`,
        );
    });

    it("registers nothing without active tasks", () => {
        const store: WorkflowStore = new Map();
        registerContextTasks(store, undefined);
        registerContextTasks(store, [sys({ level: "personal" })]);
        assert.equal(store.size, 0);
    });
});
