/**
 * Billing-provider seam client (contracts/billing-provider.openapi.json).
 *
 * An optional external service may issue offline-payment quotes (e.g. a
 * bank-transfer quote from an accounting system), track their payment,
 * and serve the user's fiscal documents. The core only relays: it sends
 * the plan as opaque data, passes answers through, and applies the grants
 * the service posts back (routes/billingGrants.ts).
 *
 * Standalone-core rule: with BILLING_PROVIDER_URL or BILLING_SERVICE_SECRET
 * unset the seam is inert — every caller sees "not configured".
 */
import { mintAdminServiceToken, mintServiceToken } from "./serviceIdentity";

const DEFAULT_TIMEOUT_MS = 20_000;

export function billingProviderConfigured(): boolean {
    return !!process.env.BILLING_PROVIDER_URL?.trim() && !!process.env.BILLING_SERVICE_SECRET?.trim();
}

export class BillingProviderUnavailable extends Error {
    constructor(message: string) {
        super(message);
        this.name = "BillingProviderUnavailable";
    }
}

export interface BillingProviderCall {
    /** Call on behalf of this user (scope seam:billing)… */
    user?: { id: string; email: string | null };
    /** …or as the operator (scope seam:billing-admin). */
    admin?: boolean;
    method?: "GET" | "POST";
    body?: unknown;
    query?: Record<string, string | null | undefined>;
    timeoutMs?: number;
}

/** One HTTP call to the provider. Throws BillingProviderUnavailable on transport failure. */
export async function billingProviderFetch(path: string, call: BillingProviderCall): Promise<Response> {
    const base = process.env.BILLING_PROVIDER_URL?.trim().replace(/\/+$/, "");
    if (!base || !billingProviderConfigured()) {
        throw new BillingProviderUnavailable("billing provider not configured");
    }
    const token = call.admin
        ? mintAdminServiceToken("billing")
        : call.user
          ? mintServiceToken("billing", call.user.id, null, call.user.email)
          : null;
    if (!token) throw new BillingProviderUnavailable("no identity for billing provider call");

    const url = new URL(`${base}${path}`);
    for (const [k, v] of Object.entries(call.query ?? {})) {
        if (v) url.searchParams.set(k, v);
    }
    try {
        return await fetch(url, {
            method: call.method ?? "GET",
            headers: {
                authorization: `Bearer ${token}`,
                ...(call.body !== undefined ? { "content-type": "application/json" } : {}),
            },
            body: call.body !== undefined ? JSON.stringify(call.body) : undefined,
            signal: AbortSignal.timeout(call.timeoutMs ?? DEFAULT_TIMEOUT_MS),
        });
    } catch (err) {
        throw new BillingProviderUnavailable(
            `billing provider unreachable: ${err instanceof Error ? err.message : String(err)}`,
        );
    }
}
