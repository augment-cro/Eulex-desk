import type { ColumnConfig } from "../shared/types";

export type PillSegment =
    | { type: "text"; content: string }
    | { type: "pill"; content: string };

/**
 * Sequential pill styles assigned to tags by their position in the tags array.
 * Categorical (no semantic status) → mapped onto the neutral secondary chip
 * ladder; the original distinct hues collapse since no multi-hue categorical
 * tokens exist in the theme.
 */
export const TAG_COLORS = [
    "bg-secondary text-secondary-foreground",
    "bg-secondary text-secondary-foreground",
    "bg-secondary text-secondary-foreground",
    "bg-secondary text-secondary-foreground",
    "bg-secondary text-secondary-foreground",
    "bg-secondary text-secondary-foreground",
    "bg-secondary text-secondary-foreground",
    "bg-secondary text-secondary-foreground",
];

const CURRENCY_COLORS: Record<string, string> = {
    USD: "bg-secondary text-secondary-foreground",
    EUR: "bg-secondary text-secondary-foreground",
    GBP: "bg-secondary text-secondary-foreground",
    JPY: "bg-secondary text-secondary-foreground",
    CHF: "bg-secondary text-secondary-foreground",
    AUD: "bg-secondary text-secondary-foreground",
    CAD: "bg-secondary text-secondary-foreground",
    SGD: "bg-secondary text-secondary-foreground",
    HKD: "bg-secondary text-secondary-foreground",
    NZD: "bg-secondary text-secondary-foreground",
    CNY: "bg-secondary text-secondary-foreground",
};

export function getPillClass(content: string, column?: ColumnConfig): string {
    if (column?.format === "yes_no") {
        const lower = content.toLowerCase();
        if (lower === "yes") return "bg-success/10 text-success";
        if (lower === "no") return "bg-destructive/10 text-destructive";
        return "bg-muted text-foreground";
    }
    if (column?.format === "currency") {
        return (
            CURRENCY_COLORS[content.toUpperCase()] ??
            "bg-secondary text-secondary-foreground"
        );
    }
    if (column?.format === "tag" && column.tags?.length) {
        const idx = column.tags.findIndex(
            (t) => t.toLowerCase() === content.toLowerCase(),
        );
        if (idx >= 0) return TAG_COLORS[idx % TAG_COLORS.length]!;
    }
    return "bg-muted text-foreground";
}

/** Split text on [[...]] pill markers, preserving surrounding text. */
export function parsePills(text: string): PillSegment[] {
    const segments: PillSegment[] = [];
    const regex = /\[\[([^\]]+)\]\]/g;
    let lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
        if (match.index > lastIndex) {
            segments.push({ type: "text", content: text.slice(lastIndex, match.index) });
        }
        segments.push({ type: "pill", content: match[1] });
        lastIndex = regex.lastIndex;
    }
    if (lastIndex < text.length) {
        segments.push({ type: "text", content: text.slice(lastIndex) });
    }
    return segments;
}
