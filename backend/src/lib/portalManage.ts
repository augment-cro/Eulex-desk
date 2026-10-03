/**
 * Generic client for the external portal "manage" API (AdminMax → "Portal").
 *
 * Max knows nothing about portal.eulex.ai's data model: it forwards the
 * `/adminmax/portal/*` requests to `PORTAL_MANAGE_URL` and renders whatever
 * JSON comes back. The portal is a separate program reached over the
 * network; when the URL is unset the feature reports itself as unavailable.
 *
 * Auth: a static service key (`PORTAL_MANAGE_KEY`) sent as
 * `X-Portal-Service-Key`. The admin's own AdminMax token is never forwarded.
 */

function baseUrl(): string {
    return (process.env.PORTAL_MANAGE_URL ?? "").trim().replace(/\/+$/, "");
}

function serviceKey(): string {
    return (process.env.PORTAL_MANAGE_KEY ?? "").trim();
}

export function portalManageConfigured(): boolean {
    return baseUrl() !== "";
}

export class PortalManageError extends Error {
    constructor(
        message: string,
        public readonly status: number,
    ) {
        super(message);
    }
}

/** Integer query parameter clamped to [min, max]; `fallback` when absent/invalid. */
export function clampInt(
    raw: unknown,
    fallback: number,
    min: number,
    max: number,
): number {
    const n = typeof raw === "number" ? raw : parseInt(String(raw ?? ""), 10);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(Math.max(Math.trunc(n), min), max);
}

export async function portalManageFetch<T = unknown>(
    path: string,
    init: { method?: string; body?: unknown; timeoutMs?: number } = {},
): Promise<T> {
    const res = await fetch(`${baseUrl()}${path}`, {
        method: init.method ?? "GET",
        headers: {
            "X-Portal-Service-Key": serviceKey(),
            Accept: "application/json",
            ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
        signal: AbortSignal.timeout(init.timeoutMs ?? 15_000),
    });
    const text = await res.text();
    if (!res.ok) {
        let detail = text;
        try {
            const parsed = JSON.parse(text) as { detail?: unknown; error?: unknown };
            const d = parsed.detail ?? parsed.error;
            if (typeof d === "string") detail = d;
        } catch {
            /* keep raw */
        }
        throw new PortalManageError(
            `portal-manage ${path} → ${res.status}: ${detail.slice(0, 500)}`,
            res.status,
        );
    }
    return (text ? JSON.parse(text) : {}) as T;
}
