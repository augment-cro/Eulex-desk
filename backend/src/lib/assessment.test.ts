import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    RECORD_ASSESSMENT_DESCRIPTION,
    assessmentAck,
    assessmentForModel,
    assessmentsFromEvents,
    countByStatus,
    createAssessmentLedger,
    loadPriorAssessments,
    parseAssessment,
    type AssessmentSnapshot,
} from "./assessment.js";
import { enrichWithPriorEvents, runToolCalls, type DocIndex, type ToolCall } from "./chatTools.js";
import { contextTaskForId, ASSESSMENT_INSTRUCTION, CONTEXT_TASKS_INSTRUCTION, TASK_PLAN_REMINDER } from "./seams/contextTasks.js";
import type { ResolvedContext } from "./seams/contextsRuntime.js";

const finding = (over: Record<string, unknown> = {}) => ({
    id: "F-1",
    check_id: "AA-20",
    requirement: "Ljudski nadzor s ovlašću odbijanja rezultata",
    category: "zakon",
    applicability: "sada",
    evidence: [],
    evidence_weight: "nema",
    verification: "nedostaje",
    status: "gap",
    action: "Zatražiti postupak nadzora i primjer intervencije",
    closure_criterion: "Postupak s ovlastima i primjer stvarne intervencije",
    ...over,
});

const base = (over: Record<string, unknown> = {}) => ({
    title: "Provjera alata za zapošljavanje",
    task_id: "RT-10",
    systems: [{ id: "S-1", name: "HireRank", version: "3.2" }],
    use_cases: [{ id: "U-1", system_id: "S-1", description: "Rangiranje kandidata" }],
    roles: [{ use_case_id: "U-1", role: "subjekt koji uvodi sustav", basis: "Ugovor o licenci, čl. 2." }],
    facts: [{ id: "C-1", use_case_id: "U-1", statement: "Alat rangira kandidate", status: "document_supported", evidence: [{ doc_id: "doc-0", quote: "rangira prijave", page: "3" }] }],
    decisions: [{
        id: "D-1", use_case_id: "U-1", topic: "Prilog III. t. 4.", classification: "potencijalno visokorizičan",
        limitation: "INSUFFICIENT FACTS", reasoning: "Rangiranje kandidata; utjecaj na odluku nije utvrđen.",
        legal_sources: ["32024R1689 (02024R1689-20260727) čl. 6. st. 2.; Prilog III. t. 4. a)"], fact_ids: ["C-1"],
    }],
    findings: [
        finding(),
        finding({ id: "F-2", check_id: "AA-27", requirement: "Obavijest o interakciji s UI", status: "🔴", evidence_weight: "izjava", verification: "nije provjereno" }),
        finding({ id: "F-3", requirement: "Evidencija obrade", status: "ok", evidence_weight: "dokument", verification: "provjereno", evidence: [{ doc_id: "doc-0", quote: "evidencija obrade", page: "7" }] }),
    ],
    unread_documents: ["Prilog B (skenirani PDF) — pogađa F-1"],
    source_conflicts: [],
    reassessment_triggers: ["promjena namjene"],
    warning: "STOP",
    ...over,
});

