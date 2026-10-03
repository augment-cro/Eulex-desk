/**
 * The assessment record of a context task (RT-02, RT-04, RT-10, RT-11 …):
 * a structured, versioned result — systems, use cases, roles, facts with
 * their status, classification decisions, findings with evidence and
 * closure criteria — that the model keeps with record_assessment and picks
 * up again with load_assessment (EU AI Governance operativni dio §3–§5.1.1,
 * §9, §10).
 *
 * No table of its own: every version is an `assessment_recorded` event
 * persisted with the answer's events, so the chat (or, in a project, every
 * chat of the project) is the store. A new version never overwrites an
 * earlier one; the earlier event stays as it was.
 *
 * The first call sends the whole record; every later call is a PATCH
 * (assessment_id + only what changes): items are upserted by id into the
 * previous version, everything not mentioned is carried over, a finding is
 * removed only through `superseded`, and top-level fields replace only when
 * given — so a long record is never re-sent (output tokens are the cost).
 *
 * Server-side rules (the model gets a clear refusal to fix):
 *  - nema zelenog bez dokaza: an `ok` finding needs evidence that is more
 *    than a statement, and a verification that was actually done;
 *  - every finding that is not `ok` names the next action and its closure
 *    criterion;
 *  - every decision rests on a fact and a legal source;
 *  - a finding turns green only with new evidence (`closed_by`);
 *  - one record per turn: a second record without assessment_id is refused
 *    (update the first instead of forking it);
 *  - the counts per status are computed here, never taken from the model.
 */
import { randomUUID } from "crypto";

// ---------------------------------------------------------------------------
// Vocabulary (the allowed labels of operativni dio §4)
// ---------------------------------------------------------------------------

export const FINDING_STATUSES = ["material", "gap", "legal", "insufficient", "ok"] as const;
export type FindingStatus = (typeof FINDING_STATUSES)[number];
/** The model may also write the status emoji. */
const STATUS_BY_EMOJI: Record<string, FindingStatus> = {
    "\u{1F534}": "material", // 🔴
    "\u{1F7E1}": "gap", // 🟡
    "\u{1F535}": "legal", // 🔵
    "⚪": "insufficient", // ⚪
    "\u{1F7E2}": "ok", // 🟢
};
export const FACT_STATUSES = [
    "user_asserted",
    "document_supported",
    "observed",
    "inferred",
    "unknown",
    "conflicting",
] as const;
export const CLASSIFICATIONS = [
    "visokorizičan",
    "potencijalno visokorizičan",
    "nije utvrđeno da je visokorizičan",
    "nejasno",
] as const;
export const LIMITATIONS = ["UNVERIFIED", "INTERPRETATION REQUIRED", "INSUFFICIENT FACTS"] as const;
export const CATEGORIES = ["zakon", "smjernica", "kodeks", "interno"] as const;
export const APPLICABILITY = ["sada", "kasnije", "ne primjenjuje se", "neutvrđeno"] as const;
export const EVIDENCE_WEIGHTS = ["izjava", "dokument", "izvještaj treće strane", "opaženo", "nema"] as const;
export const VERIFICATIONS = ["provjereno", "djelomično", "nedostaje", "nije provjereno", "potrebna provjera"] as const;
export const DUE_KINDS = ["zakonski", "interni"] as const;
export const WARNINGS = ["STOP", "REVIEW", "STANDARD"] as const;

/** Weights that are not evidence of fulfilment. */
const NOT_EVIDENCE: readonly string[] = ["izjava", "nema"];
/** Verifications that allow a green finding. */
const VERIFIED: readonly string[] = ["provjereno", "djelomično"];

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export interface Evidence {
    /** As the model wrote it (doc-N of that turn, a URL …). */
    doc_id: string;
    /** The document it resolved to that turn, when it is one of the chat's documents. */
    document_id?: string;
    filename?: string;
    quote: string;
    page?: string;
}

export interface Fact {
    id: string;
    use_case_id?: string;
    statement: string;
    value?: string;
    status: (typeof FACT_STATUSES)[number];
    evidence: Evidence[];
}

export interface Decision {
    id: string;
    use_case_id: string;
    topic: string;
    classification: (typeof CLASSIFICATIONS)[number] | null;
    limitation?: (typeof LIMITATIONS)[number];
    reasoning: string;
    legal_sources: string[];
    fact_ids: string[];
}

export interface Finding {
    id: string;
    check_id?: string;
    requirement: string;
    category: (typeof CATEGORIES)[number];
    applicability: (typeof APPLICABILITY)[number];
    applicable_from?: string;
    practice?: string;
    evidence: Evidence[];
    evidence_weight: (typeof EVIDENCE_WEIGHTS)[number];
    verification: (typeof VERIFICATIONS)[number];
    method?: string;
    status: FindingStatus;
    action?: string;
    owner_role?: string;
    due?: string;
    due_kind?: (typeof DUE_KINDS)[number];
    closure_criterion: string;
    closed_by?: { version: number; evidence: Evidence[] };
}

export interface AssessmentBody {
    title: string;
    task_id: string | null;
    facts_as_of: string | null;
    sources_checked_at: string | null;
    systems: { id: string; name: string; version?: string }[];
    use_cases: { id: string; system_id: string; description: string }[];
    roles: { use_case_id: string; role: string; basis: string }[];
    facts: Fact[];
    decisions: Decision[];
    findings: Finding[];
    unread_documents: string[];
    source_conflicts: string[];
    reassessment_triggers: string[];
    warning: (typeof WARNINGS)[number] | null;
    superseded: string[];
}

export type StatusCounts = Record<FindingStatus, number>;

export interface AssessmentChanges {
    from_version: number;
    closed: string[];
    added: string[];
    changed: string[];
    superseded: string[];
}

