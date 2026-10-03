/**
 * Legal-reference resolution after the answer is complete (tracker #45, L3).
 *
 * The answer's article references ("članka 8. stavka 1. Zakona o iznimnim
 * mjerama kontrole cijena") are found by REGEX — the same expression the
 * frontend linker uses, so both sides see the same spans — and each one is
 * assigned to an act in three tiers:
 *
 *   1. regex   — the act is named right next to the reference and a
 *                harvested source of that act carries that article. Final;
 *                the model cannot override it.
 *   2. model   — a fast model (Haiku) reads the whole answer and assigns the
 *                remaining references to acts from a CLOSED list (the
 *                harvested registry) or names an act the registry lacks. It
 *                resolves back-references ("istog Zakona"), abbreviations
 *                ("ZOR-a"), enumerations and Croatian common names of EU
 *                acts — everything the regex deliberately leaves alone.
 *   3. lookup  — (act, article) pairs the registry lacks are fetched from
 *                the legal MCP (`resolve` + `get_article`) and become new
 *                `legal_sources`; a pair the corpus cannot confirm is marked
 *                `unverified` — the hallucination signal.
 *
 * Output: a `legal_refs` event (one row per regex span, keyed by article
 * number + occurrence so the frontend can find the same span after its own
 * preprocessing) plus the sources the lookup added. Everything is fail-soft
 * and budgeted: the model call and each MCP call have their own timeout, at
 * most LOOKUP_CAP lookups per turn, and any failure degrades to what the
 * regex alone decided — exactly the pre-existing behaviour.
 */

import type { LegalSource } from "./chatTools";
import { harvestLegalSources } from "./chatTools";
import type { LoadedMcpServer } from "./mcp/types";
import { completeText } from "./llm";
import type { LlmUsage } from "./llm/types";
import type { UserApiKeys } from "./llm";
import {
    identifierInScope,
    isLegalMcpServer,
    redactToolResult,
} from "./seams/scopeEnforcement";

// ---------------------------------------------------------------------------
// Regex layer — MUST stay byte-identical to
// frontend/src/app/components/shared/legalRefLinking.ts (the frontend finds
// the same spans to apply this event; see `applyLegalRefs` there).
// ---------------------------------------------------------------------------

export const ARTICLE_REF_RE =
    /(?<![\p{L}\p{N}])(?:članc\w*|člank\w*|članak\w*|articol\w*|artikel\w*|articles?|art\.?|čl\.?|§{1,2})\s*(\d+(?:\.?[a-z](?![a-z]))?)(?!\d|\.\d)/giu;

export function normalizeArticleNumber(raw: string): string {
    return raw.replace(/[.\s]/g, "").toLowerCase();
}

// Enumerations and ranges after a reference: "članaka 158. i 166.", "čl. 5.,
// 7. i 9.", "članci 10. do 15.", "Articles 5, 6 and 7", "§§ 12-14". Prose
// does not repeat the keyword, so each listed number is its own span (a
// range links its end points). Croatian references carry the ordinal dot on
// every number ("158. i 166."), which keeps "od 5 do 12 godina" out; a
// number followed by a month, a unit or "godine" is never an article.
const ARTICLE_CONT_RE =
    /^(\.?)(\s*,\s*|\s*[–—-]\s*|\s+(?:i|te|ili|do|and|or|to|et|und|oder|bis)\s+)(\d{1,4}(?:\.?[a-z](?![\p{L}]))?)(?![\p{N}])/iu;
const NOT_ARTICLE_AFTER_RE =
    /^\.?\s*(?:godin\p{L}*|mjesec\p{L}*|dan(?:a|i)?(?![\p{L}])|sat\p{L}*|eur\p{L}*|kun\p{L}*|kn(?![\p{L}])|%|posto|siječnj\p{L}*|veljač\p{L}*|ožujk\p{L}*|travnj\p{L}*|svibnj\p{L}*|lipnj\p{L}*|srpnj\p{L}*|kolovoz\p{L}*|rujn\p{L}*|listopad\p{L}*|studen\p{L}*|prosin\p{L}*|years?|months?|days?)/iu;
const MAX_CONTINUATIONS = 12;

// A reference whose prose continues with a document of the user's own —
// "članka 13. Ugovora", "čl. 4. stavka 2. Dodatka br. 4", "točke 3. ponude",
// "Općih uvjeta", "Pravilnika o radu" — cites that document, not a law, and
// must never be linked to a harvested act that happens to carry the same
// number (BugFix 2026-09-28: "članak 13.7" of company documents opened
// Zakon o komunalnom gospodarstvu, čl. 13). EU treaties ("Ugovora o
// funkcioniranju Europske unije") are acts and stay linkable.
// MUST stay identical in backend lib/legalRefs.ts and frontend
// components/shared/legalRefLinking.ts.
export const DOCUMENT_ANCHOR_RE =
    /^\.?\s*(?:(?:st(?:av\p{L}*|\.)|toč(?:k\p{L}*|\.)|podtoč\p{L}*|alin\p{L}*|podstav\p{L}*)\s*\d+\.?\s*(?:[a-z]\)\s*)?,?\s*)*(?:of\s+(?:the\s+|this\s+)?)?(?:(?:ovog|ovoga|tog|toga|navedenog|predmetnog|osnovnog|istog|našeg|vašeg|glavnog|kolektivn\p{L}*|okvirn\p{L}*|kupoprodajn\p{L}*|društven\p{L}*)\s+)?(?:ugovor(?:a|u|om|i|e|ima)?(?!\s+o\s+(?:europsk|funkcionir|pristupanj|osnivanj))|dodat(?:ak|ka|ku|kom|ci|aka)|aneks\p{L}*|ponud(?:a|e|i|u|om)|opć\p{L}*\s+uvjet\p{L}*|pravilnik\p{L}*\s+o\s+radu|klauzul\p{L}*|contract|clause|addendum|offer|terms\s+and\s+conditions)(?![\p{L}])/iu;

export function anchoredToDocument(after: string): boolean {
    return DOCUMENT_ANCHOR_RE.test(after);
}

/** Every article reference in `text`, in order: each ARTICLE_REF_RE match
 *  plus the numbers enumerated right after it. `num` is the number as
 *  written ("17.a"); `text` the span to mark. */
