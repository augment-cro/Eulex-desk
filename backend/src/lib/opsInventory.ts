/**
 * Generic client for an external ops-inventory service (AdminMax → "Baze").
 *
 * Max knows nothing about the data stores behind that page: it forwards
 * `GET /adminmax/databases` to `OPS_INVENTORY_URL` and renders whatever JSON
 * comes back. The service is a separate program reached over the network;
 * when the URL is unset the feature reports itself as unavailable.
 *
 * Auth: a Google OIDC identity token for the service URL, minted from this
 * backend's runtime service account (Cloud Run metadata). For local
 * development `OPS_INVENTORY_TOKEN` (a static bearer) can be used instead.
 */
import { GoogleAuth } from "google-auth-library";

function baseUrl(): string {
    return (process.env.OPS_INVENTORY_URL ?? "").trim().replace(/\/+$/, "");
}

export function opsInventoryConfigured(): boolean {
    return baseUrl() !== "";
}

let googleAuth: GoogleAuth | null = null;

async function authorization(): Promise<string> {
    const staticToken = process.env.OPS_INVENTORY_TOKEN?.trim();
    if (staticToken) return `Bearer ${staticToken}`;
    googleAuth ??= new GoogleAuth();
    const client = await googleAuth.getIdTokenClient(baseUrl());
    const token = await client.idTokenProvider.fetchIdToken(baseUrl());
    return `Bearer ${token}`;
}

export class OpsInventoryError extends Error {
    constructor(
        message: string,
        public readonly status: number,
    ) {
        super(message);
    }
}

export async function opsInventoryFetch<T = unknown>(
    path: string,
    init: { method?: string; body?: unknown; timeoutMs?: number } = {},
): Promise<T> {
    const res = await fetch(`${baseUrl()}${path}`, {
        method: init.method ?? "GET",
        headers: {
            Authorization: await authorization(),
            Accept: "application/json",
            ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
        signal: AbortSignal.timeout(init.timeoutMs ?? 30_000),
    });
    const text = await res.text();
    if (!res.ok) {
        let detail = text;
        try {
            detail = (JSON.parse(text) as { detail?: string }).detail ?? text;
        } catch {
            /* keep raw */
        }
        throw new OpsInventoryError(`ops-inventory ${path} → ${res.status}: ${detail.slice(0, 500)}`, res.status);
    }
    return (text ? JSON.parse(text) : {}) as T;
}
