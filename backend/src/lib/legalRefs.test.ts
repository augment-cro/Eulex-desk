import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    anchoredToDocument,
    groupActs,
    LEGAL_REFS_MODEL,
    legalSourcesFromPersistedContent,
    parseAssignments,
    resolveLegalRefs,
    scanArticleRefs,
} from "./legalRefs";
import type { LegalSource } from "./chatTools";
import type { LoadedMcpServer } from "./mcp/types";

function src(
    id: string,
    documentTitle: string,
    articleLabel: string | null,
    extra: Partial<LegalSource> = {},
): LegalSource {
    return {
        id,
        scope: "@hr",
        title: articleLabel ? `${documentTitle}, čl. ${articleLabel.replace(/\D/g, "")}` : documentTitle,
        documentTitle,
        citation: null,
        snippet: null,
        externalUrl: null,
        articleLabel,
        fetchPath: null,
        celex: null,
        inForce: true,
        kind: "regulation",
        ...extra,
    };
}

const ZT7 = src("zt/7", "Zakon o trgovini", "Članak 7.");
const ZT8 = src("zt/8", "Zakon o trgovini", "Članak 8.");
const ZT9 = src("zt/9", "Zakon o trgovini", "Članak 9.");
const ZIM6 = src("zim/6", "Zakon o iznimnim mjerama kontrole cijena", "Članak 6.");

const SENTENCE =
    "Riječ je o Odluci (NN 101/2026), donesenoj na temelju članka 8. stavka 1., u vezi s člankom 6. podstavkom 7. Zakona o iznimnim mjerama kontrole cijena (NN 40/25). Prema članku 9. stavku 1. Zakona o trgovini, trgovina na malo je kupnja robe. Nasuprot tome, članak 7. stavak 1. istog Zakona uređuje trgovinu na veliko.";

// The @hr get_article payload shape (trimmed) that a lookup returns.
function articlePayload(uuid: string, actTitle: string, n: string) {
    return {
        article_label: `Članak ${n}.`,
        text: "…",
        text_available: true,
        sources: [
            {
                id: `@hr/regulation/${uuid}/article/Članak ${n}.`,
                scope: "@hr",
                title: `${actTitle}, čl. ${n}`,
                document: { id: uuid, title: actTitle, citation: null, type: "Zakon", subtype: "Zakon", version_id: null },
                article: { label: `Članak ${n}.`, ordinal: n, heading: null, segment_id: null },
                match: null,
                links: { backend_fetch: `/api/v1/regulations/${uuid}/article/Članak ${n}.`, frontend_path: "" },
                in_force: true,
            },
        ],
    };
}

type Call = { tool: string; args: Record<string, unknown> };

function fakeServer(reply: (tool: string, args: Record<string, unknown>) => unknown, calls: Call[]): LoadedMcpServer {
    const tools = ["resolve", "get_article", "find_publication"];
    return {
        row: { slug: "sys-eulex", name: "EULEX" } as LoadedMcpServer["row"],
        tools: [],
        toolNameMap: new Map(tools.map((t) => [`mcp__sys-eulex__${t}`, t])),
        client: {
            callTool: async () => "",
            callToolRich: async (tool, args) => {
                calls.push({ tool, args });
                const out = reply(tool, args);
                if (out instanceof Error) throw out;
                return { text: JSON.stringify(out), structured: out };
            },
            close: async () => {},
        },
    };
}

const ZIM_UUID = "544a812c-19bf-4dc7-8875-ee953b1fd36b";

const corpus = (tool: string, args: Record<string, unknown>) => {
    if (tool === "resolve") {
        const q = String(args.query);
        if (/iznimnim mjerama/i.test(q)) {
            return {
                matches: [
                    { uri: `@hr/regulation/${ZIM_UUID}`, title: "Zakon o iznimnim mjerama kontrole cijena", in_force: true, similarity: 1 },
                    { uri: "@hr/regulation/b7d01760-0000-0000-0000-000000000000", title: "Zakon o iznimnim mjerama kontrole cijena", in_force: false, similarity: 1 },
                ],
            };
        }
        return { matches: [] };
    }
    if (tool === "get_article") {
        const uri = String(args.uri);
        if (uri.includes(ZIM_UUID) && args.article === "8") {
            return articlePayload(ZIM_UUID, "Zakon o iznimnim mjerama kontrole cijena", "8");
        }
        return { error: "not_found", sources: [] };
    }
    return {};
};