export function articleSpansIn(
    text: string,
): Array<{ index: number; text: string; num: string }> {
    const out: Array<{ index: number; text: string; num: string }> = [];
    for (const m of text.matchAll(ARTICLE_REF_RE)) {
        const index = m.index ?? 0;
        // A rendered document-citation token (`§3§`) is not "§ 3" — a real
        // section sign is never closed by another one. Skipping it keeps the
        // frontend's (number, occurrence) keys in line with the backend,
        // which scans the raw answer where the token is still "[3]".
        if (m[0].startsWith("§") && text[index + m[0].length] === "§") continue;
        out.push({ index, text: m[0], num: m[1] });
        const croatian = /^čl/iu.test(m[0]);
        let p = index + m[0].length;
        for (let k = 0; k < MAX_CONTINUATIONS; k++) {
            const c = text.slice(p, p + 40).match(ARTICLE_CONT_RE);
            if (!c) break;
            if (croatian && c[1] !== ".") break;
            const start = p + c[1].length + c[2].length;
            const end = start + c[3].length;
            const rest = text.slice(end, end + 24);
            if (croatian && !rest.startsWith(".")) break;
            if (NOT_ARTICLE_AFTER_RE.test(rest)) break;
            out.push({ index: start, text: c[3], num: c[3] });
            p = end;
        }
    }
    return out;
}

const ACT_STOPWORDS = new Set([
    "o", "i", "u", "na", "za", "te", "od", "iz", "s", "sa",
    "of", "the", "and", "on", "for",
    "de", "du", "des", "la", "le", "les", "et",
    "und", "der", "die", "das",
    "del", "della", "dei", "e",
    "eu", "ez", "eec",
]);

function stem(word: string): string {
    return word.toLowerCase().slice(0, 5);
}

export function actTokens(title: string): string[] {
    const out: string[] = [];
    for (const m of title.matchAll(/\p{L}+/gu)) {
        const w = m[0].toLowerCase();
        if (w.length < 3 || ACT_STOPWORDS.has(w)) continue;
        out.push(stem(w));
    }
    return out;
}

const ACT_KEYWORD_RE =
    /(?<![\p{L}])(?:[Zz]akonik\p{L}*|[Zz]akon\p{L}*|[Pp]ravilnik\p{L}*|[Uu]redb\p{L}*|[Oo]dluk\p{L}*|[Uu]stav\p{L}*|[Kk]odeks\p{L}*|[Dd]irektiv\p{L}*|Regulation|Directive|Decision|Act|Code|Gesetz\p{L}*|Verordnung|Richtlinie|Loi|Décret|Règlement|Codice|Legge|Decreto|Regolamento|Direttiva)(?![\p{L}])/gu;
const DEMONSTRATIVE_RE =
    /(?:ovog|ovoga|ove|toga|tog|te|istog|istoga|iste|navedenog|navedene|spomenutog|spomenute|this|that|the same|dieses|dieser|derselben)\s+$/iu;
const EU_KEYWORD_RE =
    /^(?:[Uu]redb|[Oo]dluk|[Dd]irektiv|Regulation|Directive|Decision|Verordnung|Richtlinie|Règlement|Regolamento|Direttiva)/u;

export function namedActsIn(
    window: string,
    side: "after" | "before" = "after",
): { named: boolean; euPossible: boolean } {
    const mentions: string[] = [];
    for (const m of window.matchAll(ACT_KEYWORD_RE)) {
        const before = window.slice(Math.max(0, (m.index ?? 0) - 16), m.index);
        if (DEMONSTRATIVE_RE.test(before)) continue;
        mentions.push(m[0]);
    }
    if (mentions.length === 0) return { named: false, euPossible: false };
    const nearest = side === "after" ? mentions[0] : mentions[mentions.length - 1];
    return { named: true, euPossible: EU_KEYWORD_RE.test(nearest) };
}

// Keyword stems that every act shares ("zakon", "uredb", …) — they never
// identify an act on their own, so ranking by position skips them.
const GENERIC_ACT_STEMS = new Set([
    "zakon", "pravi", "uredb", "odluk", "ustav", "kodek", "direk", "regul",
    "direc", "decis", "gesez", "veror", "richt", "règle", "regol", "diret",
]);

/**
 * The stretch of `window` that holds the act mention NEAREST the reference:
 * from the closest non-demonstrative act keyword, at most ACT_SPAN chars
 * onward ("Zakona o iznimnim mjerama kontrole cijena (NN 40/25)…"). Matching
 * inside this stretch only keeps a second act two clauses away ("… Prema
 * članku 9. Zakona o trgovini") from claiming the reference. Null when no
 * act is named.
 *
 * Croatian puts an act's identifying adjective BEFORE the keyword
 * ("Kaznenog zakona", "Ovršnog zakona", "Pomorskog zakonika"), so the
 * stretch also takes up to two words right before the keyword —
 * letters and spaces only, so "stavak 1. Kaznenog zakona" pulls in
 * "Kaznenog" but never "1.". Starting AT the keyword cut "Kaznenog" off and
 * left every Kazneni zakon reference named-but-unmatched → Haiku had to
 * resolve what the regex should settle.
 */
const ACT_SPAN = 80;
const ACT_LEAD_RE = /(?:\p{L}+\s+){1,2}$/u;
export function nearestActSpan(
    window: string,
    side: "after" | "before",
): string | null {
    let pick: number | null = null;
    for (const m of window.matchAll(ACT_KEYWORD_RE)) {
        const before = window.slice(Math.max(0, (m.index ?? 0) - 16), m.index);
        if (DEMONSTRATIVE_RE.test(before)) continue;
        pick = m.index ?? 0;
        if (side === "after") break; // first mention is the nearest
    }
    if (pick === null) return null;
    const lead = window.slice(0, pick).match(ACT_LEAD_RE)?.[0] ?? "";
    return window.slice(pick - lead.length, pick + ACT_SPAN);
}

export function actMentionPosition(window: string, title: string): number {
    const tokens = actTokens(title);
    if (tokens.length === 0) return -1;
    const words = [...window.matchAll(/\p{L}+/gu)].map((m) => stem(m[0]));
    let first = -1;
    let firstSpecific = -1;
    for (const t of tokens) {
        const at = words.indexOf(t);
        if (at < 0) return -1;
        if (first < 0 || at < first) first = at;
        if (!GENERIC_ACT_STEMS.has(t) && (firstSpecific < 0 || at < firstSpecific)) {
            firstSpecific = at;
        }
    }
    // Rank by the first identifying word ("trgov", "iznim"), not by the
    // shared keyword ("zakon") that every act title starts with.
    return firstSpecific >= 0 ? firstSpecific : first;
}

