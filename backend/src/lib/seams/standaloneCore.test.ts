import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { RequestHandler } from "express";
import request from "supertest";
import { contextsClient } from "./contextsClient.js";
import {
  loadContextsForTurn,
  buildContextsSystemBlock,
  type ContextSelectionStore,
} from "./contextsRuntime.js";
import { buildScopeSet, precheckToolArgs, redactToolResult } from "./scopeEnforcement.js";
import { makeContextsRouter, type ContextsRuntimeStore } from "../../routes/contexts.js";

/**
 * Standalone-core rule (design §2): with CONTEXTS_URL /
 * CONTEXTS_SERVICE_SECRET unset the core behaves like vanilla Eulex Desk — no
 * contexts in the prompt, no network calls, no thrown or logged errors.
 * Hermetic: nothing here opens a socket or a database connection; every
 * collaborator that WOULD is replaced by one that throws if touched.
 */

const SEAM_ENVS = ["CONTEXTS_URL", "CONTEXTS_SERVICE_SECRET"] as const;
const saved: Record<string, string | undefined> = {};

function throwingStore(): ContextSelectionStore & ContextsRuntimeStore {
  const boom = () => {
    throw new Error("unset seams must never reach the store");
  };
  return {
    enabledContextIds: async () => boom(),
    contextIdsForWorkflow: async () => boom(),
    contextIdsForProject: async () => boom(),
    getPrefs: async () => boom(),
    setPref: async () => boom(),
    linkWorkflow: async () => boom(),
    unlinkWorkflow: async () => boom(),
    linkProject: async () => boom(),
    unlinkProject: async () => boom(),
    linksForContext: async () => boom(),
    notificationCountsSince: async () => boom(),
  };
}

describe("standalone core — all contexts seam envs unset", () => {
  const consoleCalls: string[] = [];
  const origWarn = console.warn;
  const origError = console.error;

  beforeEach(() => {
    for (const env of SEAM_ENVS) {
      saved[env] = process.env[env];
      delete process.env[env];
    }
    consoleCalls.length = 0;
    console.warn = (...args: unknown[]) => void consoleCalls.push(`warn: ${args.join(" ")}`);
    console.error = (...args: unknown[]) => void consoleCalls.push(`error: ${args.join(" ")}`);
  });
  afterEach(() => {
    for (const env of SEAM_ENVS) {
      if (saved[env] === undefined) delete process.env[env];
      else process.env[env] = saved[env];
    }
    console.warn = origWarn;
    console.error = origError;
  });

  it("(a) the contexts client reports unconfigured and every call fails soft", async () => {
    assert.equal(contextsClient.isConfigured(), false);
    const list = await contextsClient.list("u1");
    assert.deepEqual(list, { ok: false, error: "CONTEXTS_URL_NOT_SET" });
    const resolve = await contextsClient.resolve("c1", "q", "u1");
    assert.deepEqual(resolve, { ok: false, error: "CONTEXTS_URL_NOT_SET" });
    assert.deepEqual(consoleCalls, []);
  });

  it("(a′) loadContextsForTurn returns the no-contexts result without touching the store", async () => {
    const out = await loadContextsForTurn({
      userId: "u1",
      email: "u1@example.com",
      query: "anything",
      workflowId: "11111111-2222-3333-4444-555555555555",
      projectId: "p1",
      store: throwingStore(),
    });
    assert.deepEqual(out, []);
    assert.deepEqual(consoleCalls, []);
  });

  it("(b) chat prompt assembly carries no contexts block and no scope enforcement", async () => {
    const active = await loadContextsForTurn({
      userId: "u1",
      query: "anything",
      store: throwingStore(),
    });
    // The exact expressions chatTools.runLLMStream evaluates:
    assert.equal(buildContextsSystemBlock(active), "");   // nothing appended to the system prompt
    const whitelist = buildScopeSet(active.map((c) => c.scope_allowlist));
    assert.equal(whitelist.size, 0);
    assert.deepEqual(precheckToolArgs({ celex_id: "32019R0881" }, whitelist), { ok: true });
    const r = redactToolResult({
      text: "tool output",
      structured: { results: [{ celex_id: "32019R0881", title: "CSA" }] },
      whitelist,
      harvest: () => [],
    });
    assert.equal(r.text, "tool output");                  // untouched — vanilla behaviour
    assert.equal(r.suppressed, 0);
    assert.deepEqual(consoleCalls, []);
  });

  it("(c) the runtime routes stay mounted and inert: reads 200/empty, writes 404", async () => {
    const stubAuth: RequestHandler = (_req, res, next) => {
      res.locals.userId = "u1";
      res.locals.userEmail = "u1@example.com";
      next();
    };
    const app = express();
    app.use(express.json());
    app.use("/contexts", makeContextsRouter(throwingStore(), stubAuth));

    const toggles = await request(app).get("/contexts/toggles").expect(200);
    assert.deepEqual(toggles.body, []);
    const counts = await request(app).get("/contexts/alert-counts").expect(200);
    assert.deepEqual(counts.body, []);
    await request(app).put("/contexts/toggles/c1").send({ enabled: true }).expect(404);
    await request(app).post("/contexts/c1/workflows/wf1").expect(404);
    await request(app).get("/contexts/c1/links").expect(404);
    assert.deepEqual(consoleCalls, []);
  });
});
