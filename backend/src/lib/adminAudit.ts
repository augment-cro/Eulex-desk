/**
 * Admin action audit trail — one append-only row in public.admin_audit
 * (migration 133) per mutating /operator/v1/* action or data export.
 *
 * Same contract as recordLlmUsage: fire-and-forget, failures are logged
 * at WARN and swallowed — a broken audit insert must never fail the
 * admin action itself. This is observability, not authorization.
 */
import type { Request, Response } from "express";
import { query } from "./db";

export type AdminAuditInput = {
    /** Dot-namespaced verb, e.g. "user.tier.set", "credits.grant". */
    action: string;
    /** "user" | "tier" | "credit" | "export" | "email" | … */
    targetType?: string | null;
    targetId?: string | null;
    /**
     * Small JSON snapshot of the relevant request values. Keep it to the
     * fields an operator would ask about later (old/new tier, tokens,
     * reason) — never secrets or full document content.
     */
    payload?: Record<string, unknown> | null;
    /**
     * Operator identity: the /operator/v1 caller's declared X-Operator-Actor
     * or service account (auditMeta). Defaults to "adminmax".
     */
    actor?: string;
    ip?: string | null;
};

export async function logAdminAudit(input: AdminAuditInput): Promise<void> {
    const {
        action,
        targetType = null,
        targetId = null,
        payload = null,
        actor = "adminmax",
        ip = null,
    } = input;
    try {
        await query(
            `INSERT INTO public.admin_audit
                (actor, action, target_type, target_id, payload, ip)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [
                actor,
                action,
                targetType,
                targetId,
                payload ? JSON.stringify(payload) : null,
                ip,
            ],
        );
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[admin/audit] insert failed (non-fatal): ${msg}`);
    }
}

/** `ip` + `actor` for logAdminAudit from the current admin request. */
export function auditMeta(
    req: Request,
    res: Response,
): { ip: string | null; actor?: string } {
    const actor = res.locals.adminActor as string | undefined;
    return { ip: req.ip ?? null, ...(actor ? { actor } : {}) };
}
