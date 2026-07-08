/**
 * Weekly admin summary email — the UMP "Weekly Summary Email" replacement.
 *
 * Gathers the last 7 days of growth/usage/revenue and mails a compact
 * digest to the ops inbox. Two triggers share this function:
 *
 *   • POST /adminmax/cron/weekly-summary   — Cloud Scheduler, guarded by
 *                                            ADMIN_CRON_SECRET
 *   • POST /adminmax/weekly-summary/send   — manual button in AdminMax
 *
 * Recipient: ADMIN_SUMMARY_EMAIL (default info@eulex.ai). Sent via the
 * shared email provider (Brevo by default) — see lib/email/provider.ts.
 *
 * @module adminSummary
 */
import { query } from "./db";
import { getEmailProvider } from "./email/provider";

const DEFAULT_RECIPIENT = "info@eulex.ai";

function fmtInt(n: number): string {
    return new Intl.NumberFormat("hr-HR").format(n);
}

function fmtEur(cents: number): string {
    return new Intl.NumberFormat("hr-HR", {
        style: "currency",
        currency: "EUR",
    }).format(cents / 100);
}

function fmtUsd(n: number): string {
    return new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
    }).format(n);
}

interface WeeklyStats {
    from: Date;
    to: Date;
    newUsers: number;
    totalUsers: number;
    activeUsers: number;
    requests: number;
    costUsd: number;
    revenueEurCents: number;
    paidUsers: number;
    newUserRows: Array<{ email: string; created_at: string }>;
    topUsers: Array<{ email: string; cost_usd: number; requests: number }>;
}

async function collectWeeklyStats(): Promise<WeeklyStats> {
    const to = new Date();
    const from = new Date(to.getTime() - 7 * 24 * 60 * 60 * 1000);
    const fromIso = from.toISOString();
    const toIso = to.toISOString();

    const [users, usage, revenue, paid, newest, top] = await Promise.all([
        query<{ new_users: string; total_users: string }>(
            `SELECT
                COUNT(*) FILTER (WHERE created_at >= $1)::text AS new_users,
                COUNT(*)::text AS total_users
               FROM public.users`,
            [fromIso],
        ),
        query<{ active_users: string; requests: string; cost_usd: string | null }>(
            `SELECT COUNT(DISTINCT user_id)::text AS active_users,
                    COUNT(*)::text AS requests,
                    COALESCE(SUM(cost_usd), 0) AS cost_usd
               FROM public.llm_usage
              WHERE created_at >= $1 AND created_at < $2`,
            [fromIso, toIso],
        ),
        // Token packs + subscription invoices (billing_revenue) together.
        query<{ revenue_eur_cents: string | null }>(
            `SELECT COALESCE(SUM(cents), 0) AS revenue_eur_cents
               FROM (
                    SELECT amount_eur_cents AS cents
                      FROM public.user_token_credits
                     WHERE granted_at >= $1 AND granted_at < $2
                       AND voided_at IS NULL
                       AND amount_eur_cents IS NOT NULL
                    UNION ALL
                    SELECT amount_cents AS cents
                      FROM public.billing_revenue
                     WHERE paid_at >= $1 AND paid_at < $2
               ) r`,
            [fromIso, toIso],
        ),
        query<{ paid_users: string }>(
            `SELECT COUNT(*)::text AS paid_users
               FROM public.user_tier_state
              WHERE active_tier_level_id IS NOT NULL
                AND (active_tier_until IS NULL OR active_tier_until > now())`,
        ),
        query<{ email: string; created_at: string }>(
            `SELECT email, created_at::text
               FROM public.users
              WHERE created_at >= $1
           ORDER BY created_at DESC
              LIMIT 15`,
            [fromIso],
        ),
        query<{ email: string; cost_usd: string | null; requests: string }>(
            `SELECT u.email,
                    COALESCE(SUM(lu.cost_usd), 0) AS cost_usd,
                    COUNT(*)::text AS requests
               FROM public.llm_usage lu
               JOIN public.users u ON u.id = lu.user_id
              WHERE lu.created_at >= $1 AND lu.created_at < $2
           GROUP BY u.email
           ORDER BY SUM(lu.cost_usd) DESC
              LIMIT 5`,
            [fromIso, toIso],
        ),
    ]);

    return {
        from,
        to,
        newUsers: Number(users.rows[0]?.new_users ?? 0),
        totalUsers: Number(users.rows[0]?.total_users ?? 0),
        activeUsers: Number(usage.rows[0]?.active_users ?? 0),
        requests: Number(usage.rows[0]?.requests ?? 0),
        costUsd: Number(usage.rows[0]?.cost_usd ?? 0),
        revenueEurCents: Number(revenue.rows[0]?.revenue_eur_cents ?? 0),
        paidUsers: Number(paid.rows[0]?.paid_users ?? 0),
        newUserRows: newest.rows,
        topUsers: top.rows.map((r) => ({
            email: r.email,
            cost_usd: Number(r.cost_usd ?? 0),
            requests: Number(r.requests),
        })),
    };
}

