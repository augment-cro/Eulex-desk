/**
 * Order-confirmation email (Stripe success).
 *
 * Producer-only: returns `{ subject, html, text }`; the caller ships it.
 * Sent on a successful Stripe order to TWO recipients:
 *   - the customer  (audience: "customer") — "thanks, your plan is active"
 *   - info@eulex.ai (audience: "admin")     — internal "new order" notice
 *
 * Design is deliberately identical to the chat-share invite
 * (templates/chatShare.ts): 560px white card, inline styles, table layout
 * (Outlook-safe), EB Garamond heading, dark CTA button. Reuse — not a new
 * look — so all Eulex Desk emails feel like one product.
 */

export type OrderAudience = "customer" | "admin";

export type OrderConfirmationInput = {
    audience: OrderAudience;
    /** Customer email — shown to admin, used in the customer greeting context. */
    customerEmail: string;
    customerName?: string | null;
    /** Human plan name, e.g. "Eulex Plus", "Pro", "Token paket (1.000.000)". */
    planName: string;
    /** Receipt-style extra lines (renewal date, amount, seats…). */
    detailLines?: string[];
    /** CTA target — the app for the customer, adminmax for the team. */
    ctaUrl: string;
    /** 'hr' | 'en' (any other value falls back to en). Admin copy is hr. */
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

const COPY = {
    hr: {
        customerSubject: (plan: string) => `Vaša narudžba je potvrđena — ${plan}`,
        adminSubject: (plan: string, email: string) =>
            `Nova narudžba: ${plan} — ${email}`,
        eyebrow: "Eulex Desk",
        customerTitle: "Narudžba potvrđena",
        adminTitle: "Nova narudžba",
        greeting: "Pozdrav,",
        customerIntro: (plan: string) =>
            `Hvala na narudžbi. Vaš plan „${plan}" je aktiviran i spreman za korištenje.`,
        adminIntro: (plan: string, email: string) =>
            `Zaprimljena je nova narudžba na Eulex Desku: „${plan}" — kupac ${email}.`,
        detailsHeading: "Detalji",
        customerCta: "Otvori Eulex Desk",
        adminCta: "Otvori adminmax",
        customerFooter:
            "Ako imate pitanja o naplati, odgovorite na ovaj email — javit ćemo se.",
        adminFooter: "Automatska obavijest o narudžbi.",
    },
    en: {
        customerSubject: (plan: string) => `Your order is confirmed — ${plan}`,
        adminSubject: (plan: string, email: string) =>
            `New order: ${plan} — ${email}`,
        eyebrow: "Eulex Desk",
        customerTitle: "Order confirmed",
        adminTitle: "New order",
        greeting: "Hi,",
        customerIntro: (plan: string) =>
            `Thanks for your order. Your "${plan}" plan is active and ready to use.`,
        adminIntro: (plan: string, email: string) =>
            `A new order was placed on Eulex Desk: "${plan}" — customer ${email}.`,
        detailsHeading: "Details",
        customerCta: "Open Eulex Desk",
        adminCta: "Open adminmax",
        customerFooter:
            "Questions about billing? Just reply to this email and we'll help.",
        adminFooter: "Automated order notification.",
    },
} as const;

export function renderOrderConfirmationEmail(
    input: OrderConfirmationInput,
): RenderedEmail {
    const isAdmin = input.audience === "admin";
    // Admin copy is always Croatian (internal); customer copy follows lang.
    const lang: "hr" | "en" = isAdmin
        ? "hr"
        : input.lang === "hr"
          ? "hr"
          : "en";
    const t = COPY[lang];

    const plan = input.planName.trim() || (lang === "hr" ? "Plan" : "Plan");
    const subject = isAdmin
        ? t.adminSubject(plan, input.customerEmail)
        : t.customerSubject(plan);
    const title = isAdmin ? t.adminTitle : t.customerTitle;
    const intro = isAdmin
        ? t.adminIntro(plan, input.customerEmail)
        : t.customerIntro(plan);
    const ctaLabel = isAdmin ? t.adminCta : t.customerCta;
    const footer = isAdmin ? t.adminFooter : t.customerFooter;

    const details = (input.detailLines ?? []).filter((l) => l && l.trim());
    const detailsHtml = details.length
        ? `        <tr>
          <td style="padding:4px 32px 8px 32px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e5e7eb;border-radius:10px;">
              <tr><td style="padding:14px 16px;font-size:14px;line-height:1.7;color:#374151;">
                <div style="font-size:12px;color:#6b7280;letter-spacing:0.04em;text-transform:uppercase;margin-bottom:6px;">${escapeHtml(t.detailsHeading)}</div>
                ${details.map((l) => escapeHtml(l)).join("<br />")}
              </td></tr>
            </table>
          </td>
        </tr>
`
        : "";

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
            <div style="font-size:14px;color:#6b7280;letter-spacing:0.04em;text-transform:uppercase;">${escapeHtml(t.eyebrow)}</div>
            <h1 style="margin:8px 0 0 0;font-family:'EB Garamond',Georgia,'Times New Roman',serif;font-weight:400;font-size:26px;line-height:1.25;color:#111827;">
              ${escapeHtml(title)}
            </h1>
          </td>
        </tr>
        <tr>
          <td style="padding:8px 32px 16px 32px;font-size:15px;line-height:1.55;color:#374151;">
            <p style="margin:16px 0 0 0;">${escapeHtml(t.greeting)}</p>
            <p style="margin:12px 0 0 0;">${escapeHtml(intro)}</p>
          </td>
        </tr>
${detailsHtml}        <tr>
          <td style="padding:8px 32px 24px 32px;">
            <table role="presentation" cellpadding="0" cellspacing="0">
              <tr>
                <td bgcolor="#111827" style="border-radius:10px;">
                  <a href="${escapeHtml(input.ctaUrl)}"
                     style="display:inline-block;padding:12px 22px;font-size:15px;font-weight:500;color:#ffffff;text-decoration:none;border-radius:10px;background:#111827;">
                    ${escapeHtml(ctaLabel)} →
                  </a>
                </td>
              </tr>
            </table>
          </td>
        </tr>
        <tr>
          <td style="padding:0 32px 24px 32px;">
            <hr style="border:none;border-top:1px solid #e5e7eb;margin:0 0 16px 0;" />
            <p style="margin:0;font-size:12px;line-height:1.6;color:#9ca3af;">
              ${escapeHtml(footer)}
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
        title,
        "",
        t.greeting,
        "",
        intro,
        ...(details.length ? ["", `${t.detailsHeading}:`, ...details] : []),
        "",
        `${ctaLabel}: ${input.ctaUrl}`,
        "",
        footer,
    ].join("\n");

    return { subject, html, text };
}
