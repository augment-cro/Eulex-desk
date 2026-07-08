import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import jwt from "jsonwebtoken";
import {
    mintServiceToken,
    verifyInboundServiceToken,
} from "./serviceIdentity.js";

describe("serviceIdentity", () => {
    beforeEach(() => {
        delete process.env.CONTEXTS_SERVICE_SECRET;
        delete process.env.GOVERNANCE_SERVICE_SECRET;
        delete process.env.AUDIT_SINK_SECRET;
    });

    it("returns null when the service secret is unset", () => {
        assert.equal(mintServiceToken("contexts", "u1"), null);
    });

    it("mints a verifiable outbound token with the documented claims", () => {
        process.env.CONTEXTS_SERVICE_SECRET = "s3cret";
        const token = mintServiceToken("contexts", "u1", "team-9");
        assert.ok(token);
        const payload = jwt.verify(token!, "s3cret", {
            algorithms: ["HS256"],
            audience: "contexts",
            issuer: "eulex-desk",
        }) as jwt.JwtPayload;
        assert.equal(payload.sub, "desk-u1");
        assert.equal(payload.tenant, "team-9");
        assert.equal(payload.scope, "seam:contexts");
    });

    it("caches per (service, user) until near expiry", () => {
        process.env.CONTEXTS_SERVICE_SECRET = "s3cret";
        const a = mintServiceToken("contexts", "cache-user");
        const b = mintServiceToken("contexts", "cache-user");
        assert.equal(a, b);
    });

    it("verifies inbound tokens signed with any configured service secret", () => {
        process.env.GOVERNANCE_SERVICE_SECRET = "g-secret";
        const inbound = jwt.sign(
            { sub: "svc", iss: "governance", aud: "eulex-desk" },
            "g-secret",
            { algorithm: "HS256", expiresIn: 60 },
        );
        const identity = verifyInboundServiceToken(inbound);
        assert.deepEqual(identity, { service: "governance", sub: "svc" });
    });

    it("rejects inbound tokens with a wrong secret or no configured secrets", () => {
        const bad = jwt.sign(
            { sub: "svc", iss: "governance", aud: "eulex-desk" },
            "wrong",
            { algorithm: "HS256", expiresIn: 60 },
        );
        assert.equal(verifyInboundServiceToken(bad), null);
    });
});
