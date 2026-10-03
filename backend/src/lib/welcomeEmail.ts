/**
 * Welcome e-mail after registration — sent exactly once per user.
 *
 * Trigger: the Supabase auth path in middleware/auth.ts, on the request
 * whose upsert genuinely INSERTED the public.users row (`xmax = 0`). That
 * guard already fires once per user; the billing_order_emails ledger
 * (key `welcome:<userId>`, same discipline as order confirmations and
 * expiry reminders) makes the send idempotent on top of it, so a retry or
 * a second trigger path can never produce a second welcome.
 *
 * Claim-first, then send: a failed send is logged and NOT retried (no
 * cron owns this mail), which is the safer failure mode for a welcome —
 * one missing mail beats a duplicate. Never throws; safe to await inside
 * auth. `sendWelcomeEmailBounded` caps how long auth waits — Cloud Run
 * throttles CPU outside a request, so a detached (fire-and-forget) send
 * could stall until the next request; awaiting keeps the send on request
 * CPU while the bound keeps the first authenticated request snappy.
 *
 * The legacy WordPress path in auth.ts deliberately does NOT send this:
 * eulex.ai no longer registers users (decision 2026-08-03, tracker #37),
 * and its "new user" branch also fires for e-mail-linked existing accounts.
 */
import type { Request } from "express";
import { query } from "./db";
import {
    getEmailProvider,
    type EmailAddress,
    type EmailMessage,
    type EmailSendResult,
} from "./email/provider";
import {
    renderWelcomeEmail,
    type WelcomeLang,
} from "./email/templates/welcome";

/** Replies land with the team, same address the order confirmation uses. */
export const WELCOME_REPLY_TO: EmailAddress = { email: "info@eulex.ai", name: "EULEX" };

/** How long auth waits for the send before moving on (send continues). */
export const WELCOME_EMAIL_MAX_WAIT_MS = 4_000;

export type WelcomeEmailInput = {
    userId: string;
    email: string;
    displayName?: string | null;
    lang: WelcomeLang;
    /** true → the mail mentions the free plan + daily limit. */
    freeTier: boolean;
};

export type WelcomeDeps = {
    /** Ledger claim — true exactly once per user. */
    claim: (userId: string) => Promise<boolean>;
    send: (msg: EmailMessage) => Promise<EmailSendResult>;
    /** Frontend base URL, e.g. https://max.eulex.ai */
    baseUrl: () => string;
};

export type WelcomeSendResult =
    | { status: "sent"; messageId: string }
    | { status: "already_sent" }
    | { status: "skipped"; reason: string }
    | { status: "failed"; reason: string }
    /** Bounded wait elapsed; the send is still running in the background. */
    | { status: "pending" };

async function defaultClaim(userId: string): Promise<boolean> {
    try {
        const r = await query<{ order_key: string }>(
            `INSERT INTO public.billing_order_emails (order_key, user_id, plan)
             VALUES ($1, $2, 'welcome')
             ON CONFLICT (order_key) DO NOTHING
             RETURNING order_key`,
            [`welcome:${userId}`, userId],
        );
        return r.rows.length > 0;
    } catch (err) {
        // Ledger down → prefer a missed welcome over a possible duplicate.
        console.error(
            "[welcomeEmail] claim failed:",
            err instanceof Error ? err.message : err,
        );
        return false;
    }
}

function defaultBaseUrl(): string {
    // FRONTEND_URL is a comma-separated CORS-origins list; the first entry
    // is the public domain (same rule as every other mail link builder).
    return (process.env.FRONTEND_URL ?? "https://max.eulex.ai")
        .split(",")[0]
        .trim()
        .replace(/\/+$/, "");
}

export const defaultWelcomeDeps: WelcomeDeps = {
    claim: defaultClaim,
    send: (msg) => getEmailProvider().send(msg),
    baseUrl: defaultBaseUrl,
};

/**
 * Language for the welcome mail = the UI language at signup, read off the
 * X-UI-Locale header the web app sends on every request ("hr-HR" → hr).
 * Unlike parseUiLocale (LLM output, defaults to en) this defaults to hr —
 * the product default and what user_profiles.preferred_language starts as.
 */
export function welcomeLocaleFromRequest(req: Pick<Request, "headers">): WelcomeLang {
    const raw = req.headers["x-ui-locale"];
    const v = Array.isArray(raw) ? raw[0] : raw;
    const base = (v ?? "").trim().toLowerCase().split("-")[0];
    return base === "en" ? "en" : "hr";
}

function isPlausibleEmail(email: string): boolean {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/** Never throws. */
export async function sendWelcomeEmail(
    input: WelcomeEmailInput,
    deps: WelcomeDeps = defaultWelcomeDeps,
): Promise<WelcomeSendResult> {
    try {
        const email = (input.email ?? "").trim();
        if (!isPlausibleEmail(email)) {
            console.warn(`[welcomeEmail] skipped user=${input.userId}: invalid email`);
            return { status: "skipped", reason: "invalid email" };
        }
        if (!(await deps.claim(input.userId))) {
            return { status: "already_sent" };
        }
        const name = input.displayName?.trim() || null;
        const baseUrl = deps.baseUrl();
        const rendered = renderWelcomeEmail({
            email,
            displayName: name,
            lang: input.lang,
            freeTier: input.freeTier,
            ctaUrl: `${baseUrl}/assistant`,
            assetBaseUrl: baseUrl,
        });
        const result = await deps.send({
            to: { email, name: name ?? undefined },
            subject: rendered.subject,
            html: rendered.html,
            text: rendered.text,
            replyTo: WELCOME_REPLY_TO,
            tags: ["welcome"],
        });
        if (!result.ok) {
            if ("skipped" in result) {
                console.warn(`[welcomeEmail] skipped for ${email}: ${result.reason}`);
                return { status: "skipped", reason: result.reason };
            }
            console.error(`[welcomeEmail] send failed for ${email}: ${result.error}`);
            return { status: "failed", reason: result.error };
        }
        console.log(`[welcomeEmail] sent to ${email} (${input.lang}, ${result.provider})`);
        return { status: "sent", messageId: result.messageId };
    } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        console.error(`[welcomeEmail] threw for user=${input.userId}: ${reason}`);
        return { status: "failed", reason };
    }
}

/**
 * `sendWelcomeEmail`, but the caller waits at most `maxWaitMs`. Past the
 * bound the send keeps running (its own logging covers the outcome) and
 * the caller gets `{ status: "pending" }`. Never throws.
 */
export async function sendWelcomeEmailBounded(
    input: WelcomeEmailInput,
    maxWaitMs: number = WELCOME_EMAIL_MAX_WAIT_MS,
    deps: WelcomeDeps = defaultWelcomeDeps,
): Promise<WelcomeSendResult> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<WelcomeSendResult>((resolve) => {
        timer = setTimeout(() => resolve({ status: "pending" }), maxWaitMs);
        timer.unref?.();
    });
    const work = sendWelcomeEmail(input, deps).finally(() => {
        if (timer) clearTimeout(timer);
    });
    const result = await Promise.race([work, timeout]);
    if (result.status === "pending") {
        console.warn(
            `[welcomeEmail] still sending after ${maxWaitMs} ms for user=${input.userId} — continuing in background`,
        );
    }
    return result;
}
