import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { RequestHandler } from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { createServiceTokenRouter } from "../../routes/serviceToken.js";

const stubAuth: RequestHandler = (_req, res, next) => {
    res.locals.userId = "u-token";
    next();
};

function buildApp(tenant: string | null = null) {
    const app = express();
    app.use(
        "/service-token",
        createServiceTokenRouter(stubAuth, async () => tenant),
    );
    return app;
}

describe("GET /service-token/:service", () => {
    beforeEach(() => {
        delete process.env.CONTEXTS_SERVICE_SECRET;
        delete process.env.GOVERNANCE_SERVICE_SECRET;
        delete process.env.AUDIT_SINK_SECRET;
    });

    it("404s for an unknown service name", async () => {
        await request(buildApp()).get("/service-token/nope").expect(404);
    });

    it("404s when the named service has no secret configured (inert seam)", async () => {
        await request(buildApp()).get("/service-token/contexts").expect(404);
    });

    it("returns a verifiable token with the documented claims when configured", async () => {
        process.env.CONTEXTS_SERVICE_SECRET = "s3cret";
        const res = await request(buildApp("team-9"))
            .get("/service-token/contexts")
            .expect(200);
        assert.ok(res.body.token);
        assert.ok(typeof res.body.expires_in === "number" && res.body.expires_in > 0);
        const payload = jwt.verify(res.body.token, "s3cret", {
            algorithms: ["HS256"],
            audience: "contexts",
            issuer: "eulex-desk",
        }) as jwt.JwtPayload;
        assert.equal(payload.sub, "desk-u-token");
        assert.equal(payload.tenant, "team-9");
        assert.equal(payload.scope, "seam:contexts");
    });
});
