/**
 * Workspace audit trail — one append-only row in public.audit_events
 * (migration 208) per user-visible workspace action: chat turns, document
 * uploads/new versions, review creation/runs, exports, sharing changes,
 * edit accept/reject. Issue-tracker #27.
 *
 * Same contract as lib/adminAudit.ts (the operator-side twin): pure
 * fire-and-forget. recordAuditEvent NEVER throws and NEVER rejects —
 * every failure (bad metadata, DB down, schema missing) is logged at
 * WARN and swallowed. Call it un-awaited on the request path
 * (`void recordAuditEvent({ … })`) so it can never delay or break a
 * response, and never as a bare await before an SSE stream starts
 * (Express 4 drops rejections from async handlers). This is
 * observability, not authorization.
 *
 * Metadata stays PII-lean by convention: ids and enums only (model name,
 * version number, counts, flags) — never document text, message content,
 * filenames, or e-mail addresses.
 */
import { query } from "./db";

export type AuditEventInput = {
    /** The acting user (public.users.id). */
    userId: string;
    /**
     * Dot-namespaced noun.verb, e.g. "chat.turn_completed",
     * "document.uploaded", "review.run_started".
     */
    eventType: string;
    projectId?: string | null;
    documentId?: string | null;
    reviewId?: string | null;
    chatId?: string | null;
    /** Small JSON snapshot — ids and enums, never content or emails. */
    metadata?: Record<string, unknown> | null;
    /** Client surface: web | word | tabular | draft | workflow | search | title. */
    surface?: string | null;
};

export async function recordAuditEvent(input: AuditEventInput): Promise<void> {
    try {
        const {
            userId,
            eventType,
            projectId = null,
            documentId = null,
            reviewId = null,
            chatId = null,
            metadata = null,
            surface = null,
        } = input;
        await query(
            `INSERT INTO public.audit_events
                (user_id, event_type, project_id, document_id, review_id, chat_id, metadata, surface)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [
                userId,
                eventType,
                projectId,
                documentId,
                reviewId,
                chatId,
                metadata ? JSON.stringify(metadata) : null,
                surface,
            ],
        );
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[audit] insert failed (non-fatal): ${msg}`);
    }
}

/**
 * Stable feature keys for first-use tracking (migration 210). Keep in sync
 * with the admin MCP feature catalog.
 */
export type FeatureKey =
    | "assistant"
    | "projects"
    | "document"
    | "tabular"
    | "workflow"
    | "contexts"
    | "word"
    | "pii"
    | "search"
    | "team"
    | "checkout";

/**
 * Record that a user used a feature. Cheap idempotent upsert into
 * public.user_feature_first_use; the FIRST time (race-safe via xmax = 0)
 * it also emits a `feature.first_used` audit event — the activation
 * milestones the growth model needs. Fire-and-forget like recordAuditEvent:
 * never throws, never rejects. Call un-awaited.
 */
export async function recordFeatureUse(input: {
    userId: string;
    feature: FeatureKey;
    surface?: string | null;
    projectId?: string | null;
}): Promise<void> {
    try {
        const { rows } = await query<{ inserted: boolean }>(
            `INSERT INTO public.user_feature_first_use (user_id, feature, surface)
             VALUES ($1, $2, $3)
             ON CONFLICT (user_id, feature) DO NOTHING
             RETURNING (xmax = 0) AS inserted`,
            [input.userId, input.feature, input.surface ?? null],
        );
        if (rows.length > 0 && rows[0].inserted) {
            await recordAuditEvent({
                userId: input.userId,
                eventType: "feature.first_used",
                projectId: input.projectId ?? null,
                surface: input.surface ?? null,
                metadata: { feature: input.feature },
            });
        }
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[audit] feature-use upsert failed (non-fatal): ${msg}`);
    }
}
