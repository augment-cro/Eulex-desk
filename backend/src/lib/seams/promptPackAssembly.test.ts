import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
    __setPromptPackForTests,
    __resetPromptPackForTests,
    type PromptPack,
} from "./promptPack.js";
import {
    buildCoreSystemPrompt,
    buildMcpPromptAddenda,
    buildMessages,
} from "../chatTools.js";
import { localeContextForLlm } from "../uiLocale.js";

/**
 * Standalone-core rule for the governance prompt seam: with GOVERNANCE_URL /
 * GOVERNANCE_SERVICE_SECRET unset the core assembles a fully functional
 * GENERIC system prompt — no proprietary legal-methodology content (that
 * lives only in the governance service's pack), no errors. With a pack
 * pinned, its blocks land at the exact assembly positions with the
 * documented placeholder substitutions.
 *
 * NOTE: the proprietary markers below are deliberately split so this file
 * itself never contains the moved phrases.
 */

const GOV_ENVS = ["GOVERNANCE_URL", "GOVERNANCE_SERVICE_SECRET"] as const;
const saved: Record<string, string | undefined> = {};

// Phrases that exist ONLY in the moved (proprietary) blocks.
const PROPRIETARY_MARKERS = [
    "LEGAL" + " REASONING & METHOD",
    "LAYERED" + " EU + NATIONAL RESEARCH",
    "TOPIC ROUTING" + " ACROSS DOMAIN SOURCES",
    "Obiteljskog" + " zakona",
    "PRAVNA METODA" + " NA HRVATSKOM",
];

// NON-proprietary fixture pack (fake block texts only).
const FIXTURE_PACK: PromptPack = {
    version: 3,
    blocks: {
        method: "FIXTURE METHOD BLOCK",
        citations_legal: "FIXTURE CITATIONS BLOCK",
        grounding: "\n\n---\nFIXTURE GROUNDING 1. {{GROUNDING_POINT_1}}\n---\n",
        grounding_point1_eulex: "FIXTURE EULEX BRANCH",
        grounding_point1_generic: "FIXTURE GENERIC BRANCH",
        jurisdictions: "\n\n---\nFIXTURE JURISDICTIONS: {{ACTIVE_JURISDICTIONS}}\n---\n",
        layered_research: "\n\n---\nFIXTURE LAYERED\n---\n",
        topic_routing: "\n\n---\nFIXTURE ROUTING\n---\n",
        locale_legal: { hr: "FIXTURE HR LEGAL", en: "FIXTURE EN LEGAL" },
    },
    workflow_packs: [],
    enrichment_prompt: "",
};

const eulexServer = { row: { slug: "sys-eulex", name: "EULEX" } };
const zakonServer = { row: { slug: "sys-zakon-hr", name: "Zakon.hr" } };

function assembleFullPrompt(locale: "hr" | "en"): string {
    const apiMessages = buildMessages(
        [{ role: "user", content: "probe" }],
        [],
        localeContextForLlm(locale, { omitReferenceTime: true }),
    ) as { role: string; content: string }[];
    return apiMessages[0].content + buildMcpPromptAddenda([eulexServer, zakonServer]);
}

describe("standalone core — governance prompt seam unset (generic prompt)", () => {
    beforeEach(() => {
        for (const env of GOV_ENVS) {
            saved[env] = process.env[env];
            delete process.env[env];
        }
        __resetPromptPackForTests();
    });
    afterEach(() => {
        for (const env of GOV_ENVS) {
            if (saved[env] === undefined) delete process.env[env];
            else process.env[env] = saved[env];
        }
        __resetPromptPackForTests();
    });

    it("chat assembly does not throw and carries the generic method block", () => {
        for (const locale of ["hr", "en"] as const) {
            const prompt = assembleFullPrompt(locale);
            assert.ok(prompt.includes("LEGAL METHOD (generic):"));
            assert.ok(prompt.includes("recommend independent review by a qualified lawyer"));
            // Grounding fallback + jurisdictions fallback with the labels substituted
            assert.ok(prompt.includes("GROUNDING SOURCES — live research tools"));
            assert.ok(prompt.includes("EU law (EUR-Lex / CJEU scope); Croatian law"));
            assert.ok(!prompt.includes("{{ACTIVE_JURISDICTIONS}}"));
        }
    });

    it("no proprietary strings appear anywhere in the assembled output", () => {
        for (const locale of ["hr", "en"] as const) {
            const prompt = assembleFullPrompt(locale);
            for (const marker of PROPRIETARY_MARKERS) {
                assert.ok(
                    !prompt.includes(marker),
                    `proprietary marker leaked into ${locale} prompt: ${marker}`,
                );
            }
        }
    });
});

describe("prompt assembly with a pinned pack", () => {
    beforeEach(() => __setPromptPackForTests(FIXTURE_PACK));
    afterEach(() => __resetPromptPackForTests());

    it("inserts method + citations blocks at their base-prompt positions", () => {
        const prompt = buildCoreSystemPrompt();
        const method = prompt.indexOf("FIXTURE METHOD BLOCK");
        const docCitations = prompt.indexOf("DOCUMENT CITATION INSTRUCTIONS");
        const legalCitations = prompt.indexOf("FIXTURE CITATIONS BLOCK");
        const capabilities = prompt.indexOf("DOCX GENERATION:");
        assert.ok(method > 0 && docCitations > method);
        assert.ok(legalCitations > docCitations && capabilities > legalCitations);
    });

    it("substitutes the grounding branch and jurisdiction labels", () => {
        const withEulex = buildMcpPromptAddenda([eulexServer, zakonServer]);
        assert.ok(withEulex.includes("FIXTURE GROUNDING 1. FIXTURE EULEX BRANCH"));
        assert.ok(
            withEulex.includes(
                "FIXTURE JURISDICTIONS: EU law (EUR-Lex / CJEU scope); Croatian law (EU Member State — EU law applies within it)",
            ),
        );
        assert.ok(withEulex.includes("FIXTURE LAYERED"));
        assert.ok(withEulex.includes("FIXTURE ROUTING"));

        const withoutEulex = buildMcpPromptAddenda([zakonServer]);
        assert.ok(withoutEulex.includes("FIXTURE GROUNDING 1. FIXTURE GENERIC BRANCH"));
        assert.ok(!withoutEulex.includes("FIXTURE LAYERED")); // needs EU + Member State
        assert.ok(!withoutEulex.includes("FIXTURE ROUTING")); // needs >1 jurisdiction
    });

    it("inserts the locale legal halves into the locale block", () => {
        assert.ok(localeContextForLlm("hr").includes("FIXTURE HR LEGAL"));
        assert.ok(localeContextForLlm("en").includes("FIXTURE EN LEGAL"));
        assert.ok(!localeContextForLlm("en").includes("FIXTURE HR LEGAL"));
    });
});