describe("scanArticleRefs", () => {
    it("finds every span with number + occurrence and prose windows", () => {
        const spans = scanArticleRefs("Vidi članak 8. i članak 8. te čl. 17.a Zakona.");
        assert.deepEqual(
            spans.map((s) => [s.text, s.number, s.occurrence]),
            [["članak 8", "8", 0], ["članak 8", "8", 1], ["čl. 17.a", "17a", 0]],
        );
        assert.ok(spans[2].after.startsWith(" Zakona"));
    });
});

describe("scanArticleRefs — enumerations and ranges", () => {
    const spans = (t: string) => scanArticleRefs(t).map((s) => s.text);
    it("each enumerated / range end number is its own span", () => {
        assert.deepEqual(spans("posebne odredbe članaka 158. i 166.; kod"), ["članaka 158", "166"]);
        assert.deepEqual(spans("čl. 5., 7. i 9. Zakona o radu"), ["čl. 5", "7", "9"]);
        assert.deepEqual(spans("članci 10. do 15. ZOR-a"), ["članci 10", "15"]);
        assert.deepEqual(spans("članci 10.–15."), ["članci 10", "15"]);
        assert.deepEqual(spans("Articles 5, 6 and 7 GDPR"), ["Articles 5", "6", "7"]);
        assert.deepEqual(spans("§§ 12-14 BGB"), ["§§ 12", "14"]);
    });
    it("never continues into amounts, dates, years or stavci", () => {
        assert.deepEqual(spans("prema članku 3. i 15 godina zatvora"), ["članku 3"]);
        assert.deepEqual(spans("prema članku 3. i 15. godine"), ["članku 3"]);
        assert.deepEqual(spans("vrijedi članak 5. do 31. prosinca"), ["članak 5"]);
        assert.deepEqual(spans("članak 153. stavak 1. i 2."), ["članak 153"]);
        assert.deepEqual(spans("čl. 5 i 7"), ["čl. 5"]); // HR without ordinal dots
    });
    it("occurrence counts continuation numbers like any other span", () => {
        const s = scanArticleRefs("članaka 158. i 166. te članak 166.");
        assert.deepEqual(s.map((x) => [x.text, x.number, x.occurrence]), [
            ["članaka 158", "158", 0],
            ["166", "166", 0],
            ["članak 166", "166", 1],
        ]);
    });
});

describe("parseAssignments", () => {
    it("accepts fenced JSON and drops malformed rows", () => {
        const out = parseAssignments(
            '```json\n{"refs":[{"i":0,"act":"A1","act_name":null,"scope":null},{"i":9,"act":"A1"},{"i":1,"act":null,"act_name":"Zakon o radu","scope":"@hr"},{"i":2,"act":"junk","act_name":"","scope":"@xx"}]}\n```',
            3,
        );
        assert.deepEqual(out, [
            { i: 0, act: "A1", act_name: null, scope: null },
            { i: 1, act: null, act_name: "Zakon o radu", scope: "@hr" },
            { i: 2, act: null, act_name: null, scope: null },
        ]);
        assert.deepEqual(parseAssignments("not json", 3), []);
    });
});

describe("groupActs", () => {
    it("groups by act with the article numbers each act covers", () => {
        const acts = [...groupActs([ZT7, ZT8, ZT9, ZIM6]).values()];
        assert.deepEqual(
            acts.map((a) => [a.key, a.title, [...a.articles.keys()]]),
            [["A1", "Zakon o trgovini", ["7", "8", "9"]], ["A2", "Zakon o iznimnim mjerama kontrole cijena", ["6"]]],
        );
    });
});

