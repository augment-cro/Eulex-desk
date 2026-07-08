/**
 * Simple Analytics wrapper — Task E / Phase 1
 *
 * Privacy contract: event names and metadata MUST NOT contain any
 * document/chat content, file names, CM numbers, project/chat/user UUIDs,
 * email, display names, or anything the user typed. The `pickAllowed` helper
 * enforces the allowlist at runtime.
 */

// ---------------------------------------------------------------------------
// Window type augmentation
// ---------------------------------------------------------------------------

declare global {
    interface Window {
        /**
         * Simple Analytics event function.
         * Before the SA script loads this is a queue-stub created in layout.tsx.
         */
        sa_event?: (event: string, metadata?: Record<string, unknown>) => void;
        /**
         * Simple Analytics pageview function.
         * Called manually because auto-collect is disabled (raw ID paths must
         * not be sent; we normalise them first). Only defined once the SA
         * script has loaded — trackPageview() queues until then.
         */
        sa_pageview?: (path: string) => void;
        /**
         * Global metadata object merged into every SA event automatically by
         * the SA script when it reads `window.sa_metadata`.
         */
        sa_metadata?: Record<string, unknown>;
    }
}

// ---------------------------------------------------------------------------
// Allowlisted metadata keys (privacy hard gate)
// ---------------------------------------------------------------------------

export const ALLOWED_KEYS = [
    "tier",
    "ui_locale",
    "surface",
    "model_tier",
    "source",
    "result",
    "trigger",
    "provider",
    "kind",
    "change",
    "workflow_type",
    "file_type",
    "has_attachment",
    "from_workflow",
    "column_count",
    "entity_count",
] as const;

const ALLOWED_KEY_SET: ReadonlySet<string> = new Set(ALLOWED_KEYS);

/** Regex that valid event names must match: lowercase snake_case, 1–200 chars. */
export const EVENT_NAME_REGEX = /^[a-z0-9_]{1,200}$/;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Warn in dev only — no-ops in production. */
function devWarn(...args: unknown[]): void {
    if (process.env.NODE_ENV !== "production") {
        console.warn("[sa]", ...args);
    }
}

/** Return a copy of `metadata` containing only allowlisted keys. */
function pickAllowed(
    metadata: Record<string, unknown> | undefined,
): Record<string, unknown> {
    if (!metadata) return {};
    return Object.fromEntries(
        Object.entries(metadata).filter(([k]) => ALLOWED_KEY_SET.has(k)),
    );
}

// ---------------------------------------------------------------------------
// Path normalisation
// ---------------------------------------------------------------------------

/**
 * A path segment that looks like an opaque identifier rather than a static
 * route name: a UUID, a pure number, or any 8+ char URL-safe string that
 * contains a digit. Over-matching is fine (a static segment rendered as
 * `:id` only coarsens analytics); under-matching leaks an identifier to a
 * third party — so this is deliberately aggressive.
 */
const OPAQUE_SEGMENT =
    /^(?:\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|(?=[^/]*\d)[A-Za-z0-9._~-]{8,})$/i;

/**
 * Replace raw ID/token segments with safe placeholders.
 *
 * Two passes, fail-closed:
 *   1. Known route shapes get named placeholders (`/projects/:id`,
 *      `/chat/:id`, `/tabular-reviews/:id`, `/share/:token`,
 *      `/workflows/:id`).
 *   2. Any remaining segment that looks like an opaque identifier
 *      (UUID, number, digit-bearing slug) becomes `:id` — so a new
 *      dynamic route that nobody added to pass 1 cannot leak its raw
 *      ID to Simple Analytics by default.
 *
 * @example
 *   normalizePath("/projects/abc-123/assistant/chat/def-456")
 *   // → "/projects/:id/assistant/chat/:id"
 *   normalizePath("/adminmax/users/6f9619ff-8b86-d011-b42d-00c04fc964ff")
 *   // → "/adminmax/users/:id"   (generic pass — not in the named list)
 */
