/**
 * Cross-page rate-limit store.
 *
 * The backend echoes `RateLimit-*` headers on every authenticated
 * route call (chat, projectChat, tabular, workflows, … plus the
 * dedicated `/user/rate-limit-status` poll). We park the latest
 * snapshot here so the banner can subscribe once and stay current
 * without hammering the network — every request the user already
 * makes acts as a free heartbeat.
 *
 * The store is intentionally module-scoped (singleton) because the
 * banner can mount in multiple places (Assistant, Tabular, Workflows)
 * and we want them all to see the same state.
 */

export type RateLimitState = "hidden" | "soft" | "hard";

export type RateLimitSnapshot = {
    /** ISO timestamp of the snapshot — used as a cheap dedupe key. */
    capturedAt: string;
    /** UMP slug, e.g. "eulex_plus" / "eulex_free". */
    tierSlug: string;
    /** Human label, e.g. "Eulex Plus". */
    tierLabel: string;
    /** Daily quota (tokens / 24h). */
    dailyTokens: number;
    /** Active credit-pack remainder. */
    bonusTokens: number;
    /** dailyTokens + bonusTokens. */
    limitTokens: number;
    /** Used in the rolling 24h window. */
    usedTokens: number;
    /** Remaining = max(0, limitTokens - usedTokens). */
    remainingTokens: number;
    /** Number of LLM requests in window (informational). */
    questionsInWindow: number;
    /** Server-side soft warning threshold crossed? */
    state: RateLimitState;
    /** ISO timestamp when oldest usage falls out of window. */
    nextReliefAt: string | null;
    /** `buyTokenPacks` entitlement (Plus and up) — show "Nadoplati" CTA. */
    topupAvailable: boolean;
};

type Subscriber = (snap: RateLimitSnapshot | null) => void;

let current: RateLimitSnapshot | null = null;
const subscribers = new Set<Subscriber>();

const SOFT_THRESHOLD = 0.8;

function notify() {
    for (const fn of subscribers) {
        try {
            fn(current);
        } catch (err) {
            console.error("[rateLimitStore] subscriber threw:", err);
        }
    }
}

export function getRateLimitSnapshot(): RateLimitSnapshot | null {
    return current;
}

export function subscribeRateLimit(fn: Subscriber): () => void {
    subscribers.add(fn);
    fn(current);
    return () => {
        subscribers.delete(fn);
    };
}

export function pushRateLimitSnapshot(snap: RateLimitSnapshot): void {
    current = snap;
    notify();
}

export function clearRateLimitSnapshot(): void {
    current = null;
    notify();
}

/**
 * Compute the soft/hard/hidden state from raw numbers.
 */
export function computeRateState(
    used: number,
    limit: number,
    over: boolean,
): RateLimitState {
    if (over || (limit > 0 && used >= limit)) return "hard";
    if (limit > 0 && used / limit >= SOFT_THRESHOLD) return "soft";
    return "hidden";
}

/**
 * Pull every `RateLimit-*` header off the response and emit a snapshot
 * if at least the core fields are present. Safe to call on any
 * `Response` — silently no-ops when the headers are missing (e.g. for
 * non-LLM routes the server doesn't bother attaching them).
 */
export function pushFromResponseHeaders(res: Response): void {
    const limitHeader = res.headers.get("RateLimit-Limit");
    const remaining = res.headers.get("RateLimit-Remaining");
    if (!limitHeader || remaining == null) return;
    const limit = parseLimitHeader(limitHeader);
    const used = Number(res.headers.get("X-RateLimit-Used-Tokens") ?? 0);
    const dailyTokens = Number(res.headers.get("X-RateLimit-Daily-Tokens") ?? limit);
    const bonusTokens = Number(res.headers.get("X-RateLimit-Bonus-Tokens") ?? 0);
    const questions = Number(res.headers.get("X-RateLimit-Questions") ?? 0);
    const tierSlug = res.headers.get("X-RateLimit-Tier-Slug") ?? "eulex_free";
    const tierLabel =
        res.headers.get("X-RateLimit-Tier-Label") ?? "Eulex FREE";
    const resetSec = Number(res.headers.get("RateLimit-Reset") ?? 0);
    const nextReliefAt = resetSec
        ? new Date(Date.now() + resetSec * 1000).toISOString()
        : null;
    const remainingNum = Number(remaining);
    const over = remainingNum <= 0 || used >= limit;
    const state = computeRateState(used, limit, over);
    // Backend is authoritative: it echoes the `buyTokenPacks` entitlement
    // (Plus and up) as this header. Fall back to "anyone above Free" only
    // if an older backend omits it, so higher tiers never lose top-up.
    const topupHeader = res.headers.get("X-RateLimit-Topup-Available");
    const topupAvailable =
        topupHeader != null
            ? topupHeader === "1"
            : tierSlug !== "eulex_free";
    pushRateLimitSnapshot({
        capturedAt: new Date().toISOString(),
        tierSlug,
        tierLabel,
        dailyTokens,
        bonusTokens,
        limitTokens: limit,
        usedTokens: used,
        remainingTokens: Math.max(0, remainingNum),
        questionsInWindow: questions,
        state,
        nextReliefAt,
        topupAvailable,
    });
}

/**
 * Update from a 429 JSON body. Used when fetch.ok is false but the
 * RateLimit-* headers may be partial.
 */
export function pushFromRateLimitedError(body: {
    limit_tokens?: number;
    used_tokens?: number;
    daily_tokens?: number;
    bonus_remaining?: number;
    next_relief_at?: string | null;
    tier?: { slug?: string; label?: string };
    topup_available?: boolean;
}): void {
    const limit = Number(body.limit_tokens ?? 0);
    const used = Number(body.used_tokens ?? limit);
    pushRateLimitSnapshot({
        capturedAt: new Date().toISOString(),
        tierSlug: body.tier?.slug ?? "eulex_free",
        tierLabel: body.tier?.label ?? "Eulex FREE",
        dailyTokens: Number(body.daily_tokens ?? limit),
        bonusTokens: Number(body.bonus_remaining ?? 0),
        limitTokens: limit,
        usedTokens: used,
        remainingTokens: 0,
        questionsInWindow: current?.questionsInWindow ?? 0,
        state: "hard",
        nextReliefAt: body.next_relief_at ?? null,
        topupAvailable: !!body.topup_available,
    });
}

function parseLimitHeader(value: string): number {
    // IETF format: "<limit>;w=<window>" — we only care about the limit.
    const limitPart = value.split(";")[0]?.trim();
    const n = Number(limitPart);
    return Number.isFinite(n) ? n : 0;
}