/** Act title of a source: `documentTitle`, else `title` minus ", čl. N …". */
export function actTitleOf(source: LegalSource): string | null {
    if (source.kind === "caselaw") return null;
    const own = (source.documentTitle || "").trim();
    if (own) return own;
    const raw = (source.title || "").trim();
    if (!raw) return null;
    const cut = raw.replace(
        /\s*[,;—–-]\s*(?:čl\.?|članak|članc\w*|člank\w*|art\.?|articles?|articol\w*|artikel\w*|§{1,2})\s*\d.*$/iu,
        "",
    );
    return cut.trim() || null;
}

/**
 * Deterministic choice among the sources carrying the referenced number.
 * Returns the source, or null; `strong` says an act named in the prose
 * settled it (the model may not override a strong pick).
 */
export function pickSourceForRef(
    candidates: LegalSource[],
    after: string,
    before: string,
): { source: LegalSource | null; strong: boolean; actNamed: boolean } {
    if (candidates.length === 0) {
        const actNamed = namedActsIn(after).named || namedActsIn(before, "before").named;
        return { source: null, strong: false, actNamed };
    }
    for (const [window, side] of [
        [after, "after"],
        [before, "before"],
    ] as const) {
        const acts = namedActsIn(window, side);
        if (!acts.named) continue;
        const span = nearestActSpan(window, side) ?? window;
        let best: LegalSource | null = null;
        let bestPos = Number.POSITIVE_INFINITY;
        for (const c of candidates) {
            const title = actTitleOf(c);
            if (!title) continue;
            const pos = actMentionPosition(span, title);
            if (pos >= 0 && pos < bestPos) {
                best = c;
                bestPos = pos;
            }
        }
        if (best) return { source: best, strong: true, actNamed: true };
        if (acts.euPossible) {
            const eu = candidates.filter((c) => c.scope === "@eu");
            if (eu.length === 1) return { source: eu[0], strong: true, actNamed: true };
        }
        return { source: null, strong: false, actNamed: true };
    }
    return {
        source: candidates.length === 1 ? candidates[0] : null,
        strong: false,
        actNamed: false,
    };
}

const AFTER_WINDOW = 160;
const BEFORE_WINDOW = 80;

export interface ArticleRefSpan {
    /** Exact matched text ("članka 8"). */
    text: string;
    /** Offset into the scanned text. */
    index: number;
    /** Normalized article number ("8", "17a"). */
    number: string;
    /** 0-based occurrence of this number among the regex matches — the key
     *  the frontend uses to find the same span. */
    occurrence: number;
    after: string;
    before: string;
}

/** Every article reference in `text`, in order, with its prose windows. */
export function scanArticleRefs(text: string): ArticleRefSpan[] {
    const out: ArticleRefSpan[] = [];
    const seen = new Map<string, number>();
    for (const m of articleSpansIn(text)) {
        const index = m.index;
        const number = normalizeArticleNumber(m.num);
        const occurrence = seen.get(number) ?? 0;
        seen.set(number, occurrence + 1);
        const end = index + m.text.length;
        let after = text.slice(end, end + AFTER_WINDOW);
        const nlA = after.indexOf("\n");
        if (nlA >= 0) after = after.slice(0, nlA);
        let before = text.slice(Math.max(0, index - BEFORE_WINDOW), index);
        const nlB = before.lastIndexOf("\n");
        if (nlB >= 0) before = before.slice(nlB + 1);
        out.push({ text: m.text, index, number, occurrence, after, before });
    }
    return out;
}

// ---------------------------------------------------------------------------
// Event shape (persisted in chat_messages.content next to legal_sources)
// ---------------------------------------------------------------------------

export type LegalRefStatus =
    /** Points at a registry source (`source_id`). */
    | "linked"
    /** An act was named (by prose or model) but the corpus could not confirm
     *  that article — shown as unverified, never linked to another act. */
    | "unverified"
    /** Nobody could tell which act it belongs to — plain text. */
    | "unresolved";

export interface LegalRefItem {
    text: string;
    number: string;
    occurrence: number;
    source_id: string | null;
    status: LegalRefStatus;
    /** Which tier decided. */
    by: "regex" | "model" | "lookup" | "none";
    /** Act name as the model read it, when it named one. */
    act?: string | null;
}

/**
 * A reference the regex could not find (an act named without an article —
 * "u skladu s Kaznenim zakonom", "ZOR-a" — or an article number it missed),
 * found by the model and verified here. Anchored by the exact `text` and its
 * occurrence in the joined answer, so the frontend can mark it on the raw
 * content before its own preprocessing.
 */
export interface LegalRefExtra {
    /** Exact text to mark ("Kaznenim zakonom", "166"). */
    text: string;
    /** 0-based occurrence of `text` in the joined answer. */
    occurrence: number;
    /** Offset in the joined answer (diagnostic; the anchor is text+occurrence). */
    start: number;
    kind: "article" | "act";
    /** Normalized article number for kind "article". */
    number: string | null;
    source_id: string | null;
    status: "linked" | "unverified";
    by: "model" | "lookup";
    act?: string | null;
}

export type LegalRefsEvent = {
    type: "legal_refs";
    refs: LegalRefItem[];
    /** Model-found references outside the regex spans (absent on turns
     *  answered before 2026-09-24). */
    extra?: LegalRefExtra[];
    /** Model used for tier 2, null when it did not run. */
    model: string | null;
};

// ---------------------------------------------------------------------------
// Tier 2 — fast model
// ---------------------------------------------------------------------------

// Sonnet 5.5 since 2026-09-29 (Haiku before), at effort "low": thinking
// stays on, but this pass runs before [DONE] and lengthens the spinner.
export const LEGAL_REFS_MODEL = "claude-sonnet-5-5";
export const LEGAL_REFS_EFFORT = "low" as const;
// The model also lists the references the regex missed (`extra`), so it
// runs on every answer with legal sources and writes more than assignments.
// 20 s / 8k tokens (10 s / 3k on Haiku): Sonnet thinks first, and thinking
// counts against max_tokens.
const MODEL_TIMEOUT_MS = 20_000;
const MODEL_MAX_TOKENS = 8_000;
const MCP_TIMEOUT_MS = 4_000;
const LOOKUP_CAP = 6;
const ANSWER_CHAR_CAP = 16_000;
const MAX_EXTRAS = 40;

type ActEntry = {
    key: string;
    title: string;
    scope: string;
    /** normalized article number → source */
    articles: Map<string, LegalSource>;
    /** The act as a whole (no article, not a version), when harvested. */
    whole: LegalSource | null;
};

