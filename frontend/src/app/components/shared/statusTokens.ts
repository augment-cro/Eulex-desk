/**
 * The model's status tokens — 🔴 material problem, 🟡 gap, 🔵 legal
 * assessment needed, ⚪ insufficient information, 🟢 no material gap (the
 * EULEX AI Governance rules make it write them). They stay the canonical
 * text; the UI only draws them as soft dots (StatusDot).
 */
export const STATUS_KINDS = [
    "problem",
    "gap",
    "assessment",
    "insufficient",
    "clear",
] as const;
export type StatusKind = (typeof STATUS_KINDS)[number];

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

export function hasStatusToken(text: string): boolean {
    STATUS_TOKEN_RE.lastIndex = 0;
    return STATUS_TOKEN_RE.test(text);
}

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
