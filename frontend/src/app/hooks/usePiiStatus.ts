"use client";

/**
 * Lightweight status hook for the chat composer's shield badge.
 *
 * Responsibilities:
 *   - Resolve effective mode = chat.pii_mode ?? userProfile.piiDefaultMode.
 *   - Poll session meta when a session exists so the badge can show
 *     "12 PII hidden" and update after a new document is added.
 *   - Expose helpers so callers can avoid duplicating mode logic.
 *
 * Polling uses an exponential-backoff schedule (1s → 2s → 5s → 30s)
 * so an open chat that doesn't grow doesn't keep hitting the backend.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { piiSessionMeta, type PiiMode, type PiiSessionMeta } from "@/app/lib/mikeApi";
import { useUserProfile } from "@/contexts/UserProfileContext";

const BACKOFF_STEPS_MS = [1_000, 2_000, 5_000, 15_000, 30_000];

export interface UsePiiStatusOptions {
    /**
     * The chat's own PII mode override (chat.pii_mode column). When
     * null/undefined the hook falls back to `userProfile.piiDefaultMode`.
     */
    chatMode?: PiiMode | null;
    /**
     * Known session id. When provided the hook polls meta. Pass null
     * when you don't yet have one (the composer starts that way for new
     * chats — first document upload creates the session).
     */
    sessionId?: string | null;
    /**
     * Disable polling entirely (e.g. mode === "off"). Saves a network
     * round-trip per chat open.
     */
    enabled?: boolean;
}

export interface UsePiiStatusResult {
    /** The resolved mode after merging chat + user defaults. */
    mode: PiiMode;
    /** True when mode != "off". */
    active: boolean;
    /** True when mode === "strict_legal" or "strict". */
    requiresReview: boolean;
    /** Most recent session metadata (null until first poll). */
    meta: PiiSessionMeta | null;
    /** Trigger an immediate refetch (e.g. after a doc upload). */
    refresh: () => Promise<void>;
}

export function usePiiStatus(opts: UsePiiStatusOptions = {}): UsePiiStatusResult {
    const { profile } = useUserProfile();
    const userDefault = profile?.piiDefaultMode ?? "off";
    const userReviewRequired = !!profile?.piiReviewRequired;

    const mode: PiiMode = (opts.chatMode ?? userDefault) as PiiMode;
    const active = mode !== "off";
    const requiresReview =
        active && (mode === "strict_legal" || mode === "strict" || userReviewRequired);

    const [meta, setMeta] = useState<PiiSessionMeta | null>(null);
    const stepRef = useRef(0);
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const enabled = opts.enabled !== false && active && !!opts.sessionId;

    const fetchNow = useCallback(async () => {
        if (!opts.sessionId) return;
        try {
            const next = await piiSessionMeta(opts.sessionId);
            setMeta(next);
        } catch (err) {
            // Network blip — silent. Next backoff tick will retry.
        }
    }, [opts.sessionId]);

    useEffect(() => {
        if (!enabled) {
            setMeta(null);
            return;
        }
        let cancelled = false;
        stepRef.current = 0;

        const tick = async () => {
            if (cancelled) return;
            await fetchNow();
            const step = BACKOFF_STEPS_MS[Math.min(stepRef.current, BACKOFF_STEPS_MS.length - 1)];
            stepRef.current += 1;
            timerRef.current = setTimeout(tick, step);
        };

        tick();

        return () => {
            cancelled = true;
            if (timerRef.current) clearTimeout(timerRef.current);
        };
    }, [enabled, fetchNow]);

    const refresh = useCallback(async () => {
        // Reset backoff so the next interval is short again.
        stepRef.current = 0;
        await fetchNow();
    }, [fetchNow]);

    return { mode, active, requiresReview, meta, refresh };
}
