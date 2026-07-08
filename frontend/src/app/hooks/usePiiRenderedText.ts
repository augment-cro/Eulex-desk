"use client";

/**
 * Lazy de-anonymization for assistant messages.
 *
 * Detects placeholders (`⟦PII:…⟧`) in a string and asynchronously
 * resolves them via the backend's `/pii/sessions/:id/render` endpoint.
 * Until the round-trip completes (or when no sessionId / no placeholders
 * are present) the original text is returned unchanged.
 *
 * Caching is per-text per-session — the same string never round-trips
 * twice, which matters for SSR-stable chat histories that re-render on
 * every navigation.
 */

import { useEffect, useState } from "react";
import { piiRender } from "@/app/lib/mikeApi";

// Cache keyed by `${sessionId}::${text}`. Stays in memory for the
// lifetime of the SPA — chats rarely produce identical assistant
// strings, so it stays small.
const renderCache = new Map<string, string>();

const PLACEHOLDER_RE = /\u27E6PII:[A-Z][A-Z0-9_]*_\d+\u27E7/;

export function containsPiiPlaceholder(text: string): boolean {
    return PLACEHOLDER_RE.test(text);
}

interface UsePiiRenderedTextResult {
    text: string;
    /** True while we're waiting for /render. */
    loading: boolean;
    /** True once we have the de-anonymized version. */
    rendered: boolean;
    /** Placeholders we got back that aren't in the session — usually
     * indicates an LLM hallucination. Surface them so the UI can show
     * a small warning. */
    hallucinated: string[];
}

export function usePiiRenderedText(
    sessionId: string | null | undefined,
    text: string,
): UsePiiRenderedTextResult {
    const [state, setState] = useState<UsePiiRenderedTextResult>(() => {
        if (!sessionId || !containsPiiPlaceholder(text)) {
            return { text, loading: false, rendered: false, hallucinated: [] };
        }
        const cached = renderCache.get(`${sessionId}::${text}`);
        if (cached !== undefined) {
            return { text: cached, loading: false, rendered: true, hallucinated: [] };
        }
        return { text, loading: true, rendered: false, hallucinated: [] };
    });

    useEffect(() => {
        let cancelled = false;

        if (!sessionId || !containsPiiPlaceholder(text)) {
            setState({ text, loading: false, rendered: false, hallucinated: [] });
            return;
        }

        const cacheKey = `${sessionId}::${text}`;
        const cached = renderCache.get(cacheKey);
        if (cached !== undefined) {
            setState({ text: cached, loading: false, rendered: true, hallucinated: [] });
            return;
        }

        setState({ text, loading: true, rendered: false, hallucinated: [] });

        piiRender(sessionId, text)
            .then((res) => {
                if (cancelled) return;
                renderCache.set(cacheKey, res.rendered_text);
                setState({
                    text: res.rendered_text,
                    loading: false,
                    rendered: true,
                    hallucinated: res.hallucinated_placeholders ?? [],
                });
            })
            .catch(() => {
                if (cancelled) return;
                // Fail open — leave the placeholder text visible rather
                // than blocking the message. The user-facing result is
                // "AI mentioned ⟦PII:PERSON_1⟧" which is harmless info.
                setState({ text, loading: false, rendered: false, hallucinated: [] });
            });

        return () => {
            cancelled = true;
        };
    }, [sessionId, text]);

    return state;
}
