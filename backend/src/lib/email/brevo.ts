/**
 * Brevo (formerly Sendinblue) transactional email backend.
 *
 * Uses `@getbrevo/brevo` v5+: `BrevoClient.transactionalEmails.sendTransacEmail`.
 * Picks up `BREVO_API_KEY` from env. If the key is missing we deliberately
 * do NOT throw at startup — the share router callsite will get a
 * `{ ok: false, skipped: true }` result and roll back the DB invite,
 * which is friendlier in dev than a hard crash on the first share.
 */

import type {
    EmailMessage,
    EmailProvider,
    EmailSendResult,
} from "./provider";
import { getDefaultSender } from "./provider";

type BrevoSdk = typeof import("@getbrevo/brevo");
type BrevoClientInstance = InstanceType<BrevoSdk["BrevoClient"]>;

export class BrevoEmailProvider implements EmailProvider {
    readonly name = "brevo";
    private client: BrevoClientInstance | null = null;
    private warnedMissingKey = false;

    private getClient(): BrevoClientInstance | null {
        if (this.client) return this.client;
        const apiKey = (process.env.BREVO_API_KEY ?? "").trim();
        if (!apiKey) {
            if (!this.warnedMissingKey) {
                console.warn(
                    "[email/brevo] BREVO_API_KEY is not set — emails will be skipped",
                );
                this.warnedMissingKey = true;
            }
            return null;
        }
        // Lazy require so the dist isn't loaded when EMAIL_PROVIDER=noop.
        const { BrevoClient } = require("@getbrevo/brevo") as BrevoSdk;
        this.client = new BrevoClient({ apiKey });
        return this.client;
    }

    async send(msg: EmailMessage): Promise<EmailSendResult> {
        const client = this.getClient();
        if (!client) {
            return {
                ok: false,
                skipped: true,
                reason: "BREVO_API_KEY not configured",
                provider: this.name,
            };
        }

        const sender = getDefaultSender();
        try {
            const result = await client.transactionalEmails.sendTransacEmail({
                sender,
                to: [{ email: msg.to.email, name: msg.to.name }],
                subject: msg.subject,
                htmlContent: msg.html,
                textContent: msg.text,
                replyTo: msg.replyTo
                    ? { email: msg.replyTo.email, name: msg.replyTo.name }
                    : undefined,
                tags: msg.tags,
            });
            const messageId =
                (result as { messageId?: string } | undefined)?.messageId ??
                "unknown";
            return { ok: true, messageId, provider: this.name };
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            // Brevo SDK throws typed errors (UnauthorizedError, etc.) but
            // we don't want to leak SDK types into callers. Log the
            // status code if present so Cloud Logging is searchable.
            const status =
                typeof (err as { statusCode?: number })?.statusCode === "number"
                    ? (err as { statusCode: number }).statusCode
                    : null;
            console.error(
                `[email/brevo] send failed${status ? ` (${status})` : ""}: ${message}`,
            );
            return {
                ok: false,
                error: status
                    ? `Brevo ${status}: ${message}`
                    : `Brevo: ${message}`,
                provider: this.name,
            };
        }
    }
}
