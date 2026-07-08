import { Router, type Request, type RequestHandler, type Response } from "express";
import { requireAuth } from "../middleware/auth";
import { query } from "../lib/db";
import { contextsClient } from "../lib/seams/contextsClient";
import { safeErrorMessage } from "../lib/safeError";

/**
 * Generic contexts runtime routes — the core-owned state for the optional
 * context provider (CONTEXTS_URL): per-user toggles, workflow/project
 * attach links, and notification badge counts. All context ids are OPAQUE
 * — content, sources, sharing and alert intelligence live behind the
 * provider's own management API, which the frontend calls directly.
 *
 * Standalone posture (no CONTEXTS_URL): every read responds 200 with an
 * empty list and every write responds 404 — no errors, no network calls.
 */

/** Max simultaneously active contexts (mirrored client-side). */
export const MAX_ACTIVE_CONTEXTS = 5;

/** Core-owned runtime state, keyed by opaque context ids. */
export interface ContextsRuntimeStore {
    getPrefs(userId: string): Promise<Map<string, boolean>>;
    setPref(userId: string, contextId: string, enabled: boolean): Promise<void>;
    linkWorkflow(contextId: string, workflowId: string): Promise<void>;
    unlinkWorkflow(contextId: string, workflowId: string): Promise<void>;
    linkProject(contextId: string, projectId: string): Promise<void>;
    unlinkProject(contextId: string, projectId: string): Promise<void>;
    linksForContext(contextId: string): Promise<{ workflows: string[]; projects: string[] }>;
    /** Notification counts per context_ref over the trailing N days. */
    notificationCountsSince(contextIds: string[], days: number): Promise<Map<string, number>>;
}

export const pgContextsRuntimeStore: ContextsRuntimeStore = {
    async getPrefs(userId) {
        const { rows } = await query<{ context_id: string; enabled: boolean }>(
            `SELECT context_id, enabled FROM public.user_context_prefs WHERE user_id = $1`,
            [userId],
        );
        return new Map(rows.map((r) => [r.context_id, r.enabled === true]));
    },
    async setPref(userId, contextId, enabled) {
        await query(
            `INSERT INTO public.user_context_prefs (user_id, context_id, enabled)
             VALUES ($1,$2,$3)
             ON CONFLICT (user_id, context_id)
             DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = now()`,
            [userId, contextId, enabled],
        );
    },
    async linkWorkflow(contextId, workflowId) {
        await query(
            `INSERT INTO public.context_workflow_links (context_id, workflow_id)
             VALUES ($1,$2) ON CONFLICT DO NOTHING`,
            [contextId, workflowId],
        );
    },
    async unlinkWorkflow(contextId, workflowId) {
        await query(
            `DELETE FROM public.context_workflow_links WHERE context_id = $1 AND workflow_id = $2`,
            [contextId, workflowId],
        );
    },
    async linkProject(contextId, projectId) {
        await query(
            `INSERT INTO public.context_project_links (context_id, project_id)
             VALUES ($1,$2) ON CONFLICT DO NOTHING`,
            [contextId, projectId],
        );
    },
    async unlinkProject(contextId, projectId) {
        await query(
            `DELETE FROM public.context_project_links WHERE context_id = $1 AND project_id = $2`,
            [contextId, projectId],
        );
    },
    async linksForContext(contextId) {
        const [wf, pr] = await Promise.all([
            query<{ workflow_id: string }>(
                `SELECT workflow_id FROM public.context_workflow_links WHERE context_id = $1`,
                [contextId],
            ),
            query<{ project_id: string }>(
                `SELECT project_id FROM public.context_project_links WHERE context_id = $1`,
                [contextId],
            ),
        ]);
        return {
            workflows: wf.rows.map((r) => r.workflow_id),
            projects: pr.rows.map((r) => r.project_id),
        };
    },
    async notificationCountsSince(contextIds, days) {
        if (contextIds.length === 0) return new Map();
        const { rows } = await query<{ context_ref: string; count: string }>(
            `SELECT context_ref, count(*) AS count
               FROM public.service_notifications
              WHERE context_ref = ANY($1)
                AND created_at > now() - make_interval(days => $2)
              GROUP BY context_ref`,
            [contextIds, days],
        );
        return new Map(rows.map((r) => [r.context_ref, Number(r.count)]));
    },
};

/** The provider client surface these routes need (injectable for tests). */
export type ProviderClient = Pick<typeof contextsClient, "isConfigured" | "list">;

function handleError(res: Response, err: unknown): void {
    res.status(500).json({ detail: safeErrorMessage(err) });
}

/**
 * Express 4 does not catch async-handler rejections — an unhandled one
 * hangs the request. Every handler below is registered through this
 * wrapper so any rejection lands as a JSON 500.
 */
