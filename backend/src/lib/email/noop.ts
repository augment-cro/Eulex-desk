/**
 * Console-only email provider for local dev / CI where no real provider
 * is configured. Logs the message instead of shipping it, returns a
 * fake messageId so callers proceed as if it had been delivered.
 *
 * Activate via `EMAIL_PROVIDER=noop` in .env.
 */

import type {
    EmailMessage,
    EmailProvider,
    EmailSendResult,
} from "./provider";

export class NoopEmailProvider implements EmailProvider {
    readonly name = "noop";

    async send(msg: EmailMessage): Promise<EmailSendResult> {
        console.log("[email/noop] would send:", {
            to: msg.to,
            subject: msg.subject,
            replyTo: msg.replyTo,
            tags: msg.tags,
            preview: msg.text?.slice(0, 240) ?? msg.html.slice(0, 240),
        });
        return {
            ok: true,
            messageId: `noop-${Date.now()}`,
            provider: this.name,
        };
    }
}
