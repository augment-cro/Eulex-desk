import type {
    CitationPinpoint,
    LegalDocumentArticle,
    LegalSource,
    PinpointTarget,
} from "./types";

/**
 * Kill switch for the magenta stavak/točka pinpoint highlight. Flip to
 * `false` to fully disable the feature (no pinpoint parsing → panels behave
 * exactly as before: green article-level highlight only). See
 * vanjska_dokumentacija/magenta-pinpoint-citacije.md.
 */
export const PINPOINT_HIGHLIGHT_ENABLED = true;

// Enumeration separators inside a stavak/točka list: ", ", " i ", " te ",
// " ili ", " and ", " or ". A separator must be FOLLOWED by another id token
// (the scan regex enforces this), so prose like "stavka 2. i alineje" can
// never extend the list.
const PIN_SEP = String.raw`(?:\s*,\s*|\s+(?:i|te|ili|and|or)\s+)`;
// Range joiners: "stavci 1. do 3.", "st. 2.–5.", "točke a)-c)". A bare word
// ("do donošenja") never matches because the token regexes require an id on
// BOTH sides of the joiner.
const PIN_RANGE = String.raw`\s*(?:do|to|through|[–—-])\s*`;
// One stavak id token: "2", "2a", "(2)", "2." — optionally a range.
const STAVAK_TOK = String.raw`\(?\d+[a-z]?\)?\.?(?:${PIN_RANGE}\(?\d+[a-z]?\)?\.?)?`;
// One točka id token: digits may stand alone ("3", "(3)", "3."), letters must
// close with ")" ("a)", "(a)") so the conjunction "i" in "točke i alineje"
// can never be captured. Optionally a range ("a) do c)").
const TOCKA_ID = String.raw`(?:\(?\d+\)?\.?|\(?[a-z]{1,2}\))`;
const TOCKA_TOK = String.raw`${TOCKA_ID}(?:${PIN_RANGE}${TOCKA_ID})?`;

// One pass over the window finds every stavak-list and točka-list mention in
// prose order. HR declensions (stavak/stavka/stavke/stavku/stavkom/stavaka/
// stavci/stavcima, točka/točke/točki/točku/točkom/točkama/točaka) + the
// "st."/"toč." abbreviations + EN "paragraph(s)"/"point(s)".
const PIN_SCAN_RE = new RegExp(
    String.raw`\b(?:stav(?:ak(?:a)?|k(?:a|e|i|u|om)|ci(?:ma)?)\s+|st\.\s*|paragraphs?\s+)(?<stavci>${STAVAK_TOK}(?:${PIN_SEP}${STAVAK_TOK})*)` +
        String.raw`|\b(?:to[čc](?:k(?:a|e|i|u|om|ama)|ak(?:a)?|\.)\s*|points?\s+)(?<tocke>${TOCKA_TOK}(?:${PIN_SEP}${TOCKA_TOK})*)`,
    "giu",
);

// Hard cap on parsed targets — a runaway enumeration can't bloat the render.
const PIN_MAX_TARGETS = 24;
// Hard cap on how many ids a single range ("st. 1. do N.") may expand to.
const PIN_MAX_RANGE = 30;

/**
 * Split a matched enumeration span ("2., 3a. i 9.", "a) do c)") into
 * normalized lowercase ids, expanding numeric/letter ranges. Unexpandable
 * range endpoints (suffixed numbers like "2a do 5b") degrade to just the two
 * endpoints — never a guess.
 */
function splitEnumIds(span: string, kind: "stavak" | "tocka"): string[] {
    const out: string[] = [];
    for (const tok of span.split(new RegExp(PIN_SEP, "giu"))) {
        const ids = tok
            .split(new RegExp(PIN_RANGE, "iu"))
            .map((end) =>
                kind === "stavak"
                    ? end.match(/\d+[a-z]?/iu)?.[0]
                    : (end.match(/([a-z]{1,2})\)/iu)?.[1] ??
                      end.match(/\d+/u)?.[0]),
            )
            .filter((id): id is string => !!id)
            .map((id) => id.toLowerCase());
        if (ids.length === 2) {
            const [a, b] = ids;
            if (/^\d+$/.test(a) && /^\d+$/.test(b)) {
                const lo = parseInt(a, 10);
                const hi = parseInt(b, 10);
                if (hi > lo && hi - lo < PIN_MAX_RANGE) {
                    for (let n = lo; n <= hi; n++) out.push(String(n));
                    continue;
                }
            } else if (/^[a-z]$/.test(a) && /^[a-z]$/.test(b)) {
                const lo = a.charCodeAt(0);
                const hi = b.charCodeAt(0);
                if (hi > lo) {
                    for (let c = lo; c <= hi; c++)
                        out.push(String.fromCharCode(c));
                    continue;
                }
            }
            out.push(a, b);
            continue;
        }
        if (ids[0]) out.push(ids[0]);
    }
    return out;
}

