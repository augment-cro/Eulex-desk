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
import type { SeamResult } from "./types";
import { getContextsHeaderBlock, getContextsFooterBlock } from "./promptPack";
import { buildContextTasksCatalog } from "./contextTasks";
import { resolveModel } from "../llm/models";
import type { ReasoningEffort } from "../llm/types";

/** One resolved context: opaque id + the provider's resolve payload. */
export interface ResolvedContext extends ContextResolveResult {
    id: string;
}

/**
 * Something an active context brings that this turn runs without: a context
 * the provider failed to resolve (anything but 404 — 5xx, timeout, network),
 * or a context document that did not join the turn's documents. Named to the
 * model and shown under the answer, so an assessment never reads as complete
 * without it.
 */
export interface UnavailableContextItem {
    kind: "context" | "document";
    /**
     * A document's source label (else its file name or id). Empty for a
     * context: its name comes with the resolve that failed — the UI names it
     * from the user's own list by `id`.
     */
    name: string;
    /** The context id (kind "context" only). */
    id?: string;
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
 *  - dropping every id the provider refuses or fails to resolve — a refusal
 *    (404: deleted, or not accessible to this caller) silently, any other
 *    failure (5xx, timeout, network) reported to `unavailable`;
 *  - dropping EULEX system contexts when the caller's tier does not grant
 *    them (`systemContexts`), even if a provider resolves them anyway.
 * Never rejects — chat must not break on a contexts lookup error.
 */
export async function loadContextsForTurn(params: {
    userId: string;
    email?: string | null;
    /** The turn's user query, forwarded to the provider's resolve. */
    query: string;
    /** The caller's tier grants EULEX system contexts (entitlement `systemContexts`). */
    systemContexts?: boolean;
    workflowId?: string | null;
    projectId?: string | null;
    store?: ContextSelectionStore;
    client?: Pick<typeof contextsClient, "isConfigured" | "resolve">;
    /** Collects the contexts that failed to resolve (in id order). */
    unavailable?: UnavailableContextItem[];
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
        ids.map(async (id): Promise<ResolvedContext | "failed" | null> => {
            let res: SeamResult<ContextResolveResult>;
            try {
                res = await client.resolve(
                    id,
                    params.query,
                    params.userId,
                    null,
                    params.email ?? null,
                    { systemContexts: params.systemContexts === true },
                );
            } catch (err) {
                res = { ok: false, error: err instanceof Error ? err.message : String(err) };
            }
            if (!res.ok) {
                // 404 = deleted or not accessible to this caller — silently
                // dropped by design; anything else means the turn runs
                // without a context the user switched on.
                if (res.status === 404) return null;
                console.warn(
                    `[contexts] resolve failed for ${id} (non-fatal): ${res.error}`,
                );
                return "failed";
            }
            if (res.data.level === "system" && params.systemContexts !== true) return null;
            return { id, ...res.data };
        }),
    );
    const out: ResolvedContext[] = [];
    resolved.forEach((r, i) => {
        if (r === "failed") params.unavailable?.push({ kind: "context", name: "", id: ids[i] });
        else if (r) out.push(r);
    });
    return out;
}

/** System contexts (EULEX) before personal ones; id order within each. */
export function orderForPrompt(active: ResolvedContext[]): ResolvedContext[] {
    const rank = (r: ResolvedContext) => (r.level === "system" ? 0 : 1);
    return [...active].sort((a, b) => rank(a) - rank(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * The system-prompt block for the active contexts: a precedence header
 * (EULEX safeguards first — governance pack `contexts_header`), each
 * resolve response's self-contained block with system contexts before
 * personal ones, the catalog of their tasks (seams/contextTasks — one line
 * per task, never the steps) and a footer reminder. Opaque text,
 * deterministic, cache-stable: no timestamps, no randomness, byte-identical
 * across turns for the same active set and context versions. Appended to
 * the STATIC (cache_control'd) system prompt. Empty when no context is
 * active.
 */
export function buildContextsSystemBlock(active: ResolvedContext[]): string {
    if (active.length === 0) return "";
    const ordered = orderForPrompt(active);
    const catalog = buildContextTasksCatalog(ordered);
    return (
        `\n\n---\n${getContextsHeaderBlock()}\n` +
        ordered.map((r) => r.instructions_md).join("") +
        (catalog ? `\n${catalog}` : "") +
        `\n${getContextsFooterBlock()}\n---\n`
    );
}

/**
 * The allowlists the core enforces this turn. Scope is enforced only while
 * at least one active context answers STRICTLY (a provider that predates
 * answer modes is treated as strict); the scope is then the union of EVERY
 * active context's allowlist, so an extended context's sources stay
 * reachable next to a strict one. All-extended → no scope enforcement.
 */
export function scopeAllowlistsForTurn(
    active: ResolvedContext[] | undefined,
): (string[] | undefined)[] {
    const list = active ?? [];
    const anyStrict = list.some((r) => r.answer_mode !== "extended");
    return anyStrict ? list.map((r) => r.scope_allowlist) : [];
}

/** URLs of the active contexts' link sources — readable even with web off. */
export function contextSourceUrls(active: ResolvedContext[] | undefined): string[] {
    const out: string[] = [];
    for (const r of active ?? []) for (const s of r.sources ?? []) if (s.url) out.push(s.url);
    return out;
}

const EFFORTS: readonly ReasoningEffort[] = ["low", "medium", "high", "xhigh", "max"];

/** The model and reasoning effort a system context sets for the turn. */
export interface ContextRunSettings {
    contextId: string;
    /** A model id this core knows. */
    model?: string;
    effort?: ReasoningEffort;
}

/**
 * The model and reasoning effort this turn runs on when an active EULEX
 * system context names them; null when none does. Personal contexts never
 * decide the model (the provider sends none for them — this is the second
 * guard). With several system contexts active, the first in prompt order
 * that names either one decides both, so the pair comes from one context.
 * A model id this core does not know is dropped with a warning and the turn
 * keeps its own model.
 */
export function contextRunSettings(active: ResolvedContext[] | undefined): ContextRunSettings | null {
    for (const r of orderForPrompt(active ?? [])) {
        if (r.level !== "system") continue;
        const model = r.model ? resolveModel(r.model, "") : "";
        if (r.model && !model) {
            console.warn(`[contexts] context ${r.id} names a model this core does not know: ${r.model}`);
        }
        const effort = EFFORTS.find((e) => e === r.reasoning_effort);
        if (!model && !effort) continue;
        return { contextId: r.id, ...(model ? { model } : {}), ...(effort ? { effort } : {}) };
    }
    return null;
}

export type ContextsAppliedEvent = {
    type: "contexts_applied";
    contexts: { id: string; name: string; level: "personal" | "system"; version_label?: string }[];
    /** Present when a system context chose them for this answer. */
    model?: string;
    effort?: ReasoningEffort;
    /** What the answer ran without; omitted when everything loaded. */
    unavailable?: UnavailableContextItem[];
};

/**
 * The per-answer record of which contexts took part (shown under the answer;
 * a system context also brings its disclaimer), with the model and effort a
 * system context set for the answer, and what of the active contexts could
 * not be loaded. Null when no context is active and nothing failed.
 */
export function contextsAppliedEvent(
    active: ResolvedContext[] | undefined,
    run: ContextRunSettings | null = null,
    unavailable: UnavailableContextItem[] = [],
): ContextsAppliedEvent | null {
    const list = orderForPrompt(active ?? []);
    if (list.length === 0 && unavailable.length === 0) return null;
    return {
        type: "contexts_applied",
        contexts: list.map((r) => ({
            id: r.id,
            name: r.name ?? "",
            level: r.level === "system" ? "system" : "personal",
            ...(r.version_label ? { version_label: r.version_label } : {}),
        })),
        ...(run?.model ? { model: run.model } : {}),
        ...(run?.effort ? { effort: run.effort } : {}),
        ...(unavailable.length > 0 ? { unavailable } : {}),
    };
}

/**
 * The trusted note telling the model what of the active contexts this turn
 * runs without. Rides the per-turn dynamic system suffix, never the cached
 * contexts block (it appears only when a load fails). Empty when everything
 * loaded.
 */
export function contextsUnavailableNote(unavailable: UnavailableContextItem[] | undefined): string {
    const list = unavailable ?? [];
    if (list.length === 0) return "";
    const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
    const lines = list.map((u) =>
        u.kind === "document"
            ? `- the context document "${oneLine(u.name)}"`
            : `- an active context${u.name ? ` "${oneLine(u.name)}"` : ""} as a whole (its instructions and sources are missing)`,
    );
    return (
        `CONTEXT SOURCES NOT LOADED — these sources of the user's active contexts could not be loaded this turn:\n` +
        `${lines.join("\n")}\n` +
        `Say so in the answer wherever a conclusion depends on them, and do not present such findings as complete.`
    );
}
