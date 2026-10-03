"use client";

import type { CitationQuote } from "../shared/types";

/**
 * Tabular citation markers — both forms in ONE pattern, so the i-th match
 * is the i-th badge and the i-th status in the backend's
 * `unverified_citations`:
 *   [[page:<N>||quote:<text>]]                        paged documents
 *   [[sheet:<SheetName>||cell:<A1 or A1:B2>||quote:<text>]]  spreadsheets
 * (`quote:` itself is optional, as it always was for the page form.)
 * Groups: 1 page · 2 sheet · 3 cell · 4 quote.
 *
 * MUST stay semantically identical to backend `CITATION_MARKER_RE`
 * (backend/src/lib/quoteVerification.ts).
 */
export const CITATION_MARKER_RE =
    /\[\[(?:page:(\d+)|sheet:([^|\[\]]+)\|\|cell:([A-Z]{1,3}\d+(?::[A-Z]{1,3}\d+)?))\|\|(?:quote:)?((?:[^\[\]]|\[[^\]]*\])+)\]\]/gi;

/** Tag/pill markers — must NOT swallow page or sheet citation markers. */
const PILL_RE = /\[\[(?!page:\d+\|\||sheet:)([^\]]+)\]\]/g;

/**
 * One parsed tabular citation: `page` for paged documents, `sheet` + `cell`
 * for spreadsheets (the shape the shared viewers take).
 */
export type ParsedCitation = CitationQuote;

/**
 * Strip frontend render tokens if they were accidentally persisted or
 * copied into stored summary text. Real citations live as [[page:…]] /
 * [[sheet:…||cell:…]].
 */
export function sanitizeCellSummary(text: string): string {
    return text
        .replace(/`§[cp]\d+§`/g, "")
        .replace(/§[cp]\d+§/g, "")
        .replace(/\u200B/g, "")
        .trim();
}

/**
 * If the LLM double-wrapped JSON inside summary, lift the inner markdown
 * out so the UI renders prose — not a literal `"summary": "…"` dump.
 */
export function unwrapNestedSummaryJson(text: string): string {
    const trimmed = sanitizeCellSummary(text);
    if (!trimmed.startsWith("{") || trimmed.length > 50_000) return trimmed;
    const stripped = trimmed
        .replace(/^```(?:json|jsonl)?\s*/i, "")
        .replace(/\s*```$/, "")
        .trim();
    try {
        const nested = JSON.parse(stripped) as { summary?: unknown };
        if (nested && typeof nested.summary === "string") {
            return sanitizeCellSummary(nested.summary);
        }
    } catch {
        // not nested JSON
    }
    return trimmed;
}

/**
 * Replaces [[page:n||quote:...]] and [[sheet:S||cell:A1||quote:...]] markers
 * with `§idx§` placeholders. Returns the processed string and an ordered
 * array of extracted citation data (document order = badge order).
 */
export function preprocessCitations(text: string): {
    processed: string;
    citations: ParsedCitation[];
} {
    const clean = unwrapNestedSummaryJson(text);
    const citations: ParsedCitation[] = [];
    CITATION_MARKER_RE.lastIndex = 0;
    const processed = clean.replace(
        CITATION_MARKER_RE,
        (
            _,
            page: string | undefined,
            sheet: string | undefined,
            cell: string | undefined,
            quote: string,
        ) => {
            const idx = citations.length;
            citations.push(
                page !== undefined
                    ? { page: parseInt(page, 10), quote: quote.trim() }
                    : {
                          sheet: (sheet ?? "").trim(),
                          cell: (cell ?? "").toUpperCase(),
                          quote: quote.trim(),
                      },
            );
            return `§${idx}§`;
        },
    );
    return { processed, citations };
}

export function prepareTabularMarkdown(text: string): {
    processed: string;
    citations: ParsedCitation[];
    pills: string[];
} {
    const { processed: withCits, citations } = preprocessCitations(text);
    const pills: string[] = [];
    let out = withCits.replace(PILL_RE, (_, content) => {
        const idx = pills.length;
        pills.push(content);
        return `\`§p${idx}§\`\u200B`;
    });
    out = out.replace(/§(\d+)§/g, (_, idx) => `\`§c${idx}§\`\u200B`);
    return { processed: out, citations, pills };
}

/** Normalize react-markdown `code` children to a plain token string. */
export function parseInlineCodeToken(children: unknown): string {
    if (Array.isArray(children)) {
        return children
            .map((c) =>
                typeof c === "string" || typeof c === "number"
                    ? String(c)
                    : "",
            )
            .join("")
            .replace(/\u200B/g, "")
            .trim();
    }
    return String(children ?? "")
        .replace(/\u200B/g, "")
        .trim();
}
