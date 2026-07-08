/**
 * "Pretplata vam istječe" reminder — daily cron.
 *
 * Stripe already handles renewals + receipts for auto-renewing
 * subscriptions, so this reminder deliberately targets ONLY the cases
 * Stripe does not cover:
 *
 *   • manually assigned tiers (AdminMax / bank transfer) with an
 *     active_tier_until and no Stripe subscription behind them,
 *   • Stripe subscriptions the user has cancelled
 *     (cancel_at_period_end = true → tier ends at the period boundary),
 *   • UMP-inherited tiers with an expiry date.
 *
 * Users whose active Stripe subscription will auto-renew are skipped.
 *
 * Idempotent per (user, expiry date) via the billing_order_emails ledger
 * (key `expiry_reminder:<user>:<until-date>`), so the daily cron sends
 * exactly one reminder per expiry, roughly REMINDER_WINDOW_DAYS before.
 *
 * Triggers:
 *   • POST /adminmax/cron/expiry-reminders   — Cloud Scheduler (daily),
 *                                              guarded by ADMIN_CRON_SECRET
 *   • POST /adminmax/expiry-reminders/send   — manual AdminMax trigger
 *
 * @module expiryReminders
 */
import { query } from "./db";
import { getEmailProvider } from "./email/provider";
import { getStripe, isStripeConfigured } from "./stripe";

const REMINDER_WINDOW_DAYS = 7;

interface ExpiringUser {
    id: string;
    email: string | null;
    display_name: string | null;
    preferred_language: string | null;
    active_tier_until: string;
    stripe_customer_id: string | null;
    tier_label: string | null;
}

/** True when the customer has an active Stripe sub that will auto-renew. */
async function willAutoRenew(stripeCustomerId: string): Promise<boolean> {
    if (!isStripeConfigured()) return false;
    try {
        const subs = await getStripe().subscriptions.list({
            customer: stripeCustomerId,
            status: "all",
            limit: 5,
        });
        return subs.data.some(
            (s) =>
                ["active", "trialing"].includes(s.status) &&
                !s.cancel_at_period_end,
        );
    } catch (err) {
        // On Stripe lookup failure err on the side of NOT mailing — a
        // wrong "your plan expires" to an auto-renewing customer is
        // worse than a missed reminder for an edge case.
        console.warn(
            "[expiryReminders] stripe lookup failed, skipping user:",
            err instanceof Error ? err.message : err,
        );
        return true;
    }
}

/** One reminder per (user, expiry date) — ledger claim, INSERT-once. */
async function claimReminder(userId: string, untilIso: string): Promise<boolean> {
    const key = `expiry_reminder:${userId}:${untilIso.slice(0, 10)}`;
    try {
        const r = await query<{ order_key: string }>(
            `INSERT INTO public.billing_order_emails (order_key, user_id, plan)
             VALUES ($1, $2, 'expiry_reminder')
             ON CONFLICT (order_key) DO NOTHING
             RETURNING order_key`,
            [key, userId],
        );
        return r.rows.length > 0;
    } catch (err) {
        console.error(
            "[expiryReminders] claim failed:",
            err instanceof Error ? err.message : err,
        );
        return false;
    }
}

function frontendBaseUrl(): string {
    return (
        (process.env.FRONTEND_URL ?? "https://max.eulex.ai")
            .split(",")[0]
            .trim()
            .replace(/\/+$/, "")
    );
}

