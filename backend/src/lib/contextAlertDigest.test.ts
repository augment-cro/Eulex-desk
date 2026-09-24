import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { sendContextAlertDigests, type PendingRow } from "./contextAlertDigest.js";
import { renderContextAlertDigestEmail } from "./email/templates/contextAlertDigest.js";

const row = (o: Partial<PendingRow>): PendingRow => ({
    id: "n1", user_id: "u1", title: "Legal source update in context \"gdpr\"", body_md: "• 32016R0679: new consolidated version",
    link: "/contexts/c1", created_at: "2026-08-29T06:00:00Z", email: "owner@example.com", display_name: "Ana", preferred_language: "hr", ...o,
});

describe("sendContextAlertDigests", () => {
    it("groups per user, sends one e-mail, claims each row only after a successful send", async () => {
        const sent: string[] = []; const claimed: string[] = [];
        const r = await sendContextAlertDigests({
            fetchPending: async () => [row({ id: "n1" }), row({ id: "n2" }), row({ id: "n3", user_id: "u2", email: "b@example.com", preferred_language: "en" })],
            claim: async (id) => { claimed.push(id); return true; },
            send: async (m) => { sent.push(`${m.to.email}|${m.subject}`); return { ok: true, messageId: "x", provider: "fake" }; },
            baseUrl: () => "https://max.example",
        });
        assert.equal(r.recipients, 2); assert.equal(r.sent, 2); assert.equal(r.claimed, 3);
        assert.ok(sent[0].startsWith("owner@example.com|Eulex Desk: 2 promjene"));
        assert.ok(sent[1].startsWith("b@example.com|Eulex Desk: 1 source change"));
        assert.deepEqual(claimed.sort(), ["n1", "n2", "n3"]);
    });
    it("does not claim when the send fails, skips users without e-mail", async () => {
        const claimed: string[] = [];
        const r = await sendContextAlertDigests({
            fetchPending: async () => [row({ id: "n1" }), row({ id: "n2", user_id: "u9", email: null })],
            claim: async (id) => { claimed.push(id); return true; },
            send: async () => ({ ok: false, error: "boom", provider: "fake" }),
            baseUrl: () => "https://max.example",
        });
        assert.equal(r.failed, 1); assert.equal(r.skipped_no_email, 1); assert.deepEqual(claimed, []);
    });
});

describe("renderContextAlertDigestEmail", () => {
    it("renders hr/en with absolute links and escaped html", () => {
        const e = renderContextAlertDigestEmail({ lang: "en", displayName: null, baseUrl: "https://max.example", items: [{ title: "<b>x</b>", body_md: null, link: "/contexts/c1", created_at: "2026-08-29T06:00:00Z" }] });
        assert.ok(e.html.includes("&lt;b&gt;x&lt;/b&gt;")); assert.ok(e.html.includes("https://max.example/contexts/c1")); assert.ok(e.text.includes("https://max.example/contexts/c1"));
        assert.equal(renderContextAlertDigestEmail({ lang: "hr", displayName: "A", baseUrl: "x", items: [] }).subject.startsWith("Eulex Desk: 0 promjena"), true);
    });
});