describe("resolveLegalRefs — the NN 101/2026 turn", () => {
    it("regex settles named refs, the model resolves the back-reference, lookup fills the missing article", async () => {
        const calls: Call[] = [];
        const prompts: string[] = [];
        const res = await resolveLegalRefs({
            answer: SENTENCE,
            registry: [ZT7, ZT8, ZT9, ZIM6],
            servers: [fakeServer(corpus, calls)],
            complete: async ({ user }) => {
                prompts.push(user);
                // Only čl. 8 is open (ZIMKC has no article 8 in the registry);
                // a model answer for an already-settled ref (i: 3) is ignored.
                return {
                    text: JSON.stringify({
                        refs: [
                            { i: 0, act: null, act_name: "Zakon o iznimnim mjerama kontrole cijena", scope: "@hr" },
                            { i: 3, act: "A2", act_name: null, scope: null },
                        ],
                    }),
                    usage: { input_tokens: 10, output_tokens: 5 } as never,
                };
            },
        });
        assert.ok(res);
        const refs = res!.event.refs.map((r) => [r.text, r.status, r.by, r.source_id]);
        assert.deepEqual(refs, [
            ["članka 8", "linked", "lookup", `@hr/regulation/${ZIM_UUID}/article/Članak 8.`],
            ["člankom 6", "linked", "regex", "zim/6"],
            ["članku 9", "linked", "regex", "zt/9"],
            // "istog Zakona" is a back-reference, but the window BEFORE the
            // reference names Zakon o trgovini → the regex settles it.
            ["članak 7", "linked", "regex", "zt/7"],
        ]);
        assert.equal(res!.newSources.length, 1);
        assert.equal(res!.newSources[0].documentTitle, "Zakon o iznimnim mjerama kontrole cijena");
        assert.deepEqual(
            calls.map((c) => c.tool),
            ["resolve", "get_article"],
        );
        assert.equal(calls[1].args.uri, `@hr/regulation/${ZIM_UUID}`); // in-force twin preferred
        assert.equal(calls[1].args.article, "8");
        // The model saw the closed act list and only the open refs matter.
        assert.match(prompts[0], /A1: Zakon o trgovini/);
        assert.match(prompts[0], /A2: Zakon o iznimnim mjerama kontrole cijena/);
        assert.equal(res!.event.model, LEGAL_REFS_MODEL);
        assert.deepEqual(
            [res!.stats.regex, res!.stats.model, res!.stats.lookup, res!.stats.unverified, res!.stats.unresolved],
            [3, 0, 1, 0, 0],
        );
    });

    it("a named act the corpus cannot confirm → unverified, never another act", async () => {
        const calls: Call[] = [];
        const res = await resolveLegalRefs({
            answer: "Prema članku 99. Zakona o nepostojećim stvarima vrijedi X. Vidi i članak 8. stavak 2.",
            registry: [ZT8],
            servers: [fakeServer(corpus, calls)],
            complete: async () => ({
                text: JSON.stringify({
                    refs: [
                        { i: 0, act: null, act_name: "Zakon o nepostojećim stvarima", scope: "@hr" },
                        { i: 1, act: "A1", act_name: null, scope: null },
                    ],
                }),
            }),
        });
        const refs = res!.event.refs.map((r) => [r.text, r.status, r.by, r.source_id]);
        assert.deepEqual(refs, [
            ["članku 99", "unverified", "lookup", null],
            ["članak 8", "linked", "model", "zt/8"],
        ]);
        assert.equal(res!.newSources.length, 0);
    });

    it("model failure → regex-only result (named act without source stays plain, unique number links)", async () => {
        const res = await resolveLegalRefs({
            answer: SENTENCE,
            registry: [ZT7, ZT8, ZT9, ZIM6],
            servers: [],
            complete: async () => {
                throw new Error("boom");
            },
        });
        const refs = res!.event.refs.map((r) => [r.text, r.status, r.by]);
        assert.deepEqual(refs, [
            ["članka 8", "unresolved", "none"], // act named (ZIMKC), no source → nothing
            ["člankom 6", "linked", "regex"],
            ["članku 9", "linked", "regex"],
            ["članak 7", "linked", "regex"], // "istog Zakona" = no act named, unique 7
        ]);
        assert.equal(res!.event.model, null);
    });

    it("model cannot override a strong regex pick", async () => {
        const res = await resolveLegalRefs({
            answer: "Prema članku 9. stavku 1. Zakona o trgovini vrijedi X.",
            registry: [ZT9, src("zim/9", "Zakon o iznimnim mjerama kontrole cijena", "Članak 9.")],
            servers: [],
            complete: async () => ({
                text: JSON.stringify({ refs: [{ i: 0, act: "A2", act_name: null, scope: null }] }),
            }),
        });
        // The model runs (it also looks for missed references) but its
        // assignment for a regex-settled span is ignored.
        assert.deepEqual(res!.event.refs.map((r) => [r.source_id, r.by]), [["zt/9", "regex"]]);
        assert.equal(res!.event.model, LEGAL_REFS_MODEL);
    });

    it("regex settles 'članku N. Kaznenog zakona' (adjective before the keyword)", async () => {
        // Staging 2026-09-24: the act span started AT "zakona", cut
        // "Kaznenog" off, and the regex settled 1 of 5 — Haiku did the rest.
        const kz = (n: string) => src(`kz/${n}`, "Kazneni zakon", `Članak ${n}.`);
        const answer =
            "U Hrvatskoj, članak 153. stavak 1. Kaznenog zakona (NN 125/11 … 136/25) propisuje kaznu zatvora od tri do osam godina, a ako je djelo počinjeno uporabom sile, prema članku 153. stavku 2., **od 5 do 12 godina**.\n\n" +
            "Za prouzročenje smrti silovane osobe izriče se najmanje **5 godina zatvora**, prema članku 154. Kaznenog zakona. Za djela prema djetetu primjenjuju se posebne odredbe članaka 158. i 166.; kod ranije počinjenih djela ključna je primjena blažeg zakona prema članku 3. Kaznenog zakona.";
        const res = await resolveLegalRefs({
            answer,
            registry: ["154", "153", "44", "3", "158", "166"].map(kz),
            servers: [],
            complete: async () => ({ text: JSON.stringify({ refs: [] }) }),
        });
        assert.deepEqual(
            res!.event.refs.map((r) => [r.text, r.status, r.by, r.source_id]),
            [
                ["članak 153", "linked", "regex", "kz/153"],
                // No act named → weak pick, kept when the model adds nothing.
                ["članku 153", "linked", "regex", "kz/153"],
                ["članku 154", "linked", "regex", "kz/154"],
                ["članaka 158", "linked", "regex", "kz/158"],
                // Enumeration: the keyword is not repeated before 166.
                ["166", "linked", "regex", "kz/166"],
                ["članku 3", "linked", "regex", "kz/3"],
            ],
        );
        assert.deepEqual([res!.stats.regex, res!.stats.model, res!.stats.unresolved], [6, 0, 0]);
    });

    it("no references → null (no event, no model call)", async () => {
        let called = false;
        const res = await resolveLegalRefs({
            answer: "Nema referenci.",
            registry: [ZT8],
            servers: [],
            complete: async () => {
                called = true;
                return { text: "{}" };
            },
        });
        assert.equal(res, null);
        assert.equal(called, false);
    });
});

