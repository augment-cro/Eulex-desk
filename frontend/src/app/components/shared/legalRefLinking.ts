import type { LegalRefExtra, LegalRefItem, LegalSource, MikeAnnotation } from "./types";
import {
    articleBaseOf,
    hasArticleSuffix,
    normalizeArticleNumber,
    parsePinpoint,
    upgradeSourceArticleSuffix,
} from "./legalSourceUtils";

// Article-reference auto-linking. Matches "Članak 5", "čl. 153", "članka 17",
// "čl. 17.a" (suffixed articles), "Article 6", "Art. 5" (HR + EN),
// Unicode-boundary aware. The suffix letter must be adjacent to the digits or
// the dot (NO whitespace) — free prose like "članak 17. i 18." must never
// capture "17i".
// Stem-based so ALL Croatian declensions link: člank\w* (članka, članku,
// člankom, članke), članc\w* (članci, člancima), članak\w* (članak,
// članaka). Enumerating forms missed the instrumental — "uređeno je člankom
// 153." rendered unlinked. Safe to be loose here: autoLinkLegalRefs only
// links numbers that map to exactly one harvested source.
// Cross-language coverage: HR stems + EN article/art. + FR article (same
// stem) + IT articol\w* (articolo/articoli) + DE artikel\w* + German-style
// section signs § / §§ ("§ 153", "§§ 12-14").
export const ARTICLE_REF_RE =
    /(?<![\p{L}\p{N}])(?:članc\w*|člank\w*|članak\w*|articol\w*|artikel\w*|articles?|art\.?|čl\.?|§{1,2})\s*(\d+(?:\.?[a-z](?![a-z]))?)(?!\d|\.\d)/giu;

// Enumerations and ranges after a reference: "članaka 158. i 166.", "čl. 5.,
// 7. i 9.", "članci 10. do 15.", "Articles 5, 6 and 7", "§§ 12-14". Prose
// does not repeat the keyword, so each listed number is its own span (a
// range links its end points). Croatian references carry the ordinal dot on
// every number ("158. i 166."), which keeps "od 5 do 12 godina" out; a
// number followed by a month, a unit or "godine" is never an article.
// MUST stay identical to backend lib/legalRefs.ts — both sides key the
// server's `legal_refs` rows by (number, occurrence) over these spans.
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

/** `text` with every article span replaced by `render(span)` (which returns
 *  the span text itself to leave it alone). */
function replaceArticleSpans(
    text: string,
    render: (span: { index: number; text: string; num: string }) => string,
): string {
    let out = "";
    let last = 0;
    for (const span of articleSpansIn(text)) {
        out += text.slice(last, span.index) + render(span);
        last = span.index + span.text.length;
    }
    return out + text.slice(last);
}

// ---------------------------------------------------------------------------
// Act-name disambiguation
// ---------------------------------------------------------------------------
//
// A harvested registry is keyed by article NUMBER only, and "članak 8" of
// the Zakon o trgovini and "članak 8" of the Zakon o iznimnim mjerama kontrole
// cijena are both just "8". When the prose names the act right next to the
// reference ("na temelju članka 8. stavka 1. Zakona o iznimnim mjerama…") that
// name is the disambiguator a lawyer reads — so the linker reads it too:
//
//   * the named act HAS a harvested source with that number → link that one,
//     even if another act shares the number;
//   * the named act has NO such source → link nothing (a wrong act in the
//     panel is worse than no underline — the exact failure this guards);
//   * no act named next to the reference → number-only behaviour as before
//     (exactly one source → link, ambiguous → skip).

/**
 * Act title of a source. Prefers the server's own act name
 * (`documentTitle`, EULEX `document.title`); for sources persisted before
 * that field existed, derives it from the composed `title` by dropping the
 * article suffix: "Zakon o trgovini, čl. 8 — Heading" → "Zakon o trgovini".
 * Court decisions carry no act → null.
 */
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