/** One recorded version, as persisted in an `assessment_recorded` event. */
export interface AssessmentSnapshot extends AssessmentBody {
    assessment_id: string;
    version: number;
    recorded_at: string;
    /** The active context the task belongs to, resolved by the server. */
    context: { id: string; version_label?: string } | null;
    /** The task's workflow (to continue it), resolved by the server. */
    workflow: { id: string; title: string } | null;
    counts: StatusCounts;
    total: number;
    /** What changed against the previous version (absent on version 1). */
    changes?: AssessmentChanges;
}

export type AssessmentRecordedEvent = { type: "assessment_recorded"; assessment: AssessmentSnapshot };

// ---------------------------------------------------------------------------
// Tools (offered with update_plan: while a task or workflow is in play)
// ---------------------------------------------------------------------------

const evidenceSchema = {
    type: "array",
    description: "Where it is shown: the doc_id of an available document (or a URL), a verbatim quote, and the page.",
    items: {
        type: "object",
        properties: {
            doc_id: { type: "string" },
            quote: { type: "string" },
            page: { type: "string" },
        },
        required: ["doc_id", "quote"],
    },
};
const strings = (description: string) => ({ type: "array", items: { type: "string" }, description });

export const RECORD_ASSESSMENT_DESCRIPTION =
    "Record the structured result of the task you are applying (facts, classification decisions, findings with evidence); the user sees it as the REZULTAT card. Record it ONCE, when the findings are formed and before generating the Word or Excel output: the whole record, without assessment_id. After that only PATCH it: pass assessment_id and only the items that change or are new — findings, facts, decisions, use_cases, roles and systems are upserted by id (for an existing item send only the fields that change; a new item needs all its fields), everything you do not mention is carried over unchanged, a finding is removed only by listing its id in superseded, and title, warning, dates and the lists replace only when given. Every call makes a new version. To continue an earlier assessment, call load_assessment first and send only the changed and new findings, with closed_by where new evidence closes one. Rules: every finding that is not ok needs an action and a closure_criterion; nema zelenog bez dokaza — ok needs evidence beyond a statement (evidence_weight dokument, izvještaj treće strane or opaženo) and verification provjereno or djelomično; a finding that turns ok needs closed_by with the new evidence. Returns the id, version and the counts per status — use exactly those counts in your answer and documents — or the problems to fix.";

export const RECORD_ASSESSMENT_TOOL = {
    type: "function",
    function: {
        name: "record_assessment",
        description:
            RECORD_ASSESSMENT_DESCRIPTION,
        parameters: {
            type: "object",
            properties: {
                assessment: {
                    type: "object",
                    properties: {
                        assessment_id: { type: "string", description: "To patch an earlier assessment (a new version); leave out only for the first record" },
                        title: { type: "string" },
                        task_id: { type: "string", description: "The task applied, e.g. RT-10" },
                        facts_as_of: { type: "string", description: "Date the facts describe (YYYY-MM-DD)" },
                        sources_checked_at: { type: "string", description: "Date the legal sources were checked (YYYY-MM-DD)" },
                        systems: {
                            type: "array",
                            items: {
                                type: "object",
                                properties: { id: { type: "string" }, name: { type: "string" }, version: { type: "string" } },
                                required: ["id"],
                            },
                        },
                        use_cases: {
                            type: "array",
                            items: {
                                type: "object",
                                properties: { id: { type: "string" }, system_id: { type: "string" }, description: { type: "string" } },
                                required: ["id"],
                            },
                        },
                        roles: {
                            type: "array",
                            items: {
                                type: "object",
                                properties: { use_case_id: { type: "string" }, role: { type: "string" }, basis: { type: "string" } },
                                required: ["use_case_id", "role", "basis"],
                            },
                        },
                        facts: {
                            type: "array",
                            items: {
                                type: "object",
                                properties: {
                                    id: { type: "string" },
                                    use_case_id: { type: "string" },
                                    statement: { type: "string" },
                                    value: { type: "string" },
                                    status: { type: "string", enum: [...FACT_STATUSES] },
                                    evidence: evidenceSchema,
                                },
                                required: ["id"],
                            },
                        },
                        decisions: {
                            type: "array",
                            items: {
                                type: "object",
                                properties: {
                                    id: { type: "string" },
                                    use_case_id: { type: "string" },
                                    topic: { type: "string" },
                                    classification: { type: "string", enum: [...CLASSIFICATIONS], description: "Omit when not a classification" },
                                    limitation: { type: "string", enum: [...LIMITATIONS] },
                                    reasoning: { type: "string" },
                                    legal_sources: strings("Instrument, version, article/paragraph/point — at least one"),
                                    fact_ids: strings("The facts it rests on — at least one"),
                                },
                                required: ["id"],
                            },
                        },
                        findings: {
                            type: "array",
                            items: {
                                type: "object",
                                properties: {
                                    id: { type: "string" },
                                    check_id: { type: "string", description: "AA-…, AZ-…, OZ-… when it maps to a check" },
                                    requirement: { type: "string" },
                                    category: { type: "string", enum: [...CATEGORIES] },
                                    applicability: { type: "string", enum: [...APPLICABILITY] },
                                    applicable_from: { type: "string" },
                                    practice: { type: "string", description: "What the organisation actually does" },
                                    evidence: evidenceSchema,
                                    evidence_weight: { type: "string", enum: [...EVIDENCE_WEIGHTS] },
                                    verification: { type: "string", enum: [...VERIFICATIONS] },
                                    method: { type: "string" },
                                    status: {
                                        type: "string",
                                        enum: [...FINDING_STATUSES],
                                        description: "material 🔴 · gap 🟡 · legal 🔵 · insufficient ⚪ · ok 🟢",
                                    },
                                    action: { type: "string", description: "The next action — required unless the finding is ok" },
                                    owner_role: { type: "string" },
                                    due: { type: "string" },
                                    due_kind: { type: "string", enum: [...DUE_KINDS] },
                                    closure_criterion: { type: "string" },
                                    closed_by: {
                                        type: "object",
                                        description: "Only when this version closes the finding: the new evidence",
                                        properties: { evidence: evidenceSchema },
                                        required: ["evidence"],
                                    },
                                },
                                required: ["id"],
                            },
                        },
                        unread_documents: strings("Documents that could not be read, with the findings they affect"),
                        source_conflicts: strings("Contradictions between sources, kept open"),
                        reassessment_triggers: strings("Changes that require a new version"),
                        warning: { type: "string", enum: [...WARNINGS], description: "Internal escalation level" },
                        superseded: strings("Ids of earlier findings this version replaces"),
                    },
                    description: "The first record: everything. A patch: assessment_id and only what changes.",
                },
            },
            required: ["assessment"],
        },
    },
};