export function normalizePath(p: string): string {
    const named = p
        .replace(/\/projects\/[^/]+/g, "/projects/:id")
        .replace(/\/chat\/[^/]+/g, "/chat/:id")
        .replace(/\/tabular-reviews\/[^/]+/g, "/tabular-reviews/:id")
        .replace(/\/share\/[^/]+/g, "/share/:token")
        .replace(/\/workflows\/[^/]+/g, "/workflows/:id");
    return named
        .split("/")
        .map((seg) => (OPAQUE_SEGMENT.test(seg) ? ":id" : seg))
        .join("/");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Send a custom event to Simple Analytics.
 *
 * - Silently no-ops on the server (SSR).
 * - Drops events whose name violates the naming convention (dev warning).
 * - Strips any metadata key not in ALLOWED_KEYS.
 * - In development, logs to console and does NOT call the real SA function.
 * - Never throws: analytics must not be able to fail a user flow (a privacy
 *   extension replacing `sa_event` with a throwing stub would otherwise turn
 *   a successful upload into a rejected promise).
 */
export function track(
    event: string,
    metadata?: Record<string, unknown>,
): void {
    if (typeof window === "undefined") return;

    if (!EVENT_NAME_REGEX.test(event)) {
        devWarn(
            `Invalid event name "${event}" — must match /^[a-z0-9_]{1,200}$/. Event dropped.`,
        );
        return;
    }

    const clean = pickAllowed(metadata);

    if (process.env.NODE_ENV !== "production") {
        console.debug("[sa]", event, clean);
        return;
    }

    try {
        window.sa_event?.(event, clean);
    } catch (err) {
        console.error("[sa] track failed (non-fatal):", err);
    }
}

/**
 * Sync tier/locale (and any other allowed global dims) into
 * `window.sa_metadata`.
 *
 * Keys passed with a defined value are set; keys passed explicitly as
 * `undefined` are REMOVED — so logout clears the previous user's tier
 * instead of letting it stick to anonymous / next-user events. Keys not
 * mentioned are left untouched.
 */
export function setGlobalMetadata(m: {
    tier?: string;
    ui_locale?: string;
}): void {
    if (typeof window === "undefined") return;
    const next: Record<string, unknown> = { ...(window.sa_metadata ?? {}) };
    for (const [k, v] of Object.entries(m)) {
        if (!ALLOWED_KEY_SET.has(k)) continue;
        if (v === undefined) delete next[k];
        else next[k] = v;
    }
    window.sa_metadata = next;
}

// ---------------------------------------------------------------------------
// Pageviews
// ---------------------------------------------------------------------------

/**
 * Pageviews recorded before the SA script defines `window.sa_pageview`.
 * The head stub in layout.tsx only queues `sa_event`, and replaying a
 * pageview through the custom-event API would record it as a custom event
 * named "pageview" (with a non-allowlisted `path` key) instead of a real
 * pageview — so we keep our own queue and drain it from the <Script>
 * onLoad handler (see Analytics.tsx). Capped so an ad-blocked script
 * can't grow it unboundedly.
 */
const pendingPageviews: string[] = [];
const PENDING_PAGEVIEWS_CAP = 50;

function dispatchPageview(path: string): void {
    try {
        window.sa_pageview?.(path);
    } catch (err) {
        console.error("[sa] pageview failed (non-fatal):", err);
    }
}

/**
 * Record a pageview for `rawPath`, normalising ID segments first.
 * Queues until the SA script has loaded; dev-mode logs and no-ops
 * like track().
 */
export function trackPageview(rawPath: string): void {
    if (typeof window === "undefined") return;

    const safe = normalizePath(rawPath);

    if (process.env.NODE_ENV !== "production") {
        console.debug("[sa] pageview", safe);
        return;
    }

    if (typeof window.sa_pageview === "function") {
        dispatchPageview(safe);
    } else if (pendingPageviews.length < PENDING_PAGEVIEWS_CAP) {
        pendingPageviews.push(safe);
    }
}

/** Drain pageviews queued before the SA script loaded. */
export function flushPageviews(): void {
    if (typeof window === "undefined") return;
    while (pendingPageviews.length > 0) {
        dispatchPageview(pendingPageviews.shift()!);
    }
}

// ---------------------------------------------------------------------------
// Shared metadata helpers
// ---------------------------------------------------------------------------

/**
 * Derive the `file_type` metadata value for a File: the lowercased
 * extension, falling back to the MIME subtype, then "unknown".
 * (Never send the file name itself — extension only.)
 */
export function fileTypeOf(f: File): string {
    return f.name.includes(".")
        ? f.name.split(".").pop()!.toLowerCase()
        : f.type.split("/").pop()?.toLowerCase() ?? "unknown";
}
