import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { createServiceNotificationsRouter } from "../../routes/serviceNotifications.js";

function buildApp(inserted: unknown[]) {
    const app = express();
    app.use(express.json());
    app.use(
        "/internal/notifications",
        createServiceNotificationsRouter(async (rows) => {
            inserted.push(...rows);
        }),
    );
    return app;
}

function serviceToken(): string {
    return jwt.sign(
        { sub: "contexts-service", iss: "contexts", aud: "eulex-desk" },
        "s3cret",
        { algorithm: "HS256", expiresIn: 60 },
    );
}

const UID = "3b241101-e2bb-4255-8caf-4136c566a962";

describe("POST /internal/notifications", () => {
    beforeEach(() => {
        delete process.env.CONTEXTS_SERVICE_SECRET;
        delete process.env.GOVERNANCE_SERVICE_SECRET;
        delete process.env.AUDIT_SINK_SECRET;
    });

    it("401s without a valid service token (including when no secrets configured)", async () => {
        const app = buildApp([]);
        await request(app)
            .post("/internal/notifications")
            .send({ title: "hi", user_ids: [UID] })
            .expect(401);
    });

    it("400s on a missing title or missing recipients", async () => {
        process.env.CONTEXTS_SERVICE_SECRET = "s3cret";
        const app = buildApp([]);
        const auth = `Bearer ${serviceToken()}`;
        await request(app)
            .post("/internal/notifications")
            .set("authorization", auth)
            .send({ user_ids: [UID] })
            .expect(400);
        await request(app)
            .post("/internal/notifications")
            .set("authorization", auth)
            .send({ title: "hi" })
            .expect(400);
    });

    it("inserts one row per user id and stamps the source service", async () => {
        process.env.CONTEXTS_SERVICE_SECRET = "s3cret";
        const inserted: Array<Record<string, unknown>> = [];
        const app = buildApp(inserted);
        const res = await request(app)
            .post("/internal/notifications")
            .set("authorization", `Bearer ${serviceToken()}`)
            .send({ title: "Regulation changed", body_md: "…", user_ids: [UID] })
            .expect(200);
        assert.deepEqual(res.body, { ok: true, inserted: 1 });
        assert.equal(inserted[0].user_id, UID);
        assert.equal(inserted[0].source_service, "contexts");
        assert.equal(inserted[0].title, "Regulation changed");
    });

    it("rejects non-UUID user ids", async () => {
        process.env.CONTEXTS_SERVICE_SECRET = "s3cret";
        const app = buildApp([]);
        await request(app)
            .post("/internal/notifications")
            .set("authorization", `Bearer ${serviceToken()}`)
            .send({ title: "hi", user_ids: ["not-a-uuid"] })
            .expect(400);
    });
});
