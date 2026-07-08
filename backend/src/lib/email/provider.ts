/**
 * Email provider abstraction.
 *
 * Callsites only depend on `EmailProvider.send()`. The concrete provider
 * (Brevo, Resend, SES, SMTP, noop) is picked once at startup based on
 * env (`EMAIL_PROVIDER`). This keeps the rest of the codebase free of
 * vendor-specific SDK imports and makes swapping providers cheap.
 */

export type EmailAddress = {
    email: string;
    name?: string;
};

export type EmailMessage = {
    to: EmailAddress;
    subject: string;
    html: string;
    /** Plain-text fallback for clients that can't render HTML. */
    text?: string;
    /** Where "Reply" should go — typically the originating user. */
    replyTo?: EmailAddress;
    /** Free-form labels surfaced in the provider's dashboard. */
    tags?: string[];
};

export type EmailSendResult =
    | { ok: true; messageId: string; provider: string }
    | { ok: false; skipped: true; reason: string; provider: string }
    | { ok: false; error: string; provider: string };

export interface EmailProvider {
    /**
     * Implementations MUST NOT throw on transport errors — they map them
     * to `{ ok: false, error }` so the caller can decide whether to
     * rollback the DB row that triggered the send.
     */
    send(msg: EmailMessage): Promise<EmailSendResult>;
    /** Provider slug for logs. */
    readonly name: string;
}

let cached: EmailProvider | null = null;

/**
 * Resolve the active provider. Cached to avoid re-importing SDKs on
 * hot paths (each `POST /chat/:id/share` invitation calls `send()`).
 */
export function getEmailProvider(): EmailProvider {
    if (cached) return cached;
    const slug = (process.env.EMAIL_PROVIDER ?? "brevo").toLowerCase();
    if (slug === "noop" || slug === "console") {
        const { NoopEmailProvider } = require("./noop") as typeof import("./noop");
        cached = new NoopEmailProvider();
    } else {
        // Default: Brevo. Lazy-required to avoid pulling the SDK at
        // startup for noop mode.
        const { BrevoEmailProvider } = require("./brevo") as typeof import("./brevo");
        cached = new BrevoEmailProvider();
    }
    return cached;
}

/** For tests / lifecycle resets. Not used in normal flow. */
export function _resetEmailProviderForTesting(): void {
    cached = null;
}

/**
 * Default sender derived from env. Centralized so the same value lands
 * in every outgoing mail without each callsite reaching into process.env.
 */
export function getDefaultSender(): EmailAddress {
    const email = (process.env.EMAIL_FROM_ADDR ?? "").trim();
    const name = (process.env.EMAIL_FROM_NAME ?? "Eulex Desk").trim() || "Eulex Desk";
    if (!email) {
        // Surfaced as a clear log line on first send instead of crashing
        // boot — local dev often runs without the value set.
        return { email: "noreply@example.invalid", name };
    }
    return { email, name };
}