describe("assessment record — validation", () => {
    it("accepts a full record, maps status emoji to words and counts per status on the server", () => {
        const parsed = parseAssessment(base());
        assert.ok(parsed.ok, JSON.stringify(!parsed.ok && parsed.errors));
        if (!parsed.ok) return;
        assert.deepEqual(parsed.body.findings.map((f) => f.status), ["gap", "material", "ok"]);
        assert.deepEqual(countByStatus(parsed.body.findings), { material: 1, gap: 1, legal: 0, insufficient: 0, ok: 1 });
    });

    it("nema zelenog bez dokaza: green needs evidence beyond a statement, actually verified", () => {
        const noEvidence = parseAssessment(base({ findings: [finding({ status: "ok", evidence_weight: "dokument", verification: "provjereno" })] }));
        assert.equal(noEvidence.ok, false);
        assert.match(!noEvidence.ok ? noEvidence.errors[0] : "", /findings F-1: is ok \(🟢\) without evidence — nema zelenog bez dokaza/);
        const statement = parseAssessment(base({
            findings: [finding({ status: "🟢", evidence_weight: "izjava", verification: "provjereno", evidence: [{ doc_id: "doc-0", quote: "x" }] })],
        }));
        assert.match(!statement.ok ? statement.errors[0] : "", /evidence_weight "izjava" — a statement is not proof/);
        const unverified = parseAssessment(base({
            findings: [finding({ status: "ok", evidence_weight: "dokument", verification: "nije provjereno", evidence: [{ doc_id: "doc-0", quote: "x" }] })],
        }));
        assert.match(!unverified.ok ? unverified.errors[0] : "", /verification "nije provjereno"/);
    });

    it("every finding that is not ok names its next action (and closure criterion)", () => {
        const res = parseAssessment(base({
            findings: [
                finding({ action: undefined }),
                finding({ id: "F-2", status: "material", action: "  " }),
                finding({ id: "F-3", status: "ok", action: undefined, evidence_weight: "dokument", verification: "provjereno", evidence: [{ doc_id: "doc-0", quote: "q" }] }),
                finding({ id: "F-4", closure_criterion: undefined }),
            ],
        }));
        assert.equal(res.ok, false);
        const errors = !res.ok ? res.errors : [];
        assert.ok(errors.includes("findings F-4.closure_criterion: is required"), errors.join("\n"));
        assert.ok(
            errors.includes("findings F-1, F-2: action is required for every finding that is not ok — say what to do next (who obtains, changes or tests what)"),
            errors.join("\n"),
        );
    });

    it("every decision rests on a known fact and a legal source; labels and ids are checked", () => {
        const res = parseAssessment(base({
            decisions: [{ id: "D-1", use_case_id: "U-9", topic: "t", reasoning: "r", legal_sources: [], fact_ids: ["C-9"], classification: "niskorizičan" }],
            findings: [finding({ id: "F-5", category: "propis" }), finding(), finding()],
        }));
        assert.equal(res.ok, false);
        const errors = !res.ok ? res.errors.join("\n") : "";
        for (const expected of [
            "decisions D-1.classification: must be one of: visokorizičan, potencijalno visokorizičan, nije utvrđeno da je visokorizičan, nejasno",
            "decisions D-1: needs at least one legal source",
            "findings F-5.category: must be one of: zakon, smjernica, kodeks, interno",
            "findings: duplicate id F-1",
            "decisions D-1: unknown use_case_id U-9",
            "decisions D-1: unknown fact C-9",
        ]) {
            assert.ok(errors.includes(expected), `missing: ${expected}\n${errors}`);
        }
    });
});

