import { test } from "node:test";
import assert from "node:assert/strict";
import express, { Router } from "express";
import request from "supertest";
import {
    expectedAudiences,
    makeRequireOperatorCaller,
    type VerifyIdToken,
} from "../middleware/operatorAuth";
import { makeOperatorRouter } from "./operator";

const CALLER = "adminmax@project.iam.gserviceaccount.com";

function appWith(env: NodeJS.ProcessEnv, verify: VerifyIdToken) {
    const data = Router();
    data.get("/users", (_req, res) => {
        res.json({ actor: res.locals.adminActor });
    });
    const app = express();
    app.use(express.json());
    app.use(
        "/operator/v1",
        makeOperatorRouter({
            auth: makeRequireOperatorCaller({ env, verify }),
            data,
            billing: Router(),
        }),
    );
    return app;
}

const okVerify: VerifyIdToken = async (token) =>
    token === "good"
        ? { email: CALLER, email_verified: true, iss: "", aud: "", sub: "", iat: 0, exp: 0 }
        : undefined;

test("no OPERATOR_API_CALLERS → the operator surface does not exist (404)", async () => {
    let verified = 0;
    const app = appWith({}, async () => {
        verified++;
        return undefined;
    });
    const res = await request(app)
        .get("/operator/v1/users")
        .set("Authorization", "Bearer good");
    assert.equal(res.status, 404);
    assert.equal(verified, 0);
});

test("allowed service account passes; actor comes from X-Operator-Actor", async () => {
    const app = appWith({ OPERATOR_API_CALLERS: CALLER }, okVerify);
    const anon = await request(app).get("/operator/v1/users");
    assert.equal(anon.status, 401);
    const asCaller = await request(app)
        .get("/operator/v1/users")
        .set("Authorization", "Bearer good");
    assert.equal(asCaller.status, 200);
    assert.equal(asCaller.body.actor, CALLER);
    const declared = await request(app)
        .get("/operator/v1/users")
        .set("Authorization", "Bearer good")
        .set("X-Operator-Actor", "adminmax");
    assert.equal(declared.body.actor, "adminmax");
    const junkActor = await request(app)
        .get("/operator/v1/users")
        .set("Authorization", "Bearer good")
        .set("X-Operator-Actor", "<script>");
    assert.equal(junkActor.body.actor, CALLER);
});

test("callers list accepts ; , and whitespace separators", async () => {
    const app = appWith(
        { OPERATOR_API_CALLERS: `other@p.iam.gserviceaccount.com; ${CALLER.toUpperCase()}` },
        okVerify,
    );
    const res = await request(app)
        .get("/operator/v1/users")
        .set("Authorization", "Bearer good");
    assert.equal(res.status, 200);
});

test("a valid token from an account not on the list is rejected", async () => {
    const app = appWith(
        { OPERATOR_API_CALLERS: "someone-else@project.iam.gserviceaccount.com" },
        okVerify,
    );
    const res = await request(app)
        .get("/operator/v1/users")
        .set("Authorization", "Bearer good");
    assert.equal(res.status, 401);
});

test("unverified e-mail claims are rejected", async () => {
    const app = appWith({ OPERATOR_API_CALLERS: CALLER }, async () => ({
        email: CALLER,
        email_verified: false,
        iss: "",
        aud: "",
        sub: "",
        iat: 0,
        exp: 0,
    }));
    const res = await request(app)
        .get("/operator/v1/users")
        .set("Authorization", "Bearer good");
    assert.equal(res.status, 401);
});

test("dev token works outside production only", async () => {
    const env = {
        OPERATOR_API_CALLERS: CALLER,
        OPERATOR_API_DEV_TOKEN: "dev-token",
        NODE_ENV: "development",
    };
    const dev = appWith(env, async () => undefined);
    const ok = await request(dev)
        .get("/operator/v1/whoami")
        .set("Authorization", "Bearer dev-token");
    assert.equal(ok.status, 200);
    assert.equal(ok.body.caller, "dev");
    const prod = appWith({ ...env, NODE_ENV: "production" }, async () => undefined);
    const denied = await request(prod)
        .get("/operator/v1/whoami")
        .set("Authorization", "Bearer dev-token");
    assert.equal(denied.status, 401);
});

test("audience: pinned list wins, otherwise this host's origin", () => {
    const req = { headers: { host: "api.example.com" } } as unknown as express.Request;
    assert.deepEqual(expectedAudiences(req, {}), [
        "https://api.example.com",
        "https://api.example.com/operator/v1",
    ]);
    assert.deepEqual(
        expectedAudiences(req, { OPERATOR_API_AUDIENCE: "https://a.example/, max-operator" }),
        ["https://a.example", "max-operator"],
    );
});

test("POST /audit validates its input before writing", async () => {
    const app = appWith({ OPERATOR_API_CALLERS: CALLER }, okVerify);
    const bad = await request(app)
        .post("/operator/v1/audit")
        .set("Authorization", "Bearer good")
        .send({ action: "Bad Action" });
    assert.equal(bad.status, 400);
    const arr = await request(app)
        .post("/operator/v1/audit")
        .set("Authorization", "Bearer good")
        .send({ action: "portal.key.revoke", payload: [1] });
    assert.equal(arr.status, 400);
    const big = await request(app)
        .post("/operator/v1/audit")
        .set("Authorization", "Bearer good")
        .send({ action: "portal.key.revoke", payload: { x: "y".repeat(9000) } });
    assert.equal(big.status, 413);
});

test("GET /models serves this build's registry", async () => {
    const app = appWith({ OPERATOR_API_CALLERS: CALLER }, okVerify);
    const res = await request(app)
        .get("/operator/v1/models")
        .set("Authorization", "Bearer good");
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.tiers.main));
    assert.ok(res.body.defaults.main);
});
