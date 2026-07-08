/**
 * Server-side Simple Analytics event helper.
 *
 * Fire-and-forget: callers MUST NOT await this in any critical path (Stripe
 * webhook, payment processing). All network/serialisation errors are caught
 * and logged; they never propagate to the caller.
 *
 * The metadata allowlist and event-name rule below are enforced at runtime
 * (mirroring the frontend twin, frontend/src/app/lib/analytics.ts): keys
 * outside ALLOWED_KEYS are stripped, invalid event names drop the event.
 * This code path handles Stripe payloads full of customer ids and emails —
 * NEVER pass customer ids, email addresses, Stripe ids, prices/amounts, PII.
 *
 * @module analytics
 */

const SA_HOSTNAME =
    (process.env.SA_HOSTNAME ?? process.env.NEXT_PUBLIC_SA_HOSTNAME ?? "max.eulex.ai").trim();

const SA_EVENTS_URL = "https://queue.simpleanalyticscdn.com/events";

/** Bound each analytics POST so a hung SA endpoint can't accumulate sockets. */
const SA_FETCH_TIMEOUT_MS = 5_000;

/**
 * Allowlisted metadata keys. Keep in sync with ALLOWED_KEYS in
 * frontend/src/app/lib/analytics.ts (the two packages don't share code).
 */
const ALLOWED_KEYS = new Set([
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
]);

/** Valid event names: lowercase snake_case, 1–200 chars. */
const EVENT_NAME_REGEX = /^[a-z0-9_]{1,200}$/;

/** Return a copy of `metadata` containing only allowlisted keys. */
function pickAllowed(
    metadata: Record<string, unknown> | undefined,
): Record<string, unknown> {
    if (!metadata) return {};
    return Object.fromEntries(
        Object.entries(metadata).filter(([k]) => ALLOWED_KEYS.has(k)),
    );
}

/**
 * Post a named event to Simple Analytics.
 *
 * Fire-and-forget — returns void immediately. Errors are swallowed after
 * logging so a failed analytics POST can never crash the caller. Metadata
 * is filtered against ALLOWED_KEYS; anything else is silently dropped.
 *
 * @param event  Snake-case event name matching /^[a-z0-9_]{1,200}$/
 * @param metadata  Optional allowlisted key/value pairs (see ALLOWED_KEYS).
 */
export function postEvent(
    event: string,
    metadata?: Record<string, unknown>,
): void {
    // No-op outside production to avoid polluting analytics with dev noise.
    if (process.env.NODE_ENV !== "production") return;

    if (!EVENT_NAME_REGEX.test(event)) {
        console.error(`[analytics] invalid event name "${event}" — dropped`);
        return;
    }

    const clean = pickAllowed(metadata);

    const body = JSON.stringify({
        type: "event",
        hostname: SA_HOSTNAME,
        event,
        ...(Object.keys(clean).length > 0 ? { metadata: clean } : {}),
        ua: "max-server/1.0 (+https://max.eulex.ai)",
    });

    // Intentionally not awaited — this is a side-effect POST that must never
    // block or throw into any calling code.
    fetch(SA_EVENTS_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        signal: AbortSignal.timeout(SA_FETCH_TIMEOUT_MS),
    }).catch((err: unknown) => {
        console.error(
            "[analytics] postEvent failed (non-fatal):",
            err instanceof Error ? err.message : err,
        );
    });
}