// Words that carry no identity ("Zakon o radu" → only "zakon" + "radu").
const ACT_STOPWORDS = new Set([
    "o",
    "i",
    "u",
    "na",
    "za",
    "te",
    "od",
    "iz",
    "s",
    "sa",
    "of",
    "the",
    "and",
    "on",
    "for",
    "de",
    "du",
    "des",
    "la",
    "le",
    "les",
    "et",
    "und",
    "der",
    "die",
    "das",
    "del",
    "della",
    "dei",
    "e",
    "eu",
    "ez",
    "eec",
]);

/** Matching prefix of a word: first 5 letters, lowercase — enough to meet
 *  every Croatian case ending ("trgovini"/"trgovine" → "trgov"). */
function stem(word: string): string {
    return word.toLowerCase().slice(0, 5);
}

/** Identity tokens of an act title (stems of its content words). */
export function actTokens(title: string): string[] {
    const out: string[] = [];
    for (const m of title.matchAll(/\p{L}+/gu)) {
        const w = m[0].toLowerCase();
        if (w.length < 3 || ACT_STOPWORDS.has(w)) continue;
        out.push(stem(w));
    }
    return out;
}

// Act-keyword mentions in prose. Croatian stems are case-insensitive (mid-
// sentence "zakona" is normal); the EN/FR/DE/IT nouns are capitalised only,
// so ordinary words ("act", "code", "decision") never count as an act name.
const ACT_KEYWORD_RE =
    /(?<![\p{L}])(?:[Zz]akonik\p{L}*|[Zz]akon\p{L}*|[Pp]ravilnik\p{L}*|[Uu]redb\p{L}*|[Oo]dluk\p{L}*|[Uu]stav\p{L}*|[Kk]odeks\p{L}*|[Dd]irektiv\p{L}*|Regulation|Directive|Decision|Act|Code|Gesetz\p{L}*|Verordnung|Richtlinie|Loi|Décret|Règlement|Codice|Legge|Decreto|Regolamento|Direttiva)(?![\p{L}])/gu;

// "ovoga Zakona", "istog Zakona", "this Regulation" — a back-reference to an
// act already in play, not a name. Ignored as a disambiguator.
const DEMONSTRATIVE_RE =
    /(?:ovog|ovoga|ove|toga|tog|te|istog|istoga|iste|navedenog|navedene|spomenutog|spomenute|this|that|the same|dieses|dieser|derselben)\s+$/iu;

// Keywords that can name an EU instrument (as opposed to a national act
// only). "Uredba"/"Odluka" exist in both layers, so they count as both.
const EU_KEYWORD_RE =
    /^(?:[Uu]redb|[Oo]dluk|[Dd]irektiv|Regulation|Directive|Decision|Verordnung|Richtlinie|Règlement|Regolamento|Direttiva)/u;

export type NamedActs = {
    /** At least one act-keyword mention (not a back-reference) in the window. */
    named: boolean;
    /** The mention CLOSEST to the reference could be an EU instrument
     *  ("Opće uredbe o zaštiti podataka" yes; "Zakona o provedbi Opće uredbe"
     *  no — the nearest word says it is a national act). */
    euPossible: boolean;
};

/**
 * Does the prose window name an act at all, and could the one nearest the
 * reference be an EU instrument? `side` says where the window sits relative
 * to the reference: "after" → the first mention is the nearest, "before" →
 * the last one is.
 */
