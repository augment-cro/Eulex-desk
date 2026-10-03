import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { decideExternalGrant, parseExternalGrant } from "./externalGrants";
import { getLegalProTierLevelId, getPlusTierLevelId, getProTierLevelId } from "./stripe";
import { createBillingGrantsRouter } from "../routes/billingGrants";

const now = new Date("2026-01-10T12:00:00Z");
const inDays = (d: number) => new Date(now.getTime() + d * 86_400_000);

describe("parseExternalGrant", () => {
    it("accepts null (withdraw) and a bounded paid-plan grant", () => {
        assert.deepEqual(parseExternalGrant(null, now), { ok: true, grant: null });
        const r = parseExternalGrant(
            { tier_level_id: getProTierLevelId(), until: inDays(30).toISOString(), label: "virman: ponuda 1" },
            now,
        );
        assert.ok(r.ok && r.grant && r.grant.tierLevelId === getProTierLevelId());
    });
    it("refuses unknown levels, bad dates and far futures", () => {
        assert.equal(parseExternalGrant({ tier_level_id: 999, until: inDays(1).toISOString() }, now).ok, false);
        assert.equal(parseExternalGrant({ tier_level_id: getProTierLevelId(), until: "soon" }, now).ok, false);
        assert.equal(
            parseExternalGrant({ tier_level_id: getProTierLevelId(), until: inDays(500).toISOString() }, now).ok,
            false,
        );
        assert.equal(parseExternalGrant(undefined, now).ok, false);
    });
});

describe("decideExternalGrant", () => {
    const pro = { tierLevelId: getProTierLevelId(), until: inDays(3), label: "ponuda 1" };
    const none = { level: null, until: null, reason: null };

    it("writes a grant when nothing is active", () => {
        const d = decideExternalGrant("billing", none, pro, now);
        assert.equal(d.action, "set");
        assert.ok(d.action === "set" && d.reason.startsWith("ext:billing:"));
    });

    it("never overrides an equal or stronger foreign grant", () => {
        const stripeLegal = { level: getLegalProTierLevelId(), until: inDays(20), reason: "Stripe invoice.paid" };
        assert.deepEqual(decideExternalGrant("billing", stripeLegal, pro, now), { action: "none", why: "stronger-grant" });
        const adminPro = { level: getProTierLevelId(), until: null, reason: "AdminMax" };
        assert.equal(decideExternalGrant("billing", adminPro, pro, now).action, "none");
    });

    it("upgrades over a weaker foreign grant", () => {
        const plus = { level: getPlusTierLevelId(), until: inDays(20), reason: "Stripe" };
        assert.equal(decideExternalGrant("billing", plus, pro, now).action, "set");
    });

    it("is a no-op for the same grant, and replaces its own", () => {
        const current = { level: pro.tierLevelId, until: pro.until, reason: "ext:billing: ponuda 1" };
        assert.deepEqual(decideExternalGrant("billing", current, pro, now), { action: "none", why: "unchanged" });
        const longer = { ...pro, until: inDays(33) };
        assert.equal(decideExternalGrant("billing", current, longer, now).action, "set");
    });

    it("withdraws only its own live grant", () => {
        const ours = { level: pro.tierLevelId, until: inDays(2), reason: "ext:billing: ponuda 1" };
        const d = decideExternalGrant("billing", ours, null, now);
        assert.ok(d.action === "set" && d.until.getTime() === now.getTime());
        const foreign = { level: pro.tierLevelId, until: inDays(2), reason: "AdminMax" };
        assert.deepEqual(decideExternalGrant("billing", foreign, null, now), { action: "none", why: "nothing-to-end" });
        const lapsed = { ...ours, until: inDays(-1) };
        assert.equal(decideExternalGrant("billing", lapsed, null, now).action, "none");
    });
});

describe("POST /internal/billing/grants", () => {
    const app = express();
    app.use(express.json());
    app.use("/internal/billing", createBillingGrantsRouter());
    const UID = "3b241101-e2bb-4255-8caf-4136c566a962";
    const sign = (iss: string) =>
        jwt.sign({ sub: `svc-${iss}`, iss, aud: "eulex-desk" }, "s3cret", { algorithm: "HS256", expiresIn: 60 });

    beforeEach(() => {
        delete process.env.CONTEXTS_SERVICE_SECRET;
        delete process.env.BILLING_SERVICE_SECRET;
    });

    it("is inert without the billing secret", async () => {
        await request(app).post("/internal/billing/grants").send({ user_id: UID, grant: null }).expect(401);
    });

    it("accepts only the billing service's identity", async () => {
        process.env.CONTEXTS_SERVICE_SECRET = "s3cret";
        await request(app)
            .post("/internal/billing/grants")
            .set("authorization", `Bearer ${sign("contexts")}`)
            .send({ user_id: UID, grant: null })
            .expect(401);
    });

    it("validates the body before touching the DB", async () => {
        process.env.BILLING_SERVICE_SECRET = "s3cret";
        const auth = `Bearer ${sign("billing")}`;
        await request(app).post("/internal/billing/grants").set("authorization", auth).send({ user_id: "x", grant: null }).expect(400);
        await request(app)
            .post("/internal/billing/grants")
            .set("authorization", auth)
            .send({ user_id: UID, grant: { tier_level_id: 999, until: "2026-01-01" } })
            .expect(400);
    });
});
