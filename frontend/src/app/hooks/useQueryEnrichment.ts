"use client";

import { useState, useCallback, useRef } from "react";
import {
    streamEnrichQuery,
    type EnrichedQuery,
    type QueryEnrichmentResult,
} from "@/app/lib/mikeApi";

// ─── localStorage cache ───────────────────────────────────────────────────────
// Caches completed enrichment results so the same query doesn't hit the LLM
// again. Key = djb2 hash of the lowercased, trimmed query.
// TTL = 24 h, max 30 entries (oldest evicted first).

const CACHE_PREFIX = "mike:enrich:v1:";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const CACHE_MAX = 30;

interface CacheEntry {
    variants: EnrichedQuery[];
    ts: number; // creation timestamp (for LRU eviction)
}

function djb2(s: string): string {
    let h = 5381;
    for (let i = 0; i < s.length; i++) {
        h = ((h << 5) + h) ^ s.charCodeAt(i);
        h = h >>> 0; // keep unsigned 32-bit
    }
    return h.toString(36);
}

function cacheKey(query: string): string {
    return CACHE_PREFIX + djb2(query.trim().toLowerCase());
}

function cacheGet(query: string): EnrichedQuery[] | null {
    try {
        const raw = localStorage.getItem(cacheKey(query));
        if (!raw) return null;
        const entry: CacheEntry = JSON.parse(raw);
        if (Date.now() - entry.ts > CACHE_TTL_MS) {
            localStorage.removeItem(cacheKey(query));
            return null;
        }
        return entry.variants;
    } catch {
        return null;
    }
}

function cacheSet(query: string, variants: EnrichedQuery[]): void {
    try {
        // Evict oldest entries if we're at the limit
        const keys: { key: string; ts: number }[] = [];
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k?.startsWith(CACHE_PREFIX)) {
                try {
                    const e: CacheEntry = JSON.parse(localStorage.getItem(k)!);
                    keys.push({ key: k, ts: e.ts });
                } catch { /* skip malformed */ }
            }
        }
        if (keys.length >= CACHE_MAX) {
            keys.sort((a, b) => a.ts - b.ts);
            for (let i = 0; i <= keys.length - CACHE_MAX; i++) {
                localStorage.removeItem(keys[i].key);
            }
        }
        const entry: CacheEntry = { variants, ts: Date.now() };
        localStorage.setItem(cacheKey(query), JSON.stringify(entry));
    } catch { /* storage full or unavailable */ }
}

// ─────────────────────────────────────────────────────────────────────────────

export function useQueryEnrichment() {
    // Completed variant cards (full {query, why} objects)
    const [variants, setVariants] = useState<EnrichedQuery[]>([]);
    // Per-card streaming text — index matches the incoming card position.
    // Updated character-by-character via delta events before the card completes.
    const [streamingTexts, setStreamingTexts] = useState<string[]>([]);
    const [isEnriching, setIsEnriching] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const lastCallRef = useRef(0);
    const abortRef = useRef<AbortController | null>(null);

    const enrich = useCallback(
        async (query: string, options?: { locale?: string; documentNames?: string[] }) => {
            const now = Date.now();
            if (now - lastCallRef.current < 300) return;
            lastCallRef.current = now;

            abortRef.current?.abort();
            const controller = new AbortController();
            abortRef.current = controller;

            // ── Phase 1: localStorage cache check ────────────────────────────
            const cached = cacheGet(query);
            if (cached && cached.length > 0) {
                console.log("[enrich] cache HIT (localStorage):", djb2(query.trim().toLowerCase()));
                setVariants(cached);
                setStreamingTexts([]);
                setError(null);
                setIsEnriching(false);
                return;
            }

            setIsEnriching(true);
            setError(null);
            setVariants([]);
            setStreamingTexts([]);

            // Accumulate variants for caching after stream completes
            const collectedVariants: EnrichedQuery[] = [];

            try {
                for await (const event of streamEnrichQuery(query, options, controller.signal)) {
                    if (controller.signal.aborted) break;

                    if (event.type === "delta") {
                        // Append text chunk to the streaming buffer for this card index
                        setStreamingTexts((prev) => {
                            const next = [...prev];
                            next[event.index] = (next[event.index] ?? "") + event.text;
                            return next;
                        });
                    } else if (event.type === "variant") {
                        // Card complete — move from streaming to final variants
                        collectedVariants[event.index] = event.variant;
                        setVariants((prev) => {
                            const next = [...prev];
                            next[event.index] = event.variant;
                            return next;
                        });
                        // Clear the streaming buffer for this slot (card is done)
                        setStreamingTexts((prev) => {
                            const next = [...prev];
                            next[event.index] = "";
                            return next;
                        });
                    }
                }

                // ── Phase 1: persist to localStorage after successful stream ─
                if (!controller.signal.aborted && collectedVariants.filter(Boolean).length > 0) {
                    cacheSet(query, collectedVariants.filter(Boolean));
                    console.log("[enrich] cached to localStorage:", djb2(query.trim().toLowerCase()));
                }
            } catch (err) {
                if ((err as Error)?.name === "AbortError") return;
                setError(err instanceof Error ? err.message : "Enrichment failed");
            } finally {
                setIsEnriching(false);
            }
        },
        [],
    );

    const reset = useCallback(() => {
        abortRef.current?.abort();
        setVariants([]);
        setStreamingTexts([]);
        setError(null);
        setIsEnriching(false);
    }, []);

    // Build QueryEnrichmentResult from completed variants for EnrichmentPanel
    const result: QueryEnrichmentResult | null =
        variants.filter(Boolean).length > 0
            ? {
                  improved_queries: variants.filter(Boolean).map((v) => v.query),
                  improved_queries_rich: variants.filter(Boolean),
              }
            : null;

    return { result, variants, streamingTexts, isEnriching, error, enrich, reset };
}
