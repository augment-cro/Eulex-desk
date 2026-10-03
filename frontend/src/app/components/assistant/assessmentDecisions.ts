import type { AssessmentDecision, AssessmentSnapshot } from "../shared/types";

/**
 * The decisions of an assessment record as the REZULTAT card shows them.
 * A context task records each answered question of the EU AI Act Compliance
 * Checker as a decision with an id starting "CHK-" (the context's
 * convention, so it works with any record schema); the one that carries a
 * classification is where the decision fell.
 */

export const isCheckerDecision = (d: AssessmentDecision) => /^CHK-/i.test(d.id.trim());

/** Decisions that classify a use case, in record order. */
export function classificationDecisions(a: Pick<AssessmentSnapshot, "decisions">): AssessmentDecision[] {
    return a.decisions.filter((d) => d.classification);
}

export interface DecisionStep {
    decision: AssessmentDecision;
    /** "file, page" of every piece of evidence behind its facts, once each. */
    evidence: string[];
    /** Status of the facts it rests on (user_asserted, document_supported …), once each. */
    factStatuses: string[];
    /** It classifies — for a Checker question: the decision fell here. */
    decisive: boolean;
}

/** Every decision with the evidence of its facts, in record order. */
export function decisionSteps(a: Pick<AssessmentSnapshot, "decisions" | "facts">): DecisionStep[] {
    const facts = new Map(a.facts.map((f) => [f.id, f]));
    return a.decisions.map((decision) => {
        const evidence = new Set<string>();
        const factStatuses = new Set<string>();
        for (const id of decision.fact_ids) {
            const fact = facts.get(id);
            if (!fact) continue;
            factStatuses.add(fact.status);
            for (const e of fact.evidence) evidence.add(`${e.filename ?? e.doc_id}${e.page ? `, ${e.page}` : ""}`);
        }
        return {
            decision,
            evidence: [...evidence],
            factStatuses: [...factStatuses],
            decisive: !!decision.classification,
        };
    });
}

/** The Checker questions answered in the record, in record order. */
export function checkerPath(a: Pick<AssessmentSnapshot, "decisions" | "facts">): DecisionStep[] {
    return decisionSteps(a).filter((s) => isCheckerDecision(s.decision));
}
