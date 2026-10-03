import { describe, expect, it } from "vitest";
import { checkerPath, classificationDecisions, isCheckerDecision } from "./assessmentDecisions";
import { parseAssessmentSnapshot } from "./assessmentEvents";
import type { AssessmentDecision, AssessmentFact } from "../shared/types";

const decision = (over: Partial<AssessmentDecision>): AssessmentDecision => ({
    id: "D-1",
    use_case_id: "U1",
    topic: "t",
    classification: null,
    reasoning: "r",
    legal_sources: ["čl. 6. st. 2. Akta"],
    fact_ids: [],
    ...over,
});

const facts: AssessmentFact[] = [
    {
        id: "F1",
        statement: "Sustav rangira kandidate",
        status: "document_supported",
        evidence: [
            { doc_id: "doc-1", filename: "Politika.docx", quote: "rangira", page: "str. 2" },
            { doc_id: "doc-1", filename: "Politika.docx", quote: "rangira opet", page: "str. 2" },
        ],
    },
    { id: "F2", statement: "Odluku donosi čovjek", status: "user_asserted", evidence: [] },
];

describe("assessment decisions", () => {
    it("a Checker step is a decision whose id starts with CHK-", () => {
        expect(isCheckerDecision(decision({ id: "CHK-U1-QAIS5" }))).toBe(true);
        expect(isCheckerDecision(decision({ id: "chk-U1-Q1" }))).toBe(true);
        expect(isCheckerDecision(decision({ id: "D-U1-klasifikacija" }))).toBe(false);
    });

    it("the Checker path keeps record order, gathers the evidence of its facts once and marks where the decision fell", () => {
        const path = checkerPath({
            facts,
            decisions: [
                decision({ id: "CHK-U1-Q1", fact_ids: ["F2"] }),
                decision({ id: "D-other", classification: "nejasno", fact_ids: ["F1"] }),
                decision({ id: "CHK-U1-QAIS5", classification: "potencijalno visokorizičan", fact_ids: ["F1", "F2", "F9"] }),
            ],
        });
        expect(path.map((s) => [s.decision.id, s.decisive])).toEqual([
            ["CHK-U1-Q1", false],
            ["CHK-U1-QAIS5", true],
        ]);
        expect(path[0].evidence).toEqual([]);
        expect(path[0].factStatuses).toEqual(["user_asserted"]);
        expect(path[1].evidence).toEqual(["Politika.docx, str. 2"]);
        expect(path[1].factStatuses).toEqual(["document_supported", "user_asserted"]);
    });

    it("classification decisions are the ones with a classification, Checker or not", () => {
        const out = classificationDecisions({
            decisions: [
                decision({ id: "CHK-U1-Q1" }),
                decision({ id: "CHK-U1-QAIS5", classification: "visokorizičan" }),
                decision({ id: "D-U2", classification: "nejasno" }),
            ],
        });
        expect(out.map((d) => d.id)).toEqual(["CHK-U1-QAIS5", "D-U2"]);
    });

    it("a snapshot from an older core without facts or decisions still parses", () => {
        const a = parseAssessmentSnapshot({ assessment_id: "A-1", version: 1, findings: [], counts: {} });
        expect(a?.facts).toEqual([]);
        expect(a?.decisions).toEqual([]);
    });
});