/**
 * Parse a precise sub-article reference (stavak/točka) from prose adjacent
 * to an article reference — the `text` argument is the prose that FOLLOWS
 * the article number, e.g. ". stavku 2. točki a) Zakona…" or "(1)(a) GDPR".
 *
 * Conservative by design (legal domain — a wrong pinpoint is worse than
 * none): only the text up to the next article reference is considered, so a
 * pinpoint is never stolen from a different article mentioned later in the
 * sentence. Returns null when no stavak/točka is present (article-level
 * citation, green highlight only).
 *
 * Recognized forms (all yield one or MORE targets, in prose order):
 *   single:       "stavak 2", "st. 2", "točka a)", "toč. a)", "točka 3."
 *   enumerations: "stavak 2. i 9.", "stavcima 2., 5. i 9.", "st. 2. i 9.",
 *                 "točke a) i c)", "paragraphs 2 and 9", "points (a) and (b)"
 *   repeated kw:  "stavak 2. i stavak 9.", mixed "stavak 2. točka a) i
 *                 stavak 9." → [{2,a},{9}]
 *   reversed:     "točki a) stavka 2." → [{2,a}] (genitive attribution)
 *   ranges:       "stavci 1. do 3.", "st. 2.–5.", "točke a)-c)"
 *   EU compact:   "Article 6(1)(a)", "(1), (2) and (3)", "(1)(a) and (b)"
 * Not recognized (by design, too ambiguous): podstavak, alineja, dashes.
 */
