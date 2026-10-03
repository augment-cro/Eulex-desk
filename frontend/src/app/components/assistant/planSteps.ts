import type { AssistantEvent, PlanStep } from "../shared/types";

const STATUSES: readonly PlanStep["status"][] = [
    "pending",
    "in_progress",
    "done",
    "blocked",
];

/** The steps of a streamed plan_updated event; malformed steps are dropped. */
export function parsePlanSteps(v: unknown): PlanStep[] {
    if (!Array.isArray(v)) return [];
    return v.flatMap((s): PlanStep[] => {
        if (!s || typeof s !== "object") return [];
        const { title, status, note } = s as Record<string, unknown>;
        if (typeof title !== "string" || !title.trim()) return [];
        if (!STATUSES.includes(status as PlanStep["status"])) return [];
        return [
            {
                title,
                status: status as PlanStep["status"],
                ...(typeof note === "string" && note.trim() ? { note } : {}),
            },
        ];
    });
}

/** The plan a message shows: its latest plan_updated (each one replaces the plan). */
export function latestPlanSteps(
    events: AssistantEvent[] | undefined,
): PlanStep[] | null {
    for (let i = (events?.length ?? 0) - 1; i >= 0; i--) {
        const e = events![i];
        if (e.type === "plan_updated") return e.steps.length ? e.steps : null;
    }
    return null;
}