describe("assessment record — versions", () => {
    const ledger = (prior: AssessmentSnapshot[] = []) => {
        let n = 0;
        return createAssessmentLedger({
            loadPrior: async () => prior,
            newId: () => `PROC-TEST${++n}`,
            now: () => new Date(`2026-10-03T10:0${n}:00Z`),
            resolveTask: (task) => (task === "RT-10" ? { context: { id: "ctx-1", version_label: "v1.3" }, workflow: { id: "ctx-ctx-1-RT-10", title: "RT-10 Provjera" } } : null),
            lookupDoc: (doc) => (doc === "doc-0" ? { document_id: "uuid-0", filename: "Ugovor.pdf" } : null),
        });
    };

    it("a new record gets an id, version 1, the task's context and workflow, and evidence resolved to documents", async () => {
        const res = await ledger().record(base());
        assert.ok(res.ok);
        if (!res.ok) return;
        const s = res.snapshot;
        assert.equal(s.assessment_id, "PROC-TEST1");
        assert.equal(s.version, 1);
        assert.deepEqual(s.context, { id: "ctx-1", version_label: "v1.3" });
        assert.deepEqual(s.workflow, { id: "ctx-ctx-1-RT-10", title: "RT-10 Provjera" });
        assert.deepEqual(s.counts, { material: 1, gap: 1, legal: 0, insufficient: 0, ok: 1 });
        assert.equal(s.total, 3);
        assert.deepEqual(s.findings[2].evidence[0], { doc_id: "doc-0", quote: "evidencija obrade", page: "7", document_id: "uuid-0", filename: "Ugovor.pdf" });
        assert.equal(s.changes, undefined);
        assert.match(assessmentAck(s), /^Recorded assessment PROC-TEST1 v1: 🔴 1 · 🟡 1 · 🔵 0 · ⚪ 0 · 🟢 1 \(3 findings, STOP\)\./);
    });

    it("a patch upserts by id, carries everything else over, removes only through superseded and reports what changed", async () => {
        const l = ledger();
        const v1 = await l.record(base());
        assert.ok(v1.ok);
        // F-1 turns green without closed_by evidence → refused.
        const noClose = await l.record({
            assessment_id: "PROC-TEST1",
            findings: [{ id: "F-1", status: "ok", verification: "provjereno", evidence_weight: "dokument", evidence: [{ doc_id: "doc-0", quote: "Prilog 2" }] }],
        });
        assert.equal(noClose.ok, false);
        assert.match(!noClose.ok ? noClose.errors[0] : "", /findings F-1 turns green — close it with closed_by/);

        const v2 = await l.record({
            assessment_id: "PROC-TEST1",
            findings: [
                {
                    id: "F-1", status: "ok", verification: "provjereno", evidence_weight: "dokument",
                    evidence: [{ doc_id: "doc-0", quote: "Prilog 2: ovlast odbijanja", page: "2" }],
                    closed_by: { evidence: [{ doc_id: "doc-0", quote: "Prilog 2: ovlast odbijanja", page: "2" }] },
                },
                { id: "F-3", verification: "djelomično" },
                finding({ id: "F-4", requirement: "Zapisi (logovi)", status: "insufficient", action: "Zatražiti uzorak zapisa" }),
            ],
            superseded: ["F-2"],
            warning: "REVIEW",
        });
        assert.ok(v2.ok, JSON.stringify(!v2.ok && v2.errors));
        if (!v2.ok || !v1.ok) return;
        const s2 = v2.snapshot;
        assert.equal(s2.version, 2);
        assert.deepEqual(s2.findings.map((f) => f.id), ["F-1", "F-3", "F-4"]);
        // Carried over: the title, the other parts, the untouched fields of F-3 and its resolved evidence.
        assert.equal(s2.title, v1.snapshot.title);
        assert.deepEqual(s2.facts, v1.snapshot.facts);
        assert.deepEqual(s2.decisions, v1.snapshot.decisions);
        assert.deepEqual(s2.unread_documents, v1.snapshot.unread_documents);
        const f3 = s2.findings[1];
        assert.equal(f3.requirement, "Evidencija obrade");
        assert.equal(f3.verification, "djelomično");
        assert.deepEqual(f3.evidence, v1.snapshot.findings[2].evidence);
        assert.equal(s2.warning, "REVIEW");
        assert.equal(s2.findings[0].closed_by?.version, 2);
        assert.deepEqual(s2.changes, { from_version: 1, closed: ["F-1"], added: ["F-4"], changed: ["F-3"], superseded: ["F-2"] });
        assert.deepEqual(s2.counts, { material: 0, gap: 0, legal: 0, insufficient: 1, ok: 2 });
        assert.deepEqual(s2.superseded, ["F-2"]);
        // v1 stays as it was.
        assert.equal(v1.snapshot.findings.length, 3);
        assert.equal(v1.snapshot.findings[0].status, "gap");

        // A patch that only changes the warning: a new version, findings unchanged.
        const v3 = await l.record({ assessment_id: "PROC-TEST1", warning: "STANDARD" });
        assert.ok(v3.ok);
        if (!v3.ok) return;
        assert.deepEqual(v3.snapshot.findings, s2.findings);
        assert.deepEqual(v3.snapshot.changes, { from_version: 2, closed: [], added: [], changed: [], superseded: [] });
        assert.equal((await l.load({ assessment_id: "PROC-TEST1" }))?.version, 3);
    });

    it("a new item in a patch needs all its fields; an item without id is refused", async () => {
        const l = ledger();
        await l.record(base());
        const partial = await l.record({ assessment_id: "PROC-TEST1", findings: [{ id: "F-9", status: "gap" }] });
        assert.equal(partial.ok, false);
        const errors = !partial.ok ? partial.errors.join("\n") : "";
        assert.match(errors, /findings F-9\.requirement: is required/);
        assert.match(errors, /findings F-9\.closure_criterion: is required/);
        const noId = await l.record({ assessment_id: "PROC-TEST1", facts: [{ statement: "x", status: "unknown" }] });
        assert.deepEqual(!noId.ok && noId.errors, ["facts[0].id: is required — items are matched by id"]);
    });

    it("one record per turn: a second record without assessment_id is refused, not forked", async () => {
        const l = ledger();
        const first = await l.record(base());
        assert.ok(first.ok);
        const fork = await l.record(base({ title: "Druga verzija" }));
        assert.deepEqual(!fork.ok && fork.errors, [
            "this turn already recorded PROC-TEST1 (v1) — use assessment_id PROC-TEST1 to update it, sending only the changed or new items",
        ]);
    });

    it("an unknown id is refused; a superseded id must be an earlier finding", async () => {
        const unknown = await ledger().record(base({ assessment_id: "PROC-NOPE" }));
        assert.match(!unknown.ok ? unknown.errors[0] : "", /PROC-NOPE is not an assessment of this chat/);
        const l = ledger();
        await l.record(base());
        const bad = await l.record({ assessment_id: "PROC-TEST1", findings: [{ id: "F-1", verification: "djelomično" }], superseded: ["F-9", "F-1"] });
        assert.deepEqual(!bad.ok && bad.errors, [
            "superseded: F-9 is not a finding of version 1",
            "superseded: F-1 is also in findings — supersede it or update it, not both",
        ]);
    });
});