function renderHtml(s: WeeklyStats, adminUrl: string): string {
    const period = `${s.from.toLocaleDateString("hr-HR")} – ${s.to.toLocaleDateString("hr-HR")}`;
    const stat = (label: string, value: string) => `
        <td style="padding:12px 16px;border:1px solid #e2e8f0;border-radius:8px;">
            <div style="font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:#64748b;">${label}</div>
            <div style="font-size:20px;font-weight:600;color:#0f172a;margin-top:4px;">${value}</div>
        </td>`;
    const newUserList = s.newUserRows
        .map(
            (u) =>
                `<li style="margin:2px 0;color:#334155;">${u.email} <span style="color:#94a3b8;">(${new Date(u.created_at).toLocaleDateString("hr-HR")})</span></li>`,
        )
        .join("");
    const topList = s.topUsers
        .map(
            (u) =>
                `<li style="margin:2px 0;color:#334155;">${u.email} — ${fmtUsd(u.cost_usd)} · ${fmtInt(u.requests)} zahtjeva</li>`,
        )
        .join("");
    return `<!doctype html><html><body style="font-family:Arial,Helvetica,sans-serif;background:#f8fafc;padding:24px;">
    <div style="max-width:640px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;padding:28px;">
        <h1 style="font-size:18px;color:#0f172a;margin:0 0 4px;">Eulex Desk — tjedni sažetak</h1>
        <p style="color:#64748b;font-size:13px;margin:0 0 20px;">${period}</p>
        <table role="presentation" style="border-collapse:separate;border-spacing:8px;width:100%;">
            <tr>
                ${stat("Novi korisnici", fmtInt(s.newUsers))}
                ${stat("Aktivni korisnici", fmtInt(s.activeUsers))}
                ${stat("Ukupno korisnika", fmtInt(s.totalUsers))}
            </tr>
            <tr>
                ${stat("Zahtjevi", fmtInt(s.requests))}
                ${stat("Trošak (LLM)", fmtUsd(s.costUsd))}
                ${stat("Prihod", fmtEur(s.revenueEurCents))}
            </tr>
            <tr>
                ${stat("Plaćene pretplate", fmtInt(s.paidUsers))}
            </tr>
        </table>
        ${s.newUserRows.length > 0 ? `<h2 style="font-size:14px;color:#0f172a;margin:20px 0 6px;">Najnovije registracije</h2><ul style="font-size:13px;padding-left:18px;margin:0;">${newUserList}</ul>` : ""}
        ${s.topUsers.length > 0 ? `<h2 style="font-size:14px;color:#0f172a;margin:20px 0 6px;">Top korisnici po trošku</h2><ul style="font-size:13px;padding-left:18px;margin:0;">${topList}</ul>` : ""}
        <p style="margin-top:24px;"><a href="${adminUrl}" style="display:inline-block;background:#0f172a;color:#ffffff;text-decoration:none;font-size:13px;padding:10px 18px;border-radius:8px;">Otvori AdminMax</a></p>
    </div>
</body></html>`;
}

function renderText(s: WeeklyStats): string {
    return [
        `Eulex Desk — tjedni sažetak (${s.from.toLocaleDateString("hr-HR")} – ${s.to.toLocaleDateString("hr-HR")})`,
        ``,
        `Novi korisnici: ${fmtInt(s.newUsers)}`,
        `Aktivni korisnici: ${fmtInt(s.activeUsers)}`,
        `Ukupno korisnika: ${fmtInt(s.totalUsers)}`,
        `Zahtjevi: ${fmtInt(s.requests)}`,
        `Trošak (LLM): ${fmtUsd(s.costUsd)}`,
        `Prihod: ${fmtEur(s.revenueEurCents)}`,
        `Plaćene pretplate: ${fmtInt(s.paidUsers)}`,
    ].join("\n");
}

/**
 * Collect + send. Returns the stats so the manual trigger can show them
 * in the AdminMax UI without a second round-trip.
 */
export async function sendWeeklyAdminSummary(): Promise<{
    ok: boolean;
    sent_to: string;
    stats: {
        new_users: number;
        active_users: number;
        total_users: number;
        requests: number;
        cost_usd: number;
        revenue_eur_cents: number;
        paid_users: number;
    };
}> {
    const stats = await collectWeeklyStats();
    const recipient =
        process.env.ADMIN_SUMMARY_EMAIL?.trim() || DEFAULT_RECIPIENT;
    const frontendBase =
        (process.env.FRONTEND_URL ?? "https://max.eulex.ai")
            .split(",")[0]
            .trim()
            .replace(/\/+$/, "");
    const result = await getEmailProvider().send({
        to: { email: recipient, name: "EULEX" },
        subject: `Eulex Desk tjedni sažetak — ${stats.newUsers} novih korisnika, ${fmtEur(stats.revenueEurCents)} prihoda`,
        html: renderHtml(stats, `${frontendBase}/adminmax`),
        text: renderText(stats),
        tags: ["admin-weekly-summary"],
    });
    if (!result.ok) {
        const reason =
            "error" in result ? result.error : result.reason;
        throw new Error(`Weekly summary send failed: ${reason}`);
    }
    console.log(`[adminSummary] weekly summary sent to ${recipient}`);
    return {
        ok: true,
        sent_to: recipient,
        stats: {
            new_users: stats.newUsers,
            active_users: stats.activeUsers,
            total_users: stats.totalUsers,
            requests: stats.requests,
            cost_usd: stats.costUsd,
            revenue_eur_cents: stats.revenueEurCents,
            paid_users: stats.paidUsers,
        },
    };
}
