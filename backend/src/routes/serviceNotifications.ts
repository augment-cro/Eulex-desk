/**
 * Generic notification intake (design §4.2; contract:
 * contracts/context-provider.openapi.json /notifications).
 *
 * Configured external services (any implementation of the open contract)
 * post { title, body_md?, link?, user_ids[] | context_ref }
 * with a service-identity token; the core stores rows it does not
 * interpret. No consumer UI yet — the badge/digest surface lands with
 * the contexts feature. With no seam secrets configured the route is
 * mounted but every request 401s (standalone-core rule: inert).
 */
import { Router } from "express";
import { verifyInboundServiceToken } from "../lib/seams/serviceIdentity";
import { from } from "../lib/dbShim";

// Type alias (not interface) so rows stay assignable to dbShim's
// Record<string, unknown> insert signature.
export type NotificationRow = {
    user_id: string | null;
    context_ref: string | null;
    title: string;
    body_md: string | null;
    link: string | null;
    source_service: string;
};

type InsertRows = (rows: NotificationRow[]) => Promise<void>;

const UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function defaultInsert(rows: NotificationRow[]): Promise<void> {
    const { error } = await from("service_notifications").insert(rows);
    if (error) throw error;
}

export function createServiceNotificationsRouter(
    insertRows: InsertRows = defaultInsert,
): Router {
    const router = Router();

    router.post("/", async (req, res) => {
        const auth = req.headers.authorization ?? "";
        const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
        const identity = token ? verifyInboundServiceToken(token) : null;
        if (!identity) {
            res.status(401).json({ error: "unauthorized" });
            return;
        }

        const { title, body_md, link, user_ids, context_ref } = (req.body ??
            {}) as Record<string, unknown>;

        if (typeof title !== "string" || !title.trim() || title.length > 500) {
            res.status(400).json({ error: "title required (string, ≤500 chars)" });
            return;
        }
        const ids = Array.isArray(user_ids) ? user_ids.slice(0, 100) : [];
        const hasContextRef = typeof context_ref === "string" && context_ref.trim();
        if (!ids.length && !hasContextRef) {
            res.status(400).json({ error: "user_ids[] or context_ref required" });
            return;
        }
        if (ids.some((id) => typeof id !== "string" || !UUID_RE.test(id))) {
            res.status(400).json({ error: "user_ids must be UUIDs" });
            return;
        }

        const base = {
            context_ref: hasContextRef ? String(context_ref).trim() : null,
            title: title.trim(),
            body_md: typeof body_md === "string" ? body_md : null,
            link: typeof link === "string" ? link : null,
            source_service: identity.service,
        };
        const rows: NotificationRow[] = ids.length
            ? ids.map((id) => ({ ...base, user_id: id as string }))
            : [{ ...base, user_id: null }];

        try {
            await insertRows(rows);
            res.json({ ok: true, inserted: rows.length });
        } catch (err) {
            console.error("[serviceNotifications] insert failed", err);
            res.status(500).json({ error: "insert failed" });
        }
    });

    return router;
}

export default createServiceNotificationsRouter();
