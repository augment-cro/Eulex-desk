import type { MikeContext, MikeContextSource } from "@/app/lib/mikeApi";
import type { ContextUnavailable } from "../shared/types";

/** A system context's name/description in the UI locale, else the stored one. */
export function localizedContextName(
    ctx: Pick<MikeContext, "name" | "name_i18n">,
    locale: string,
): string {
    const key = locale === "en" ? "en" : "hr";
    return ctx.name_i18n?.[key]?.trim() || ctx.name;
}

export function localizedContextDescription(
    ctx: Pick<MikeContext, "description" | "description_i18n">,
    locale: string,
): string | null {
    const key = locale === "en" ? "en" : "hr";
    return ctx.description_i18n?.[key]?.trim() || ctx.description;
}

export function isSystemContext(ctx: Pick<MikeContext, "level">): boolean {
    return ctx.level === "system";
}

/** Source categories of a context, in display order. */
export const SOURCE_GROUPS = [
    "law",
    "official",
    "caselaw",
    "documents",
    "other",
] as const;
export type SourceGroup = (typeof SOURCE_GROUPS)[number];

/**
 * Category of a source: legislation, official bodies' guidance (links of
 * authority tier 1–2), case law, context documents, and other (expert /
 * secondary) sources.
 */
export function sourceGroup(
    s: Pick<MikeContextSource, "kind" | "authority_tier">,
): SourceGroup {
    if (s.kind === "legal_instrument" || s.kind === "legal_article") return "law";
    if (s.kind === "caselaw") return "caselaw";
    if (s.kind === "document") return "documents";
    return s.authority_tier === "1" || s.authority_tier === "2"
        ? "official"
        : "other";
}

export function groupSources<T extends Pick<MikeContextSource, "kind" | "authority_tier">>(
    sources: T[],
): { group: SourceGroup; items: T[] }[] {
    return SOURCE_GROUPS.map((group) => ({
        group,
        items: sources.filter((s) => sourceGroup(s) === group),
    })).filter((g) => g.items.length > 0);
}

/** Reasoning-effort levels a system context may set. */
export const CONTEXT_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type ContextEffort = (typeof CONTEXT_EFFORTS)[number];

export function isContextEffort(v: unknown): v is ContextEffort {
    return CONTEXT_EFFORTS.includes(v as ContextEffort);
}

/** A streamed event's `unavailable` list; malformed entries are dropped. */
export function parseContextsUnavailable(v: unknown): ContextUnavailable[] {
    if (!Array.isArray(v)) return [];
    return v.flatMap((u): ContextUnavailable[] => {
        if (!u || typeof u !== "object") return [];
        const { kind, name, id } = u as Record<string, unknown>;
        if ((kind !== "context" && kind !== "document") || typeof name !== "string") return [];
        return [{ kind, name, ...(typeof id === "string" ? { id } : {}) }];
    });
}

/**
 * Names of what an answer ran without. A context that failed to load comes
 * without a name: it is named from the user's own contexts by id (in the UI
 * locale), else `fallback`.
 */
export function unavailableNames(
    unavailable: ContextUnavailable[],
    known: Pick<MikeContext, "id" | "name" | "name_i18n">[],
    locale: string,
    fallback: string,
): string[] {
    return unavailable.map((u) => {
        if (u.name.trim()) return u.name.trim();
        const ctx = u.id ? known.find((c) => c.id === u.id) : undefined;
        return ctx ? localizedContextName(ctx, locale) : fallback;
    });
}

// Product names, not translated. An id missing here is shown as it is.
const MODEL_LABELS: Record<string, string> = {
    "claude-opus-5-5": "Claude Opus 5.5",
    "claude-sonnet-5-5": "Claude Sonnet 5.5",
};

export function contextModelLabel(id: string): string {
    return MODEL_LABELS[id] ?? id;
}
