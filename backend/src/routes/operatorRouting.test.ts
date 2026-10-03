// /operator/v1 resolves the admin data routes with service auth; the routes
// the console serves itself (bugfix, databases, portal, benchmarks) are not
// part of the core. Routes chosen to answer without a database.
import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import request from "supertest";

process.env.OPERATOR_API_CALLERS = "adminmax@p.iam.gserviceaccount.com";
process.env.OPERATOR_API_DEV_TOKEN = "dev-op";
process.env.NODE_ENV = "test";
delete process.env.STRIPE_SECRET_KEY;

test("operator API serves the data routes and nothing console-only", async () => {
  const { makeOperatorRouter } = await import("./operator");
  const { internalCronRouter } = await import("./internalCron");
  const app = express();
  app.use(express.json());
  app.use("/operator/v1", makeOperatorRouter());
  app.use("/internal/cron", internalCronRouter);
  const op = "Bearer dev-op";
  const get = (path: string) =>
    request(app).get(`/operator/v1${path}`).set("Authorization", op);

  assert.equal((await get("/entitlement-catalog")).status, 200);
  assert.equal((await get("/users/not-a-uuid")).status, 400);
  assert.equal((await get("/promos")).body.configured, false);
  for (const path of ["/bugfix/status", "/databases", "/portal/overview", "/benchmarks/overview"]) {
    assert.equal((await get(path)).status, 404, path);
  }
  assert.equal(
    (await request(app).get("/operator/v1/entitlement-catalog").set("Authorization", "Bearer x")).status,
    401,
  );
  process.env.ADMIN_CRON_SECRET = "cron-s";
  assert.equal(
    (await request(app).post("/internal/cron/context-alerts").set("x-cron-secret", "nope")).status,
    401,
  );
  const w = await get("/whoami").set("X-Operator-Actor", "adminmax");
  assert.equal(w.body.caller, "adminmax");
});
