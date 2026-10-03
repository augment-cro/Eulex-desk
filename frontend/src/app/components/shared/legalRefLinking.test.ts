import { describe, it, expect } from "vitest";
import {
    actMentionPosition,
    actTitleOf,
    applyLegalRefExtras,
    applyLegalRefs,
    articleSpansIn,
    autoLinkLegalRefs,
    createLegalRefCursor,
    markLegalRefExtras,
    namedActsIn,
    nearestActSpan,
    pickSourceForRef,
} from "./legalRefLinking";
import type { LegalRefExtra, LegalSource, MikeAnnotation } from "./types";

function src(
    id: string,
    title: string,
    articleLabel: string | null,
    extra: Partial<LegalSource> = {},
): LegalSource {
    return { id, scope: "@hr", title, articleLabel, kind: "regulation", ...extra };
}

const ZT7 = src("zt/7", "Zakon o trgovini, čl. 7", "Članak 7.");
const ZT8 = src("zt/8", "Zakon o trgovini, čl. 8", "Članak 8.");
const ZT9 = src("zt/9", "Zakon o trgovini, čl. 9", "Članak 9.");
const ZIM8 = src("zim/8", "Zakon o iznimnim mjerama kontrole cijena, čl. 8", "Članak 8.");
const ZIM6 = src("zim/6", "Zakon o iznimnim mjerama kontrole cijena, čl. 6", "Članak 6.");
const ODLUKA = src("odl", "Odluku o isticanju dodatne cijene kao mjera izravne kontrole cijena", null);
const GDPR6 = src(
    "@eu/celex/32016R0679#6",
    "Regulation (EU) 2016/679 of the European Parliament and of the Council on the protection of natural persons with regard to the processing of personal data (General Data Protection Regulation)",
    "Article 6",
    { scope: "@eu" },
);
const ZOR6 = src("zor/6", "Zakon o radu, čl. 6", "Članak 6.");

// The sentence from the 2026-09-19 report (NN 101/2026 Odluka), verbatim.
const SENTENCE =
    "Riječ je o Odluci o isticanju dodatne cijene kao mjera izravne kontrole cijena (NN 101/2026), koju je Vlada Republike Hrvatske donijela 10. rujna 2026. na temelju članka 8. stavka 1., u vezi s člankom 6. podstavkom 7. Zakona o iznimnim mjerama kontrole cijena (NN 40/25). Odluka stupa na snagu 1. listopada 2026.";