async function sendReminderEmail(u: ExpiringUser): Promise<boolean> {
    const email = u.email?.trim();
    if (!email) return false;
    const lang: "hr" | "en" = u.preferred_language === "hr" ? "hr" : "en";
    const until = new Date(u.active_tier_until);
    const daysLeft = Math.max(
        1,
        Math.ceil((until.getTime() - Date.now()) / (24 * 60 * 60 * 1000)),
    );
    const dateStr = until.toLocaleDateString(lang === "hr" ? "hr-HR" : "en-US", {
        day: "numeric",
        month: "long",
        year: "numeric",
    });
    const plan = u.tier_label ?? "Eulex";
    const base = frontendBaseUrl();
    const L =
        lang === "hr"
            ? {
                  subject: `Vaša ${plan} pretplata istječe ${dateStr}`,
                  hi: `Pozdrav${u.display_name ? ` ${u.display_name}` : ""},`,
                  body: `vaša ${plan} pretplata istječe za ${daysLeft} ${daysLeft === 1 ? "dan" : "dana"} (${dateStr}). Nakon isteka račun prelazi na besplatni paket s manjim dnevnim limitima. Pretplatu možete obnoviti u postavkama računa.`,
                  cta: "Obnovi pretplatu",
              }
            : {
                  subject: `Your ${plan} plan expires on ${dateStr}`,
                  hi: `Hi${u.display_name ? ` ${u.display_name}` : ""},`,
                  body: `your ${plan} plan expires in ${daysLeft} ${daysLeft === 1 ? "day" : "days"} (${dateStr}). After that your account drops to the free tier with lower daily limits. You can renew from your account settings.`,
                  cta: "Renew your plan",
              };
    const html = `<!doctype html><html><body style="font-family:Arial,Helvetica,sans-serif;background:#f8fafc;padding:24px;">
    <div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;padding:28px;">
        <h1 style="font-size:17px;color:#0f172a;margin:0 0 12px;">${L.subject}</h1>
        <p style="font-size:14px;color:#334155;">${L.hi}</p>
        <p style="font-size:14px;color:#334155;">${L.body}</p>
        <p style="margin-top:20px;"><a href="${base}/account?tab=billing" style="display:inline-block;background:#0f172a;color:#ffffff;text-decoration:none;font-size:13px;padding:10px 18px;border-radius:8px;">${L.cta}</a></p>
    </div>
</body></html>`;
    const result = await getEmailProvider().send({
        to: { email, name: u.display_name ?? undefined },
        subject: L.subject,
        html,
        text: `${L.hi}\n\n${L.body}\n\n${base}/account?tab=billing`,
        tags: ["expiry-reminder"],
    });
    if (!result.ok) {
        const reason = "error" in result ? result.error : result.reason;
        console.error(
            `[expiryReminders] send failed for ${email}: ${reason}`,
        );
        return false;
    }
    return true;
}

/**
 * Find tiers expiring within the window and remind whoever Stripe won't
 * renew automatically. Returns counters for the cron response / logs.
 */
export async function sendExpiryReminders(): Promise<{
    ok: true;
    expiring: number;
    skipped_auto_renew: number;
    already_reminded: number;
    sent: number;
}> {
    const expiring = await query<ExpiringUser>(
        `SELECT u.id, u.email, u.display_name, u.preferred_language,
                s.active_tier_until, s.stripe_customer_id,
                tl.display_label AS tier_label
           FROM public.user_tier_state s
           JOIN public.users u ON u.id = s.user_id
           LEFT JOIN public.tier_limits tl
                  ON tl.tier_level_id = s.active_tier_level_id
          WHERE s.active_tier_level_id IS NOT NULL
            AND s.active_tier_until IS NOT NULL
            AND s.active_tier_until > now()
            AND s.active_tier_until <= now() + ($1 || ' days')::interval
          ORDER BY s.active_tier_until ASC`,
        [REMINDER_WINDOW_DAYS],
    );

    let skippedAutoRenew = 0;
    let alreadyReminded = 0;
    let sent = 0;

    for (const u of expiring.rows) {
        if (u.stripe_customer_id && (await willAutoRenew(u.stripe_customer_id))) {
            skippedAutoRenew++;
            continue;
        }
        if (!(await claimReminder(u.id, u.active_tier_until))) {
            alreadyReminded++;
            continue;
        }
        if (await sendReminderEmail(u)) {
            sent++;
            console.log(
                `[expiryReminders] reminded ${u.email} (until=${u.active_tier_until})`,
            );
        }
    }

    console.log(
        `[expiryReminders] expiring=${expiring.rows.length} sent=${sent} auto-renew-skip=${skippedAutoRenew} already=${alreadyReminded}`,
    );
    return {
        ok: true,
        expiring: expiring.rows.length,
        skipped_auto_renew: skippedAutoRenew,
        already_reminded: alreadyReminded,
        sent,
    };
}