describe("resolveLegalRefs — references the regex missed (extra)", () => {
    const KZ_UUID = "22dc8255-8025-4126-b8af-ec2c29ccc106";
    const kz = (n: string) =>
        src(`@hr/regulation/${KZ_UUID}/article/Članak ${n}.`, "Kazneni zakon", `Članak ${n}.`, {
            fetchPath: `/api/v1/regulations/${KZ_UUID}/article/Članak ${n}.`,
        });
    const KZ_WHOLE = src(`@hr/regulation/${KZ_UUID}`, "Kazneni zakon", null, {
        title: "Kazneni zakon",
        fetchPath: `/api/v1/regulations/${KZ_UUID}`,
    });
    const ZKP_UUID = "0b1c2d3e-0000-4000-8000-000000000001";
    const answer =
        "U skladu s Kaznenim zakonom i ZKP-om, kazna za silovanje propisana je u članku 153. Kaznenog zakona. " +
        "Posebne odredbe su čl. 158 i 166 za djecu, a primjenjuje se i načelo blažeg zakona.";
    const model = {
        text: JSON.stringify({
            // "čl. 158" is open: "blažeg zakona" after it reads as an act
            // name to the regex, so the model assigns it.
            refs: [{ i: 1, act: "A1" }],
            extra: [
                { context: "U skladu s Kaznenim zakonom i", mark: "Kaznenim zakonom", kind: "act", act: "A1" },
                { context: "Kaznenim zakonom i ZKP-om, kazna", mark: "ZKP-om", kind: "act", act_name: "Zakon o kaznenom postupku", scope: "@hr" },
                { context: "čl. 158 i 166 za djecu", mark: "166", kind: "article", article: "166", act: "A1" },
                // Attached to "članku 153." — belongs to that reference.
                { context: "članku 153. Kaznenog zakona.", mark: "Kaznenog zakona", kind: "act", act: "A1" },
                // Generic words — do not name Kazneni zakon.
                { context: "načelo blažeg zakona.", mark: "blažeg zakona", kind: "act", act: "A1" },
                // Not in the answer.
                { context: "prema Zakonu o radu", mark: "Zakonu o radu", kind: "act", act_name: "Zakon o radu", scope: "@hr" },
            ],
        }),
    };
    const zkpServer = (calls: Call[]) =>
        fakeServer((tool, args) => {
            if (tool === "resolve" && /kaznenom postupku/i.test(String(args.query))) {
                return { matches: [{ uri: `@hr/regulation/${ZKP_UUID}`, title: "Zakon o kaznenom postupku", in_force: true, similarity: 1 }] };
            }
            return { matches: [] };
        }, calls);

    it("verifies, places and links model-found references; drops the rest", async () => {
        const calls: Call[] = [];
        const res = await resolveLegalRefs({
            answer,
            registry: [kz("153"), kz("158"), kz("166"), KZ_WHOLE],
            servers: [zkpServer(calls)],
            complete: async () => model,
        });
        assert.deepEqual(
            res!.event.refs.map((r) => [r.text, r.status, r.source_id]),
            [
                ["članku 153", "linked", kz("153").id],
                ["čl. 158", "linked", kz("158").id],
            ],
        );
        assert.deepEqual(
            res!.event.extra!.map((e) => [e.kind, e.text, e.occurrence, e.status, e.by, e.source_id]),
            [
                ["act", "Kaznenim zakonom", 0, "linked", "model", KZ_WHOLE.id],
                ["act", "ZKP-om", 0, "linked", "lookup", `@hr/regulation/${ZKP_UUID}`],
                ["article", "166", 0, "linked", "model", kz("166").id],
            ],
        );
        assert.equal(answer.slice(res!.event.extra![2].start, res!.event.extra![2].start + 3), "166");
        assert.deepEqual([res!.stats.extra, res!.stats.extraRejected], [3, 3]);
        // The looked-up act comes back as a new whole-act source.
        assert.deepEqual(
            res!.newSources.map((s) => [s.id, s.articleLabel, s.fetchPath]),
            [[`@hr/regulation/${ZKP_UUID}`, null, `/api/v1/regulations/${ZKP_UUID}`]],
        );
        assert.deepEqual(calls.map((c) => c.tool), ["resolve"]);
    });

    it("act named without a harvested whole-act source → derived from its article source", async () => {
        const res = await resolveLegalRefs({
            answer,
            registry: [kz("153"), kz("158"), kz("166")],
            servers: [],
            complete: async () => model,
        });
        const first = res!.event.extra![0];
        assert.deepEqual([first.text, first.status, first.source_id], ["Kaznenim zakonom", "linked", `@hr/regulation/${KZ_UUID}`]);
        const whole = res!.newSources.find((s) => s.id === `@hr/regulation/${KZ_UUID}`);
        assert.equal(whole?.fetchPath, `/api/v1/regulations/${KZ_UUID}`);
        // ZKP could not be looked up (no server) → unverified, never another act.
        assert.deepEqual(
            [res!.event.extra![1].text, res!.event.extra![1].status],
            ["ZKP-om", "unverified"],
        );
    });

    it("act-only answer (no article at all) still calls the model", async () => {
        let called = false;
        const res = await resolveLegalRefs({
            answer: "To uređuje Kazneni zakon.",
            registry: [kz("153"), KZ_WHOLE],
            servers: [],
            complete: async () => {
                called = true;
                return {
                    text: JSON.stringify({
                        refs: [],
                        extra: [{ context: "uređuje Kazneni zakon.", mark: "Kazneni zakon", kind: "act", act: "A1" }],
                    }),
                };
            },
        });
        assert.equal(called, true);
        assert.deepEqual(res!.event.refs, []);
        assert.deepEqual(res!.event.extra!.map((e) => [e.text, e.source_id]), [["Kazneni zakon", KZ_WHOLE.id]]);
    });
});

