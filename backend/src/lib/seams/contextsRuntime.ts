/**
 * Per-turn context loading for chat: which contexts the user has switched
 * on (core-owned prefs/link tables, opaque context ids) resolved into
 * promptable content by the configured context provider
 * (contracts/context-provider.openapi.json).
 *
 * Optional seam: with no CONTEXTS_URL configured every loader returns the
 * empty set — no network calls, no logs, no errors (standalone-core rule).
 * The provider re-checks access per caller on every resolve, so a context
 * attached to a shared workflow/project never widens its own access:
 * inaccessible ids simply resolve 404 and are dropped.
 */
import { query } from "../db";
import { contextsClient, type ContextResolveResult } from "./contextsClient";

/** One resolved context: opaque id + the provider's resolve payload. */
export interface ResolvedContext extends ContextResolveResult {
    id: string;
}

/**
 * Core-owned runtime selection state: per-user toggles and
 * workflow/project attach links, all keyed by opaque context ids.
 */
export interface ContextSelectionStore {
    enabledContextIds(userId: string): Promise<string[]>;
    contextIdsForWorkflow(workflowId: string): Promise<string[]>;
    contextIdsForProject(projectId: string): Promise<string[]>;
}

export const pgContextSelectionStore: ContextSelectionStore = {
    async enabledContextIds(userId) {
        const { rows } = await query<{ context_id: string }>(
            `SELECT context_id FROM public.user_context_prefs
              WHERE user_id = $1 AND enabled = true`,
            [userId],
        );
        return rows.map((r) => r.context_id);
    },
    async contextIdsForWorkflow(workflowId) {
        const { rows } = await query<{ context_id: string }>(
            `SELECT context_id FROM public.context_workflow_links WHERE workflow_id = $1`,
            [workflowId],
        );
        return rows.map((r) => r.context_id);
    },
    async contextIdsForProject(projectId) {
        const { rows } = await query<{ context_id: string }>(
            `SELECT context_id FROM public.context_project_links WHERE project_id = $1`,
            [projectId],
        );
        return rows.map((r) => r.context_id);
    },
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * One-call loader for a chat turn's active contexts: globally-toggled ∪
 * contexts attached to the applied workflow / project, resolved by the
 * configured provider. Owns:
 *  - the no-provider early exit (CONTEXTS_URL unset → [] with zero work);
 *  - the UUID guard on workflowId — built-in workflow-pack ids
 *    ("builtin-…", served by the governance prompt pack) are not UUIDs and
 *    would make the Postgres uuid cast throw, so link lookup skips them;
 *  - per-part fail-soft — each selection read degrades to [] on its own, so
 *    a linked-load error never discards the user's toggled contexts (and
 *    vice versa);
 *  - dedupe + deterministic id sort, so the injected prompt block is
 *    byte-identical across turns for the same active set (prompt-cache
 *    stability);
 *  - dropping every id the provider refuses or fails to resolve.
 * Never rejects — chat must not break on a contexts lookup error.
 */
export async function loadContextsForTurn(params: {
    userId: string;
    email?: string | null;
    /** The turn's user query, forwarded to the provider's resolve. */
    query: string;
    workflowId?: string | null;
    projectId?: string | null;
    store?: ContextSelectionStore;
    client?: Pick<typeof contextsClient, "isConfigured" | "resolve">;
}): Promise<ResolvedContext[]> {
    const client = params.client ?? contextsClient;
    if (!client.isConfigured()) return [];
    const store = params.store ?? pgContextSelectionStore;

    const soft = (p: Promise<string[]>, label: string): Promise<string[]> =>
        p.catch((err) => {
            console.warn(
                `[contexts] ${label} load failed (non-fatal):`,
                err instanceof Error ? err.message : err,
            );
            return [];
        });

    const parts = await Promise.all([
        soft(store.enabledContextIds(params.userId), "toggled"),
        params.workflowId && UUID_RE.test(params.workflowId)
            ? soft(store.contextIdsForWorkflow(params.workflowId), "workflow-linked")
            : Promise.resolve([]),
        params.projectId
            ? soft(store.contextIdsForProject(params.projectId), "project-linked")
            : Promise.resolve([]),
    ]);
    const ids = [...new Set(parts.flat())].sort();
    if (ids.length === 0) return [];

    const resolved = await Promise.all(
        ids.map(async (id): Promise<ResolvedContext | null> => {
            const res = await client.resolve(
                id,
                params.query,
                params.userId,
                null,
                params.email ?? null,
            );
            if (!res.ok) {
                // 404 = deleted or not accessible to this caller — silently
                // dropped by design; anything else is worth a warning.
                if (res.status !== 404) {
                    console.warn(
                        `[contexts] resolve failed for ${id} (non-fatal): ${res.error}`,
                    );
                }
                return null;
            }
            return { id, ...res.data };
        }),
    );
    return resolved.filter((r): r is ResolvedContext => r !== null);
}

/**
 * The system-prompt block for the active contexts. Each resolve response
 * carries one self-contained instruction block (its own scope preamble,
 * sources, pins), so the core just concatenates them in id order — opaque
 * text, deterministic, cache-stable: no timestamps, no randomness,
 * byte-identical across turns for the same active set and context
 * versions. Appended to the STATIC (cache_control'd) system prompt.
 */
export function buildContextsSystemBlock(active: ResolvedContext[]): string {
    return active.map((r) => r.instructions_md).join("");
}