describe("assessment record — earlier versions from stored events", () => {
    const snap = (id: string, version: number, task: string, at: string) =>
        ({ ...(parseAssessment(base({ task_id: task })) as { body: object }).body, assessment_id: id, version, recorded_at: at, context: null, workflow: null, counts: { material: 1, gap: 1, legal: 0, insufficient: 0, ok: 1 }, total: 3 }) as AssessmentSnapshot;

    it("reads assessment_recorded events; load gives the latest version, by id, by task or the most recent", async () => {
        const stored = [
            [{ type: "content", text: "…" }, { type: "assessment_recorded", assessment: snap("PROC-A", 1, "RT-10", "2026-10-01T10:00:00Z") }],
            [{ type: "assessment_recorded", assessment: snap("PROC-A", 2, "RT-10", "2026-10-02T10:00:00Z") }],
            [{ type: "assessment_recorded", assessment: snap("PROC-B", 1, "RT-02", "2026-10-03T10:00:00Z") }, { type: "assessment_recorded", assessment: { junk: true } }],
            "not events",
        ];
        const prior = assessmentsFromEvents(stored);
        assert.equal(prior.length, 3);
        const l = createAssessmentLedger({ loadPrior: async () => prior });
        assert.equal((await l.load({ assessment_id: "PROC-A" }))?.version, 2);
        assert.equal((await l.load({}))?.assessment_id, "PROC-B");
        assert.equal((await l.load({ task_id: "RT-10" }))?.assessment_id, "PROC-A");
        assert.equal(await l.load({ assessment_id: "PROC-X" }), null);
        // Continuing PROC-A from the stored v2 gives v3.
        const v3 = await l.record(base({ assessment_id: "PROC-A" }));
        assert.ok(v3.ok && v3.snapshot.version === 3);
    });

    it("scope: this chat's answers, or every (not deleted) chat of the project", async () => {
        const calls: string[] = [];
        const db = {
            from(table: string) {
                return {
                    select() {
                        return {
                            eq(col: string, val: string) {
                                calls.push(`${table}.${col}=${val}`);
                                return {
                                    neq: async (c: string, v: string) => {
                                        calls.push(`${table}.${c}!=${v}`);
                                        return { data: [{ id: "chat-2" }, { id: "chat-1" }] };
                                    },
                                };
                            },
                            in(col: string, vals: string[]) {
                                calls.push(`${table}.${col} in ${vals.join(",")}`);
                                return {
                                    eq: () => ({ order: () => ({ limit: async () => ({ data: [{ content: [{ type: "assessment_recorded", assessment: snap("PROC-P", 1, "RT-10", "2026-10-03T00:00:00Z") }] }] }) }) }),
                                };
                            },
                        };
                    },
                };
            },
        };
        const inChat = await loadPriorAssessments(db, { chatId: "chat-1" });
        assert.deepEqual(calls, ["chat_messages.chat_id in chat-1"]);
        assert.equal(inChat[0].assessment_id, "PROC-P");
        calls.length = 0;
        await loadPriorAssessments(db, { chatId: "chat-1", projectId: "proj-1" });
        assert.deepEqual(calls, ["chats.project_id=proj-1", "chats.status!=deleted", "chat_messages.chat_id in chat-1,chat-2"]);
        assert.deepEqual(await loadPriorAssessments(db, {}), []);
    });

    it("load is compact: counts, one line per finding and the open questions — no evidence quotes", () => {
        const s = snap("PROC-A", 2, "RT-10", "2026-10-02T10:00:00Z");
        s.facts.push({ id: "C-2", statement: "Tko odobrava odluku nije poznato", status: "unknown", evidence: [] });
        const text = assessmentForModel(s);
        assert.match(text, /^Assessment PROC-A, latest version v2 \(RT-10\) — Provjera alata za zapošljavanje; recorded 2026-10-02T10:00:00Z; warning STOP\.\nCounts: 🔴 1 · 🟡 1 · 🔵 0 · ⚪ 0 · 🟢 1 \(3 findings\)\./);
        assert.ok(text.includes("\n- F-1 [AA-20] gap · nedostaje · Ljudski nadzor s ovlašću odbijanja rezultata — closes when: Postupak s ovlastima i primjer stvarne intervencije"));
        assert.ok(text.includes("\n- F-3 [AA-20] ok · provjereno · Evidencija obrade — closes when:"));
        assert.ok(text.includes("Open questions:\n- fact C-2 (unknown): Tko odobrava odluku nije poznato\n- decision D-1 (INSUFFICIENT FACTS): Prilog III. t. 4.\n- unread document: Prilog B (skenirani PDF) — pogađa F-1"));
        assert.ok(text.includes("Use cases: U-1 (S-1) Rangiranje kandidata"));
        assert.ok(text.includes("Decisions (id · use case · topic → classification):\n- D-1 · U-1 · Prilog III. t. 4. → potencijalno visokorizičan (INSUFFICIENT FACTS)\n"));
        assert.ok(text.includes("call record_assessment with assessment_id PROC-A and ONLY the changed or new items"));
        assert.ok(!text.includes("rangira prijave") && !text.includes("evidencija obrade\""), "no evidence quotes");
    });

    it("load with finding_ids returns those findings in full, evidence pointed at this turn's doc ids", () => {
        const s = snap("PROC-A", 2, "RT-10", "2026-10-02T10:00:00Z");
        s.findings[2].evidence = [{ doc_id: "doc-5", document_id: "uuid-0", filename: "Ugovor.pdf", quote: "q" }];
        s.findings[1].evidence = [{ doc_id: "doc-1", document_id: "uuid-gone", filename: "Stari.pdf", quote: "q" }];
        const text = assessmentForModel(s, (id) => (id === "uuid-0" ? "doc-0" : null), ["F-3", "F-2", "F-9"]);
        assert.match(text, /\nFindings in full \(not found: F-9\):\n/);
        const json = JSON.parse(text.split("\n").find((l) => l.startsWith("["))!);
        assert.deepEqual(json.map((f: { id: string }) => f.id), ["F-2", "F-3"]);
        assert.equal(json[1].evidence[0].doc_id, "doc-0");
        assert.equal(json[0].evidence[0].doc_id, "Stari.pdf (not attached this turn)");
        assert.equal("document_id" in json[1].evidence[0], false);
    });
});

