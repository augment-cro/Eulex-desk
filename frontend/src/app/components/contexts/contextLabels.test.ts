import { describe, it, expect } from "vitest";
import {
    groupSources,
    parseContextsUnavailable,
    sourceGroup,
    unavailableNames,
} from "./contextLabels";

describe("source categories", () => {
    it("assigns each source to one category", () => {
        expect(sourceGroup({ kind: "legal_instrument", authority_tier: "1" })).toBe("law");
        expect(sourceGroup({ kind: "caselaw", authority_tier: "3" })).toBe("caselaw");
        expect(sourceGroup({ kind: "web", authority_tier: "2" })).toBe("official");
        expect(sourceGroup({ kind: "web", authority_tier: "5" })).toBe("other");
        expect(sourceGroup({ kind: "document", authority_tier: "2" })).toBe("documents");
    });
    it("groups in display order and drops empty categories", () => {
        const g = groupSources([
            { kind: "web", authority_tier: "5" },
            { kind: "caselaw", authority_tier: "3" },
            { kind: "legal_instrument", authority_tier: "1" },
        ] as const);
        expect(g.map((x) => x.group)).toEqual(["law", "caselaw", "other"]);
    });
});

describe("what an answer ran without", () => {
    it("keeps well-formed entries of a streamed event, drops the rest", () => {
        expect(
            parseContextsUnavailable([
                { kind: "context", name: "", id: "c1" },
                { kind: "document", name: "AZOP smjernice" },
                { kind: "source", name: "x" },
                { kind: "document" },
                null,
            ]),
        ).toEqual([
            { kind: "context", name: "", id: "c1" },
            { kind: "document", name: "AZOP smjernice" },
        ]);
        expect(parseContextsUnavailable(undefined)).toEqual([]);
    });

    it("names a context that failed to load from the user's list, in the UI locale, else the fallback", () => {
        const known = [
            {
                id: "c1",
                name: "EU AI Governance",
                name_i18n: { hr: "Upravljanje UI u EU", en: null },
            },
        ];
        const missing = [
            { kind: "context" as const, name: "", id: "c1" },
            { kind: "context" as const, name: "", id: "c2" },
            { kind: "document" as const, name: " AZOP smjernice " },
        ];
        expect(unavailableNames(missing, known, "hr", "aktivni kontekst")).toEqual([
            "Upravljanje UI u EU",
            "aktivni kontekst",
            "AZOP smjernice",
        ]);
        expect(unavailableNames(missing, known, "en", "an active context")[0]).toBe(
            "EU AI Governance",
        );
    });
});
