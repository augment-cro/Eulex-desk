/**
 * Welcome e-mail — sent once, right after registration (first provisioning
 * of a public.users row — see middleware/auth.ts + lib/welcomeEmail.ts).
 *
 * Producer-only: returns `{ subject, html, text }`; the caller ships it.
 * Three parts, in this order: thanks, the basics (account / sign-in /
 * plan), and a short list of what Eulex Desk can do. Every capability line
 * mirrors copy that already ships in the app (landing features, sidebar
 * names, plan catalog, Pro locks) — nothing here promises a feature the
 * product does not have.
 *
 * Design: "E-mail dobrodošlice — nakon registracije" (design canvas mockup,
 * 2026-09-25) — paper background, 600px white card, Source Serif 4 body,
 * IBM Plex Mono labels, lime (#D4FF3F) EULEX pennant and CTA. Translated to
 * e-mail-safe markup: table layout, inline styles (Outlook, Gmail), web
 * fonts only as progressive enhancement over Georgia / Menlo. The pennant
 * logo (CSS clip-path) and the feature icons (inline SVG — Gmail strips
 * both) ship as PNGs under frontend/public/email/, rendered at 3x from the
 * design, so `assetBaseUrl` must be the public frontend origin.
 *
 * Localization: `lang` is the UI language at signup (X-UI-Locale header);
 * anything other than "en" renders Croatian (the product default).
 */

export type WelcomeLang = "hr" | "en";

