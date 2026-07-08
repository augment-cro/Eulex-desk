"use client";

const PAGE_CITATION_RE =
    /\[\[page:(\d+)\|\|(?:quote:)?((?:[^\[\]]|\[[^\]]*\])+)\]\]/gi;

/** Tag/pill markers — must NOT swallow [[page:N||quote:…]] citations. */
const PILL_RE = /\[\[(?!page:\d+\|\|)([^\]]+)\]\]/g;

export interface ParsedCitation {
    page: number;
    quote: string;
}

/**
 * Strip frontend render tokens if they were accidentally persisted or
 * copied into stored summary text. Real citations live as [[page:…]].
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
 * Replaces [[page:n||quote:...]] markers with `§idx§` placeholders.
 * Returns the processed string and an ordered array of extracted citation data.
 */
export function preprocessCitations(text: string): {
    processed: string;
    citations: ParsedCitation[];
} {
    const clean = unwrapNestedSummaryJson(text);
    const citations: ParsedCitation[] = [];
    PAGE_CITATION_RE.lastIndex = 0;
    const processed = clean.replace(PAGE_CITATION_RE, (_, page, quote) => {
        const idx = citations.length;
        citations.push({ page: parseInt(page, 10), quote: quote.trim() });
        return `§${idx}§`;
    });
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
