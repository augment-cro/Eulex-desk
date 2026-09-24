/**
 * PII restoration for tools that write into the user's files.
 *
 * In an active PII mode the model only ever sees placeholders
 * (`⟦PII:PERSON_1⟧`), and the PII prompt addendum tells it to copy them
 * verbatim. That is right for the chat reply — the frontend renders it
 * through /render — but a file is not rendered: generate_docx wrote the
 * placeholders straight into the DOCX, and edit_document inserted them into
 * the user's real document as tracked changes (and could not anchor a
 * `find` that contained one).
 *
 * `restorePlaceholders` resolves every placeholder in a tool's arguments
 * through the chat's shield session and returns a map that can
 *   - `restore` a value (placeholders → real values) before the file is
 *     written, and
 *   - `mask` a value (real values → placeholders) before anything goes
 *     back to the model, because a tool result is sent to the provider.
 */

import { PII_PLACEHOLDER_RE } from "./placeholders";
import { collectPlaceholdersDeep } from "./redactJsonDeep";
import type { Result } from "./client";

export interface PlaceholderMap {
    /** Number of placeholders this map can restore. */
    readonly size: number;
    /** Replace every known placeholder in every string of `value`. */
    restore<T>(value: T): T;
    /** Replace every restored original in every string of `value` with its placeholder. */
    mask<T>(value: T): T;
}

function mapStringsDeep<T>(value: T, fn: (s: string) => string): T {
    if (value == null) return value;
    if (typeof value === "string") return fn(value) as T;
    if (Array.isArray(value))
        return value.map((v) => mapStringsDeep(v, fn)) as unknown as T;
    if (typeof value === "object") {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value))
            out[k] = mapStringsDeep(v, fn);
        return out as T;
    }
    return value;
}

export function buildPlaceholderMap(
    pairs: ReadonlyMap<string, string>,
): PlaceholderMap {
    // Longest original first, so "Ivan Horvat" is masked before "Ivan".
    const byOriginal = [...pairs.entries()]
        .filter(([, original]) => original.length > 0)
        .sort((a, b) => b[1].length - a[1].length);
    return {
        size: pairs.size,
        restore: (value) =>
            mapStringsDeep(value, (s) =>
                s.replace(
                    new RegExp(PII_PLACEHOLDER_RE.source, "g"),
                    (ph) => pairs.get(ph) ?? ph,
                ),
            ),
        mask: (value) =>
            mapStringsDeep(value, (s) => {
                let out = s;
                for (const [placeholder, original] of byOriginal)
                    out = out.split(original).join(placeholder);
                return out;
            }),
    };
}

export const EMPTY_PLACEHOLDER_MAP = buildPlaceholderMap(new Map());

export interface RestoreDeps {
    getSessionId: (chatId: string) => Promise<string | null>;
    deanonymizeJson: (
        sessionId: string,
        data: unknown,
    ) => Promise<Result<unknown>>;
}

/**
 * Resolve the placeholders in `args`. Returns the empty map when there is
 * nothing to restore, and null when placeholders are present but the
 * shield cannot resolve them (no session, sidecar down) — the caller must
 * then refuse to write the file rather than write placeholders into it.
 * A placeholder the session does not know (a hallucinated one) simply
 * stays as it is.
 */
export async function restorePlaceholders(
    args: unknown,
    chatId: string,
    deps: RestoreDeps,
): Promise<PlaceholderMap | null> {
    const placeholders = collectPlaceholdersDeep(args);
    if (placeholders.length === 0) return EMPTY_PLACEHOLDER_MAP;

    const sessionId = await deps.getSessionId(chatId);
    if (!sessionId) return null;
    const res = await deps.deanonymizeJson(sessionId, placeholders);
    if (
        !res.ok ||
        !Array.isArray(res.data) ||
        res.data.length !== placeholders.length
    ) {
        return null;
    }

    const pairs = new Map<string, string>();
    placeholders.forEach((ph, i) => {
        const original = (res.data as unknown[])[i];
        if (typeof original === "string" && original !== ph)
            pairs.set(ph, original);
    });
    return buildPlaceholderMap(pairs);
}

/** Drop every placeholder from `text` — for names the model will see again. */
export function stripPlaceholders(text: string): string {
    return text.replace(new RegExp(PII_PLACEHOLDER_RE.source, "g"), "");
}
