/**
 * The model's status tokens — 🔴 material problem, 🟡 gap, 🔵 legal
 * assessment needed, ⚪ insufficient information, 🟢 no material gap (the
 * EULEX AI Governance rules make it write them). The model's text keeps
 * them; generated files draw them calmer: a small pastel dot in Word
 * (docxPalette), a plain ● / ○ in Excel. The frontend has its twin in
 * app/components/shared/statusTokens.ts.
 */
export type StatusKind = "problem" | "gap" | "assessment" | "insufficient" | "clear";

const KIND_BY_TOKEN: Record<string, StatusKind> = {
    "\u{1F534}": "problem", // 🔴
    "\u{1F7E1}": "gap", // 🟡
    "\u{1F535}": "assessment", // 🔵
    "⚪": "insufficient", // ⚪
    "\u{1F7E2}": "clear", // 🟢
};

/** One of the five, with a following variation selector (U+FE0F) if present. */
const STATUS_TOKEN_RE = /(\u{1F534}|\u{1F7E1}|\u{1F535}|⚪|\u{1F7E2})️?/gu;

export type StatusPart = string | { status: StatusKind; token: string };

/** Text split into plain runs and status tokens, in order; empty runs dropped. */
export function splitStatusTokens(text: string): StatusPart[] {
    const parts: StatusPart[] = [];
    let last = 0;
    for (const m of text.matchAll(STATUS_TOKEN_RE)) {
        const at = m.index ?? 0;
        if (at > last) parts.push(text.slice(last, at));
        parts.push({ status: KIND_BY_TOKEN[m[1]], token: m[0] });
        last = at + m[0].length;
    }
    if (last < text.length) parts.push(text.slice(last));
    return parts;
}

/** The plain-text form: ● for a status, ○ for insufficient information. */
export function statusDotGlyph(status: StatusKind): string {
    return status === "insufficient" ? "○" : "●";
}

/** Status tokens replaced by their plain glyph (Excel cells). */
export function statusTokensAsGlyphs(text: string): string {
    return text.replace(STATUS_TOKEN_RE, (_m, token: string) => statusDotGlyph(KIND_BY_TOKEN[token]));
}
