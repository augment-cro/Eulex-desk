/**
 * Shared result type for all license-boundary seam clients — mirrors
 * the discriminated-union pattern of `lib/pii/client.ts` so callers
 * pick fail-open vs fail-closed without try/catch.
 */
export type SeamResult<T> =
    | { ok: true; data: T }
    | { ok: false; error: string; status?: number };