describe("assessment record — tools, events and prompt", () => {
    async function run(name: string, args: unknown, ledger = createAssessmentLedger({ loadPrior: async () => [], newId: () => "PROC-T" })) {
        const events: Record<string, unknown>[] = [];
        const write = (s: string) => {
            for (const line of s.split("\n")) if (line.startsWith("data: ")) events.push(JSON.parse(line.slice(6)));
        };
        const docIndex: DocIndex = { "doc-0": { document_id: "uuid-0", filename: "Ugovor.pdf" } };
        const call: ToolCall = { id: "tc-1", function: { name, arguments: JSON.stringify(args) } };
        const out = await runToolCalls(
            [call], new Map(), "user-1", {} as Parameters<typeof runToolCalls>[3], write,
            undefined, undefined, docIndex, undefined, null, undefined, undefined, undefined,
            undefined, null, undefined, undefined, undefined, undefined, ledger,
        );
        return { out, events, result: (out.toolResults[0] as { content: string }).content, ledger };
    }

    it("record_assessment streams assessment_recorded (persisted with the answer) and returns the counts", async () => {
        const { out, events, result, ledger } = await run("record_assessment", { assessment: base() });
        assert.equal(events.length, 1);
        assert.equal(events[0].type, "assessment_recorded");
        assert.deepEqual(out.assessmentsRecorded, events);
        assert.match(result, /^Recorded assessment PROC-T v1: 🔴 1 · 🟡 1 · 🔵 0 · ⚪ 0 · 🟢 1/);
        const loaded = await run("load_assessment", {}, ledger);
        assert.match(loaded.result, /^Assessment PROC-T, latest version v1/);
    });

    it("a refused record streams nothing and lists what to fix", async () => {
        const { out, events, result } = await run("record_assessment", { assessment: base({ findings: [finding({ status: "ok", evidence_weight: "dokument", verification: "provjereno" })] }) });
        assert.deepEqual(events, []);
        assert.deepEqual(out.assessmentsRecorded, []);
        assert.match(result, /^record_assessment refused — fix these and call it again:\n- findings F-1: is ok \(🟢\) without evidence/);
    });

    it("the next turn's tool summary names the latest version of each assessment", async () => {
        const v1 = { ...(parseAssessment(base()) as { body: object }).body, assessment_id: "PROC-A", version: 1, recorded_at: "x", context: null, workflow: null, counts: { material: 1, gap: 1, legal: 0, insufficient: 0, ok: 1 }, total: 3 };
        const stored = [
            { type: "assessment_recorded", assessment: v1 },
            { type: "assessment_recorded", assessment: { ...v1, version: 2, counts: { material: 0, gap: 1, legal: 0, insufficient: 0, ok: 2 } } },
        ];
        const chain = { select: () => chain, eq: () => chain, order: () => chain, limit: async () => ({ data: [{ content: stored }] }) };
        const out = await enrichWithPriorEvents(
            [{ role: "user", content: "x" }, { role: "assistant", content: "Gotovo." }],
            "chat-1",
            { from: () => chain } as unknown as Parameters<typeof enrichWithPriorEvents>[2],
            {},
        );
        assert.equal(
            out[1].content,
            "Gotovo.\n\n[Tool activity in your previous turn]\n- record_assessment: PROC-A v2 (RT-10) — 🔴 0 · 🟡 1 · 🔵 0 · ⚪ 0 · 🟢 2; continue it with load_assessment",
        );
    });

    it("the task catalog and every task prompt tell the model to record and continue assessments", () => {
        assert.ok(CONTEXT_TASKS_INSTRUCTION.endsWith(ASSESSMENT_INSTRUCTION));
        assert.ok(TASK_PLAN_REMINDER.endsWith(ASSESSMENT_INSTRUCTION));
        assert.match(ASSESSMENT_INSTRUCTION, /record it with record_assessment ONCE, when the findings are formed and before generating the Word or Excel output/);
        assert.match(ASSESSMENT_INSTRUCTION, /only patch it: assessment_id plus the changed or new items, never the whole record again/);
        assert.match(ASSESSMENT_INSTRUCTION, /call load_assessment first and send only the changed and new findings, with closed_by/);
        assert.match(RECORD_ASSESSMENT_DESCRIPTION, /Record it ONCE, .* After that only PATCH it/);
        assert.match(RECORD_ASSESSMENT_DESCRIPTION, /every finding that is not ok needs an action and a closure_criterion/);
        const active: ResolvedContext[] = [{
            id: "c1", instructions_md: "", sources: [], level: "system", version_label: "v1.3",
            tasks: [{ id: "RT-10", name: "Provjera usklađenosti dokumenta", summary: "…", status: "ready", prompt_md: "1. …" }],
        }];
        assert.deepEqual(contextTaskForId(active, "RT-10"), {
            context: { id: "c1", version_label: "v1.3" },
            workflow: { id: "ctx-c1-RT-10", title: "RT-10 Provjera usklađenosti dokumenta" },
        });
        assert.equal(contextTaskForId(active, "RT-99"), null);
    });
});