export function namedActsIn(
    window: string,
    side: "after" | "before" = "after",
): NamedActs {
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
 * left every Kazneni zakon reference named-but-unmatched → unlinked.
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

/**
 * Position (word index) at which `title` is named in `window`, or -1. Every
 * identity token of the title must appear as a word-prefix in the window
 * (declension-tolerant), so "Zakona o iznimnim mjerama kontrole cijena"
 * names "Zakon o iznimnim mjerama kontrole cijena" but not "Zakon o
 * trgovini". Long EU titles (many tokens) practically never match — those
 * fall back to the EU-keyword rule in `pickSourceForRef`.
 */
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

/**
 * Choose the source a prose reference points at, given every harvested
 * source that carries the referenced article number (`candidates`) and the
 * prose around the reference (`after` first — Croatian puts the act after
 * the article — then `before`). Returns null when the reference must stay
 * unlinked. See the rules at the top of this section.
 */
export function pickSourceForRef(
    candidates: LegalSource[],
    after: string,
    before: string,
): LegalSource | null {
    if (candidates.length === 0) return null;
    for (const [window, side] of [
        [after, "after"],
        [before, "before"],
    ] as const) {
        const acts = namedActsIn(window, side);
        if (!acts.named) continue;
        const span = nearestActSpan(window, side) ?? window;
        // 1. A candidate whose act is named in this window — closest wins.
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
        if (best) return best;
        // 2. The window names an EU-style instrument ("Opće uredbe o zaštiti
        //    podataka") whose long official title never token-matches: link
        //    the one EU candidate, if there is exactly one.
        if (acts.euPossible) {
            const eu = candidates.filter((c) => c.scope === "@eu");
            if (eu.length === 1) return eu[0];
        }
        // 3. An act is named but no harvested source belongs to it — never
        //    link a different act under its name.
        return null;
    }
    // No act named nearby: number-only rule, unchanged.
    return candidates.length === 1 ? candidates[0] : null;
}

// Prose window sizes around a reference. `after` is long enough to reach the
// act name past a stavak/točka pinpoint and a second article ("članka 8.
// stavka 1., u vezi s člankom 6. podstavkom 7. Zakona o …"); both stop at a
// paragraph break so a neighbouring paragraph never lends its act.
const AFTER_WINDOW = 160;
const BEFORE_WINDOW = 80;

function windowAfter(text: string, from: number): string {
    const w = text.slice(from, from + AFTER_WINDOW);
    const nl = w.indexOf("\n");
    return nl >= 0 ? w.slice(0, nl) : w;
}

function windowBefore(text: string, to: number): string {
    const w = text.slice(Math.max(0, to - BEFORE_WINDOW), to);
    const nl = w.lastIndexOf("\n");
    return nl >= 0 ? w.slice(nl + 1) : w;
}

/**
 * Second citation pass: turn bare article references in the prose into
 * clickable underlined references mapped to harvested legal sources, even
 * when the model omitted the [N] marker. Conservative — a reference is
 * linked only when it resolves to ONE source (by number, disambiguated by
 * the act named in the surrounding prose — see `pickSourceForRef`), and
 * never doubles up where a model pill already follows. Reuses the
 * `#legal-cite-N` link + renderer in AssistantMessage.
 */
export function autoLinkLegalRefs(
    text: string,
    legalSources: LegalSource[],
    citationsList: MikeAnnotation[],
): string {
    if (legalSources.length === 0) return text;
    // article number → every source carrying it (in registry order).
    const byNumber = new Map<string, LegalSource[]>();
    for (const s of legalSources) {
        // Labels are clean strings ("Članak 17.a", "Članak 17. a") — an
        // optional space before the suffix letter is safe here, unlike in
        // free prose (ARTICLE_REF_RE).
        const raw = s.articleLabel?.match(/\d+(?:\.?\s?[a-z](?![a-z]))?/i)?.[0];
        if (!raw) continue;
        const num = normalizeArticleNumber(raw);
        const list = byNumber.get(num);
        if (list) list.push(s);
        else byNumber.set(num, [s]);
    }
    if (byNumber.size === 0) return text;

    return replaceArticleSpans(
        text,
        ({ index: offset, text: full, num }) => {
            const norm = normalizeArticleNumber(num);
            const end = offset + full.length;
            const after = windowAfter(text, end);
            const before = windowBefore(text, offset);
            // "članka 13. Ugovora" cites the user's document, not a law.
            if (anchoredToDocument(after)) return full;
            let src = pickSourceForRef(byNumber.get(norm) ?? [], after, before);
            // Issue #43 — suffixed prose ref ("čl. 17.a") with no exact
            // source: the MCP sometimes returns the BASE number ("17") for a
            // suffixed article. Fall back to the base-number source when it
            // is unambiguous AND no sibling source claims another suffixed
            // variant of the same base (17.b would make "17" a real
            // ambiguity), and upgrade its labels so the suffix survives into
            // the tab/header/scroll.
            if (!src && !byNumber.has(norm) && hasArticleSuffix(norm)) {
                const base = articleBaseOf(norm);
                const siblingSuffixed = [...byNumber.keys()].some(
                    (k) =>
                        k !== norm &&
                        hasArticleSuffix(k) &&
                        articleBaseOf(k) === base,
                );
                const candidate = siblingSuffixed
                    ? null
                    : pickSourceForRef(byNumber.get(base) ?? [], after, before);
                if (candidate) {
                    src = upgradeSourceArticleSuffix(candidate, num);
                }
            }
            if (!src) return full; // unknown, ambiguous, or another act's number
            // Skip if a citation pill token already follows (model cited it).
            if (text.slice(end, end + 6).includes("§")) return full;
            const idx = citationsList.length;
            citationsList.push({
                type: "legal_source_data",
                ref: 0,
                source: src,
                quote: "",
                // Stavak/točka right after the reference ("članka 38. stavka
                // 3. točke l)") → magenta pinpoint in the source panel.
                pinpoint: parsePinpoint(text.slice(end, end + 140)),
            });
            // Underline the reference text itself (WP-style) instead of
            // appending a numbered pill: wrap the matched prose in a link
            // whose href carries the citation index; the `a` renderer turns
            // it into a clickable underlined inline reference.
            return `[${full}](#legal-cite-${idx})`;
        },
    );
}

// ---------------------------------------------------------------------------
// Server-resolved references (`legal_refs` event, backend lib/legalRefs)
// ---------------------------------------------------------------------------

/** Occurrence counter shared across a message's content events, so the
 *  (number, occurrence) keys line up with the backend's scan of the joined
 *  answer text. Create one per message render. */
export type LegalRefCursor = Map<string, number>;

export function createLegalRefCursor(): LegalRefCursor {
    return new Map();
}

/**
 * Apply the backend's `legal_refs` resolution to one content event: every
 * regex span is looked up by (article number, occurrence) and rendered as
 * a link to the resolved source, an "unverified" mark, or plain text.
 * Spans the event does not know (text drift after preprocessing) fall
 * back to the local number-plus-act rule, so nothing is ever less linked
 * than before.
 */
export function applyLegalRefs(
    text: string,
    refs: LegalRefItem[],
    legalSources: LegalSource[],
    citationsList: MikeAnnotation[],
    cursor: LegalRefCursor,
): string {
    const byId = new Map(legalSources.map((s) => [s.id, s]));
    const byKey = new Map<string, LegalRefItem>();
    for (const r of refs) byKey.set(`${r.number}|${r.occurrence}`, r);
    const byNumber = new Map<string, LegalSource[]>();
    for (const s of legalSources) {
        const raw = s.articleLabel?.match(/\d+(?:\.?\s?[a-z](?![a-z]))?/i)?.[0];
        if (!raw) continue;
        const num = normalizeArticleNumber(raw);
        const list = byNumber.get(num);
        if (list) list.push(s);
        else byNumber.set(num, [s]);
    }

    return replaceArticleSpans(
        text,
        ({ index: offset, text: full, num }) => {
            const norm = normalizeArticleNumber(num);
            const occurrence = cursor.get(norm) ?? 0;
            cursor.set(norm, occurrence + 1);
            const end = offset + full.length;
            if (text.slice(end, end + 6).includes("§")) return full;
            const ref = byKey.get(`${norm}|${occurrence}`);
            let src: LegalSource | null = null;
            if (ref) {
                if (ref.status === "unverified") {
                    return `[${full}](#legal-unverified)`;
                }
                if (ref.status === "linked" && ref.source_id) {
                    src = byId.get(ref.source_id) ?? null;
                }
                if (!src && ref.status === "unresolved") return full;
            }
            if (!src) {
                // Unknown span (or the source did not arrive) → local rule.
                src = pickSourceForRef(
                    byNumber.get(norm) ?? [],
                    windowAfter(text, end),
                    windowBefore(text, offset),
                );
            }
            if (!src) return full;
            const idx = citationsList.length;
            citationsList.push({
                type: "legal_source_data",
                ref: 0,
                source: src,
                quote: "",
                pinpoint: parsePinpoint(text.slice(end, end + 140)),
            });
            return `[${full}](#legal-cite-${idx})`;
        },
    );
}

// ---------------------------------------------------------------------------
// Model-found references (`legal_refs.extra`)
// ---------------------------------------------------------------------------
//
// References the regex cannot find ("u skladu s Kaznenim zakonom", "ZOR-a",
// a missed article number), found by the model and verified by the backend.
// They are anchored by exact text + occurrence in the JOINED RAW answer — the
// text the backend scanned — so they are marked on the raw content events
// BEFORE preprocessCitations (whose `[N]` rule would eat a "[166]" link),
// with private-use sentinels: OPEN + key char, the text, CLOSE. After the
// other passes `applyLegalRefExtras` turns the sentinels into links.

const EXTRA_OPEN = "";
const EXTRA_CLOSE = "";
const EXTRA_KEY_BASE = 0xe100;
const MAX_MARKED_EXTRAS = 0x100;
const EXTRA_RE = /([-])([^]*)/gu;

/**
 * Wrap each extra's text in sentinels inside the content event it falls in
 * (`texts[i]` is null for non-content events). An extra not found at its
 * occurrence, overlapping another, or straddling two events is skipped.
 */
export function markLegalRefExtras(
    texts: Array<string | null>,
    extras: LegalRefExtra[],
): Array<string | null> {
    if (extras.length === 0) return texts;
    const joined = texts.map((t) => t ?? "").join("");
    const spans: Array<{ start: number; end: number; k: number }> = [];
    extras.slice(0, MAX_MARKED_EXTRAS).forEach((e, k) => {
        if (!e.text) return;
        let at = joined.indexOf(e.text);
        for (let n = 0; at >= 0 && n < e.occurrence; n++) {
            at = joined.indexOf(e.text, at + 1);
        }
        if (at < 0) return;
        const end = at + e.text.length;
        if (spans.some((s) => at < s.end && end > s.start)) return;
        spans.push({ start: at, end, k });
    });
    let base = 0;
    return texts.map((t) => {
        if (t === null) return t;
        const from = base;
        base += t.length;
        let out = t;
        for (const s of spans
            .filter((s) => s.start >= from && s.end <= from + t.length)
            .sort((a, b) => b.start - a.start)) {
            const a = s.start - from;
            const b = s.end - from;
            out =
                out.slice(0, a) +
                EXTRA_OPEN +
                String.fromCharCode(EXTRA_KEY_BASE + s.k) +
                out.slice(a, b) +
                EXTRA_CLOSE +
                out.slice(b);
        }
        return out;
    });
}

/**
 * Turn the sentinels `markLegalRefExtras` left in a processed content event
 * into links: linked → `[text](#legal-cite-N)` (a whole-act source opens the
 * act), unverified → the dotted `#legal-unverified` mark, anything else →
 * plain text. Every sentinel is stripped.
 */
export function applyLegalRefExtras(
    text: string,
    extras: LegalRefExtra[],
    legalSources: LegalSource[],
    citationsList: MikeAnnotation[],
): string {
    if (!text.includes(EXTRA_OPEN)) return text;
    const byId = new Map(legalSources.map((s) => [s.id, s]));
    return text
        .replace(EXTRA_RE, (full: string, key: string, inner: string, offset: number) => {
            const e = extras[key.charCodeAt(0) - EXTRA_KEY_BASE];
            // Another pass already linked something inside — leave it.
            if (!e || inner.includes("](#")) return inner;
            if (e.status === "unverified") return `[${inner}](#legal-unverified)`;
            const src = e.source_id ? byId.get(e.source_id) : undefined;
            if (!src) return inner;
            const end = offset + full.length;
            const idx = citationsList.length;
            citationsList.push({
                type: "legal_source_data",
                ref: 0,
                source: src,
                quote: "",
                pinpoint:
                    e.kind === "article" ? parsePinpoint(text.slice(end, end + 140)) : null,
            });
            return `[${inner}](#legal-cite-${idx})`;
        })
        .replace(/[-]?|/gu, "");
}