function wrapAsync(fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler {
    return (req, res) => {
        Promise.resolve(fn(req, res)).catch((err) => handleError(res, err));
    };
}

/**
 * Router factory. `auth` is injectable so route tests can stub the
 * authenticated user; production uses the default `requireAuth`.
 */
export function makeContextsRouter(
    store: ContextsRuntimeStore = pgContextsRuntimeStore,
    auth: RequestHandler = requireAuth,
    client: ProviderClient = contextsClient,
): Router {
    const r = Router();

    /**
     * The caller's visible context ids, per the provider. `null` means the
     * visible set is unknown (provider unreachable) — readers then degrade
     * to unfiltered core state instead of wiping the user's toggles.
     * Unconfigured provider → empty set (feature dormant).
     */
    async function visibleIds(res: Response): Promise<Set<string> | null> {
        if (!client.isConfigured()) return new Set();
        const listed = await client.list(
            res.locals.userId,
            null,
            res.locals.userEmail ?? null,
        );
        if (!listed.ok) return null;
        return new Set(listed.data.map((c) => c.id));
    }

    r.get("/toggles", auth, wrapAsync(async (_req, res) => {
        if (!client.isConfigured()) return void res.json([]);
        const prefs = await store.getPrefs(res.locals.userId);
        const visible = await visibleIds(res);
        const rows = [...prefs.entries()]
            .filter(([id]) => visible === null || visible.has(id))
            .map(([contextId, enabled]) => ({ contextId, enabled }));
        res.json(rows);
    }));

    // Registered before the /:id routes so "alert-counts" is never
    // captured as an id.
    r.get("/alert-counts", auth, wrapAsync(async (_req, res) => {
        const visible = await visibleIds(res);
        if (!visible || visible.size === 0) return void res.json([]);
        const counts = await store.notificationCountsSince([...visible], 14);
        res.json([...counts.entries()].map(([contextId, count]) => ({ contextId, count })));
    }));

    r.put("/toggles/:id", auth, wrapAsync(async (req, res) => {
        const contextId = req.params.id;
        const enabled = !!req.body?.enabled;
        const visible = await visibleIds(res);
        // Only contexts the provider lists for this caller can be toggled;
        // with the provider unreachable, writes fail closed.
        if (!visible?.has(contextId)) {
            return void res.status(404).json({ detail: "Context not found" });
        }
        if (enabled) {
            const prefs = await store.getPrefs(res.locals.userId);
            // Re-enabling an already-enabled context is an idempotent no-op —
            // it must never trip the cap. The cap counts only enabled prefs
            // for contexts the user can still see, so stale prefs (deleted /
            // unshared contexts) don't occupy slots.
            const alreadyOn = prefs.get(contextId) === true;
            const active = [...prefs.entries()].filter(([id, on]) => on && visible.has(id)).length;
            if (!alreadyOn && active >= MAX_ACTIVE_CONTEXTS) {
                return void res.status(400).json({
                    errors: [`At most ${MAX_ACTIVE_CONTEXTS} contexts may be active at once`],
                });
            }
        }
        await store.setPref(res.locals.userId, contextId, enabled);
        res.json({ ok: true });
    }));

    // Attach links: a context attached to a workflow/project joins that
    // run's active set. Attaching requires the context to be visible to the
    // requester; runtime access is re-checked per requester by the
    // provider's resolve, so attaching never widens access.
    async function requireVisible(req: Request, res: Response): Promise<boolean> {
        const visible = await visibleIds(res);
        if (visible?.has(req.params.id)) return true;
        res.status(404).json({ detail: "Context not found" });
        return false;
    }

    r.post("/:id/workflows/:workflowId", auth, wrapAsync(async (req, res) => {
        if (!(await requireVisible(req, res))) return;
        await store.linkWorkflow(req.params.id, req.params.workflowId);
        res.status(201).json({ ok: true });
    }));
    r.delete("/:id/workflows/:workflowId", auth, wrapAsync(async (req, res) => {
        if (!(await requireVisible(req, res))) return;
        await store.unlinkWorkflow(req.params.id, req.params.workflowId);
        res.status(204).send();
    }));
    r.post("/:id/projects/:projectId", auth, wrapAsync(async (req, res) => {
        if (!(await requireVisible(req, res))) return;
        await store.linkProject(req.params.id, req.params.projectId);
        res.status(201).json({ ok: true });
    }));
    r.delete("/:id/projects/:projectId", auth, wrapAsync(async (req, res) => {
        if (!(await requireVisible(req, res))) return;
        await store.unlinkProject(req.params.id, req.params.projectId);
        res.status(204).send();
    }));
    r.get("/:id/links", auth, wrapAsync(async (req, res) => {
        if (!(await requireVisible(req, res))) return;
        res.json(await store.linksForContext(req.params.id));
    }));

    return r;
}

export const contextsRouter = makeContextsRouter();
