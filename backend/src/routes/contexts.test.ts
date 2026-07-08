import { describe, it } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { RequestHandler } from "express";
import request from "supertest";
import {
  makeContextsRouter,
  MAX_ACTIVE_CONTEXTS,
  type ContextsRuntimeStore,
  type ProviderClient,
} from "./contexts.js";
import type { ContextSummary } from "../lib/seams/contextsClient.js";

const stubAuth: RequestHandler = (_req, res, next) => {
  res.locals.userId = "u1";
  res.locals.userEmail = "u1@example.com";
  next();
};

/** In-memory runtime store, keyed like the pg tables. */
function memoryStore(): ContextsRuntimeStore & {
  prefs: Map<string, boolean>;
  workflowLinks: Set<string>;
  projectLinks: Set<string>;
  counts: Map<string, number>;
} {
  const prefs = new Map<string, boolean>();
  const workflowLinks = new Set<string>();
  const projectLinks = new Set<string>();
  const counts = new Map<string, number>();
  return {
    prefs, workflowLinks, projectLinks, counts,
    getPrefs: async () => new Map(prefs),
    setPref: async (_u, id, enabled) => void prefs.set(id, enabled),
    linkWorkflow: async (c, w) => void workflowLinks.add(`${c}:${w}`),
    unlinkWorkflow: async (c, w) => void workflowLinks.delete(`${c}:${w}`),
    linkProject: async (c, p) => void projectLinks.add(`${c}:${p}`),
    unlinkProject: async (c, p) => void projectLinks.delete(`${c}:${p}`),
    linksForContext: async (c) => ({
      workflows: [...workflowLinks].filter((k) => k.startsWith(`${c}:`)).map((k) => k.split(":")[1]),
      projects: [...projectLinks].filter((k) => k.startsWith(`${c}:`)).map((k) => k.split(":")[1]),
    }),
    notificationCountsSince: async (ids) =>
      new Map([...counts].filter(([id]) => ids.includes(id))),
  };
}

function providerWith(contexts: ContextSummary[]): ProviderClient {
  return {
    isConfigured: () => true,
    list: async () => ({ ok: true, data: contexts }),
  };
}

const unconfigured: ProviderClient = {
  isConfigured: () => false,
  list: async () => ({ ok: false, error: "CONTEXTS_URL_NOT_SET" }),
};

function buildApp(store: ContextsRuntimeStore, client: ProviderClient) {
  const app = express();
  app.use(express.json());
  app.use("/contexts", makeContextsRouter(store, stubAuth, client));
  return app;
}

describe("contexts runtime routes", () => {
  it("GET /toggles → 200 [] when no provider is configured (feature dormant)", async () => {
    const res = await request(buildApp(memoryStore(), unconfigured))
      .get("/contexts/toggles")
      .expect(200);
    assert.deepEqual(res.body, []);
  });

  it("GET /toggles returns prefs filtered to the provider's visible set", async () => {
    const store = memoryStore();
    store.prefs.set("a", true);
    store.prefs.set("stale", true);
    const app = buildApp(store, providerWith([{ id: "a", name: "A" }, { id: "b", name: "B" }]));
    const res = await request(app).get("/contexts/toggles").expect(200);
    assert.deepEqual(res.body, [{ contextId: "a", enabled: true }]);
  });

  it("GET /toggles degrades to unfiltered prefs when the provider is unreachable", async () => {
    const store = memoryStore();
    store.prefs.set("a", true);
    const flaky: ProviderClient = {
      isConfigured: () => true,
      list: async () => ({ ok: false, error: "ECONNREFUSED" }),
    };
    const res = await request(buildApp(store, flaky)).get("/contexts/toggles").expect(200);
    assert.deepEqual(res.body, [{ contextId: "a", enabled: true }]);
  });

  it("PUT /toggles/:id upserts for a listed context and 404s otherwise (incl. unconfigured)", async () => {
    const store = memoryStore();
    const app = buildApp(store, providerWith([{ id: "a", name: "A" }]));
    await request(app).put("/contexts/toggles/a").send({ enabled: true }).expect(200);
    assert.equal(store.prefs.get("a"), true);
    await request(app).put("/contexts/toggles/unknown").send({ enabled: true }).expect(404);
    await request(buildApp(memoryStore(), unconfigured))
      .put("/contexts/toggles/a").send({ enabled: true }).expect(404);
  });

  it("PUT /toggles/:id enforces the active cap, ignoring stale prefs; re-enable is a no-op", async () => {
    const store = memoryStore();
    const visible = Array.from({ length: MAX_ACTIVE_CONTEXTS + 1 }, (_, i) => ({
      id: `c${i}`,
      name: `C${i}`,
    }));
    for (let i = 0; i < MAX_ACTIVE_CONTEXTS; i++) store.prefs.set(`c${i}`, true);
    store.prefs.set("stale-gone", true); // not visible → must not occupy a slot
    const app = buildApp(store, providerWith(visible));

    const res = await request(app)
      .put(`/contexts/toggles/c${MAX_ACTIVE_CONTEXTS}`)
      .send({ enabled: true })
      .expect(400);
    assert.match(res.body.errors[0], /at most/i);

    // Re-enabling an already-enabled context never trips the cap.
    await request(app).put("/contexts/toggles/c0").send({ enabled: true }).expect(200);
    // Disabling always works.
    await request(app).put("/contexts/toggles/c0").send({ enabled: false }).expect(200);
    assert.equal(store.prefs.get("c0"), false);
  });

  it("GET /alert-counts returns service_notifications counts for visible contexts; [] when dormant", async () => {
    const store = memoryStore();
    store.counts.set("a", 3);
    store.counts.set("invisible", 9);
    const app = buildApp(store, providerWith([{ id: "a", name: "A" }]));
    const res = await request(app).get("/contexts/alert-counts").expect(200);
    assert.deepEqual(res.body, [{ contextId: "a", count: 3 }]);

    const dormant = await request(buildApp(store, unconfigured))
      .get("/contexts/alert-counts")
      .expect(200);
    assert.deepEqual(dormant.body, []);
  });

  it("attach links: create/list/delete for a visible context, 404 for an invisible one", async () => {
    const store = memoryStore();
    const app = buildApp(store, providerWith([{ id: "a", name: "A" }]));

    await request(app).post("/contexts/a/workflows/wf1").expect(201);
    await request(app).post("/contexts/a/projects/p1").expect(201);
    const links = await request(app).get("/contexts/a/links").expect(200);
    assert.deepEqual(links.body, { workflows: ["wf1"], projects: ["p1"] });

    await request(app).delete("/contexts/a/workflows/wf1").expect(204);
    await request(app).delete("/contexts/a/projects/p1").expect(204);
    const empty = await request(app).get("/contexts/a/links").expect(200);
    assert.deepEqual(empty.body, { workflows: [], projects: [] });

    await request(app).post("/contexts/nope/workflows/wf1").expect(404);
    await request(app).get("/contexts/nope/links").expect(404);
  });

  it("an async handler rejection becomes a 500 JSON response, not a hang", async () => {
    const store = memoryStore();
    store.getPrefs = async () => {
      throw new Error("db down");
    };
    const app = buildApp(store, providerWith([{ id: "a", name: "A" }]));
    const res = await request(app).get("/contexts/toggles").expect(500);
    assert.ok(res.body.detail);
  });
});
