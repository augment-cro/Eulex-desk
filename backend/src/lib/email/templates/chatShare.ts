/**
 * Chat-share invitation email.
 *
 * Producer-only: returns `{ subject, html, text }` strings; the provider
 * is responsible for actually shipping the bytes. We intentionally keep
 * the HTML simple and inline-styled — many mail clients (Outlook
 * desktop in particular) strip <style> blocks, and table-based layouts
 * survive better than divs with classes.
 *
 * Localization follows `users.preferred_language` (migration 106).
 * Unknown languages fall back to English.
 */

export type ChatShareEmailInput = {
    ownerName: string;
    ownerEmail: string;
    chatTitle: string | null;
    shareUrl: string;
    expiresAt: Date;
    /** 'hr' | 'en' (any other value falls back to en) */
    lang?: string | null;
};

export type RenderedEmail = {
    subject: string;
    html: string;
    text: string;
};

function escapeHtml(s: string): string {
    return s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function formatDate(d: Date, lang: "hr" | "en"): string {
    try {
        return new Intl.DateTimeFormat(lang === "hr" ? "hr-HR" : "en-US", {
            day: "numeric",
            month: "long",
            year: "numeric",
        }).format(d);
    } catch {
        return d.toISOString().slice(0, 10);
    }
}

const COPY = {
    hr: {
        subject: (owner: string, title: string) =>
            `${owner} dijeli razgovor s tobom: "${title}"`,
        greeting: "Pozdrav,",
        intro: (owner: string, ownerEmail: string, title: string) =>
            `${owner} (${ownerEmail}) podijelio/la je s tobom razgovor "${title}" iz Eulex Desk asistenta.`,
        whatYouSee:
            "Klikom na gumb otvaraš sigurnu kopiju razgovora (snapshot). Ako se želiš pridružiti razgovoru i nastaviti ga, dovoljno je da se prijaviš s ovom email adresom.",
        cta: "Otvori razgovor",
        expires: (d: string) => `Poveznica vrijedi do ${d}.`,
        footer:
            "Ako nisi očekivao/la ovu poruku, slobodno je zanemari — poveznica je vezana isključivo za tvoju email adresu.",
        productName: "Eulex Desk",
    },
    en: {
        subject: (owner: string, title: string) =>
            `${owner} shared a conversation with you: "${title}"`,
        greeting: "Hi,",
        intro: (owner: string, ownerEmail: string, title: string) =>
            `${owner} (${ownerEmail}) shared the conversation "${title}" from Eulex Desk Assistant with you.`,
        whatYouSee:
            "Click the button below to open a secure snapshot of the conversation. To continue the conversation together, just sign in using this email address.",
        cta: "Open conversation",
        expires: (d: string) => `This link is valid until ${d}.`,
        footer:
            "If you weren't expecting this email, you can ignore it — the link is bound to your email address only.",
        productName: "Eulex Desk",
    },
} as const;

export function renderChatShareEmail(input: ChatShareEmailInput): RenderedEmail {
    const lang: "hr" | "en" = input.lang === "hr" ? "hr" : "en";
    const t = COPY[lang];

    const safeTitle = input.chatTitle?.trim() || (lang === "hr" ? "Razgovor" : "Conversation");
    const ownerDisplay = input.ownerName?.trim() || input.ownerEmail;

    const subject = t.subject(ownerDisplay, safeTitle);
    const expiresStr = t.expires(formatDate(input.expiresAt, lang));

    const html = `<!DOCTYPE html>
<html lang="${lang}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${escapeHtml(subject)}</title>
</head>
<body style="margin:0;padding:0;background:#f6f7f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#111827;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f7f9;padding:32px 12px;">
  <tr>
    <td align="center">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#ffffff;border:1px solid #e5e7eb;border-radius:16px;overflow:hidden;">
        <tr>
          <td style="padding:28px 32px 8px 32px;">
            <div style="font-size:14px;color:#6b7280;letter-spacing:0.04em;text-transform:uppercase;">${escapeHtml(t.productName)}</div>
            <h1 style="margin:8px 0 0 0;font-family:'EB Garamond',Georgia,'Times New Roman',serif;font-weight:400;font-size:26px;line-height:1.25;color:#111827;">
              ${escapeHtml(safeTitle)}
            </h1>
          </td>
        </tr>
        <tr>
          <td style="padding:8px 32px 16px 32px;font-size:15px;line-height:1.55;color:#374151;">
            <p style="margin:16px 0 0 0;">${escapeHtml(t.greeting)}</p>
            <p style="margin:12px 0 0 0;">${escapeHtml(t.intro(ownerDisplay, input.ownerEmail, safeTitle))}</p>
            <p style="margin:12px 0 0 0;">${escapeHtml(t.whatYouSee)}</p>
          </td>
        </tr>
        <tr>
          <td style="padding:8px 32px 24px 32px;">
            <table role="presentation" cellpadding="0" cellspacing="0">
              <tr>
                <td bgcolor="#111827" style="border-radius:10px;">
                  <a href="${escapeHtml(input.shareUrl)}"
                     style="display:inline-block;padding:12px 22px;font-size:15px;font-weight:500;color:#ffffff;text-decoration:none;border-radius:10px;background:#111827;">
                    ${escapeHtml(t.cta)} →
                  </a>
                </td>
              </tr>
            </table>
            <p style="margin:18px 0 0 0;font-size:13px;color:#6b7280;">${escapeHtml(expiresStr)}</p>
          </td>
        </tr>
        <tr>
          <td style="padding:0 32px 24px 32px;">
            <hr style="border:none;border-top:1px solid #e5e7eb;margin:0 0 16px 0;" />
            <p style="margin:0;font-size:12px;line-height:1.6;color:#9ca3af;">
              ${escapeHtml(t.footer)}
            </p>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;

    const text = [
        t.greeting,
        "",
        t.intro(ownerDisplay, input.ownerEmail, safeTitle),
        "",
        t.whatYouSee,
        "",
        `${t.cta}: ${input.shareUrl}`,
        "",
        expiresStr,
        "",
        t.footer,
    ].join("\n");

    return { subject, html, text };
}