function run(text: string, sources: LegalSource[]) {
    const list: MikeAnnotation[] = [];
    const out = autoLinkLegalRefs(text, sources, list);
    const links = [...out.matchAll(/\[([^\]]+)\]\(#legal-cite-(\d+)\)/g)].map(
        (m) => ({
            text: m[1],
            source: (list[Number(m[2])] as { source: LegalSource }).source.id,
        }),
    );
    return { out, list, links };
}

describe("actTitleOf", () => {
    it("prefers the server's document title when present", () => {
        expect(
            actTitleOf(src("kz/153", "Kazneni zakon, čl. 153 — Silovanje", "Članak 153.", {
                documentTitle: "Kazneni zakon",
            })),
        ).toBe("Kazneni zakon");
    });
    it("strips the article suffix (and heading) from legacy HR titles", () => {
        expect(actTitleOf(ZT8)).toBe("Zakon o trgovini");
        expect(actTitleOf(ZIM6)).toBe("Zakon o iznimnim mjerama kontrole cijena");
        expect(actTitleOf(src("kz/153", "Kazneni zakon, čl. 153 — Silovanje", "Članak 153."))).toBe("Kazneni zakon");
        expect(actTitleOf(ODLUKA)).toBe(ODLUKA.title);
    });
    it("is null for court decisions", () => {
        expect(actTitleOf({ ...ZT8, kind: "caselaw" })).toBeNull();
    });
});

describe("namedActsIn / actMentionPosition", () => {
    it("recognises declined act names and ignores back-references", () => {
        expect(namedActsIn(" stavka 1. Zakona o trgovini")).toEqual({
            named: true,
            euPossible: false,
        });
        expect(namedActsIn(" iz članka 6. ovoga Zakona")).toEqual({
            named: false,
            euPossible: false,
        });
        expect(namedActsIn(" Opće uredbe o zaštiti podataka")).toEqual({
            named: true,
            euPossible: true,
        });
        // Nearest mention decides: a national act built ON an EU one.
        expect(namedActsIn(" Zakona o provedbi Opće uredbe")).toEqual({
            named: true,
            euPossible: false,
        });
        expect(namedActsIn("Opće uredbe, odnosno Zakona o", "before")).toEqual({
            named: true,
            euPossible: false,
        });
        expect(namedActsIn(" (NN 40/25) i dalje")).toEqual({
            named: false,
            euPossible: false,
        });
    });
    it("lowercase English nouns never count as an act", () => {
        expect(namedActsIn(" the parties act in good faith").named).toBe(false);
        expect(namedActsIn(" under the Consumer Rights Act 2015").named).toBe(true);
    });
    it("matches every content word by prefix, declension-tolerant", () => {
        const w = " podstavkom 7. Zakona o iznimnim mjerama kontrole cijena (NN 40/25)";
        expect(actMentionPosition(w, "Zakon o iznimnim mjerama kontrole cijena")).toBeGreaterThanOrEqual(0);
        expect(actMentionPosition(w, "Zakon o trgovini")).toBe(-1);
        expect(actMentionPosition(" prema Kaznenog zakona", "Kazneni zakon")).toBeGreaterThanOrEqual(0);
    });
});

describe("pickSourceForRef", () => {
    it("named act with a matching candidate wins over a same-number rival", () => {
        expect(pickSourceForRef([ZT8, ZIM8], " stavka 1. Zakona o iznimnim mjerama kontrole cijena", "")).toBe(ZIM8);
        expect(pickSourceForRef([ZT8, ZIM8], " stavku 1. Zakona o trgovini", "")).toBe(ZT8);
    });
    it("named act with NO candidate → nothing (never another act)", () => {
        expect(pickSourceForRef([ZT8], " stavka 1. Zakona o iznimnim mjerama kontrole cijena", "")).toBeNull();
    });
    it("EU keyword + one EU candidate → the EU source", () => {
        expect(pickSourceForRef([GDPR6, ZOR6], " Opće uredbe o zaštiti podataka", "")).toBe(GDPR6);
        expect(pickSourceForRef([GDPR6], " Opće uredbe o zaštiti podataka", "")).toBe(GDPR6);
        // "Zakona …" is never an EU instrument.
        expect(pickSourceForRef([GDPR6], " Zakona o provedbi Opće uredbe", "")).toBeNull();
    });
    it("no act named → number-only rule", () => {
        expect(pickSourceForRef([ZT8], " stavka 1. propisuje", "")).toBe(ZT8);
        expect(pickSourceForRef([ZT8, ZIM8], " stavka 1. propisuje", "")).toBeNull();
        expect(pickSourceForRef([], " Zakona o trgovini", "")).toBeNull();
    });
    it("falls back to the act named BEFORE the reference", () => {
        expect(pickSourceForRef([ZT8, ZIM8], " propisuje da", "Zakon o trgovini u članku")).toBe(ZT8);
    });
});

describe("autoLinkLegalRefs — NN 101/2026 report", () => {
    it("registry holds only Zakon o trgovini → neither reference links to it", () => {
        const { links } = run(SENTENCE, [ZT7, ZT8, ZT9]);
        expect(links).toEqual([]);
    });
    it("an act named two clauses later never claims the reference (nearest mention wins)", () => {
        const text =
            SENTENCE +
            " Prema članku 9. stavku 1. Zakona o trgovini, trgovina na malo je kupnja robe.";
        const { links } = run(text, [ZT7, ZT8, ZT9]);
        expect(links).toEqual([{ text: "članku 9", source: "zt/9" }]);
    });
    it("both acts harvested → čl. 8 and čl. 6 link to the named act, with the stavak pinpoint", () => {
        const { links, list } = run(SENTENCE, [ZT7, ZT8, ZT9, ZIM8, ZIM6, ODLUKA]);
        expect(links).toEqual([
            { text: "članka 8", source: "zim/8" },
            { text: "člankom 6", source: "zim/6" },
        ]);
        expect((list[0] as { pinpoint?: unknown }).pinpoint).toEqual({
            targets: [{ stavak: "1" }],
        });
        expect((list[1] as { pinpoint?: unknown }).pinpoint).toBeNull();
    });
    it("Zakon o trgovini references still link when the prose names it", () => {
        const text =
            "Prema članku 9. stavku 1. Zakona o trgovini, trgovina na malo je kupnja robe. Nasuprot tome, članak 7. stavak 1. istog Zakona određuje trgovinu na veliko.";
        const { links } = run(text, [ZT7, ZT8, ZT9, ZIM8, ZIM6]);
        expect(links).toEqual([
            { text: "članku 9", source: "zt/9" },
            // "istog Zakona" is a back-reference → number-only rule → unique 7.
            { text: "članak 7", source: "zt/7" },
        ]);
    });
});

describe("nearestActSpan — adjective before the keyword", () => {
    it("pulls in up to two words before the keyword, never digits", () => {
        expect(nearestActSpan(" stavak 1. Kaznenog zakona (NN 125/11)", "after")).toBe(
            "Kaznenog zakona (NN 125/11)",
        );
        expect(nearestActSpan(" stavka 2. Općeg poreznog zakona", "after")).toBe(
            "Općeg poreznog zakona",
        );
        expect(nearestActSpan(" stavka 1. Zakona o trgovini", "after")).toBe("Zakona o trgovini");
    });
});

// Staging 2026-09-24 ("koja je kazna za silovanje?"): every "… Kaznenog
// zakona" reference rendered unlinked — the act span started AT "zakona"
// and cut "Kaznenog" off. Only čl. 153 (no act named) and čl. 158 (a later
// "Kaznenog zakona" fell inside its span by luck) were underlined.
describe("autoLinkLegalRefs — Kazneni zakon (staging 2026-09-24)", () => {
    const kz = (n: string) =>
        src(`kz/${n}`, `Kazneni zakon, čl. ${n} — X`, `Članak ${n}.`, {
            documentTitle: "Kazneni zakon",
        });
    const KZ = ["154", "153", "44", "3", "158", "166", "46"].map(kz);
    const ANSWER =
        "U Hrvatskoj, članak 153. stavak 1. Kaznenog zakona (NN 125/11 … 136/25) propisuje: „Tko s drugom osobom bez njezina pristanka izvrši spolni odnošaj ili s njim izjednačenu spolnu radnju [...] kaznit će se kaznom zatvora od tri do osam godina.” Dakle, za osnovni oblik kazna je **od 3 do 8 godina zatvora**, a ako je djelo počinjeno uporabom sile ili ozbiljne prijetnje, prema članku 153. stavku 2., **od 5 do 12 godina**.\n\n" +
        "Za teške oblike kazna može iznositi **od 5 do 15 godina**, dok se za prouzročenje smrti silovane osobe izriče najmanje **5 godina zatvora**, prema članku 154. Kaznenog zakona. Za djela prema djetetu mlađem od 15 godina primjenjuju se posebne odredbe članaka 158. i 166.; kod ranije počinjenih djela ključan je datum počinjenja i primjena blažeg zakona prema članku 3. Kaznenog zakona.";

    it("links every reference to its Kazneni zakon article", () => {
        expect(run(ANSWER, KZ).links).toEqual([
            { text: "članak 153", source: "kz/153" },
            { text: "članku 153", source: "kz/153" },
            { text: "članku 154", source: "kz/154" },
            { text: "članaka 158", source: "kz/158" },
            // Enumeration — the keyword is not repeated before 166.
            { text: "166", source: "kz/166" },
            { text: "članku 3", source: "kz/3" },
        ]);
    });

    it("an adjective naming another act still blocks the link", () => {
        expect(run("Prema članku 3. Ovršnog zakona.", KZ).links).toEqual([]);
    });
});

describe("autoLinkLegalRefs — unchanged behaviour", () => {
    it("unique number, no act named → links", () => {
        expect(run("Vidi članak 8. stavak 2.", [ZT8]).links).toEqual([
            { text: "članak 8", source: "zt/8" },
        ]);
    });
    it("ambiguous number, no act named → no link", () => {
        expect(run("Vidi članak 8. stavak 2.", [ZT8, ZIM8]).links).toEqual([]);
    });
    it("GDPR cited in Croatian links the EU source", () => {
        expect(run("Obrada je zakonita prema članku 6. Opće uredbe o zaštiti podataka.", [GDPR6, ZOR6]).links).toEqual([
            { text: "članku 6", source: GDPR6.id },
        ]);
    });
    it("issue #43 suffix fallback survives, and respects the named act", () => {
        const base = src("zim/17", "Zakon o iznimnim mjerama kontrole cijena, čl. 17", "Članak 17.");
        const { links, list } = run("Prema čl. 17.a Zakona o iznimnim mjerama kontrole cijena.", [base, ZT8]);
        expect(links).toEqual([{ text: "čl. 17.a", source: "zim/17" }]);
        expect((list[0] as { source: LegalSource }).source.articleLabel).toMatch(/^Članak 17\.a\.?$/);
        // Same suffixed ref naming an act that holds no article 17 → nothing.
        expect(run("Prema čl. 17.a Zakona o trgovini.", [base, ZT8]).links).toEqual([]);
    });
    it("never doubles a model pill", () => {
        expect(run("članak 8. `§0§`", [ZT8]).links).toEqual([]);
    });
    it("no sources → text untouched", () => {
        expect(run(SENTENCE, []).out).toBe(SENTENCE);
    });
});

describe("applyLegalRefs — server-resolved references", () => {
    const refsFor = (
        rows: Array<[string, string, number, string | null, "linked" | "unverified" | "unresolved"]>,
    ) =>
        rows.map(([text, number, occurrence, source_id, status]) => ({
            text,
            number,
            occurrence,
            source_id,
            status,
            by: "model" as const,
        }));

    it("links by (number, occurrence), marks unverified, leaves unresolved plain", () => {
        const list: MikeAnnotation[] = [];
        const cursor = new Map<string, number>();
        const out = applyLegalRefs(
            "Vidi članak 8. stavak 2., zatim članak 8. i članak 99. te članak 5.",
            refsFor([
                ["članak 8", "8", 0, "zt/8", "linked"],
                ["članak 8", "8", 1, "zim/8", "linked"],
                ["članak 99", "99", 0, null, "unverified"],
                ["članak 5", "5", 0, null, "unresolved"],
            ]),
            [ZT8, ZIM8],
            list,
            cursor,
        );
        expect(out).toBe(
            "Vidi [članak 8](#legal-cite-0). stavak 2., zatim [članak 8](#legal-cite-1). i [članak 99](#legal-unverified). te članak 5.",
        );
        expect(list.map((a) => (a as { source: LegalSource }).source.id)).toEqual(["zt/8", "zim/8"]);
        expect((list[0] as { pinpoint?: unknown }).pinpoint).toEqual({ targets: [{ stavak: "2" }] });
    });

    it("occurrence counter carries across content events", () => {
        const list: MikeAnnotation[] = [];
        const cursor = createLegalRefCursor();
        const refs = refsFor([
            ["članak 8", "8", 0, "zt/8", "linked"],
            ["članak 8", "8", 1, "zim/8", "linked"],
        ]);
        const a = applyLegalRefs("Prvi članak 8.", refs, [ZT8, ZIM8], list, cursor);
        const b = applyLegalRefs("Drugi članak 8.", refs, [ZT8, ZIM8], list, cursor);
        expect(a).toBe("Prvi [članak 8](#legal-cite-0).");
        expect(b).toBe("Drugi [članak 8](#legal-cite-1).");
        expect((list[1] as { source: LegalSource }).source.id).toBe("zim/8");
    });

    it("a span the event does not know falls back to the local rule", () => {
        const list: MikeAnnotation[] = [];
        const out = applyLegalRefs(
            "Prema članku 9. stavku 1. Zakona o trgovini.",
            [],
            [ZT9],
            list,
            createLegalRefCursor(),
        );
        expect(out).toBe("Prema [članku 9](#legal-cite-0). stavku 1. Zakona o trgovini.");
    });

    it("a linked ref whose source has not arrived falls back, never crashes", () => {
        const out = applyLegalRefs(
            "Prema članku 8. Zakona o iznimnim mjerama kontrole cijena.",
            refsFor([["članku 8", "8", 0, "missing/8", "linked"]]),
            [ZT8],
            [],
            createLegalRefCursor(),
        );
        // Local rule: act named (ZIMKC) but only Zakon o trgovini has 8 → plain.
        expect(out).toBe("Prema članku 8. Zakona o iznimnim mjerama kontrole cijena.");
    });
});

// Same cases as backend legalRefs.test.ts — both sides must find the same
// spans, or the server's (number, occurrence) rows land on the wrong text.
describe("articleSpansIn — enumerations and ranges (parity with backend)", () => {
    const spans = (t: string) => articleSpansIn(t).map((s) => s.text);
    it("each enumerated / range end number is its own span", () => {
        expect(spans("posebne odredbe članaka 158. i 166.; kod")).toEqual(["članaka 158", "166"]);
        expect(spans("čl. 5., 7. i 9. Zakona o radu")).toEqual(["čl. 5", "7", "9"]);
        expect(spans("članci 10. do 15. ZOR-a")).toEqual(["članci 10", "15"]);
        expect(spans("članci 10.–15.")).toEqual(["članci 10", "15"]);
        expect(spans("Articles 5, 6 and 7 GDPR")).toEqual(["Articles 5", "6", "7"]);
        expect(spans("§§ 12-14 BGB")).toEqual(["§§ 12", "14"]);
    });
    it("never continues into amounts, dates, years or stavci", () => {
        expect(spans("prema članku 3. i 15 godina zatvora")).toEqual(["članku 3"]);
        expect(spans("prema članku 3. i 15. godine")).toEqual(["članku 3"]);
        expect(spans("vrijedi članak 5. do 31. prosinca")).toEqual(["članak 5"]);
        expect(spans("članak 153. stavak 1. i 2.")).toEqual(["članak 153"]);
        expect(spans("čl. 5 i 7")).toEqual(["čl. 5"]);
    });
});

describe("markLegalRefExtras / applyLegalRefExtras — model-found references", () => {
    const KZ = src("@hr/regulation/kz", "Kazneni zakon", null, { documentTitle: "Kazneni zakon" });
    const KZ166 = src("kz/166", "Kazneni zakon, čl. 166", "Članak 166.", { documentTitle: "Kazneni zakon" });
    const extra = (
        text: string,
        occurrence: number,
        kind: "act" | "article",
        source_id: string | null,
        status: "linked" | "unverified" = "linked",
    ): LegalRefExtra => ({
        text,
        occurrence,
        start: 0,
        kind,
        number: kind === "article" ? text : null,
        source_id,
        status,
        by: "model",
    });

    it("marks by text + occurrence across content events, then links", () => {
        const extras = [
            extra("Kaznenim zakonom", 1, "act", KZ.id),
            extra("166", 0, "article", KZ166.id),
            extra("ZKP-om", 0, "act", null, "unverified"),
            extra("Zakonom o radu", 0, "act", "missing/source"),
        ];
        const texts = [
            "U skladu s Kaznenim zakonom i ZKP-om [1]. ",
            null, // a non-content event between two content chunks
            "Opet prema Kaznenim zakonom, čl. 158 i 166 stavak 2. te Zakonom o radu.",
        ];
        const marked = markLegalRefExtras(texts, extras);
        expect(marked[1]).toBeNull();
        // A bare number never becomes "[166]" — the citation-marker rule
        // would eat it; sentinels carry it through preprocessing instead.
        expect(marked[2]).not.toContain("[166]");
        const list: MikeAnnotation[] = [];
        const out = [marked[0]!, marked[2]!].map((t) =>
            applyLegalRefExtras(t, extras, [KZ, KZ166], list),
        );
        expect(out[0]).toBe("U skladu s Kaznenim zakonom i [ZKP-om](#legal-unverified) [1]. ");
        expect(out[1]).toBe(
            "Opet prema [Kaznenim zakonom](#legal-cite-0), čl. 158 i [166](#legal-cite-1) stavak 2. te Zakonom o radu.",
        );
        expect(list.map((a) => (a as { source: LegalSource }).source.id)).toEqual([KZ.id, KZ166.id]);
        expect((list[1] as { pinpoint?: unknown }).pinpoint).toEqual({ targets: [{ stavak: "2" }] });
        expect(out.join("")).not.toMatch(/[\uE000-\uE1FF]/u);
    });

    it("an extra whose text is not at its occurrence is skipped", () => {
        const texts = ["Samo jednom: Kazneni zakon."];
        expect(markLegalRefExtras(texts, [extra("Kazneni zakon", 1, "act", KZ.id)])).toEqual(texts);
    });

    it("no extras → texts untouched, no sentinels to strip", () => {
        const texts = ["Kazneni zakon.", null];
        expect(markLegalRefExtras(texts, [])).toBe(texts);
        expect(applyLegalRefExtras("Kazneni zakon.", [], [KZ], [])).toBe("Kazneni zakon.");
    });
});

describe("autoLinkLegalRefs — references into the user's own documents (BugFix 2026-09-28)", () => {
    const ZKG13 = src("zkg/13", "Zakon o komunalnom gospodarstvu, čl. 13", "Članak 13.");

    it("never links a decimal clause number ('članak 13.7')", () => {
        expect(articleSpansIn("Prema članku 13.7 Općih uvjeta, rok je 8 dana.")).toEqual([]);
        const list: MikeAnnotation[] = [];
        const out = autoLinkLegalRefs("Prema članku 13.7 Općih uvjeta, rok je 8 dana.", [ZKG13], list);
        expect(out).toBe("Prema članku 13.7 Općih uvjeta, rok je 8 dana.");
        expect(list).toHaveLength(0);
    });

    it("never links a reference into the user's contract", () => {
        const text = "Prema članku 13. Ugovora o djelu, izvršitelj odgovara za nedostatke.";
        const list: MikeAnnotation[] = [];
        expect(autoLinkLegalRefs(text, [ZKG13], list)).toBe(text);
        expect(list).toHaveLength(0);
    });

    it("still links the number-only reference when nothing anchors it to a document", () => {
        const list: MikeAnnotation[] = [];
        const out = autoLinkLegalRefs("Rok je uređen člankom 13.", [ZKG13], list);
        expect(out).toContain("](#legal-cite-0)");
    });
});