describe("legalSourcesFromPersistedContent", () => {
    it("collects legal_sources from persisted event arrays, deduped, tolerating strings", () => {
        const rows = [
            { content: [{ type: "content", text: "x" }, { type: "legal_sources", sources: [ZT8, ZT9] }] },
            { content: JSON.stringify([{ type: "legal_sources", sources: [ZT9, ZIM6] }]) },
            { content: "not json" },
            { content: null },
        ];
        assert.deepEqual(
            legalSourcesFromPersistedContent(rows).map((s) => s.id),
            ["zt/8", "zt/9", "zim/6"],
        );
    });
});

describe("resolveLegalRefs — references into the user's own documents (BugFix 2026-09-28)", () => {
    const ZKG13 = src("zkg/13", "Zakon o komunalnom gospodarstvu", "Članak 13.");

    it("a decimal clause number ('članak 13.7') is not an article reference", () => {
        assert.deepEqual(scanArticleRefs("Prema članku 13.7 Općih uvjeta, rok je 8 dana."), []);
        assert.deepEqual(scanArticleRefs("Vidi čl. 13.7. i 13.8."), []);
        // Suffixed articles still match.
        assert.deepEqual(scanArticleRefs("čl. 17.a Zakona").map((s) => s.number), ["17a"]);
    });

    it("a reference followed by the user's document stays plain text", async () => {
        const res = await resolveLegalRefs({
            answer: "Prema članku 13. Ugovora o djelu, izvršitelj odgovara za nedostatke.",
            registry: [ZKG13],
            servers: [],
            complete: async () => ({ text: JSON.stringify({ refs: [{ i: 0, act: "A1", act_name: null, scope: null }] }) }),
        });
        assert.deepEqual(res!.event.refs.map((r) => [r.text, r.status, r.source_id]), [
            ["članku 13", "unresolved", null],
        ]);
    });

    it("an explicit 'cannot tell' from the model is respected (no weak number-only link)", async () => {
        const res = await resolveLegalRefs({
            answer: "Rok za prigovor uređen je člankom 13., a naknada se plaća mjesečno.",
            registry: [ZKG13],
            servers: [],
            complete: async () => ({ text: JSON.stringify({ refs: [{ i: 0, act: null, act_name: null, scope: null }] }) }),
        });
        assert.deepEqual(res!.event.refs.map((r) => [r.status, r.source_id]), [["unresolved", null]]);
    });

    it("the weak number-only link still applies when the model gives no answer", async () => {
        const res = await resolveLegalRefs({
            answer: "Rok za prigovor uređen je člankom 13., a naknada se plaća mjesečno.",
            registry: [ZKG13],
            servers: [],
            complete: async () => {
                throw new Error("timeout");
            },
        });
        assert.deepEqual(res!.event.refs.map((r) => [r.status, r.source_id]), [["linked", "zkg/13"]]);
    });

    it("anchoredToDocument: contracts, annexes, offers and terms — but not EU treaties or laws", () => {
        for (const after of [
            ". Ugovora o djelu",
            ". stavka 2. Ugovora",
            ". toč. 3. ovog ugovora",
            ". Dodatka br. 4",
            ". aneksa",
            ". ponude P/31-07/26",
            ". Općih uvjeta poslovanja",
            ". Pravilnika o radu",
            ". Kolektivnog ugovora",
            " of the Contract",
        ]) {
            assert.equal(anchoredToDocument(after), true, after);
        }
        for (const after of [
            ". Ugovora o funkcioniranju Europske unije",
            ". Ugovora o Europskoj uniji",
            ". Zakona o obveznim odnosima",
            ". stavka 1. Zakona o gradnji",
            ". Pravilnika o jednostavnim građevinama",
            ". ugovorne kazne",
            ". dodatno propisuje",
        ]) {
            assert.equal(anchoredToDocument(after), false, after);
        }
    });
});