export const LOAD_ASSESSMENT_TOOL = {
    type: "function",
    function: {
        name: "load_assessment",
        description:
            "Load the latest version of an earlier assessment record of this chat (in a project: of any chat of the project) to continue it — a compact overview: counts, every finding's id, check, requirement, status, verification and closure criterion, and the open questions. Pass finding_ids to get those findings in full (evidence quotes included). Without assessment_id: the most recent one (of task_id, when given). Call it before patching an assessment.",
        parameters: {
            type: "object",
            properties: {
                assessment_id: { type: "string" },
                task_id: { type: "string" },
                finding_ids: { type: "array", items: { type: "string" }, description: "Findings to return in full" },
            },
        },
    },
};

// ---------------------------------------------------------------------------
// Parsing — collects every problem, path-prefixed
// ---------------------------------------------------------------------------

const MAX_ITEMS = 200;
const MAX_TEXT = 2000;
const MAX_QUOTE = 1500;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => v != null && typeof v === "object" && !Array.isArray(v);

class Errors {
    list: string[] = [];
    add(path: string, msg: string) {
        if (this.list.length < 40) this.list.push(`${path}: ${msg}`);
    }
}

function text(e: Errors, path: string, v: unknown, opts: { required?: boolean; max?: number } = {}): string | undefined {
    if (v == null || (typeof v === "string" && !v.trim())) {
        if (opts.required) e.add(path, "is required");
        return undefined;
    }
    if (typeof v !== "string" && typeof v !== "number") {
        e.add(path, "must be text");
        return undefined;
    }
    const t = String(v).trim();
    const max = opts.max ?? MAX_TEXT;
    return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function oneOf<T extends string>(
    e: Errors,
    path: string,
    v: unknown,
    allowed: readonly T[],
    opts: { required?: boolean; nullable?: boolean } = {},
): T | null | undefined {
    if (v == null || v === "") {
        if (opts.required && !opts.nullable) e.add(path, `is required (one of: ${allowed.join(", ")})`);
        return opts.nullable ? null : undefined;
    }
    if (typeof v === "string" && (allowed as readonly string[]).includes(v.trim())) return v.trim() as T;
    e.add(path, `must be one of: ${allowed.join(", ")}`);
    return undefined;
}

function list<T>(e: Errors, path: string, v: unknown, item: (x: unknown, p: string) => T | undefined): T[] {
    if (v == null) return [];
    if (!Array.isArray(v)) {
        e.add(path, "must be a list");
        return [];
    }
    if (v.length > MAX_ITEMS) e.add(path, `has more than ${MAX_ITEMS} items`);
    const out: T[] = [];
    v.slice(0, MAX_ITEMS).forEach((x, i) => {
        const r = item(x, `${path}[${i}]`);
        if (r !== undefined) out.push(r);
    });
    return out;
}

const texts = (e: Errors, path: string, v: unknown) =>
    list(e, path, v, (x, p) => text(e, p, x, { required: true }));

function evidenceList(e: Errors, path: string, v: unknown): Evidence[] {
    return list(e, path, v, (x, p) => {
        if (!isObj(x)) {
            e.add(p, "must be an object {doc_id, quote, page?}");
            return undefined;
        }
        const doc_id = text(e, `${p}.doc_id`, x.doc_id, { required: true, max: 300 });
        const quote = text(e, `${p}.quote`, x.quote, { required: true, max: MAX_QUOTE });
        const page = text(e, `${p}.page`, x.page, { max: 40 });
        if (!doc_id || !quote) return undefined;
        // The document it resolved to when it was recorded (carried over).
        const document_id = typeof x.document_id === "string" ? x.document_id : undefined;
        const filename = typeof x.filename === "string" ? x.filename : undefined;
        return {
            doc_id,
            ...(document_id ? { document_id } : {}),
            ...(filename ? { filename } : {}),
            quote,
            ...(page ? { page } : {}),
        };
    });
}

function uniqueIds(e: Errors, path: string, items: { id: string }[]): Set<string> {
    const seen = new Set<string>();
    for (const it of items) {
        if (seen.has(it.id)) e.add(path, `duplicate id ${it.id}`);
        seen.add(it.id);
    }
    return seen;
}

/**
 * Validate the model's assessment and normalize it. Errors name the field
 * (with the item's id where there is one) so the model can fix them.
 */
export function parseAssessment(raw: unknown): { ok: true; body: AssessmentBody; assessment_id?: string } | { ok: false; errors: string[] } {
    const e = new Errors();
    if (!isObj(raw)) return { ok: false, errors: ["assessment must be an object"] };

    const assessment_id = text(e, "assessment_id", raw.assessment_id, { max: 80 });
    const title = text(e, "title", raw.title, { required: true, max: 300 }) ?? "";
    const task_id = text(e, "task_id", raw.task_id, { max: 20 }) ?? null;

    const systems = list(e, "systems", raw.systems, (x, p) => {
        if (!isObj(x)) return void e.add(p, "must be an object {id, name, version?}");
        const id = text(e, `${p}.id`, x.id, { required: true, max: 80 });
        const name = text(e, `${p}.name`, x.name, { required: true, max: 300 });
        const version = text(e, `${p}.version`, x.version, { max: 80 });
        return id && name ? { id, name, ...(version ? { version } : {}) } : undefined;
    });
    const use_cases = list(e, "use_cases", raw.use_cases, (x, p) => {
        if (!isObj(x)) return void e.add(p, "must be an object {id, system_id, description}");
        const id = text(e, `${p}.id`, x.id, { required: true, max: 80 });
        const system_id = text(e, `${p}.system_id`, x.system_id, { required: true, max: 80 });
        const description = text(e, `${p}.description`, x.description, { required: true });
        return id && system_id && description ? { id, system_id, description } : undefined;
    });
    const roles = list(e, "roles", raw.roles, (x, p) => {
        if (!isObj(x)) return void e.add(p, "must be an object {use_case_id, role, basis}");
        const use_case_id = text(e, `${p}.use_case_id`, x.use_case_id, { required: true, max: 80 });
        const role = text(e, `${p}.role`, x.role, { required: true, max: 200 });
        const basis = text(e, `${p}.basis`, x.basis, { required: true });
        return use_case_id && role && basis ? { use_case_id, role, basis } : undefined;
    });
    const facts = list(e, "facts", raw.facts, (x, p): Fact | undefined => {
        if (!isObj(x)) return void e.add(p, "must be an object");
        const id = text(e, `${p}.id`, x.id, { required: true, max: 80 });
        const at = id ? `facts ${id}` : p;
        const statement = text(e, `${at}.statement`, x.statement, { required: true });
        const status = oneOf(e, `${at}.status`, x.status, FACT_STATUSES, { required: true });
        const use_case_id = text(e, `${at}.use_case_id`, x.use_case_id, { max: 80 });
        const value = text(e, `${at}.value`, x.value);
        const evidence = evidenceList(e, `${at}.evidence`, x.evidence);
        if (!id || !statement || !status) return undefined;
        return { id, statement, status, evidence, ...(use_case_id ? { use_case_id } : {}), ...(value ? { value } : {}) };
    });
    const decisions = list(e, "decisions", raw.decisions, (x, p): Decision | undefined => {
        if (!isObj(x)) return void e.add(p, "must be an object");
        const id = text(e, `${p}.id`, x.id, { required: true, max: 80 });
        const at = id ? `decisions ${id}` : p;
        const use_case_id = text(e, `${at}.use_case_id`, x.use_case_id, { required: true, max: 80 });
        const topic = text(e, `${at}.topic`, x.topic, { required: true, max: 300 });
        const classification = oneOf(e, `${at}.classification`, x.classification, CLASSIFICATIONS, { nullable: true }) ?? null;
        const limitation = oneOf(e, `${at}.limitation`, x.limitation, LIMITATIONS) ?? undefined;
        const reasoning = text(e, `${at}.reasoning`, x.reasoning, { required: true });
        const legal_sources = texts(e, `${at}.legal_sources`, x.legal_sources);
        const fact_ids = texts(e, `${at}.fact_ids`, x.fact_ids);
        // §10: every conclusion rests on a fact and a provision.
        if (id && fact_ids.length === 0) e.add(at, "needs at least one fact in fact_ids");
        if (id && legal_sources.length === 0) e.add(at, "needs at least one legal source");
        if (!id || !use_case_id || !topic || !reasoning) return undefined;
        return { id, use_case_id, topic, classification, ...(limitation ? { limitation } : {}), reasoning, legal_sources, fact_ids };
    });
    const findings = list(e, "findings", raw.findings, (x, p): Finding | undefined => {
        if (!isObj(x)) return void e.add(p, "must be an object");
        const id = text(e, `${p}.id`, x.id, { required: true, max: 80 });
        const at = id ? `findings ${id}` : p;
        const rawStatus = typeof x.status === "string" ? x.status.trim().replace(/️/g, "") : x.status;
        const status = oneOf(e, `${at}.status`, STATUS_BY_EMOJI[rawStatus as string] ?? rawStatus, FINDING_STATUSES, { required: true });
        const requirement = text(e, `${at}.requirement`, x.requirement, { required: true });
        const category = oneOf(e, `${at}.category`, x.category, CATEGORIES, { required: true });
        const applicability = oneOf(e, `${at}.applicability`, x.applicability, APPLICABILITY, { required: true });
        const evidence_weight = oneOf(e, `${at}.evidence_weight`, x.evidence_weight, EVIDENCE_WEIGHTS, { required: true });
        const verification = oneOf(e, `${at}.verification`, x.verification, VERIFICATIONS, { required: true });
        const closure_criterion = text(e, `${at}.closure_criterion`, x.closure_criterion, { required: true });
        const evidence = evidenceList(e, `${at}.evidence`, x.evidence);
        const opt = (k: string, max?: number) => text(e, `${at}.${k}`, x[k], { max });
        const check_id = opt("check_id", 80);
        const applicable_from = opt("applicable_from", 80);
        const practice = opt("practice");
        const method = opt("method");
        const action = opt("action");
        const owner_role = opt("owner_role", 200);
        const due = opt("due", 80);
        const due_kind = oneOf(e, `${at}.due_kind`, x.due_kind, DUE_KINDS) ?? undefined;
        let closed_by: Finding["closed_by"];
        if (x.closed_by != null) {
            if (!isObj(x.closed_by)) e.add(`${at}.closed_by`, "must be an object {evidence}");
            else {
                const ev = evidenceList(e, `${at}.closed_by.evidence`, x.closed_by.evidence);
                const v = Number(x.closed_by.version);
                closed_by = { version: Number.isInteger(v) && v > 0 ? v : 0, evidence: ev };
            }
        }
        // Nema zelenog bez dokaza (§4, §5.1.1, VT-35).
        if (status === "ok") {
            if (evidence.length === 0) {
                e.add(at, "is ok (🟢) without evidence — nema zelenog bez dokaza: add the document and quote that shows it, or use another status");
            } else if (evidence_weight && NOT_EVIDENCE.includes(evidence_weight)) {
                e.add(at, `is ok (🟢) on evidence_weight "${evidence_weight}" — a statement is not proof of fulfilment; use another status until there is a document, a third-party report or an observation`);
            }
            if (verification && !VERIFIED.includes(verification)) {
                e.add(at, `is ok (🟢) with verification "${verification}" — a finding is green only when it was verified (provjereno or djelomično)`);
            }
        }
        if (!id || !status || !requirement || !category || !applicability || !evidence_weight || !verification || !closure_criterion) {
            return undefined;
        }
        return {
            id,
            ...(check_id ? { check_id } : {}),
            requirement,
            category,
            applicability,
            ...(applicable_from ? { applicable_from } : {}),
            ...(practice ? { practice } : {}),
            evidence,
            evidence_weight,
            verification,
            ...(method ? { method } : {}),
            status,
            ...(action ? { action } : {}),
            ...(owner_role ? { owner_role } : {}),
            ...(due ? { due } : {}),
            ...(due_kind ? { due_kind } : {}),
            closure_criterion,
            ...(closed_by ? { closed_by } : {}),
        };
    });

    // Every open finding says what happens next (§10: "sljedeća radnja").
    const noAction = findings.filter((f) => f.status !== "ok" && !f.action).map((f) => f.id);
    if (noAction.length) {
        e.add(
            `findings ${noAction.join(", ")}`,
            "action is required for every finding that is not ok — say what to do next (who obtains, changes or tests what)",
        );
    }

    // References between the parts.
    const systemIds = uniqueIds(e, "systems", systems);
    const useCaseIds = uniqueIds(e, "use_cases", use_cases);
    const factIds = uniqueIds(e, "facts", facts);
    uniqueIds(e, "decisions", decisions);
    uniqueIds(e, "findings", findings);
    for (const u of use_cases) {
        if (systemIds.size && !systemIds.has(u.system_id)) e.add(`use_cases ${u.id}`, `unknown system_id ${u.system_id}`);
    }
    const knownUseCase = (path: string, id: string | undefined) => {
        if (id && useCaseIds.size && !useCaseIds.has(id)) e.add(path, `unknown use_case_id ${id}`);
    };
    for (const r of roles) knownUseCase("roles", r.use_case_id);
    for (const f of facts) knownUseCase(`facts ${f.id}`, f.use_case_id);
    for (const d of decisions) {
        knownUseCase(`decisions ${d.id}`, d.use_case_id);
        for (const fid of d.fact_ids) if (!factIds.has(fid)) e.add(`decisions ${d.id}`, `unknown fact ${fid}`);
    }

    const body: AssessmentBody = {
        title,
        task_id,
        facts_as_of: text(e, "facts_as_of", raw.facts_as_of, { max: 40 }) ?? null,
        sources_checked_at: text(e, "sources_checked_at", raw.sources_checked_at, { max: 40 }) ?? null,
        systems,
        use_cases,
        roles,
        facts,
        decisions,
        findings,
        unread_documents: texts(e, "unread_documents", raw.unread_documents),
        source_conflicts: texts(e, "source_conflicts", raw.source_conflicts),
        reassessment_triggers: texts(e, "reassessment_triggers", raw.reassessment_triggers),
        warning: oneOf(e, "warning", raw.warning, WARNINGS, { nullable: true }) ?? null,
        superseded: texts(e, "superseded", raw.superseded),
    };
    if (e.list.length) return { ok: false, errors: e.list };
    return { ok: true, body, ...(assessment_id ? { assessment_id } : {}) };
}

/** Findings per status (§10: the totals must match the rows). */
export function countByStatus(findings: Pick<Finding, "status">[]): StatusCounts {
    const counts: StatusCounts = { material: 0, gap: 0, legal: 0, insufficient: 0, ok: 0 };
    for (const f of findings) counts[f.status]++;
    return counts;
}

/**
 * The rules of a new version against the previous one: every earlier
 * finding is kept or listed as superseded; a finding turns green only with
 * new evidence in `closed_by`. Returns the errors and the changes.
 */
export function compareVersions(
    prev: AssessmentSnapshot,
    next: AssessmentBody,
    version: number,
): { errors: string[]; changes: AssessmentChanges } {
    const errors: string[] = [];
    const before = new Map(prev.findings.map((f) => [f.id, f]));
    const now = new Map(next.findings.map((f) => [f.id, f]));
    for (const id of next.superseded) {
        if (!before.has(id)) errors.push(`superseded: ${id} is not a finding of version ${prev.version}`);
        if (now.has(id)) errors.push(`superseded: ${id} is still among the findings — supersede it or keep it, not both`);
    }
    for (const id of before.keys()) {
        if (!now.has(id) && !next.superseded.includes(id)) {
            errors.push(`findings ${id} of version ${prev.version} is missing — keep it (update its status) or list it in superseded`);
        }
    }
    const changes: AssessmentChanges = { from_version: prev.version, closed: [], added: [], changed: [], superseded: [...next.superseded] };
    for (const f of next.findings) {
        const old = before.get(f.id);
        if (!old) {
            changes.added.push(f.id);
            continue;
        }
        if (old.status !== "ok" && f.status === "ok") {
            if (!f.closed_by || f.closed_by.evidence.length === 0) {
                errors.push(`findings ${f.id} turns green — close it with closed_by: {evidence: [the new evidence that meets its closure criterion]}`);
            } else {
                f.closed_by.version = version;
            }
            changes.closed.push(f.id);
        } else if (JSON.stringify(old) !== JSON.stringify(f)) {
            changes.changed.push(f.id);
        }
    }
    return { errors, changes };
}

// ---------------------------------------------------------------------------
// Patches
// ---------------------------------------------------------------------------

/** The parts upserted by id (roles by use case and role — they have no id). */
const COLLECTIONS = ["systems", "use_cases", "roles", "facts", "decisions", "findings"] as const;
const keyOf = (coll: (typeof COLLECTIONS)[number], item: Obj) =>
    coll === "roles" ? `${String(item.use_case_id)}|${String(item.role)}` : String(item.id);
/** Top-level fields a patch replaces only when it gives them. */
const REPLACEABLE = [
    "title",
    "task_id",
    "facts_as_of",
    "sources_checked_at",
    "warning",
    "unread_documents",
    "source_conflicts",
    "reassessment_triggers",
] as const;

/**
 * Apply a patch to the previous version: items upserted by id (the fields
 * given replace those fields), everything else carried over, findings in
 * `superseded` removed, top-level fields replaced only when given. The
 * result is a whole record, validated like a first one.
 */
export function applyPatch(prev: AssessmentSnapshot, patch: Obj): { merged: Obj; errors: string[] } {
    const errors: string[] = [];
    const merged: Obj = JSON.parse(
        JSON.stringify({
            title: prev.title,
            task_id: prev.task_id,
            facts_as_of: prev.facts_as_of,
            sources_checked_at: prev.sources_checked_at,
            warning: prev.warning,
            unread_documents: prev.unread_documents,
            source_conflicts: prev.source_conflicts,
            reassessment_triggers: prev.reassessment_triggers,
            systems: prev.systems,
            use_cases: prev.use_cases,
            roles: prev.roles,
            facts: prev.facts,
            decisions: prev.decisions,
            findings: prev.findings,
        }),
    );
    for (const k of REPLACEABLE) if (k in patch) merged[k] = patch[k];
    for (const coll of COLLECTIONS) {
        const items = patch[coll];
        if (items == null) continue;
        if (!Array.isArray(items)) {
            errors.push(`${coll}: must be a list`);
            continue;
        }
        const base = merged[coll] as Obj[];
        items.forEach((item, i) => {
            if (!isObj(item)) return void errors.push(`${coll}[${i}]: must be an object`);
            if (coll !== "roles" && (typeof item.id !== "string" || !item.id.trim())) {
                return void errors.push(`${coll}[${i}].id: is required — items are matched by id`);
            }
            const at = base.findIndex((b) => keyOf(coll, b) === keyOf(coll, item));
            if (at >= 0) base[at] = { ...base[at], ...item };
            else base.push(item);
        });
    }
    const superseded = Array.isArray(patch.superseded)
        ? patch.superseded.filter((x): x is string => typeof x === "string" && !!x.trim()).map((x) => x.trim())
        : [];
    const patched = new Set(
        (Array.isArray(patch.findings) ? patch.findings : []).filter(isObj).map((f) => String(f.id)),
    );
    for (const id of superseded) {
        if (!prev.findings.some((f) => f.id === id)) errors.push(`superseded: ${id} is not a finding of version ${prev.version}`);
        if (patched.has(id)) errors.push(`superseded: ${id} is also in findings — supersede it or update it, not both`);
    }
    merged.findings = (merged.findings as Obj[]).filter((f) => !superseded.includes(String(f.id)));
    merged.superseded = superseded;
    return { merged, errors };
}

// ---------------------------------------------------------------------------
// The per-turn ledger
// ---------------------------------------------------------------------------

/** The document a doc_id names this turn (doc-N label or document UUID). */
export type DocLookup = (docId: string) => { document_id: string; filename: string } | null;

export interface AssessmentLedger {
    record(raw: unknown): Promise<{ ok: true; snapshot: AssessmentSnapshot } | { ok: false; errors: string[] }>;
    load(args: { assessment_id?: string; task_id?: string }): Promise<AssessmentSnapshot | null>;
}

export function createAssessmentLedger(opts: {
    /** Earlier versions (prior assessment_recorded events); called once, lazily. */
    loadPrior: () => Promise<AssessmentSnapshot[]>;
    /** The context and workflow of a task id among the active contexts. */
    resolveTask?: (taskId: string) => { context: AssessmentSnapshot["context"]; workflow: AssessmentSnapshot["workflow"] } | null;
    lookupDoc?: DocLookup;
    now?: () => Date;
    newId?: () => string;
}): AssessmentLedger {
    let prior: Promise<AssessmentSnapshot[]> | null = null;
    const recorded: AssessmentSnapshot[] = [];
    const all = async () => {
        prior ??= opts.loadPrior().catch((err) => {
            console.warn("[assessment] loading earlier versions failed (non-fatal):", err instanceof Error ? err.message : err);
            return [];
        });
        return [...(await prior), ...recorded];
    };
    const latest = (list: AssessmentSnapshot[], pick: (s: AssessmentSnapshot) => boolean) =>
        list.filter(pick).reduce<AssessmentSnapshot | null>(
            (best, s) => (!best || s.version > best.version || (s.version === best.version && s.recorded_at > best.recorded_at) ? s : best),
            null,
        );
    // The model's input with each new evidence item's doc_id resolved to a
    // document of this turn (items that already carry one are left as is).
    const resolveEvidence = (raw: Obj): Obj => {
        const input: Obj = JSON.parse(JSON.stringify(raw));
        const fix = (list: unknown) => {
            if (!Array.isArray(list)) return;
            for (const ev of list) {
                if (!isObj(ev) || typeof ev.doc_id !== "string" || typeof ev.document_id === "string") continue;
                const doc = opts.lookupDoc?.(ev.doc_id.trim());
                if (doc) Object.assign(ev, { document_id: doc.document_id, filename: doc.filename });
            }
        };
        for (const f of Array.isArray(input.facts) ? input.facts : []) if (isObj(f)) fix(f.evidence);
        for (const f of Array.isArray(input.findings) ? input.findings : []) {
            if (!isObj(f)) continue;
            fix(f.evidence);
            if (isObj(f.closed_by)) fix(f.closed_by.evidence);
        }
        return input;
    };

    return {
        async record(raw) {
            if (!isObj(raw)) return { ok: false, errors: ["assessment must be an object"] };
            // New evidence points at this turn's documents; carried-over
            // evidence keeps the document it was recorded with.
            const input = resolveEvidence(raw);
            const givenId = typeof input.assessment_id === "string" ? input.assessment_id.trim() : "";
            let assessment_id = givenId;
            let version = 1;
            let body: AssessmentBody;
            let changes: AssessmentChanges | undefined;
            if (!givenId) {
                // One record per turn: update it rather than forking it.
                const last = recorded.at(-1);
                if (last) {
                    return {
                        ok: false,
                        errors: [
                            `this turn already recorded ${last.assessment_id} (v${last.version}) — use assessment_id ${last.assessment_id} to update it, sending only the changed or new items`,
                        ],
                    };
                }
                const parsed = parseAssessment(input);
                if (!parsed.ok) return parsed;
                body = parsed.body;
                body.superseded = [];
                assessment_id = opts.newId?.() ?? `PROC-${randomUUID().slice(0, 8).toUpperCase()}`;
            } else {
                const prev = latest(await all(), (s) => s.assessment_id === givenId);
                if (!prev) {
                    return {
                        ok: false,
                        errors: [`assessment_id ${givenId} is not an assessment of this chat (or project) — call load_assessment, or leave assessment_id out to start a new one`],
                    };
                }
                const patched = applyPatch(prev, input);
                if (patched.errors.length) return { ok: false, errors: patched.errors };
                const parsed = parseAssessment(patched.merged);
                if (!parsed.ok) return parsed;
                body = parsed.body;
                version = prev.version + 1;
                const cmp = compareVersions(prev, body, version);
                if (cmp.errors.length) return { ok: false, errors: cmp.errors };
                changes = cmp.changes;
            }
            const task = body.task_id ? opts.resolveTask?.(body.task_id) ?? null : null;
            const counts = countByStatus(body.findings);
            const snapshot: AssessmentSnapshot = {
                assessment_id,
                version,
                recorded_at: (opts.now?.() ?? new Date()).toISOString(),
                ...body,
                context: task?.context ?? null,
                workflow: task?.workflow ?? null,
                counts,
                total: body.findings.length,
                ...(changes ? { changes } : {}),
            };
            recorded.push(snapshot);
            return { ok: true, snapshot };
        },
        async load({ assessment_id, task_id }) {
            const list = await all();
            if (assessment_id) return latest(list, (s) => s.assessment_id === assessment_id);
            // No id: the most recently recorded assessment (of the task, when given).
            const pool = task_id ? list.filter((s) => s.task_id === task_id) : list;
            return pool.reduce<AssessmentSnapshot | null>((best, s) => (!best || s.recorded_at >= best.recorded_at ? s : best), null);
        },
    };
}

// ---------------------------------------------------------------------------
// Earlier versions — from the persisted events
// ---------------------------------------------------------------------------

/** The assessment snapshots among stored message events. */
export function assessmentsFromEvents(contents: unknown[]): AssessmentSnapshot[] {
    const out: AssessmentSnapshot[] = [];
    for (const content of contents) {
        if (!Array.isArray(content)) continue;
        for (const ev of content as Obj[]) {
            if (ev?.type !== "assessment_recorded" || !isObj(ev.assessment)) continue;
            const a = ev.assessment as unknown as AssessmentSnapshot;
            if (typeof a.assessment_id === "string" && Number.isInteger(a.version) && Array.isArray(a.findings)) out.push(a);
        }
    }
    return out;
}

// Minimal structural type of the Supabase-compatible client used here.
type Rows<T> = PromiseLike<{ data: T[] | null }>;
type Db = {
    from(table: string): {
        select(cols: string): {
            eq(col: string, val: string): {
                eq(col: string, val: string): { order(col: string, o: { ascending: boolean }): { limit(n: number): Rows<{ content: unknown }> } };
                neq(col: string, val: string): Rows<{ id: string }>;
            };
            in(col: string, vals: string[]): {
                eq(col: string, val: string): { order(col: string, o: { ascending: boolean }): { limit(n: number): Rows<{ content: unknown }> } };
            };
        };
    };
};

const MAX_MESSAGES = 400;

/**
 * Earlier assessment versions in scope: this chat's answers, or — in a
 * project chat — the answers of every (not deleted) chat of the project.
 */
export async function loadPriorAssessments(
    db: unknown,
    scope: { chatId?: string | null; projectId?: string | null },
): Promise<AssessmentSnapshot[]> {
    const sb = db as Db;
    let chatIds: string[] = scope.chatId ? [scope.chatId] : [];
    if (scope.projectId) {
        const { data } = await sb.from("chats").select("id").eq("project_id", scope.projectId).neq("status", "deleted");
        chatIds = [...new Set([...chatIds, ...(data ?? []).map((r) => r.id)])];
    }
    if (chatIds.length === 0) return [];
    const { data } = await sb
        .from("chat_messages")
        .select("content")
        .in("chat_id", chatIds)
        .eq("role", "assistant")
        .order("created_at", { ascending: false })
        .limit(MAX_MESSAGES);
    return assessmentsFromEvents((data ?? []).map((r) => r.content));
}

// ---------------------------------------------------------------------------
// What the model reads back
// ---------------------------------------------------------------------------

const STATUS_EMOJI: Record<FindingStatus, string> = {
    material: "🔴",
    gap: "🟡",
    legal: "🔵",
    insufficient: "⚪",
    ok: "🟢",
};

export function countsLine(counts: StatusCounts): string {
    return FINDING_STATUSES.map((s) => `${STATUS_EMOJI[s]} ${counts[s]}`).join(" · ");
}

/** record_assessment's reply: the id, version, counts and changes to use in the answer. */
export function assessmentAck(s: AssessmentSnapshot): string {
    const c = s.changes;
    const changes = c
        ? ` Against v${c.from_version}: closed ${c.closed.join(", ") || "none"}; new ${c.added.join(", ") || "none"}; changed ${c.changed.join(", ") || "none"}; superseded ${c.superseded.join(", ") || "none"}.`
        : "";
    return (
        `Recorded assessment ${s.assessment_id} v${s.version}: ${countsLine(s.counts)} (${s.total} findings${s.warning ? `, ${s.warning}` : ""}).${changes} ` +
        `Use exactly these counts in the summary and documents. To change it, call record_assessment with assessment_id ${s.assessment_id} and only the changed or new items — do not send the whole record again.`
    );
}

const clip = (t: string, max: number) => (t.length > max ? `${t.slice(0, max - 1)}…` : t);

/**
 * load_assessment's reply. By default a compact overview — counts, one line
 * per finding (id, check, status, verification, requirement, closure
 * criterion) and the open questions — so continuing a long record does not
 * pull every evidence quote back into the context; `findingIds` returns
 * those findings in full, evidence pointed at this turn's doc ids.
 */
export function assessmentForModel(
    s: AssessmentSnapshot,
    labelFor?: (documentId: string) => string | null,
    findingIds: string[] = [],
): string {
    const head =
        `Assessment ${s.assessment_id}, latest version v${s.version}${s.task_id ? ` (${s.task_id})` : ""} — ${s.title}; recorded ${s.recorded_at}` +
        `${s.warning ? `; warning ${s.warning}` : ""}.\nCounts: ${countsLine(s.counts)} (${s.total} findings).`;
    const howTo =
        `To continue: call record_assessment with assessment_id ${s.assessment_id} and ONLY the changed or new items (a patch — everything else is carried over; it becomes v${s.version + 1}). ` +
        `Close a finding only with new evidence that meets its closure_criterion (closed_by); remove one only through superseded.`;
    if (findingIds.length) {
        const relabel = (list: Evidence[]) =>
            list.map(({ document_id, filename, ...ev }) => {
                const label = document_id ? labelFor?.(document_id) : null;
                return { ...ev, doc_id: label ?? (filename ? `${filename} (not attached this turn)` : ev.doc_id) };
            });
        const wanted = s.findings.filter((f) => findingIds.includes(f.id));
        const missing = findingIds.filter((id) => !wanted.some((f) => f.id === id));
        const full = wanted.map((f) => ({
            ...f,
            evidence: relabel(f.evidence),
            ...(f.closed_by ? { closed_by: { ...f.closed_by, evidence: relabel(f.closed_by.evidence) } } : {}),
        }));
        return `${head}\nFindings in full${missing.length ? ` (not found: ${missing.join(", ")})` : ""}:\n${JSON.stringify(full)}\n${howTo}`;
    }
    const lines = s.findings.map(
        (f) =>
            `- ${f.id}${f.check_id ? ` [${f.check_id}]` : ""} ${f.status} · ${f.verification} · ${clip(f.requirement, 160)} — closes when: ${clip(f.closure_criterion, 160)}`,
    );
    const open: string[] = [];
    for (const f of s.facts) {
        if (f.status === "unknown" || f.status === "conflicting") open.push(`fact ${f.id} (${f.status}): ${clip(f.statement, 160)}`);
    }
    for (const d of s.decisions) {
        if (d.limitation) open.push(`decision ${d.id} (${d.limitation}): ${clip(d.topic, 120)}`);
    }
    for (const u of s.unread_documents) open.push(`unread document: ${clip(u, 200)}`);
    for (const c of s.source_conflicts) open.push(`source conflict: ${clip(c, 200)}`);
    const scope = [
        s.systems.length ? `Systems: ${s.systems.map((x) => `${x.id} ${x.name}${x.version ? ` ${x.version}` : ""}`).join("; ")}` : "",
        s.use_cases.length ? `Use cases: ${s.use_cases.map((u) => `${u.id} (${u.system_id}) ${clip(u.description, 100)}`).join("; ")}` : "",
    ].filter(Boolean);
    // Classifications and the Checker path (decisions CHK-…), so a continued
    // assessment does not re-walk or contradict them.
    const decisions = s.decisions.map(
        (d) =>
            `- ${d.id} · ${d.use_case_id} · ${clip(d.topic, 120)}${d.classification ? ` → ${d.classification}` : ""}${d.limitation ? ` (${d.limitation})` : ""}`,
    );
    return [
        head,
        ...scope,
        ...(decisions.length ? [`Decisions (id · use case · topic → classification):`, ...decisions] : []),
        `Findings (id [check] status · verification · requirement — closure criterion):`,
        ...lines,
        open.length ? `Open questions:\n${open.map((o) => `- ${o}`).join("\n")}` : "Open questions: none recorded.",
        `Ask with finding_ids for any finding's full record (evidence quotes, practice, action, owner, due).`,
        howTo,
    ].join("\n");
}

/** The previous turn's assessments, one line each, for the tool-activity summary. */
export function assessmentSummaryLine(s: AssessmentSnapshot): string {
    return `- record_assessment: ${s.assessment_id} v${s.version}${s.task_id ? ` (${s.task_id})` : ""} — ${countsLine(s.counts)}; continue it with load_assessment`;
}
