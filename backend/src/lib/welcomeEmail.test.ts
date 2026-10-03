import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    sendWelcomeEmail,
    sendWelcomeEmailBounded,
    welcomeLocaleFromRequest,
    type WelcomeDeps,
} from "./welcomeEmail.js";
import { renderWelcomeEmail } from "./email/templates/welcome.js";
import type { EmailMessage } from "./email/provider.js";

const okDeps = (over: Partial<WelcomeDeps> = {}): WelcomeDeps & { sent: EmailMessage[]; claimed: string[] } => {
    const sent: EmailMessage[] = [];
    const claimed: string[] = [];
    return {
        sent,
        claimed,
        claim: async (userId) => { claimed.push(userId); return true; },
        send: async (m) => { sent.push(m); return { ok: true, messageId: "m1", provider: "fake" }; },
        baseUrl: () => "https://max.example",
        ...over,
    };
};

describe("renderWelcomeEmail", () => {
    const base = { ctaUrl: "https://max.example/assistant", assetBaseUrl: "https://max.example/" };

    it("renders Croatian by default with thanks, basics, five capabilities and the free-plan row", () => {
        const e = renderWelcomeEmail({ ...base, email: "ana@example.com", displayName: "Ana", lang: "hr", freeTier: true });
        assert.equal(e.subject, "Hvala na registraciji — Eulex Desk");
        assert.ok(e.html.includes("Hvala na registraciji"));
        assert.ok(e.html.includes("Pozdrav Ana,"));
        assert.ok(e.html.includes("ana@example.com"));
        assert.ok(e.html.includes(">Vaš račun</td>"));
        assert.ok(e.html.includes(">Plan</td>"));
        assert.ok(e.html.includes("besplatnom planu"));
        for (const label of ["Asistent", "Pravna baza", "Predmeti", "Analize", "Radni tijekovi"]) {
            assert.ok(e.html.includes(`>${label}</strong>`), label);
        }
        assert.ok(e.html.includes('href="https://max.example/assistant"'));
        assert.ok(e.html.includes("AI može pogriješiti. Odgovori ne predstavljaju pravni savjet."));
        assert.ok(e.text.includes("https://max.example/assistant"));
        assert.ok(e.text.includes("- Asistent — "));
        assert.ok(e.text.includes("- Plan: Započinjete na besplatnom planu"));
        assert.ok(e.text.includes("ana@example.com otvoren račun"));
    });

    it("loads the logo and the five feature icons from the frontend origin (no inline SVG)", () => {
        const e = renderWelcomeEmail({ ...base, email: "ana@example.com", lang: "hr", freeTier: true });
        assert.ok(e.html.includes('src="https://max.example/email/welcome-logo.png"'));
        for (const icon of ["assistant", "legal", "projects", "tabular", "workflows"]) {
            assert.ok(e.html.includes(`src="https://max.example/email/welcome-${icon}.png"`), icon);
        }
        assert.ok(!e.html.includes("<svg"));
        assert.ok(!e.html.includes("clip-path"));
    });

    it("omits the free-plan row for paid accounts and greets without a name", () => {
        const e = renderWelcomeEmail({ ...base, email: "ana@example.com", displayName: null, lang: "hr", freeTier: false });
        assert.ok(!e.html.includes("besplatnom planu"));
        assert.ok(!e.html.includes(">Plan</td>"));
        assert.ok(!e.text.includes("besplatnom planu"));
        assert.ok(e.html.includes("Pozdrav,"));
    });

    it("renders English for lang=en and falls back to Croatian for anything else", () => {
        const en = renderWelcomeEmail({ ...base, email: "b@example.com", displayName: "Bob", lang: "en", freeTier: true });
        assert.equal(en.subject, "Thanks for signing up — Eulex Desk");
        assert.ok(en.html.includes("Hi Bob,"));
        assert.ok(en.html.includes("free plan"));
        assert.ok(en.html.includes(">Your account</td>"));
        assert.ok(en.html.includes("AI can make mistakes. Answers are not legal advice."));
        assert.ok(en.html.includes('<html lang="en">'));
        const fallback = renderWelcomeEmail({ ...base, email: "b@example.com", lang: "xx" as never, freeTier: false });
        assert.equal(fallback.subject, "Hvala na registraciji — Eulex Desk");
    });

    it("escapes user-controlled values", () => {
        const e = renderWelcomeEmail({ email: "a@b.co", displayName: "<b>x</b>", lang: "en", freeTier: false, ctaUrl: 'https://x/?a="1"', assetBaseUrl: "https://x" });
        assert.ok(e.html.includes("Hi &lt;b&gt;x&lt;/b&gt;,"));
        assert.ok(!e.html.includes("<b>x</b>"));
        assert.ok(e.html.includes('href="https://x/?a=&quot;1&quot;"'));
    });
});

