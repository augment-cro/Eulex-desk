/**
 * Tasks of the active EULEX system contexts — workflows such as "RT-10
 * Provjera usklađenosti dokumenta" that a context's resolve (format 2)
 * returns (contracts/context-provider.openapi.json, ContextTask).
 *
 * Progressive disclosure: the system prompt carries only a catalog, one line
 * per task with its workflow id; the steps are loaded on demand with
 * read_workflow from the turn's WorkflowStore, where every active task is
 * registered as ctx-<context id>-<task id>. A task the user starts from the
 * context's "Zadaci" tab arrives as the ordinary [Workflow: … (id: …)]
 * marker. While the model works through a task it keeps a visible plan with
 * update_plan (lib/plan).
 */
import type { WorkflowStore } from "../chatTools";
import type { ContextTask } from "./contextsClient";
import type { ResolvedContext } from "./contextsRuntime";

/** RT-10: 2–4 capital letters, a hyphen, two digits (as the provider validates). */
const TASK_ID_RE = /^[A-Z]{2,4}-\d{2}$/;

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

export function contextTaskWorkflowId(contextId: string, taskId: string): string {
    return `ctx-${contextId}-${taskId}`;
}

export interface ActiveContextTask {
    contextId: string;
    workflowId: string;
    task: ContextTask;
}

/**
 * The tasks of the active system contexts that can run — a well-formed id,
 * a name and steps — contexts in the order given, each context's tasks as
 * the provider lists them. Personal contexts never bring tasks.
 */
export function contextTasks(active: ResolvedContext[] | undefined): ActiveContextTask[] {
    const out: ActiveContextTask[] = [];
    const seen = new Set<string>();
    for (const r of active ?? []) {
        if (r.level !== "system" || !Array.isArray(r.tasks)) continue;
        for (const task of r.tasks) {
            if (!task || typeof task.id !== "string" || !TASK_ID_RE.test(task.id)) continue;
            if (typeof task.name !== "string" || !task.name.trim()) continue;
            if (typeof task.prompt_md !== "string" || !task.prompt_md.trim()) continue;
            const workflowId = contextTaskWorkflowId(r.id, task.id);
            if (seen.has(workflowId)) continue;
            seen.add(workflowId);
            out.push({ contextId: r.id, workflowId, task });
        }
    }
    return out;
}

export function hasContextTasks(active: ResolvedContext[] | undefined): boolean {
    return contextTasks(active).length > 0;
}

const isDraft = (task: ContextTask) => task.status !== "ready";

/**
 * How to keep a task's structured result (lib/assessment): recorded as it
 * takes shape, continued as a new version, closed only on new evidence.
 */
export const ASSESSMENT_INSTRUCTION =
    "For a task with a structured result (facts, classification, findings), record it with record_assessment ONCE, when the findings are formed and before generating the Word or Excel output — every finding that is not ok with its next action and closure criterion — and use the counts it returns in your summary and documents. After that only patch it: assessment_id plus the changed or new items, never the whole record again. To continue an earlier assessment, call load_assessment first and send only the changed and new findings, with closed_by where the new evidence closes one; remove a finding only through superseded.";

export const CONTEXT_TASKS_INSTRUCTION =
    "When the user's request matches one of these tasks, or the user selected it, say which task you apply and load it with read_workflow(workflow_id) before starting. Publish its steps with update_plan and keep their status current as you work, ask the user for any missing required input instead of guessing, and finish only when its completion criteria are met. A task marked (draft) is still being prepared: say so when you apply it. " +
    ASSESSMENT_INSTRUCTION;

/**
 * The task catalog of the active contexts for the static (cached) contexts
 * block: one line per task, then how to run one. Deterministic — no
 * timestamps, task order as given — so the block stays byte-identical across
 * turns for the same context versions. Never carries the steps. Empty when
 * no active context has tasks. Pass the contexts in prompt order.
 */
export function buildContextTasksCatalog(activeInPromptOrder: ResolvedContext[]): string {
    const tasks = contextTasks(activeInPromptOrder);
    if (tasks.length === 0) return "";
    const lines = tasks.map(({ workflowId, task }) => {
        const summary = typeof task.summary === "string" ? oneLine(task.summary) : "";
        return (
            `- ${task.id} ${oneLine(task.name)}${isDraft(task) ? " (draft)" : ""}` +
            `${summary ? ` — ${summary}` : ""} (workflow_id: ${workflowId})`
        );
    });
    return (
        `TASKS OF THE ACTIVE CONTEXTS — only this catalog is here; a task's steps are loaded with read_workflow:\n` +
        `${lines.join("\n")}\n${CONTEXT_TASKS_INSTRUCTION}\n`
    );
}

export const TASK_PLAN_REMINDER =
    "Publish these steps with update_plan before you start and keep each step's status current; do not finish before every Done when criterion is met. " +
    ASSESSMENT_INSTRUCTION;

/**
 * What read_workflow returns for a task: its contract (inputs, checks,
 * output, completion criteria — the content stays in Croatian, as authored),
 * the steps, and a reminder of the plan and the completion criteria.
 */
export function renderContextTaskPrompt(task: ContextTask): string {
    const list = (label: string, items: string[] | undefined) =>
        items?.length ? [`${label}:`, ...items.map((i) => `- ${oneLine(i)}`)] : [];
    const output = task.output?.kind
        ? `Output: ${task.output.kind}${task.output.name ? ` — ${oneLine(task.output.name)}` : ""}`
        : null;
    const header = [
        `TASK ${task.id} — ${oneLine(task.name)}${isDraft(task) ? " (draft: still being prepared — say so to the user)" : ""}`,
        ...list("Required inputs", task.inputs?.required),
        ...list("Optional inputs", task.inputs?.optional),
        ...list("Checks to run", task.checks),
        ...(output ? [output] : []),
        ...list("Done when", task.done_when),
    ];
    return `${header.join("\n")}\n\n---\n\n${(task.prompt_md ?? "").trim()}\n\n---\n${TASK_PLAN_REMINDER}`;
}

/** The active context and workflow of a task id (for an assessment record). */
export function contextTaskForId(
    active: ResolvedContext[] | undefined,
    taskId: string,
): { context: { id: string; version_label?: string }; workflow: { id: string; title: string } } | null {
    const found = contextTasks(active).find((t) => t.task.id === taskId);
    if (!found) return null;
    const ctx = (active ?? []).find((r) => r.id === found.contextId);
    return {
        context: { id: found.contextId, ...(ctx?.version_label ? { version_label: ctx.version_label } : {}) },
        workflow: { id: found.workflowId, title: `${found.task.id} ${oneLine(found.task.name)}` },
    };
}

/**
 * Register the active contexts' tasks in the turn's workflow store, so
 * read_workflow and a selected task's [Workflow: …] marker work like any
 * workflow. Title: "<task id> <name>".
 */
export function registerContextTasks(
    store: WorkflowStore,
    active: ResolvedContext[] | undefined,
): void {
    for (const { workflowId, task } of contextTasks(active)) {
        store.set(workflowId, {
            title: `${task.id} ${oneLine(task.name)}`,
            prompt_md: renderContextTaskPrompt(task),
        });
    }
}