/** Group the registry by act. */
export function groupActs(registry: LegalSource[]): Map<string, ActEntry> {
    const acts = new Map<string, ActEntry>();
    for (const s of registry) {
        const title = actTitleOf(s);
        if (!title) continue;
        const id = `${s.scope}|${title.toLowerCase()}`;
        let e = acts.get(id);
        if (!e) {
            e = { key: `A${acts.size + 1}`, title, scope: s.scope, articles: new Map(), whole: null };
            acts.set(id, e);
        }
        const raw = s.articleLabel?.match(/\d+(?:\.?\s?[a-z](?![a-z]))?/i)?.[0];
        if (raw) {
            const n = normalizeArticleNumber(raw);
            if (!e.articles.has(n)) e.articles.set(n, s);
        } else if (!e.whole && !s.id.includes("/version/")) {
            e.whole = s;
        }
    }
    return acts;
}

/**
 * The whole act a harvested ARTICLE source belongs to, derived from its id —
 * "@hr/regulation/<uuid>/article/Članak 153." → "@hr/regulation/<uuid>",
 * "@eu/celex/32016R0679#6" → "@eu/celex/32016R0679". Null for other shapes.
 */
export function wholeActFromArticle(src: LegalSource, title: string): LegalSource | null {
    const hr = src.id.match(/^(@hr\/regulation\/[0-9a-f-]+)\/article\//i);
    const eu = src.id.match(/^(@eu\/celex\/([^#/]+))#/i);
    if (!hr && !eu) return null;
    return {
        id: hr ? hr[1] : eu![1],
        scope: src.scope,
        title,
        documentTitle: title,
        citation: null,
        snippet: null,
        externalUrl: eu ? `https://eur-lex.europa.eu/legal-content/EN/ALL/?uri=CELEX:${eu[2]}` : null,
        articleLabel: null,
        fetchPath: hr ? `/api/v1/regulations/${hr[1].split("/").pop()}` : `/api/v1/documents/${eu![2]}`,
        celex: eu ? eu[2] : null,
        inForce: src.inForce ?? null,
        kind: "regulation",
    };
}

export interface ModelAssignment {
    i: number;
    /** Registry act key ("A2") or null. */
    act: string | null;
    /** Act name as written / meant in the answer, when not in the registry. */
    act_name: string | null;
    scope: "@hr" | "@eu" | "other" | null;
}

const SYSTEM_PROMPT = `You map the legal references in an answer to the acts they belong to, and you find the references a scanner missed.
You receive the answer text, a numbered list of article references a scanner found (exact span + a little context; entries marked "settled" are already resolved), and a closed list of ACTS the answer's sources cover (each with a key like A1).

Task 1 — "refs": for every reference that is NOT settled, say which act it refers to. Read the whole answer: a reference may point back to an act named earlier ("istog Zakona", "tog propisa", "ZOR-a" after "Zakon o radu (ZOR)"), or belong to an enumeration ("članci 5., 7. i 9. Zakona o radu").

Task 2 — "extra": list every OTHER mention of a legal act or article that the numbered list does not cover:
- an act named on its own, without an article ("u skladu s Kaznenim zakonom", "ZOR-a", "GDPR-a", "Opća uredba o zaštiti podataka");
- an article number the scanner missed.
For each extra give "context" = 20–80 characters copied EXACTLY from the answer around the mention (same case, diacritics and punctuation), "mark" = the exact part of "context" to underline — for an act its name as written ("Kaznenim zakonom", "ZOR-a"), for an article just the number without the trailing dot ("166") — and "kind" = "act" or "article" (plus "article": the number, for kind "article").
Do NOT list: anything already in the numbered list; an act name that belongs to a listed article reference ("Kaznenog zakona" in "članku 154. Kaznenog zakona"); generic words that do not name one specific act ("zakon", "blažeg zakona", "ovaj Zakon", "propis"); court decisions; Narodne novine citations ("NN 125/11"); anything the answer does not actually say.

Assigning an act (both tasks):
- If the act is one of the listed ACTS, return its key in "act" and null in "act_name".
- If the act is NOT in the list, return null in "act" and the act's full official name (as written or clearly meant in the answer) in "act_name", plus "scope": "@hr" for Croatian acts, "@eu" for EU regulations/directives, "other" otherwise.
- If you genuinely cannot tell, return null for both.
- Never invent an act that the answer does not name or imply. Do not change article numbers.
- Articles and clauses of the user's own documents — contracts (ugovor), annexes (dodatak, aneks), offers (ponuda), general terms (opći uvjeti), internal company rules, or any uploaded file — are NOT legal acts: return null for both "act" and "act_name", and never list them as "extra". When the answer discusses such a document and a bare "članak N." could be either the document's clause or a law, return null.

Answer ONLY with JSON: {"refs":[{"i":0,"act":"A1","act_name":null,"scope":null}],"extra":[{"context":"u skladu s Kaznenim zakonom, a","mark":"Kaznenim zakonom","kind":"act","article":null,"act":"A1","act_name":null,"scope":null}]} — one "refs" object per unsettled reference index; "extra" may be empty. Nothing else.`;

function buildUserPrompt(
    answer: string,
    spans: ArticleRefSpan[],
    acts: Map<string, ActEntry>,
    settled: Map<number, string>,
): string {
    const actLines = [...acts.values()].map(
        (a) =>
            `${a.key}: ${a.title} [${a.scope}] — articles in sources: ${[...a.articles.keys()].join(", ") || "(whole act)"}`,
    );
    const refLines = spans.map(
        (s, i) =>
            `${i}: "${s.text}" — context: …${s.before.slice(-50).replace(/\s+/g, " ")}【${s.text}】${s.after.slice(0, 70).replace(/\s+/g, " ")}…${settled.has(i) ? ` (settled: ${settled.get(i)})` : ""}`,
    );
    return (
        `<answer>\n${answer.slice(0, ANSWER_CHAR_CAP)}\n</answer>\n\n` +
        `ACTS:\n${actLines.join("\n") || "(none)"}\n\n` +
        `REFERENCES:\n${refLines.join("\n") || "(none)"}`
    );
}

/** Parse the model's JSON, tolerating code fences; invalid rows dropped. */
export function parseAssignments(raw: string, count: number): ModelAssignment[] {
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return [];
    let parsed: unknown;
    try {
        parsed = JSON.parse(m[0]);
    } catch {
        return [];
    }
    const refs = (parsed as { refs?: unknown })?.refs;
    if (!Array.isArray(refs)) return [];
    const out: ModelAssignment[] = [];
    for (const r of refs) {
        if (!r || typeof r !== "object") continue;
        const o = r as Record<string, unknown>;
        const i = typeof o.i === "number" ? o.i : Number(o.i);
        if (!Number.isInteger(i) || i < 0 || i >= count) continue;
        const act = typeof o.act === "string" && /^A\d+$/.test(o.act) ? o.act : null;
        const actName =
            typeof o.act_name === "string" && o.act_name.trim()
                ? o.act_name.trim().slice(0, 200)
                : null;
        const scope =
            o.scope === "@hr" || o.scope === "@eu" || o.scope === "other"
                ? o.scope
                : null;
        out.push({ i, act, act_name: actName, scope });
    }
    return out;
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
        p.then(
            (v) => {
                clearTimeout(t);
                resolve(v);
            },
            (e) => {
                clearTimeout(t);
                reject(e);
            },
        );
    });
}

// ---------------------------------------------------------------------------
// Tier 3 — corpus lookup
// ---------------------------------------------------------------------------

function findLookupServer(servers: LoadedMcpServer[]): LoadedMcpServer | null {
    const has = (s: LoadedMcpServer, t: string) =>
        [...s.toolNameMap.values()].includes(t);
    const legal = servers.filter(
        (s) => isLegalMcpServer(s.row) && has(s, "resolve") && has(s, "get_article"),
    );
    return (
        legal.find((s) => (s.row.slug || "").toLowerCase() === "sys-eulex") ??
        legal.find((s) => /eulex/i.test(s.row.slug || "")) ??
        legal[0] ??
        null
    );
}

function obj(v: unknown): Record<string, unknown> | null {
    return v && typeof v === "object" && !Array.isArray(v)
        ? (v as Record<string, unknown>)
        : null;
}

function parseRich(r: { text: string; structured?: unknown }): Record<string, unknown> | null {
    const s = obj(r.structured);
    if (s) return s;
    try {
        return obj(JSON.parse(r.text));
    } catch {
        return null;
    }
}

function normalizeTitle(t: string): string {
    return t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

type ActMatch = { uri: string; title: string; similarity: number; in_force: boolean | null };

/** `resolve(act)` → best regulation match, or null. Exact title first, then a
 *  single high-similarity match; an ambiguous fuzzy result is never used. */
async function resolveAct(
    server: LoadedMcpServer,
    actName: string,
    scope: "@hr" | "@eu",
): Promise<ActMatch | null> {
    const res = parseRich(
        await withTimeout(
            server.client.callToolRich("resolve", { query: actName, scope, top_k: 5 }),
            MCP_TIMEOUT_MS,
            "resolve",
        ),
    );
    const matches = Array.isArray(res?.matches) ? (res!.matches as unknown[]) : [];
    const want = normalizeTitle(actName);
    type M = ActMatch;
    const ms: M[] = [];
    for (const raw of matches) {
        const m = obj(raw);
        if (!m || typeof m.uri !== "string" || typeof m.title !== "string") continue;
        ms.push({
            uri: m.uri,
            title: m.title,
            similarity: typeof m.similarity === "number" ? m.similarity : 0,
            in_force: typeof m.in_force === "boolean" ? m.in_force : null,
        });
    }
    if (ms.length === 0) return null;
    const exact = ms.filter((m) => normalizeTitle(m.title) === want);
    // Several regulations share a title (legacy fragmentation) — prefer the
    // one in force; if still several, take the first (resolve ranks it).
    const pick = (list: M[]) => list.find((m) => m.in_force === true) ?? list[0];
    if (exact.length > 0) return pick(exact);
    if (scope === "@eu") return ms[0]; // alias resolution (GDPR → CELEX)
    const strong = ms.filter((m) => m.similarity >= 0.85);
    if (strong.length === 1) return strong[0];
    return null;
}

async function fetchArticleSource(
    server: LoadedMcpServer,
    uri: string,
    article: string,
    whitelist: Set<string>,
): Promise<LegalSource | null> {
    const rich = await withTimeout(
        server.client.callToolRich("get_article", { uri, article }),
        MCP_TIMEOUT_MS,
        "get_article",
    );
    const payload = parseRich(rich);
    if (!payload || payload.error || payload.text_available === false) return null;
    const kept = redactToolResult({
        text: rich.text,
        structured: rich.structured,
        whitelist,
        harvest: harvestLegalSources,
    }).keptSources;
    // The article-level source is the one whose label carries the number.
    return (
        kept.find((s) => {
            const raw = s.articleLabel?.match(/\d+(?:\.?\s?[a-z](?![a-z]))?/i)?.[0];
            return raw ? normalizeArticleNumber(raw) === article : false;
        }) ??
        kept[0] ??
        null
    );
}

/** A whole-act source for a `resolve` match. Null for URI shapes the app
 *  cannot open as a document. */
function wholeActSourceFor(m: ActMatch, scope: "@hr" | "@eu"): LegalSource | null {
    const hr = m.uri.match(/^@hr\/regulation\/([0-9a-f-]+)$/i);
    const eu = m.uri.match(/^@eu\/celex\/([^#/]+)$/i);
    if (!hr && !eu) return null;
    return {
        id: m.uri,
        scope,
        title: m.title,
        documentTitle: m.title,
        citation: null,
        snippet: null,
        externalUrl: eu ? `https://eur-lex.europa.eu/legal-content/EN/ALL/?uri=CELEX:${eu[1]}` : null,
        articleLabel: null,
        fetchPath: hr ? `/api/v1/regulations/${hr[1]}` : `/api/v1/documents/${eu![1]}`,
        celex: eu ? eu[1] : null,
        inForce: m.in_force,
        kind: "regulation",
    };
}

// ---------------------------------------------------------------------------
// Tier 2b — references the regex missed (`extra`)
// ---------------------------------------------------------------------------

export interface ModelExtra {
    /** Verbatim stretch of the answer around the mention. */
    context: string;
    /** The part of `context` to mark. */
    mark: string;
    kind: "act" | "article";
    act: string | null;
    act_name: string | null;
    scope: "@hr" | "@eu" | "other" | null;
}

/** The model's `extra` rows, shape-checked; malformed rows dropped. */
export function parseExtras(raw: string): ModelExtra[] {
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return [];
    let parsed: unknown;
    try {
        parsed = JSON.parse(m[0]);
    } catch {
        return [];
    }
    const rows = (parsed as { extra?: unknown })?.extra;
    if (!Array.isArray(rows)) return [];
    const out: ModelExtra[] = [];
    for (const r of rows.slice(0, MAX_EXTRAS)) {
        const o = obj(r);
        if (!o) continue;
        const context = typeof o.context === "string" ? o.context : "";
        const mark = typeof o.mark === "string" ? o.mark.trim() : "";
        const kind = o.kind === "act" || o.kind === "article" ? o.kind : null;
        if (!kind || !mark || mark.length > 100 || !context.includes(mark)) continue;
        // Brackets / § / newlines / private-use chars would break the
        // frontend's markdown and sentinel handling.
        if (/[[\]§\n-]/u.test(mark)) continue;
        if (kind === "article" && !/^\d{1,4}(?:\.?[a-z])?$/i.test(mark)) continue;
        if (kind === "act" && (mark.match(/\p{L}/gu)?.length ?? 0) < 2) continue;
        out.push({
            context,
            mark,
            kind,
            act: typeof o.act === "string" && /^A\d+$/.test(o.act) ? o.act : null,
            act_name:
                typeof o.act_name === "string" && o.act_name.trim()
                    ? o.act_name.trim().slice(0, 200)
                    : null,
            scope:
                o.scope === "@hr" || o.scope === "@eu" || o.scope === "other" ? o.scope : null,
        });
    }
    return out;
}

const WORDISH_RE = /[\p{L}\p{N}]/u;

/**
 * Offset of an extra's mark in the answer: the first place its context
 * occurs verbatim where the mark sits on word boundaries, outside `taken`
 * (regex spans, extras already placed) and outside `[N]` markers. Null when
 * the model's quote is not in the answer — it never gets marked.
 */
export function locateExtra(
    answer: string,
    e: ModelExtra,
    taken: Array<[number, number]>,
): number | null {
    const inner = e.context.indexOf(e.mark);
    for (let at = answer.indexOf(e.context); at >= 0; at = answer.indexOf(e.context, at + 1)) {
        const start = at + inner;
        const end = start + e.mark.length;
        if (WORDISH_RE.test(answer.charAt(start - 1)) || WORDISH_RE.test(answer.charAt(end))) continue;
        // Inside a markdown link text or `[N]` marker — wrapping it would
        // nest links.
        const line = answer.slice(answer.lastIndexOf("\n", start - 1) + 1, start);
        if (line.lastIndexOf("[") > line.lastIndexOf("]")) continue;
        if (taken.some(([a, b]) => start < b && end > a)) continue;
        return start;
    }
    return null;
}

/** 0-based occurrence of `needle` in `text` at `start` — counted exactly as
 *  the frontend counts it to find the same place. */
export function occurrenceAt(text: string, needle: string, start: number): number {
    let n = 0;
    for (let i = text.indexOf(needle); i >= 0 && i < start; i = text.indexOf(needle, i + 1)) n++;
    return n;
}

/**
 * "članku 154. Kaznenog zakona" — an act name right after an article
 * reference, with only pinpoint words between, belongs to that reference;
 * marking it too would put two links side by side.
 */
function attachedToSpan(answer: string, start: number, spans: ArticleRefSpan[]): boolean {
    let prevEnd = -1;
    for (const s of spans) {
        const end = s.index + s.text.length;
        if (end <= start && end > prevEnd) prevEnd = end;
    }
    if (prevEnd < 0 || start - prevEnd > 40) return false;
    const gap = answer
        .slice(prevEnd, start)
        .replace(/stav\p{L}*|st\.|točk\p{L}*|podstav\p{L}*|alinej\p{L}*|al\.|(?<![\p{L}])(?:i|te)(?![\p{L}])/giu, "");
    return /^(?:[\s.,()\d–-]|(?<![\p{L}])[a-z]\))*$/u.test(gap);
}

// "ZOR-a", "GDPR", "ZKP-om" — an abbreviation names an act by itself.
const ABBREVIATION_RE = /^[A-ZČĆŽŠĐ]{2,}(?:-\p{Ll}+)?$/u;

/** Could the answer name an act at all (an act keyword or an all-caps
 *  abbreviation)? Gates the model call when the regex found no article. */
function mayNameAct(answer: string): boolean {
    return (
        new RegExp(ACT_KEYWORD_RE.source, "u").test(answer) ||
        /(?<![\p{L}])[A-ZČĆŽŠĐ]{2,}(?:-\p{Ll}+)?(?![\p{L}])/u.test(answer)
    );
}

/** Does `mark` actually name `title`? Every identity word of the title in
 *  the mark (declension-tolerant), an abbreviation, or an EU instrument
 *  (its Croatian common name never token-matches the official title). */
function namesAct(mark: string, title: string, scope: string): boolean {
    return actMentionPosition(mark, title) >= 0 || ABBREVIATION_RE.test(mark) || scope === "@eu";
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export interface ResolveLegalRefsParams {
    /** The complete answer text (all content events joined). */
    answer: string;
    /** This turn's sources first, then earlier turns' (first wins per id). */
    registry: LegalSource[];
    servers: LoadedMcpServer[];
    whitelist?: Set<string>;
    /** Model call — injectable for tests. Returns raw model text. */
    complete?: (prompt: { system: string; user: string }) => Promise<{
        text: string;
        usage?: LlmUsage;
    }>;
    apiKeys?: UserApiKeys;
    /** Set false to skip tier 2 (regex + lookup of regex-named acts only). */
    useModel?: boolean;
}

export interface ResolveLegalRefsResult {
    event: LegalRefsEvent;
    /** Sources added by lookup — emit as a `legal_sources` event. */
    newSources: LegalSource[];
    usage?: LlmUsage;
    stats: {
        refs: number;
        regex: number;
        model: number;
        lookup: number;
        unverified: number;
        unresolved: number;
        /** Model-found references that passed verification / were dropped. */
        extra: number;
        extraRejected: number;
        modelMs: number;
        lookupMs: number;
    };
}

export async function resolveLegalRefs(
    params: ResolveLegalRefsParams,
): Promise<ResolveLegalRefsResult | null> {
    const answer = params.answer;
    const spans = scanArticleRefs(answer);
    const registry = params.registry;
    const hasActs = registry.some((s) => s.kind !== "caselaw");
    // No article reference, and no harvested act or no act-like mention an
    // act-only reference could be — nothing to resolve, no model call.
    if (spans.length === 0 && !(hasActs && mayNameAct(answer))) return null;
    const whitelist = params.whitelist ?? new Set<string>();
    const acts = groupActs(registry);
    const actByKey = new Map([...acts.values()].map((a) => [a.key, a]));
    const keyOfSource = (s: LegalSource) =>
        acts.get(`${s.scope}|${(actTitleOf(s) ?? "").toLowerCase()}`)?.key ?? "?";
    const byNumber = new Map<string, LegalSource[]>();
    for (const s of registry) {
        const raw = s.articleLabel?.match(/\d+(?:\.?\s?[a-z](?![a-z]))?/i)?.[0];
        if (!raw) continue;
        const n = normalizeArticleNumber(raw);
        const list = byNumber.get(n);
        if (list) list.push(s);
        else byNumber.set(n, [s]);
    }

    const items: LegalRefItem[] = spans.map((s) => ({
        text: s.text,
        number: s.number,
        occurrence: s.occurrence,
        source_id: null,
        status: "unresolved",
        by: "none",
    }));
    const stats = {
        refs: spans.length,
        regex: 0,
        model: 0,
        lookup: 0,
        unverified: 0,
        unresolved: 0,
        extra: 0,
        extraRejected: 0,
        modelMs: 0,
        lookupMs: 0,
    };

    // Tier 1 — regex.
    const strong = new Map<number, string>(); // span index → act key
    const weak = new Map<number, LegalSource>();
    const actNamedByProse = new Set<number>();
    // References into the user's own documents stay plain text — no regex
    // pick, no model assignment, no lookup.
    const docAnchored = new Set<number>();
    spans.forEach((s, i) => {
        if (anchoredToDocument(s.after)) {
            docAnchored.add(i);
            return;
        }
        const pick = pickSourceForRef(byNumber.get(s.number) ?? [], s.after, s.before);
        if (pick.actNamed) actNamedByProse.add(i);
        if (pick.source && pick.strong) {
            items[i] = { ...items[i], source_id: pick.source.id, status: "linked", by: "regex" };
            strong.set(i, keyOfSource(pick.source));
            stats.regex++;
        } else if (pick.source) {
            weak.set(i, pick.source);
        }
    });

    // Tier 2 — model: assigns what the regex did not settle strongly AND
    // lists the references the regex missed, so it runs whenever the answer
    // has either — not only when a regex span is open.
    let usage: LlmUsage | undefined;
    let modelName: string | null = null;
    const assignments = new Map<number, ModelAssignment>();
    let extras: ModelExtra[] = [];
    const openIdx = spans.map((_, i) => i).filter((i) => !strong.has(i) && !docAnchored.has(i));
    const settledForPrompt = new Map(strong);
    for (const i of docAnchored) settledForPrompt.set(i, "the user's own document, not a legal act");
    if (params.useModel !== false && (openIdx.length > 0 || hasActs)) {
        const t0 = Date.now();
        try {
            const complete =
                params.complete ??
                (async (p: { system: string; user: string }) =>
                    completeText({
                        model: LEGAL_REFS_MODEL,
                        systemPrompt: p.system,
                        user: p.user,
                        maxTokens: MODEL_MAX_TOKENS,
                        apiKeys: params.apiKeys,
                        effort: LEGAL_REFS_EFFORT,
                    }));
            const res = await withTimeout(
                complete({ system: SYSTEM_PROMPT, user: buildUserPrompt(answer, spans, acts, settledForPrompt) }),
                MODEL_TIMEOUT_MS,
                "legal-refs model",
            );
            usage = res.usage;
            modelName = LEGAL_REFS_MODEL;
            for (const a of parseAssignments(res.text, spans.length)) {
                if (!strong.has(a.i) && !docAnchored.has(a.i)) assignments.set(a.i, a);
            }
            extras = parseExtras(res.text);
        } catch (err) {
            console.warn(
                `[legal-refs] model pass failed — regex only: ${err instanceof Error ? err.message : String(err)}`,
            );
        }
        stats.modelMs = Date.now() - t0;
    }

    // Lookup candidates: (act, article) pairs for tier 3, and acts named on
    // their own whose whole-act source is not harvested.
    type Target = { ref: number } | { extra: number };
    type Candidate = { actName: string; scope: "@hr" | "@eu"; number: string; targets: Target[] };
    const candidates = new Map<string, Candidate>();
    const addCandidate = (actName: string, scope: "@hr" | "@eu", number: string, t: Target) => {
        const k = `${scope}|${normalizeTitle(actName)}|${number}`;
        const c = candidates.get(k);
        if (c) c.targets.push(t);
        else candidates.set(k, { actName, scope, number, targets: [t] });
    };
    type ActCandidate = { actName: string; scope: "@hr" | "@eu"; targets: number[] };
    const actCandidates = new Map<string, ActCandidate>();
    const addActCandidate = (actName: string, scope: "@hr" | "@eu", j: number) => {
        const k = `${scope}|${normalizeTitle(actName)}`;
        const c = actCandidates.get(k);
        if (c) c.targets.push(j);
        else actCandidates.set(k, { actName, scope, targets: [j] });
    };
    const newSources: LegalSource[] = [];
    const addSource = (s: LegalSource) => {
        if (!registry.some((r) => r.id === s.id) && !newSources.some((n) => n.id === s.id)) {
            newSources.push(s);
        }
    };

    // Merge tier 2 into items; collect lookup candidates.
    for (const i of openIdx) {
        const span = spans[i];
        const a = assignments.get(i);
        if (a?.act && actByKey.has(a.act)) {
            const act = actByKey.get(a.act)!;
            const src = act.articles.get(span.number);
            if (src) {
                items[i] = { ...items[i], source_id: src.id, status: "linked", by: "model", act: act.title };
                stats.model++;
                continue;
            }
            // Act known, article not fetched yet → look it up.
            if (act.scope === "@hr" || act.scope === "@eu") {
                items[i] = { ...items[i], act: act.title };
                addCandidate(act.title, act.scope, span.number, { ref: i });
                continue;
            }
        }
        if (a?.act_name && (a.scope === "@hr" || a.scope === "@eu")) {
            items[i] = { ...items[i], act: a.act_name };
            addCandidate(a.act_name, a.scope, span.number, { ref: i });
            continue;
        }
        if (a?.act_name) {
            // Named but outside the corpora we can check (e.g. a foreign act).
            items[i] = { ...items[i], act: a.act_name, status: "unresolved", by: "model" };
            continue;
        }
        const w = weak.get(i);
        if (w && !actNamedByProse.has(i) && !a) {
            // No act named anywhere, one source carries the number — the
            // pre-existing rule. Applies only when the model gave no answer
            // for this reference (failed / skipped it): an explicit "cannot
            // tell" (both act fields null) is respected, because a bare
            // "članak 13." in an answer about the user's documents is often
            // the document's clause, not the one act that has an article 13.
            items[i] = { ...items[i], source_id: w.id, status: "linked", by: "regex" };
            stats.regex++;
        }
    }

    // Tier 2b — verify each model-found reference against the answer and
    // the registry before it may be marked. Anything that fails is dropped.
    const extraItems: LegalRefExtra[] = [];
    const taken: Array<[number, number]> = spans.map((s) => [s.index, s.index + s.text.length]);
    for (const e of extras) {
        const start = locateExtra(answer, e, taken);
        const act = e.act ? (actByKey.get(e.act) ?? null) : null;
        const actTitle = act?.title ?? e.act_name;
        const scope = act?.scope ?? e.scope;
        if (
            start === null ||
            !actTitle ||
            !scope ||
            (e.kind === "act" &&
                (attachedToSpan(answer, start, spans) || !namesAct(e.mark, actTitle, scope)))
        ) {
            stats.extraRejected++;
            continue;
        }
        const number = e.kind === "article" ? normalizeArticleNumber(e.mark) : null;
        const item: LegalRefExtra = {
            text: e.mark,
            occurrence: occurrenceAt(answer, e.mark, start),
            start,
            kind: e.kind,
            number,
            source_id: null,
            status: "unverified",
            by: "model",
            act: actTitle,
        };
        const checkable = scope === "@hr" || scope === "@eu";
        const j = extraItems.length;
        if (e.kind === "article") {
            const src = act?.articles.get(number!);
            if (src) {
                extraItems.push({ ...item, source_id: src.id, status: "linked" });
            } else if (checkable) {
                extraItems.push(item);
                addCandidate(actTitle, scope, number!, { extra: j });
            } else {
                stats.extraRejected++;
                continue;
            }
        } else {
            const firstArticle = act ? [...act.articles.values()][0] : undefined;
            const whole = act
                ? (act.whole ?? (firstArticle ? wholeActFromArticle(firstArticle, act.title) : null))
                : null;
            if (whole) {
                addSource(whole);
                extraItems.push({ ...item, source_id: whole.id, status: "linked" });
            } else if (checkable) {
                extraItems.push(item);
                addActCandidate(actTitle, scope, j);
            } else {
                stats.extraRejected++;
                continue;
            }
        }
        taken.push([start, start + e.mark.length]);
    }

    // Tier 3 — corpus lookup (capped, sequential per act to keep quota sane).
    if (candidates.size > 0 || actCandidates.size > 0) {
        const t0 = Date.now();
        const server = findLookupServer(params.servers);
        const matchByAct = new Map<string, ActMatch | null>();
        const lookupAct = async (name: string, scope: "@hr" | "@eu") => {
            const k = `${scope}|${normalizeTitle(name)}`;
            if (!matchByAct.has(k)) matchByAct.set(k, await resolveAct(server!, name, scope));
            return matchByAct.get(k) ?? null;
        };
        const settle = (targets: Target[], src: LegalSource | null) => {
            for (const t of targets) {
                if ("ref" in t) {
                    items[t.ref] = src
                        ? { ...items[t.ref], source_id: src.id, status: "linked", by: "lookup" }
                        : { ...items[t.ref], status: "unverified", by: "lookup" };
                    if (src) stats.lookup++;
                    else stats.unverified++;
                } else {
                    extraItems[t.extra] = src
                        ? { ...extraItems[t.extra], source_id: src.id, status: "linked", by: "lookup" }
                        : { ...extraItems[t.extra], status: "unverified", by: "lookup" };
                }
            }
        };
        let budget = LOOKUP_CAP;
        for (const c of candidates.values()) {
            let src: LegalSource | null = null;
            if (server && budget > 0) {
                budget--;
                try {
                    const m = await lookupAct(c.actName, c.scope);
                    if (m) src = await fetchArticleSource(server, m.uri, c.number, whitelist);
                } catch (err) {
                    console.warn(
                        `[legal-refs] lookup "${c.actName}" čl. ${c.number} failed: ${err instanceof Error ? err.message : String(err)}`,
                    );
                }
            }
            if (src) addSource(src);
            settle(c.targets, src);
        }
        for (const c of actCandidates.values()) {
            let src: LegalSource | null = null;
            if (server && budget > 0) {
                budget--;
                try {
                    const m = await lookupAct(c.actName, c.scope);
                    const w = m ? wholeActSourceFor(m, c.scope) : null;
                    if (w && (whitelist.size === 0 || identifierInScope(w.id, whitelist))) src = w;
                } catch (err) {
                    console.warn(
                        `[legal-refs] lookup "${c.actName}" failed: ${err instanceof Error ? err.message : String(err)}`,
                    );
                }
            }
            if (src) addSource(src);
            settle(
                c.targets.map((j) => ({ extra: j })),
                src,
            );
        }
        stats.lookupMs = Date.now() - t0;
    }

    stats.unresolved = items.filter((it) => it.status === "unresolved").length;
    stats.extra = extraItems.length;
    if (items.length === 0 && extraItems.length === 0) return null;
    return {
        event: { type: "legal_refs", refs: items, extra: extraItems, model: modelName },
        newSources,
        usage,
        stats,
    };
}

/** One-line resolution summary for the `[legal-refs]` log: every regex span
 *  and every extra with its status, tier and (shortened) source id. */
export function describeLegalRefs(event: LegalRefsEvent): string {
    const short = (id: string | null) =>
        id ? id.replace(/^@(\w+)\/(\w+)\/([0-9a-f]{8})[0-9a-f-]*/i, "@$1/$2/$3") : "-";
    const refs = event.refs.map(
        (r) => `${r.text}#${r.occurrence}=${r.status}/${r.by}:${short(r.source_id)}`,
    );
    const extra = (event.extra ?? []).map(
        (e) => `+${e.kind}"${e.text}"#${e.occurrence}=${e.status}/${e.by}:${short(e.source_id)}`,
    );
    return [...refs, ...extra].join(" | ");
}

/** Sources harvested into earlier assistant turns of this chat (from their
 *  persisted `legal_sources` events), for the conversation-level registry. */
export function legalSourcesFromPersistedContent(rows: Array<{ content: unknown }>): LegalSource[] {
    const out: LegalSource[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
        let content = row.content;
        if (typeof content === "string") {
            try {
                content = JSON.parse(content);
            } catch {
                continue;
            }
        }
        if (!Array.isArray(content)) continue;
        for (const ev of content) {
            const e = obj(ev);
            if (!e || e.type !== "legal_sources" || !Array.isArray(e.sources)) continue;
            for (const s of e.sources as LegalSource[]) {
                if (s && typeof s.id === "string" && !seen.has(s.id)) {
                    seen.add(s.id);
                    out.push(s);
                }
            }
        }
    }
    return out;
}
