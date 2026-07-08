"use client";

/**
 * React glue around `rateLimitStore`. Subscribes the component to live
 * snapshots and triggers a one-shot fetch of `/user/rate-limit-status`
 * on mount when the store is empty (e.g. fresh page load before any
 * authenticated API call).
 */

import { useEffect, useState } from "react";
import {
    getRateLimitSnapshot,
    pushRateLimitSnapshot,
    subscribeRateLimit,
    type RateLimitSnapshot,
} from "../lib/rateLimitStore";
import { getStoredTokens } from "@/lib/oauth";

const API_BASE =
    process.env.NEXT_PUBLIC_API_BASE_URL?.trim() || "http://localhost:3001";

let inflight: Promise<void> | null = null;

async function refreshOnce(): Promise<void> {
    if (inflight) return inflight;
    inflight = (async () => {
        try {
            const tokens = getStoredTokens();
            if (!tokens?.access_token) return;
            const res = await fetch(`${API_BASE}/user/rate-limit-status`, {
                headers: { Authorization: `Bearer ${tokens.access_token}` },
                cache: "no-store",
            });
            if (!res.ok) return;
            const body = await res.json();
            pushRateLimitSnapshot({
                capturedAt: new Date().toISOString(),
                tierSlug: body.tier?.slug ?? "eulex_free",
                tierLabel: body.tier?.label ?? "Eulex FREE",
                dailyTokens: Number(body.daily_tokens ?? body.limit_tokens ?? 0),
                bonusTokens: Number(body.bonus_tokens ?? 0),
                limitTokens: Number(body.limit_tokens ?? 0),
                usedTokens: Number(body.used_tokens ?? 0),
                remainingTokens: Number(body.remaining_tokens ?? 0),
                questionsInWindow: Number(body.questions_in_window ?? 0),
                state: (body.state as RateLimitSnapshot["state"]) ?? "hidden",
                nextReliefAt: body.next_relief_at ?? null,
                topupAvailable: !!body.topup_available,
            });
        } catch (err) {
            console.warn("[useRateLimitStatus] refresh failed:", err);
        } finally {
            inflight = null;
        }
    })();
    return inflight;
}

export function useRateLimitStatus(): RateLimitSnapshot | null {
    const [snap, setSnap] = useState<RateLimitSnapshot | null>(
        getRateLimitSnapshot(),
    );
    useEffect(() => {
        const unsub = subscribeRateLimit((s) => setSnap(s));
        if (!getRateLimitSnapshot()) {
            refreshOnce();
        }
        return unsub;
    }, []);
    return snap;
}

export { refreshOnce as refreshRateLimitStatus };
