/**
 * Context-alert digest — the END of the "alert me when a source changes"
 * chain (plan 2026-08-29-context-alerts-e2e, closes Plan 4).
 *
 * contexts-service posts one notification per (context, change batch) into
 * public.service_notifications (source_service='contexts', user_id=owner).
 * This sweep groups un-emailed rows per user, sends ONE hr/en digest, and
 * claims each row in the billing_order_emails ledger (key
 * `context_alert:<notification_id>`) only after a successful send —
 * at-least-once, same discipline as expiry reminders.
 *
 * Owner-only in v1: share recipients arrive with user_id = NULL and are
 * left for the share fan-out follow-up.
 */
import { query } from "./db";
import { getEmailProvider, type EmailMessage, type EmailSendResult } from "./email/provider";
import { renderContextAlertDigestEmail } from "./email/templates/contextAlertDigest";

export type PendingRow = {
    id: string;
    user_id: string;
    title: string;
    body_md: string | null;
    link: string | null;
    created_at: string;
    email: string | null;
    display_name: string | null;
    preferred_language: string | null;
};

export type DigestDeps = {
    fetchPending: () => Promise<PendingRow[]>;
    claim: (notificationId: string, userId: string) => Promise<boolean>;
    send: (msg: EmailMessage) => Promise<EmailSendResult>;
    baseUrl: () => string;
};

async function defaultFetchPending(): Promise<PendingRow[]> {
    const r = await query<PendingRow>(
        `SELECT n.id::text AS id, n.user_id::text AS user_id, n.title, n.body_md, n.link,
                n.created_at::text AS created_at, u.email, u.display_name, p.preferred_language
           FROM public.service_notifications n
           JOIN public.users u ON u.id = n.user_id
           LEFT JOIN public.user_profiles p ON p.user_id = u.id
          WHERE n.source_service = 'contexts'
            AND n.user_id IS NOT NULL
            AND n.created_at >= now() - interval '7 days'
            AND NOT EXISTS (
                SELECT 1 FROM public.billing_order_emails b
                 WHERE b.order_key = 'context_alert:' || n.id::text)
       ORDER BY n.user_id, n.created_at DESC
          LIMIT 2000`,
    );
    return r.rows;
}

async function defaultClaim(notificationId: string, userId: string): Promise<boolean> {
    try {
        const r = await query<{ order_key: string }>(
            `INSERT INTO public.billing_order_emails (order_key, user_id, plan)
             VALUES ($1, $2, 'context_alert')
             ON CONFLICT (order_key) DO NOTHING
             RETURNING order_key`,
            [`context_alert:${notificationId}`, userId],
        );
        return r.rows.length > 0;
    } catch (err) {
        console.error("[contextAlertDigest] claim failed:", err instanceof Error ? err.message : err);
        return false;
    }
}

function defaultBaseUrl(): string {
    return (process.env.FRONTEND_URL ?? "https://max.eulex.ai").split(",")[0].trim().replace(/\/+$/, "");
}

export const defaultDigestDeps: DigestDeps = {
    fetchPending: defaultFetchPending,
    claim: defaultClaim,
    send: (msg) => getEmailProvider().send(msg),
    baseUrl: defaultBaseUrl,
};

export type DigestResult = {
    ok: true;
    pending: number;
    recipients: number;
    sent: number;
    skipped_no_email: number;
    failed: number;
    claimed: number;
};

export async function sendContextAlertDigests(deps: DigestDeps = defaultDigestDeps): Promise<DigestResult> {
    const rows = await deps.fetchPending();
    const byUser = new Map<string, PendingRow[]>();
    for (const r of rows) {
        const list = byUser.get(r.user_id) ?? [];
        list.push(r);
        byUser.set(r.user_id, list);
    }
    const result: DigestResult = { ok: true, pending: rows.length, recipients: byUser.size, sent: 0, skipped_no_email: 0, failed: 0, claimed: 0 };
    const base = deps.baseUrl();
    for (const [userId, items] of byUser) {
        const email = items[0].email?.trim();
        if (!email) { result.skipped_no_email++; continue; }
        const lang: "hr" | "en" = items[0].preferred_language === "hr" ? "hr" : "en";
        const rendered = renderContextAlertDigestEmail({
            lang,
            displayName: items[0].display_name,
            baseUrl: base,
            items: items.map((it) => ({ title: it.title, body_md: it.body_md, link: it.link, created_at: it.created_at })),
        });
        const sendResult = await deps.send({
            to: { email, name: items[0].display_name ?? undefined },
            subject: rendered.subject,
            html: rendered.html,
            text: rendered.text,
            tags: ["context-alert-digest"],
        });
        if (!sendResult.ok) {
            const reason = "error" in sendResult ? sendResult.error : sendResult.reason;
            console.error(`[contextAlertDigest] send failed for ${email}: ${reason}`);
            result.failed++;
            continue;
        }
        result.sent++;
        for (const it of items) if (await deps.claim(it.id, userId)) result.claimed++;
    }
    return result;
}
