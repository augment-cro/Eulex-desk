import type { AssessmentSnapshot, AssistantEvent } from "../shared/types";

/** A streamed assessment snapshot, or null when it is not one. */
export function parseAssessmentSnapshot(v: unknown): AssessmentSnapshot | null {
    if (!v || typeof v !== "object") return null;
    const a = v as Partial<AssessmentSnapshot>;
    if (typeof a.assessment_id !== "string" || !Number.isInteger(a.version)) return null;
    if (!Array.isArray(a.findings) || !a.counts || typeof a.counts !== "object") return null;
    return {
        ...(a as AssessmentSnapshot),
        facts: Array.isArray(a.facts) ? a.facts : [],
        decisions: Array.isArray(a.decisions) ? a.decisions : [],
        unread_documents: Array.isArray(a.unread_documents) ? a.unread_documents : [],
        source_conflicts: Array.isArray(a.source_conflicts) ? a.source_conflicts : [],
        superseded: Array.isArray(a.superseded) ? a.superseded : [],
    };
}

/** The assessment a message shows: its latest assessment_recorded. */
export function latestAssessment(
    events: AssistantEvent[] | undefined,
): AssessmentSnapshot | null {
    for (let i = (events?.length ?? 0) - 1; i >= 0; i--) {
        const e = events![i];
        if (e.type === "assessment_recorded") return parseAssessmentSnapshot(e.assessment);
    }
    return null;
}
