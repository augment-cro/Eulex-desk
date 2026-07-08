/**
 * Provider registry — single source of truth for which file-source
 * connectors exist and whether each is wired up at runtime.
 *
 * Adding a new provider:
 *   1. Drop a `providers/<slug>.ts` adapter that implements
 *      ProviderAdapter from ./types.
 *   2. Append it to ADAPTERS below.
 *   3. Add the slug to the CHECK constraint in
 *      backend/migrations/108_integration_accounts.sql AND the
 *      ensureSchema mirror.
 *   4. Add the env var bootstrap to deploy docs.
 *
 * That's it — every route that talks to providers (`routes/integrations.ts`)
 * goes exclusively through `getAdapter()` so it picks up the new entry
 * automatically.
 */

import { boxAdapter } from "./providers/box";
import { googleDriveAdapter } from "./providers/google_drive";
import { oneDriveAdapter } from "./providers/onedrive";
import type { ProviderAdapter, ProviderId } from "./types";

const ADAPTERS: ReadonlyArray<ProviderAdapter> = [
    googleDriveAdapter,
    oneDriveAdapter,
    boxAdapter,
];

const BY_ID: ReadonlyMap<ProviderId, ProviderAdapter> = new Map(
    ADAPTERS.map((a) => [a.id, a]),
);

export function getAdapter(id: string): ProviderAdapter | null {
    return BY_ID.get(id as ProviderId) ?? null;
}

export interface ProviderStatus {
    id: ProviderId;
    display_name: string;
    configured: boolean;
}

export function listProviders(): ProviderStatus[] {
    return ADAPTERS.map((a) => ({
        id: a.id,
        display_name: a.display_name,
        configured: a.isConfigured(),
    }));
}

export function isValidProviderId(id: string): id is ProviderId {
    return BY_ID.has(id as ProviderId);
}