describe("welcomeLocaleFromRequest", () => {
    it("reads X-UI-Locale, tolerates region subtags and arrays, defaults to hr", () => {
        assert.equal(welcomeLocaleFromRequest({ headers: { "x-ui-locale": "en" } }), "en");
        assert.equal(welcomeLocaleFromRequest({ headers: { "x-ui-locale": "EN-US" } }), "en");
        assert.equal(welcomeLocaleFromRequest({ headers: { "x-ui-locale": ["en", "hr"] } }), "en");
        assert.equal(welcomeLocaleFromRequest({ headers: { "x-ui-locale": "hr-HR" } }), "hr");
        assert.equal(welcomeLocaleFromRequest({ headers: {} }), "hr");
        assert.equal(welcomeLocaleFromRequest({ headers: { "x-ui-locale": "de" } }), "hr");
    });
});

describe("sendWelcomeEmail", () => {
    const input = { userId: "u1", email: "Ana@Example.com ", displayName: "Ana", lang: "hr" as const, freeTier: true };

    it("claims the ledger, then sends once with reply-to and the welcome tag", async () => {
        const deps = okDeps();
        const r = await sendWelcomeEmail(input, deps);
        assert.deepEqual(r, { status: "sent", messageId: "m1" });
        assert.deepEqual(deps.claimed, ["u1"]);
        assert.equal(deps.sent.length, 1);
        const m = deps.sent[0];
        assert.deepEqual(m.to, { email: "Ana@Example.com", name: "Ana" });
        assert.equal(m.subject, "Hvala na registraciji — Eulex Desk");
        assert.deepEqual(m.replyTo, { email: "info@eulex.ai", name: "EULEX" });
        assert.deepEqual(m.tags, ["welcome"]);
        assert.ok(m.html.includes('href="https://max.example/assistant"'));
        assert.ok(m.html.includes('src="https://max.example/email/welcome-logo.png"'));
    });

    it("does not send when the ledger says it already went out", async () => {
        const deps = okDeps({ claim: async () => false });
        const r = await sendWelcomeEmail(input, deps);
        assert.deepEqual(r, { status: "already_sent" });
        assert.equal(deps.sent.length, 0);
    });

    it("skips an implausible address without touching the ledger", async () => {
        const deps = okDeps();
        const r = await sendWelcomeEmail({ ...input, email: "not-an-email" }, deps);
        assert.equal(r.status, "skipped");
        assert.deepEqual(deps.claimed, []);
        assert.equal(deps.sent.length, 0);
    });

    it("maps provider failures and skips to results instead of throwing", async () => {
        const failed = await sendWelcomeEmail(input, okDeps({ send: async () => ({ ok: false, error: "Brevo 500: boom", provider: "brevo" }) }));
        assert.deepEqual(failed, { status: "failed", reason: "Brevo 500: boom" });
        const skipped = await sendWelcomeEmail(input, okDeps({ send: async () => ({ ok: false, skipped: true, reason: "BREVO_API_KEY not configured", provider: "brevo" }) }));
        assert.deepEqual(skipped, { status: "skipped", reason: "BREVO_API_KEY not configured" });
        const threw = await sendWelcomeEmail(input, okDeps({ claim: async () => { throw new Error("db down"); } }));
        assert.deepEqual(threw, { status: "failed", reason: "db down" });
    });
});

describe("sendWelcomeEmailBounded", () => {
    const input = { userId: "u1", email: "a@example.com", lang: "en" as const, freeTier: false };

    it("returns the real result when the send is fast", async () => {
        const r = await sendWelcomeEmailBounded(input, 1_000, okDeps());
        assert.equal(r.status, "sent");
    });

    it("returns pending once the bound elapses while the send keeps running", async () => {
        let finished = false;
        const deps = okDeps({
            send: async (m) => { await new Promise((res) => setTimeout(res, 60)); finished = true; return { ok: true, messageId: "late", provider: "fake" }; },
        });
        const r = await sendWelcomeEmailBounded(input, 10, deps);
        assert.deepEqual(r, { status: "pending" });
        assert.equal(finished, false);
        await new Promise((res) => setTimeout(res, 80));
        assert.equal(finished, true);
    });
});
