/**
 * The visible step plan of a task or workflow the model is applying: the
 * update_plan tool replaces the whole plan on every call, streams a
 * `plan_updated` event (persisted with the answer's events like any other)
 * and the UI shows the latest one as the PLAN card above the answer.
 *
 * Offered only when it can matter — an active context has tasks, or a
 * workflow was selected in the conversation — so ordinary chats carry no
 * extra tool tokens.
 */
import { hasContextTasks } from "./seams/contextTasks";
import type { ResolvedContext } from "./seams/contextsRuntime";

export const PLAN_STEP_STATUSES = ["pending", "in_progress", "done", "blocked"] as const;
export type PlanStepStatus = (typeof PLAN_STEP_STATUSES)[number];

export interface PlanStep {
    title: string;
    status: PlanStepStatus;
    note?: string;
}

export type PlanUpdatedEvent = { type: "plan_updated"; steps: PlanStep[] };

export const MAX_PLAN_STEPS = 20;
const MAX_TITLE_CHARS = 120;
const MAX_NOTE_CHARS = 200;

export const UPDATE_PLAN_TOOL = {
    type: "function",
    function: {
        name: "update_plan",
        description:
            "Publish or update the step plan of the task or workflow you are applying; the user sees it as a checklist above your answer. Call it right after loading the task with read_workflow (every step, the first one in_progress), then again whenever a step's status changes. Each call replaces the whole plan. At most 20 steps; titles short (≤ 120 characters) and in the user's language.",
        parameters: {
            type: "object",
            properties: {
                steps: {
                    type: "array",
                    description: "The whole plan, in order",
                    items: {
                        type: "object",
                        properties: {
                            title: { type: "string", description: "Short step title" },
                            status: {
                                type: "string",
                                enum: [...PLAN_STEP_STATUSES],
                            },
                            note: {
                                type: "string",
                                description:
                                    "Optional one-line note (≤ 200 characters), e.g. what a blocked step is waiting for",
                            },
                        },
                        required: ["title", "status"],
                    },
                },
            },
            required: ["steps"],
        },
    },
};

/** One line, cut to `max` characters with an ellipsis. */
function clip(s: string, max: number): string {
    const t = s.replace(/\s+/g, " ").trim();
    return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

/**
 * Validate update_plan arguments. Structure errors are refused (the model
 * gets the reason and resends the plan); over-long text is clipped.
 */
export function parsePlanSteps(
    args: Record<string, unknown>,
): { ok: true; steps: PlanStep[] } | { ok: false; error: string } {
    const raw = args.steps;
    if (!Array.isArray(raw) || raw.length === 0) {
        return { ok: false, error: "steps must be a non-empty list" };
    }
    if (raw.length > MAX_PLAN_STEPS) {
        return { ok: false, error: `a plan has at most ${MAX_PLAN_STEPS} steps (got ${raw.length})` };
    }
    const steps: PlanStep[] = [];
    for (const [i, item] of raw.entries()) {
        const step = (item ?? {}) as Record<string, unknown>;
        const title = typeof step.title === "string" ? clip(step.title, MAX_TITLE_CHARS) : "";
        if (!title) return { ok: false, error: `step ${i + 1} has no title` };
        const status = step.status;
        if (!PLAN_STEP_STATUSES.includes(status as PlanStepStatus)) {
            return {
                ok: false,
                error: `step ${i + 1} has an unknown status (use ${PLAN_STEP_STATUSES.join(", ")})`,
            };
        }
        const note = typeof step.note === "string" ? clip(step.note, MAX_NOTE_CHARS) : "";
        steps.push({ title, status: status as PlanStepStatus, ...(note ? { note } : {}) });
    }
    return { ok: true, steps };
}

/** The short tool result the model gets back. */
export function planAck(steps: PlanStep[]): string {
    const done = steps.filter((s) => s.status === "done").length;
    return `Plan updated (${done}/${steps.length} done).`;
}

/**
 * The previous turn's latest plan, as one line for the tool-activity summary
 * (enrichWithPriorEvents) — the model keeps no tool results between turns,
 * and a task often continues after the user supplies a missing input.
 */
export function planSummaryLine(steps: PlanStep[]): string {
    return `- update_plan (latest): ${steps
        .map((s, i) => `${i + 1}. ${s.title} [${s.status}${s.note ? `: ${s.note}` : ""}]`)
        .join("; ")}`;
}

/**
 * Whether a turn offers update_plan: a workflow was selected in the
 * conversation, or an active context has tasks.
 */
export function offersPlanTool(
    workflowSelected: boolean | undefined,
    activeContexts: ResolvedContext[] | undefined,
): boolean {
    return workflowSelected === true || hasContextTasks(activeContexts);
}
