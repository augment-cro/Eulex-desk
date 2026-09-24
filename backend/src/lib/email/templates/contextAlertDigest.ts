/**
 * Context-alert digest e-mail — hr/en. Pure renderer (no I/O), same shape as
 * orderConfirmation.ts. One e-mail per recipient per run, listing every
 * notification the contexts-service delivered since the last digest.
 */
export type ContextAlertDigestItem = {
    title: string;
    body_md: string | null;
    link: string | null;
    created_at: string;
};

export type ContextAlertDigestInput = {
    lang: "hr" | "en";
    displayName: string | null;
    items: ContextAlertDigestItem[];
    /** Frontend base URL, e.g. https://max.eulex.ai */
    baseUrl: string;
};

export type RenderedEmail = { subject: string; html: string; text: string };

const COPY = {
    hr: {
        subject: (n: number) => `Eulex Desk: ${n} ${n === 1 ? "promjena" : n >= 2 && n <= 4 ? "promjene" : "promjena"} u izvorima vaših konteksta`,
        hi: (name: string | null) => `Pozdrav${name ? ` ${name}` : ""},`,
        intro: "izvori koje pratite u svojim kontekstima promijenili su se. Pregledajte što je novo:",
        open: "Otvori kontekst",
        footer: "Obavijesti primate jer je u kontekstu uključeno „Obavijesti me kad se izvor promijeni“. Isključite ih u postavkama konteksta.",
    },
    en: {
        subject: (n: number) => `Eulex Desk: ${n} source ${n === 1 ? "change" : "changes"} in your contexts`,
        hi: (name: string | null) => `Hi${name ? ` ${name}` : ""},`,
        intro: "sources you track in your contexts have changed. Here is what is new:",
        open: "Open context",
        footer: "You receive these because 'Alert me when a source changes' is on for the context. Turn it off in the context settings.",
    },
} as const;

function escapeHtml(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function absolute(base: string, link: string | null): string | null {
    if (!link) return null;
    return /^https?:\/\//i.test(link) ? link : `${base}${link.startsWith("/") ? "" : "/"}${link}`;
}

export function renderContextAlertDigestEmail(input: ContextAlertDigestInput): RenderedEmail {
    const c = COPY[input.lang] ?? COPY.en;
    const n = input.items.length;
    const subject = c.subject(n);
    const itemsHtml = input.items
        .map((it) => {
            const href = absolute(input.baseUrl, it.link);
            const when = new Date(it.created_at).toLocaleDateString(input.lang === "hr" ? "hr-HR" : "en-GB", { day: "numeric", month: "long", year: "numeric" });
            const body = it.body_md ? `<p style="font-size:13px;color:#475569;white-space:pre-line;margin:6px 0 0;">${escapeHtml(it.body_md)}</p>` : "";
            const cta = href ? `<p style="margin:10px 0 0;"><a href="${escapeHtml(href)}" style="font-size:13px;color:#0f172a;">${c.open} →</a></p>` : "";
            return `<div style="border:1px solid #e2e8f0;border-radius:10px;padding:14px;margin:0 0 12px;">
        <div style="font-size:12px;color:#94a3b8;">${escapeHtml(when)}</div>
        <div style="font-size:15px;color:#0f172a;font-weight:600;margin-top:2px;">${escapeHtml(it.title)}</div>${body}${cta}
      </div>`;
        })
        .join("");
    const html = `<!doctype html><html><body style="font-family:Arial,Helvetica,sans-serif;background:#f8fafc;padding:24px;">
    <div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;padding:28px;">
        <h1 style="font-size:17px;color:#0f172a;margin:0 0 12px;">${escapeHtml(subject)}</h1>
        <p style="font-size:14px;color:#334155;">${escapeHtml(c.hi(input.displayName))}</p>
        <p style="font-size:14px;color:#334155;">${escapeHtml(c.intro)}</p>
        ${itemsHtml}
        <p style="font-size:12px;color:#94a3b8;margin-top:20px;">${escapeHtml(c.footer)}</p>
    </div>
</body></html>`;
    const text = [
        c.hi(input.displayName),
        "",
        c.intro,
        "",
        ...input.items.map((it) => `• ${it.title}${it.body_md ? `\n  ${it.body_md.replace(/\n/g, "\n  ")}` : ""}${absolute(input.baseUrl, it.link) ? `\n  ${absolute(input.baseUrl, it.link)}` : ""}`),
        "",
        c.footer,
    ].join("\n");
    return { subject, html, text };
}
