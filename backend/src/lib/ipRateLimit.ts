/**
 * Small in-process, fixed-window rate limiter for unauthenticated
 * endpoints — built for POST /auth/pair/redeem (issue #148 / wiki #18),
 * where the existing per-code attempt counter does not stop a
 * distributed guesser cycling through many different codes.
 *
 * Why not express-rate-limit: it is not a dependency of this repo, and
 * the need here is a ~60-line fixed-window counter. An in-process Map
 * matches the house style (no Redis, no shadow store — see rateLimit.ts)
 * and avoids a new supply-chain edge for one route.
 *
 * Multi-instance caveat: counters live in process memory, so limits are
 * PER CLOUD RUN INSTANCE. With N instances the effective ceiling is up
 * to N× the configured limit. That is acceptable for this endpoint —
 * the per-code counter (5 tries, 5 min TTL, enforced in Postgres)
 * remains the hard backstop; this layer only throttles bulk guessing.
 * If the service ever scales wide, move the counters to Postgres.
 *
 * Not related to lib/rateLimit.ts, which meters authenticated users'
 * LLM token quotas out of the llm_usage table.
 *
 * @module ipRateLimit
 */

import type { Request, RequestHandler } from "express";

export type LimiterHit = {
    /** Whether this attempt is under the limit (the attempt is counted). */
    allowed: boolean;
    /** Attempts recorded in the current window, including this one. */
    count: number;
    /** Whole seconds until the current window resets (>= 1). */
    retryAfterSeconds: number;
};

/**
 * Fixed-window counter keyed by string. `now` is injectable for tests.
 *
 * Memory: entries are swept lazily — on any hit, once per window width,
 * every expired window is dropped. Worst case the Map holds one entry
 * per distinct key seen in the last two windows; no timer is kept, so
 * the limiter never holds the event loop open.
 */
export class FixedWindowLimiter {
    private readonly windows = new Map<
        string,
        { windowStart: number; count: number }
    >();
    private lastSweep = 0;

    constructor(
        private readonly limit: number,
        private readonly windowMs: number,
    ) {
        if (limit < 1) throw new Error("limit must be >= 1");
        if (windowMs < 1) throw new Error("windowMs must be >= 1");
    }

    /** Record one attempt for `key` and report whether it is allowed. */
    hit(key: string, now: number = Date.now()): LimiterHit {
        this.sweep(now);
        let entry = this.windows.get(key);
        if (!entry || now - entry.windowStart >= this.windowMs) {
            entry = { windowStart: now, count: 0 };
            this.windows.set(key, entry);
        }
        entry.count += 1;
        const msLeft = entry.windowStart + this.windowMs - now;
        return {
            allowed: entry.count <= this.limit,
            count: entry.count,
            retryAfterSeconds: Math.max(1, Math.ceil(msLeft / 1000)),
        };
    }

    /** Number of live (non-expired) keys — exposed for tests. */
    size(now: number = Date.now()): number {
        let n = 0;
        for (const e of this.windows.values()) {
            if (now - e.windowStart < this.windowMs) n += 1;
        }
        return n;
    }

    private sweep(now: number): void {
        if (now - this.lastSweep < this.windowMs) return;
        this.lastSweep = now;
        for (const [key, e] of this.windows) {
            if (now - e.windowStart >= this.windowMs) this.windows.delete(key);
        }
    }
}

/**
 * Client IP behind Cloud Run, WITHOUT flipping Express `trust proxy`.
 *
 * Cloud Run fronts the container with exactly one Google front-end hop,
 * which APPENDS the IP it accepted the connection from to
 * X-Forwarded-For. So the LAST entry is the only one Google vouches
 * for; everything before it is client-supplied and spoofable. We read
 * that last entry directly instead of setting `app.set("trust proxy", 1)`
 * because trust-proxy is process-global and would silently change
 * `req.ip` semantics for every other route (adminMax.ts logs req.ip in
 * a dozen places under the current direct-peer semantics). Scoping the
 * XFF parse to this module keeps the blast radius at zero.
 *
 * Local dev / tests have no XFF header — fall back to the socket peer.
 */
export function clientIpFrom(req: Request): string {
    const xff = req.headers["x-forwarded-for"];
    const raw = Array.isArray(xff) ? xff[xff.length - 1] : xff;
    if (raw) {
        const parts = raw.split(",");
        const last = parts[parts.length - 1]?.trim();
        if (last) return last;
    }
    return req.socket?.remoteAddress ?? "unknown";
}

export type IpRateLimitOptions = {
    /** Short tag for log lines, e.g. "auth/pair/redeem". */
    name: string;
    /** Window width in milliseconds (one window for both limits). */
    windowMs: number;
    /** Max attempts per client IP per window. */
    perIpLimit: number;
    /** Max attempts across ALL IPs per window (distributed-guess backstop). */
    globalLimit: number;
};

/**
 * Express middleware: 429 + `Retry-After` when either the per-IP or the
 * route-global fixed window is exhausted. Every attempt counts against
 * both windows (a rejected attempt still consumes budget — retry-storms
 * must not probe for free). Rejections are logged with the IP and the
 * window count only — never with request-body contents, so attempted
 * pairing codes stay out of the logs.
 */
export function ipRateLimit(opts: IpRateLimitOptions): RequestHandler {
    const perIp = new FixedWindowLimiter(opts.perIpLimit, opts.windowMs);
    const global = new FixedWindowLimiter(opts.globalLimit, opts.windowMs);
    return (req, res, next) => {
        const ip = clientIpFrom(req);
        const ipHit = perIp.hit(ip);
        const globalHit = global.hit("*");
        if (ipHit.allowed && globalHit.allowed) {
            next();
            return;
        }
        // If both tripped, tell the client to wait for the longer reset.
        const retryAfter = Math.max(
            ipHit.allowed ? 0 : ipHit.retryAfterSeconds,
            globalHit.allowed ? 0 : globalHit.retryAfterSeconds,
        );
        const scope = ipHit.allowed ? "global" : "ip";
        console.warn(
            `[ipratelimit] ${opts.name} 429 scope=${scope} ip=${ip} ` +
                `ipCount=${ipHit.count}/${opts.perIpLimit} ` +
                `globalCount=${globalHit.count}/${opts.globalLimit} ` +
                `retryAfter=${retryAfter}s`,
        );
        res.setHeader("Retry-After", String(retryAfter));
        res.status(429).json({
            detail: "Too many attempts, try again later",
            code: "RATE_LIMITED",
            retry_after_seconds: retryAfter,
        });
    };
}

/**
 * Positive-integer env override with a default — bad values (absent,
 * non-numeric, zero, negative) fall back silently so a typo in Cloud
 * Run env config can never disable the limiter or crash boot.
 */
export function envInt(name: string, fallback: number): number {
    const raw = process.env[name];
    if (!raw) return fallback;
    const n = Number.parseInt(raw, 10);
    return Number.isInteger(n) && n > 0 ? n : fallback;
}