export type WelcomeEmailInput = {
    /** The registered address — echoed in the basics box and the footer. */
    email: string;
    displayName?: string | null;
    lang: WelcomeLang;
    /** true → include the "you start on the free plan" row. */
    freeTier: boolean;
    /** Absolute CTA target, e.g. https://max.eulex.ai/assistant */
    ctaUrl: string;
    /** Public frontend origin serving /email/*.png, e.g. https://max.eulex.ai */
    assetBaseUrl: string;
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

type Feature = { icon: string; label: string; text: string };

type Copy = {
    subject: string;
    /** Inbox preview line (hidden in the body). */
    preheader: string;
    logoAlt: string;
    title: string;
    greeting: (name: string | null) => string;
    intro: string;
    basicsHeading: string;
    accountLabel: string;
    accountSignIn: string;
    planLabel: string;
    planFree: string;
    featuresHeading: string;
    features: Feature[];
    proNote: string;
    cta: string;
    /** Verbatim `assistant.disclaimer` from the app — legal copy, do not reword here. */
    disclaimer: string;
    /** Footer split around the e-mail address, which renders in mono. */
    footerBefore: string;
    footerAfter: string;
};

const COPY: Record<WelcomeLang, Copy> = {
    hr: {
        subject: "Hvala na registraciji — Eulex Desk",
        preheader: "Vaš račun je spreman i možete odmah početi.",
        logoAlt: "EULEX",
        title: "Hvala na registraciji",
        greeting: (name) => `Pozdrav${name ? ` ${name}` : ""},`,
        intro: "hvala što ste otvorili račun na Eulex Desku. Vaš račun je spreman i možete odmah početi.",
        basicsHeading: "Osnovne informacije",
        accountLabel: "Vaš račun",
        accountSignIn:
            "Prijava je bez lozinke — na stranici za prijavu zatražite poveznicu na tu adresu ili se prijavite Google, LinkedIn ili Microsoft računom.",
        planLabel: "Plan",
        planFree:
            "Započinjete na besplatnom planu s dnevnim limitom korištenja. Planove možete usporediti i nadograditi u Postavkama računa (Naplata i tokeni).",
        featuresHeading: "Što Eulex Desk može",
        features: [
            {
                icon: "assistant",
                label: "Asistent",
                text: "postavite pitanje na hrvatskom ili engleskom; Eulex Desk čita vaše dokumente, citira ih doslovno (stranica i članak) te sastavlja i uređuje ugovore od nacrta do potpisa.",
            },
            {
                icon: "legal",
                label: "Pravna baza",
                text: "integrirana hrvatska i europska pravna baza (EUR-Lex i nacionalno pravo) izravno u razgovoru.",
            },
            {
                icon: "projects",
                label: "Predmeti",
                text: "radni prostori vezani uz predmet: učitajte ugovore i pakete dokumenata, a asistent zadržava kontekst kroz svaki razgovor.",
            },
            {
                icon: "tabular",
                label: "Analize",
                text: "strukturirana ekstrakcija podataka iz više dokumenata odjednom; svaka ćelija citirana je natrag na stranicu i odlomak.",
            },
            {
                icon: "workflows",
                label: "Radni tijekovi",
                text: "provjerene upute kao predlošci koje dijeli cijeli ured (npr. CP popisi i sažeci kreditnih ugovora), pokreću se jednim klikom.",
            },
        ],
        proNote:
            "Uz Pro paket dodatno: anonimizacija osobnih podataka (PII), Word dodatak i povezivanje vanjskih alata (MCP).",
        cta: "Otvori Eulex Desk",
        disclaimer: "AI može pogriješiti. Odgovori ne predstavljaju pravni savjet.",
        footerBefore: "Ovu poruku primili ste jer je s adresom ",
        footerAfter:
            " otvoren račun na Eulex Desku. Ako to niste bili vi, slobodno je zanemarite. Imate pitanje? Odgovorite na ovaj e-mail.",
    },
    en: {
        subject: "Thanks for signing up — Eulex Desk",
        preheader: "Your account is ready and you can start right away.",
        logoAlt: "EULEX",
        title: "Thanks for signing up",
        greeting: (name) => `Hi${name ? ` ${name}` : ""},`,
        intro: "thanks for creating an account on Eulex Desk. Your account is ready and you can start right away.",
        basicsHeading: "The basics",
        accountLabel: "Your account",
        accountSignIn:
            "Sign-in is passwordless — on the sign-in page request a link to that address, or sign in with your Google, LinkedIn or Microsoft account.",
        planLabel: "Plan",
        planFree:
            "You start on the free plan with a daily usage limit. Compare and upgrade plans in Account Settings (Billing & tokens).",
        featuresHeading: "What Eulex Desk can do",
        features: [
            {
                icon: "assistant",
                label: "Assistant",
                text: "ask in English or Croatian; Eulex Desk reads your documents, cites them verbatim (page and article) and drafts and edits contracts from first draft to signature.",
            },
            {
                icon: "legal",
                label: "Legal content",
                text: "integrated Croatian and European legal content (EUR-Lex and national law) right in the conversation.",
            },
            {
                icon: "projects",
                label: "Projects",
                text: "matter-scoped workspaces: upload contracts and diligence packs and the assistant keeps context across every conversation.",
            },
            {
                icon: "tabular",
                label: "Tabular review",
                text: "structured data extraction across many documents at once; every cell is cited back to a page and passage.",
            },
            {
                icon: "workflows",
                label: "Workflows",
                text: "proven prompts packaged as firm-wide templates (e.g. CP checklists and credit agreement summaries), run with one click.",
            },
        ],
        proNote:
            "With the Pro plan you also get anonymization of personal data (PII), the Word add-in and external tools via MCP.",
        cta: "Open Eulex Desk",
        disclaimer: "AI can make mistakes. Answers are not legal advice.",
        footerBefore: "You're receiving this because an account was created on Eulex Desk with ",
        footerAfter: ". If that wasn't you, you can ignore this message. Questions? Just reply to this email.",
    },
};

// Design tokens (Email.dc.html) — inline hex is the only option in e-mail.
const INK = "#1E1A14";
const MUTED = "#6E6557";
const PAPER = "#FBF9F3";
const TINT = "#F6F3EB";
const BORDER = "#E4DED0";
const DIVIDER = "#EEE9DE";
const ACCENT = "#D4FF3F";
const SERIF = "'Source Serif 4',Georgia,'Times New Roman',serif";
const MONO = "'IBM Plex Mono',Menlo,Consolas,'Courier New',monospace";

const LABEL = `font-family:${MONO};font-size:11px;line-height:1.4;letter-spacing:0.14em;text-transform:uppercase;color:${MUTED};`;

export function renderWelcomeEmail(input: WelcomeEmailInput): RenderedEmail {
    const lang: WelcomeLang = input.lang === "en" ? "en" : "hr";
    const t = COPY[lang];

    const email = input.email.trim();
    const name = input.displayName?.trim() || null;
    const greeting = t.greeting(name);
    const assets = input.assetBaseUrl.replace(/\/+$/, "");
    const asset = (file: string) => escapeHtml(`${assets}/email/${file}`);

    const basicsRow = (label: string, body: string, divider: boolean) => `
                    <tr>
                      <td class="lbl" valign="top" width="104" style="width:104px;padding:17px 16px 14px 16px;${divider ? `border-bottom:1px solid ${DIVIDER};` : ""}font-family:${MONO};font-size:11px;line-height:1.4;letter-spacing:0.12em;text-transform:uppercase;color:${MUTED};">${escapeHtml(label)}</td>
                      <td class="val" valign="top" style="padding:14px 16px 14px 0;${divider ? `border-bottom:1px solid ${DIVIDER};` : ""}font-family:${SERIF};font-size:14.5px;line-height:1.5;color:${INK};">${body}</td>
                    </tr>`;

    const basicsHtml =
        basicsRow(
            t.accountLabel,
            `<div style="font-family:${MONO};font-size:13px;line-height:1.5;color:${INK};padding-bottom:4px;word-break:break-all;">${escapeHtml(email)}</div>${escapeHtml(t.accountSignIn)}`,
            input.freeTier,
        ) + (input.freeTier ? basicsRow(t.planLabel, escapeHtml(t.planFree), false) : "");

    const featuresHtml = t.features
        .map(
            (f, i) => `
                    <tr>
                      <td valign="top" width="46" style="width:46px;padding:0 0 ${i === t.features.length - 1 ? 0 : 14}px 0;"><img src="${asset(`welcome-${f.icon}.png`)}" width="32" height="32" alt="" style="display:block;width:32px;height:32px;border:0;outline:none;" /></td>
                      <td valign="top" style="padding:5px 0 ${i === t.features.length - 1 ? 0 : 14}px 0;font-family:${SERIF};font-size:14.5px;line-height:1.5;color:${INK};"><strong style="font-weight:600;">${escapeHtml(f.label)}</strong> &mdash; ${escapeHtml(f.text)}</td>
                    </tr>`,
        )
        .join("");

    const html = `<!DOCTYPE html>
<html lang="${lang}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<meta name="color-scheme" content="light" />
<meta name="supported-color-schemes" content="light" />
<title>${escapeHtml(t.subject)}</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&amp;family=Source+Serif+4:ital,opsz,wght@0,8..60,400;0,8..60,500;0,8..60,600;1,8..60,400&amp;display=swap" />
<style>
  body { margin:0; padding:0; -webkit-font-smoothing:antialiased; }
  a { color:${INK}; }
  @media only screen and (max-width:620px) {
    .wrap { padding:16px 8px !important; }
    .pad { padding-left:24px !important; padding-right:24px !important; }
    .h1 { font-size:26px !important; }
    .lbl { display:block !important; width:auto !important; padding:14px 16px 0 16px !important; border-bottom:0 !important; }
    .val { display:block !important; padding:6px 16px 14px 16px !important; }
  }
</style>
</head>
<body style="margin:0;padding:0;background:${PAPER};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all;">${escapeHtml(t.preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${PAPER}" style="background:${PAPER};">
  <tr>
    <td class="wrap" align="center" style="padding:32px 16px;">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" bgcolor="#FFFFFF" style="width:100%;max-width:600px;background:#FFFFFF;border:1px solid ${BORDER};border-radius:10px;border-collapse:separate;">
        <tr>
          <td class="pad" style="padding:24px 40px 0 40px;">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td valign="middle" style="padding-right:14px;"><a href="${escapeHtml(input.ctaUrl)}" style="text-decoration:none;"><img src="${asset("welcome-logo.png")}" width="107" height="40" alt="${escapeHtml(t.logoAlt)}" style="display:block;width:107px;height:40px;border:0;outline:none;font-family:${MONO};font-weight:600;font-size:18px;letter-spacing:0.14em;color:${INK};" /></a></td>
                <td valign="middle" style="font-family:${MONO};font-size:13px;letter-spacing:0.16em;text-transform:uppercase;color:${INK};">Desk</td>
              </tr>
            </table>
          </td>
        </tr>
        <tr>
          <td class="pad" style="padding:32px 40px 8px 40px;font-family:${SERIF};color:${INK};">
            <h1 class="h1" style="margin:0 0 14px 0;font-family:${SERIF};font-size:30px;font-weight:500;line-height:1.15;color:${INK};">${escapeHtml(t.title)}</h1>
            <p style="margin:0 0 14px 0;font-size:16px;line-height:1.55;">${escapeHtml(greeting)}</p>
            <p style="margin:0;font-size:16px;line-height:1.55;">${escapeHtml(t.intro)}</p>
          </td>
        </tr>
        <tr>
          <td class="pad" style="padding:24px 40px 0 40px;">
            <div style="${LABEL}padding-bottom:10px;">${escapeHtml(t.basicsHeading)}</div>
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid ${BORDER};border-radius:8px;border-collapse:separate;">${basicsHtml}
            </table>
          </td>
        </tr>
        <tr>
          <td class="pad" style="padding:28px 40px 0 40px;">
            <div style="${LABEL}padding-bottom:12px;">${escapeHtml(t.featuresHeading)}</div>
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${featuresHtml}
            </table>
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${TINT}" style="margin-top:16px;background:${TINT};border-radius:8px;border-collapse:separate;">
              <tr>
                <td style="padding:14px 16px;">
                  <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                    <tr>
                      <td valign="top" width="1" style="padding:2px 12px 0 0;white-space:nowrap;"><span style="display:inline-block;padding:3px 8px;border-radius:999px;background:${INK};color:${PAPER};font-family:${MONO};font-size:10.5px;line-height:1.3;letter-spacing:0.12em;text-transform:uppercase;">Pro</span></td>
                      <td valign="top" style="font-family:${SERIF};font-size:14px;line-height:1.5;color:${INK};">${escapeHtml(t.proNote)}</td>
                    </tr>
                  </table>
                </td>
              </tr>
            </table>
          </td>
        </tr>
        <tr>
          <td class="pad" style="padding:28px 40px 32px 40px;">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td bgcolor="${ACCENT}" style="background:${ACCENT};border-radius:8px;">
                  <a href="${escapeHtml(input.ctaUrl)}" style="display:inline-block;padding:15px 22px;font-family:${MONO};font-size:13px;line-height:18px;font-weight:500;letter-spacing:0.12em;text-transform:uppercase;color:${INK};text-decoration:none;border-radius:8px;">${escapeHtml(t.cta)}&nbsp;&nbsp;&rarr;</a>
                </td>
              </tr>
            </table>
            <p style="margin:14px 0 0 0;font-family:${SERIF};font-size:13px;line-height:1.5;font-style:italic;color:${MUTED};">${escapeHtml(t.disclaimer)}</p>
          </td>
        </tr>
      </table>
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;">
        <tr>
          <td class="pad" style="padding:20px 40px 0 40px;font-family:${SERIF};font-size:13px;line-height:1.55;color:${MUTED};">${escapeHtml(t.footerBefore)}<span style="font-family:${MONO};font-size:12px;">${escapeHtml(email)}</span>${escapeHtml(t.footerAfter)}</td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;

    const basicsText = [
        `- ${t.accountLabel}: ${email}. ${t.accountSignIn}`,
        ...(input.freeTier ? [`- ${t.planLabel}: ${t.planFree}`] : []),
    ];

    const text = [
        t.title,
        "",
        greeting,
        "",
        t.intro,
        "",
        `${t.basicsHeading}:`,
        ...basicsText,
        "",
        `${t.featuresHeading}:`,
        ...t.features.map((f) => `- ${f.label} — ${f.text}`),
        "",
        t.proNote,
        "",
        `${t.cta}: ${input.ctaUrl}`,
        "",
        t.disclaimer,
        "",
        `${t.footerBefore}${email}${t.footerAfter}`,
    ].join("\n");

    return { subject: t.subject, html, text };
}
