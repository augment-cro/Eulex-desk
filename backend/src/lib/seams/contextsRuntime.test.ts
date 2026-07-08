import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  loadContextsForTurn,
  buildContextsSystemBlock,
  type ContextSelectionStore,
  type ResolvedContext,
} from "./contextsRuntime.js";
import type { contextsClient, ContextResolveResult } from "./contextsClient.js";

type Client = Pick<typeof contextsClient, "isConfigured" | "resolve">;

const WF_ID = "11111111-2222-3333-4444-555555555555";

function fakeStore(overrides: Partial<ContextSelectionStore> = {}): ContextSelectionStore {
  return {
    enabledContextIds: async () => [],
    contextIdsForWorkflow: async () => [],
    contextIdsForProject: async () => [],
    ...overrides,
  };
}

function resolveOk(id: string): ContextResolveResult {
  return {
    instructions_md: `\n\n---\nBLOCK ${id}\n---\n`,
    sources: [{ id: `src-${id}` }],
    scope_allowlist: [`src-${id}`],
  };
}

function fakeClient(
  resolvable: Record<string, ContextResolveResult | { status: number }>,
  resolveCalls: string[] = [],
): Client {
  return {
    isConfigured: () => true,
    resolve: async (contextId) => {
      resolveCalls.push(contextId);
      const entry = resolvable[contextId];
      if (!entry) return { ok: false, status: 404, error: "not found" };
      if ("status" in entry && !("instructions_md" in entry)) {
        return { ok: false, status: entry.status, error: "boom" };
      }
      return { ok: true, data: entry as ContextResolveResult };
    },
  };
}

describe("loadContextsForTurn", () => {
  it("returns [] with zero store/provider work when no provider is configured", async () => {
    const neverStore = fakeStore({
      enabledContextIds: async () => {
        throw new Error("store must not be touched");
      },
    });
    const out = await loadContextsForTurn({
      userId: "u1",
      query: "q",
      store: neverStore,
      client: { isConfigured: () => false, resolve: async () => { throw new Error("no calls"); } },
    });
    assert.deepEqual(out, []);
  });

  it("merges toggled ∪ workflow-linked ∪ project-linked, dedupes and sorts by id", async () => {
    const calls: string[] = [];
    const out = await loadContextsForTurn({
      userId: "u1",
      query: "q",
      workflowId: WF_ID,
      projectId: "p1",
      store: fakeStore({
        enabledContextIds: async () => ["b", "a"],
        contextIdsForWorkflow: async () => ["c", "a"],
        contextIdsForProject: async () => ["b"],
      }),
      client: fakeClient({ a: resolveOk("a"), b: resolveOk("b"), c: resolveOk("c") }, calls),
    });
    assert.deepEqual(calls, ["a", "b", "c"]); // deduped + sorted
    assert.deepEqual(out.map((r) => r.id), ["a", "b", "c"]);
    assert.equal(out[0].instructions_md, "\n\n---\nBLOCK a\n---\n");
    assert.deepEqual(out[0].scope_allowlist, ["src-a"]);
  });

  it("skips the workflow link lookup for built-in (non-UUID) workflow ids", async () => {
    let workflowLookups = 0;
    const out = await loadContextsForTurn({
      userId: "u1",
      query: "q",
      workflowId: "builtin-cp-checklist",
      store: fakeStore({
        contextIdsForWorkflow: async () => {
          workflowLookups++;
          return ["a"];
        },
      }),
      client: fakeClient({ a: resolveOk("a") }),
    });
    assert.equal(workflowLookups, 0);
    assert.deepEqual(out, []);
  });

  it("drops ids the provider refuses (404) or fails on, keeping the rest — never rejects", async () => {
    const out = await loadContextsForTurn({
      userId: "u1",
      query: "q",
      store: fakeStore({ enabledContextIds: async () => ["gone", "a", "err"] }),
      client: fakeClient({ a: resolveOk("a"), err: { status: 500 } }),
    });
    assert.deepEqual(out.map((r) => r.id), ["a"]);
  });

  it("a selection-read failure degrades to [] for that part only (toggled survives a linked-load error)", async () => {
    const out = await loadContextsForTurn({
      userId: "u1",
      query: "q",
      projectId: "p1",
      store: fakeStore({
        enabledContextIds: async () => ["a"],
        contextIdsForProject: async () => {
          throw new Error("pre-migration environment");
        },
      }),
      client: fakeClient({ a: resolveOk("a") }),
    });
    assert.deepEqual(out.map((r) => r.id), ["a"]);
  });

  it("forwards the turn query and the caller identity to resolve", async () => {
    const seen: { id: string; query: string; userId: string; email: string | null }[] = [];
    const client: Client = {
      isConfigured: () => true,
      resolve: async (id, query, userId, _tenant, email) => {
        seen.push({ id, query, userId, email: email ?? null });
        return { ok: true, data: resolveOk(id) };
      },
    };
    await loadContextsForTurn({
      userId: "u1",
      email: "u@example.com",
      query: "what changed?",
      store: fakeStore({ enabledContextIds: async () => ["a"] }),
      client,
    });
    assert.deepEqual(seen, [{ id: "a", query: "what changed?", userId: "u1", email: "u@example.com" }]);
  });
});

describe("buildContextsSystemBlock", () => {
  it("concatenates the providers' self-contained blocks in order; empty set → empty string", () => {
    const a: ResolvedContext = { id: "a", ...resolveOk("a") };
    const b: ResolvedContext = { id: "b", ...resolveOk("b") };
    assert.equal(
      buildContextsSystemBlock([a, b]),
      "\n\n---\nBLOCK a\n---\n\n\n---\nBLOCK b\n---\n",
    );
    assert.equal(buildContextsSystemBlock([]), "");
  });
});