export function parsePinpoint(
    text: string | null | undefined,
): CitationPinpoint | null {
    if (!PINPOINT_HIGHLIGHT_ENABLED || !text) return null;
    // Window: 160 chars (room for enumerations), cut at the next article
    // reference. NB: ASCII `\b` never matches before "č", hence the Unicode
    // lookbehind (same trick as ARTICLE_REF_RE in AssistantMessage).
    let win = text.slice(0, 160);
    const nextArt = win.search(
        /(?<![\p{L}\p{N}])(?:član(?:ak|ka|ku|kom|ci|cima)?|čl\.|articles?\b|art\.)/iu,
    );
    if (nextArt >= 0) win = win.slice(0, nextArt);

    const targets: PinpointTarget[] = [];
    for (const m of win.matchAll(PIN_SCAN_RE)) {
        const stavciSpan = m.groups?.stavci;
        const tockeSpan = m.groups?.tocke;
        if (stavciSpan) {
            const nums = splitEnumIds(stavciSpan, "stavak");
            if (nums.length === 0) continue;
            // Reversed legal order — "točki a) stavka 2." — the trailing
            // stavak qualifies the bare točke before it: fill it in instead
            // of appending a separate target. Only when the stavak is a
            // SINGLE number (multi-stavak attribution would be a guess).
            let bare = 0;
            while (
                bare < targets.length &&
                targets[targets.length - 1 - bare].tocka &&
                !targets[targets.length - 1 - bare].stavak
            ) {
                bare++;
            }
            if (bare > 0 && nums.length === 1) {
                for (let j = targets.length - bare; j < targets.length; j++) {
                    targets[j] = { stavak: nums[0], tocka: targets[j].tocka };
                }
            } else {
                for (const n of nums) targets.push({ stavak: n });
            }
        } else if (tockeSpan) {
            const ids = splitEnumIds(tockeSpan, "tocka");
            if (ids.length === 0) continue;
            const last = targets[targets.length - 1];
            if (last?.stavak && !last.tocka) {
                // "stavak 2. točke a) i c)" — the točke belong to the stavak
                // they directly follow: the bare stavak target becomes pairs.
                targets.pop();
                for (const id of ids) {
                    targets.push({ stavak: last.stavak, tocka: id });
                }
            } else {
                for (const id of ids) targets.push({ tocka: id });
            }
        }
    }

    // EU compact form right after the article number: "Article 6(1)(a)",
    // "Article 6(1), (2) and (3)", "Article 6(1)(a) and (b)". Adjacent
    // group = točka of the stavak it touches; separator-joined group =
    // new stavak when numeric, sibling točka when alphabetic.
    if (targets.length === 0) {
        const head = /^\s*\((\d+[a-z]?)\)/u.exec(win);
        if (head) {
            let lastStavak = head[1].toLowerCase();
            targets.push({ stavak: lastStavak });
            let pos = head[0].length;
            for (let guard = 0; guard < 8; guard++) {
                // [1] = separator (",", "i", "and", …; absent ⇒ adjacent
                // group), [2] = the parenthesised id.
                const g =
                    /^(?:(\s*(?:,|\b(?:i|te|ili|and|or)\b)\s*)|[ \t]*)\((\d+[a-z]?|[a-z]{1,2})\)/u.exec(
                        win.slice(pos),
                    );
                if (!g?.[2]) break;
                const id = g[2].toLowerCase();
                const last = targets[targets.length - 1];
                if (!g[1]) {
                    // Adjacent "(a)" — attach to the bare stavak it touches.
                    // Anything deeper ("(1)(a)(i)" sub-points) → stop, our
                    // render granularity ends at točka.
                    if (last?.stavak && !last.tocka) {
                        targets.pop();
                        targets.push({ stavak: last.stavak, tocka: id });
                    } else {
                        break;
                    }
                } else if (/^\d/.test(id)) {
                    lastStavak = id;
                    targets.push({ stavak: id });
                } else {
                    targets.push({ stavak: lastStavak, tocka: id });
                }
                pos += g[0].length;
            }
        }
    }

    // Dedupe (repeated mentions in one sentence), preserve prose order, cap.
    const seen = new Set<string>();
    const out: PinpointTarget[] = [];
    for (const t of targets) {
        const key = `${t.stavak ?? ""}|${t.tocka ?? ""}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(t);
        if (out.length >= PIN_MAX_TARGETS) break;
    }
    return out.length > 0 ? { targets: out } : null;
}

/**
 * Bare article number from a label ("Članak 5." → "5", "Article 12a" → "12a").
 * Language-independent; matches the backend's extraction so the panel's
 * `data-article-number` keys line up.
 */
export function articleNumberOf(label: string | null | undefined): string | null {
    if (!label) return null;
    return label.match(/\d+[a-z]?/i)?.[0]?.toLowerCase() ?? null;
}

/**
 * For an HR source whose `fetchPath` points at a single article
 * (`/api/v1/regulations/{uuid}/article/{label}`), return the WHOLE-regulation
 * path (`/api/v1/regulations/{uuid}`) so the panel fetches the full
 * consolidated law (via `hr_get_full_document`) instead of just that article.
 * Returns null when the path isn't an HR regulation path.
 */
export function hrWholeRegulationPath(
    fetchPath: string | null | undefined,
): string | null {
    if (!fetchPath) return null;
    const m = fetchPath.match(/^(\/api\/v1\/regulations\/[0-9a-fA-F-]+)/);
    return m ? m[1] : null;
}

/**
 * Group key identifying the regulation a source belongs to, so siblings (the
 * different cited articles of the same law) can be collected. Uses the HR
 * whole-regulation path when available, else the source id with any `#article`
 * fragment stripped.
 */
export function regulationKeyOf(source: LegalSource): string {
    return hrWholeRegulationPath(source.fetchPath) ?? source.id.split("#")[0];
}

/**
 * All cited article numbers for the regulation `source` belongs to, gathered
 * across every legal source consulted in the same message. Drives "fetch the
 * whole law, then mark only the cited articles" in `LegalSourcePanel`.
 */
export function citedArticleNumbersFor(
    source: LegalSource,
    allSources: LegalSource[],
): string[] {
    const key = regulationKeyOf(source);
    const nums = new Set<string>();
    for (const s of allSources) {
        if (regulationKeyOf(s) !== key) continue;
        const n = articleNumberOf(s.articleLabel);
        if (n) nums.add(n);
    }
    return [...nums];
}

// ── Full-document rendering blocks ─────────────────────────────────────────
//
// The HR `/full-document` proxy returns a FLAT list of segments tagged with a
// `segmentType` (article_heading, stavak, section_heading, …). We fold that
// into render blocks so the panel can show a real hierarchy — each article as
// one card (heading + paragraphs) that can be marked/scrolled as a whole — and
// structural headings (chapters/sections) as standalone dividers. Sources
// without `segmentType` (EU/FR/single HR article) degrade to one block each.

export type LegalRenderBlock =
    | { kind: "heading"; id: string; text: string }
    | { kind: "body"; id: string; number: string | null; text: string }
    | {
          kind: "article";
          id: string;
          number: string | null;
          heading: string | null;
          subtitle: string | null;
          bodies: { id: string; text: string }[];
      };

/** `article_heading` ends with `_heading` too — exclude it from "structural". */
const STRUCTURAL_HEADING = /_heading$/;

/**
 * Drop redundant bodies inside one article. The flat segment list often
 * carries the same text twice — a parent `stavak` whose text embeds the whole
 * numbered list AND its child `tocka` segments repeating each item, plus
 * standalone "(N)" paragraph markers that the body paragraph re-states. Keep a
 * body only when its (whitespace-normalized) text is not contained in another,
 * longer body of the same article; exact duplicates keep the first occurrence.
 */
function dedupeArticleBodies(
    bodies: { id: string; text: string }[],
): { id: string; text: string }[] {
    const norm = bodies.map((b) => b.text.replace(/\s+/g, " ").trim());
    return bodies.filter((_, i) => {
        if (!norm[i]) return false;
        return !norm.some(
            (other, j) =>
                j !== i &&
                other.length >= norm[i].length &&
                other.includes(norm[i]) &&
                // for exact duplicates keep the earlier one
                (other.length > norm[i].length || j < i),
        );
    });
}

export function groupLegalSegments(
    articles: LegalDocumentArticle[],
): LegalRenderBlock[] {
    const blocks: LegalRenderBlock[] = [];
    let current: Extract<LegalRenderBlock, { kind: "article" }> | null = null;
    // The HR data model places an article's title (`article_subtitle`) JUST
    // BEFORE its `article_heading` (ordinal − 1), never after it. Buffer the
    // subtitle and hand it to the NEXT article that opens — do NOT attach it to
    // the currently-open (previous) article, or every article inherits the
    // following article's title. That misalignment is most visible where an
    // article legitimately has no title (e.g. Zakon o radu čl. 2, which then
    // wrongly shows čl. 3's title "Rodna jednakost").
    let pendingSubtitle: { id: string; text: string } | null = null;
    const flush = () => {
        if (current) {
            current.bodies = dedupeArticleBodies(current.bodies);
            blocks.push(current);
            current = null;
        }
    };
    // Emit an unconsumed buffered subtitle as a standalone heading divider so a
    // rare orphan (subtitle not immediately followed by an article_heading) is
    // preserved rather than dropped.
    const flushPendingAsHeading = () => {
        if (pendingSubtitle) {
            blocks.push({
                kind: "heading",
                id: pendingSubtitle.id,
                text: pendingSubtitle.text,
            });
            pendingSubtitle = null;
        }
    };

    for (const a of articles) {
        const st = a.segmentType ?? null;
        const num = a.number ?? null;

        if (st === "article_heading") {
            flush();
            current = {
                kind: "article",
                id: a.id,
                number: num,
                heading: a.label ?? a.text,
                subtitle: pendingSubtitle?.text ?? null,
                bodies: [],
            };
            pendingSubtitle = null;
            continue;
        }
        if ((st && STRUCTURAL_HEADING.test(st)) || st === "act_title") {
            flush();
            flushPendingAsHeading();
            blocks.push({ kind: "heading", id: a.id, text: a.label ?? a.text });
            continue;
        }
        if (st === "article_subtitle") {
            // Precedes its heading — buffer it for the next article. If one is
            // already buffered, it was orphaned; emit it before overwriting.
            flushPendingAsHeading();
            pendingSubtitle = { id: a.id, text: a.label ?? a.text };
            continue;
        }
        // No segmentType (EU/FR/single HR article): label → its own article
        // card, otherwise a plain body block. Preserves prior behaviour.
        if (st === null) {
            flush();
            flushPendingAsHeading();
            if (a.label && a.text.trim() !== a.label.trim()) {
                blocks.push({
                    kind: "article",
                    id: a.id,
                    number: num,
                    heading: a.label,
                    subtitle: null,
                    bodies: [{ id: `${a.id}-b`, text: a.text }],
                });
            } else {
                blocks.push({ kind: "body", id: a.id, number: num, text: a.text });
            }
            continue;
        }
        // Body-with-hierarchy (stavak, tocka, article_body, …): attach to the
        // open article, or stand alone if it precedes any article.
        if (current) current.bodies.push({ id: a.id, text: a.text });
        else blocks.push({ kind: "body", id: a.id, number: num, text: a.text });
    }
    flush();
    flushPendingAsHeading();
    return blocks;
}
