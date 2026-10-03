import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  loadContextsForTurn,
  buildContextsSystemBlock,
  scopeAllowlistsForTurn,
  contextsAppliedEvent,
  contextRunSettings,
  contextSourceUrls,
  contextsUnavailableNote,
  type ContextSelectionStore,
  type ResolvedContext,
  type UnavailableContextItem,
} from "./contextsRuntime.js";
import { DEFAULT_CONTEXTS_HEADER, DEFAULT_CONTEXTS_FOOTER } from "./promptPack.js";
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

  it("collects contexts that failed to resolve (not 404) as unavailable, in id order — never rejects", async (t) => {
    t.mock.method(console, "warn", () => {});
    const unavailable: UnavailableContextItem[] = [];
    const client: Client = {
      isConfigured: () => true,
      resolve: async (id) => {
        if (id === "a") return { ok: true, data: resolveOk("a") };
        if (id === "gone") return { ok: false, status: 404, error: "not found" };
        if (id === "slow") return { ok: false, error: "The operation was aborted due to timeout" };
        if (id === "down") return { ok: false, status: 503, error: "unavailable" };
        throw new Error("token mint failed");
      },
    };
    const out = await loadContextsForTurn({
      userId: "u1",
      query: "q",
      store: fakeStore({ enabledContextIds: async () => ["slow", "gone", "throws", "a", "down"] }),
      client,
      unavailable,
    });
    assert.deepEqual(out.map((r) => r.id), ["a"]);
    assert.deepEqual(unavailable, [
      { kind: "context", name: "", id: "down" },
      { kind: "context", name: "", id: "slow" },
      { kind: "context", name: "", id: "throws" },
    ]);
  });

  it("a 404 and a system context the tier does not grant stay silent", async () => {
    const unavailable: UnavailableContextItem[] = [];
    const out = await loadContextsForTurn({
      userId: "u1",
      query: "q",
      store: fakeStore({ enabledContextIds: async () => ["gone", "sys"] }),
      client: fakeClient({ sys: { ...resolveOk("sys"), level: "system" } }),
      unavailable,
    });
    assert.deepEqual(out, []);
    assert.deepEqual(unavailable, []);
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

  it("system contexts only for an entitled caller: the claim is asked for, and a resolved one is dropped otherwise", async () => {
    const asked: Array<boolean | undefined> = [];
    const client: Client = {
      isConfigured: () => true,
      resolve: async (id, _q, _u, _t, _e, opts) => {
        asked.push(opts?.systemContexts);
        return { ok: true, data: { ...resolveOk(id), level: id === "sys" ? "system" : "personal" } };
      },
    };
    const store = fakeStore({ enabledContextIds: async () => ["a", "sys"] });
    const without = await loadContextsForTurn({ userId: "u1", query: "q", store, client });
    assert.deepEqual(without.map((r) => r.id), ["a"]);
    const withSystem = await loadContextsForTurn({ userId: "u1", query: "q", store, client, systemContexts: true });
    assert.deepEqual(withSystem.map((r) => r.id), ["a", "sys"]);
    assert.deepEqual(asked, [false, false, true, true]);
  });
});

describe("buildContextsSystemBlock", () => {
  it("wraps the blocks in the precedence header/footer; system contexts first; empty set → empty string", () => {
    const a: ResolvedContext = { id: "a", ...resolveOk("a") };
    const b: ResolvedContext = { id: "b", ...resolveOk("b"), level: "system" };
    const block = buildContextsSystemBlock([a, b]);
    assert.ok(block.startsWith(`\n\n---\n${DEFAULT_CONTEXTS_HEADER}\n`));
    assert.ok(block.endsWith(`\n${DEFAULT_CONTEXTS_FOOTER}\n---\n`));
    assert.ok(block.indexOf("BLOCK b") < block.indexOf("BLOCK a"), "system context precedes personal");
    assert.equal(buildContextsSystemBlock([]), "");
  });
});

describe("scopeAllowlistsForTurn", () => {
  const strict: ResolvedContext = { id: "s", instructions_md: "", sources: [], scope_allowlist: ["x"] };
  const extended: ResolvedContext = { id: "e", instructions_md: "", sources: [], scope_allowlist: ["y"], answer_mode: "extended" };
  it("enforces nothing when every active context is extended", () => {
    assert.deepEqual(scopeAllowlistsForTurn([extended]), []);
    assert.deepEqual(scopeAllowlistsForTurn(undefined), []);
  });
  it("one strict context (or a provider without answer modes) → union of ALL allowlists", () => {
    assert.deepEqual(scopeAllowlistsForTurn([strict, extended]), [["x"], ["y"]]);
  });
});

describe("contextsAppliedEvent / contextSourceUrls", () => {
  it("lists the contexts system-first with their level; null when none", () => {
    const p: ResolvedContext = { id: "p", instructions_md: "", sources: [], name: "Mine" };
    const sys: ResolvedContext = { id: "z", instructions_md: "", sources: [{ id: "u", url: "https://azop.hr/x" }], name: "EU AI Governance", level: "system", version_label: "v1.0" };
    assert.deepEqual(contextsAppliedEvent([p, sys]), {
      type: "contexts_applied",
      contexts: [
        { id: "z", name: "EU AI Governance", level: "system", version_label: "v1.0" },
        { id: "p", name: "Mine", level: "personal" },
      ],
    });
    assert.equal(contextsAppliedEvent([]), null);
    assert.deepEqual(contextSourceUrls([p, sys]), ["https://azop.hr/x"]);
  });
});

describe("contexts that did not load — event and model note", () => {
  const sys: ResolvedContext = { id: "z", instructions_md: "", sources: [], name: "EU AI Governance", level: "system" };
  const missing: UnavailableContextItem[] = [
    { kind: "context", name: "", id: "down" },
    { kind: "document", name: "AZOP smjernice\n(2025)" },
  ];

  it("the event carries them after the contexts; omitted when everything loaded", () => {
    assert.deepEqual(contextsAppliedEvent([sys], null, missing), {
      type: "contexts_applied",
      contexts: [{ id: "z", name: "EU AI Governance", level: "system" }],
      unavailable: missing,
    });
    const loaded = contextsAppliedEvent([sys], null, []);
    assert.ok(loaded && !("unavailable" in loaded));
    assert.equal(JSON.stringify(loaded), JSON.stringify(contextsAppliedEvent([sys])));
  });

  it("a turn whose only context failed still gets an event, with no contexts", () => {
    assert.deepEqual(contextsAppliedEvent([], null, missing.slice(0, 1)), {
      type: "contexts_applied",
      contexts: [],
      unavailable: [{ kind: "context", name: "", id: "down" }],
    });
    assert.equal(contextsAppliedEvent([], null, []), null);
  });

  it("the model note names each one on one line and asks for the gap to be said; empty when nothing failed", () => {
    assert.equal(contextsUnavailableNote([]), "");
    assert.equal(contextsUnavailableNote(undefined), "");
    const note = contextsUnavailableNote(missing);
    assert.ok(note.startsWith("CONTEXT SOURCES NOT LOADED"));
    assert.ok(note.includes("\n- an active context as a whole (its instructions and sources are missing)\n"));
    assert.ok(note.includes('\n- the context document "AZOP smjernice (2025)"\n'));
    assert.ok(note.endsWith("do not present such findings as complete."));
  });
});

describe("contextRunSettings — the model and effort a system context sets", () => {
  const ctx = (id: string, over: Partial<ResolvedContext> = {}): ResolvedContext =>
    ({ id, instructions_md: "", sources: [], name: id, level: "system", ...over });

  it("is null when no active system context names a model or an effort", () => {
    assert.equal(contextRunSettings([]), null);
    assert.equal(contextRunSettings(undefined), null);
    assert.equal(contextRunSettings([ctx("a")]), null);
  });

  it("takes model and effort from the first system context in prompt order that names either", () => {
    const b = ctx("b", { model: "claude-opus-5-5", reasoning_effort: "max" });
    const a = ctx("a", { reasoning_effort: "xhigh" });
    // "a" sorts first and names an effort only: the pair comes from "a", so the model stays the turn's own.
    assert.deepEqual(contextRunSettings([b, a]), { contextId: "a", effort: "xhigh" });
    assert.deepEqual(contextRunSettings([b]), { contextId: "b", model: "claude-opus-5-5", effort: "max" });
  });

  it("ignores a personal context, an unknown model and an unknown effort", (t) => {
    t.mock.method(console, "warn", () => {});
    const personal = ctx("p", { level: "personal", model: "claude-opus-5-5", reasoning_effort: "max" });
    assert.equal(contextRunSettings([personal]), null);
    assert.equal(contextRunSettings([ctx("x", { model: "no-such-model", reasoning_effort: "extreme" })]), null);
    assert.deepEqual(
      contextRunSettings([ctx("x", { model: "no-such-model", reasoning_effort: "high" })]),
      { contextId: "x", effort: "high" },
    );
  });

  it("the applied model and effort ride on the contexts_applied event", () => {
    const sys = ctx("z", { name: "EU AI Governance", version_label: "v1.1", model: "claude-opus-5-5", reasoning_effort: "xhigh" });
    assert.deepEqual(contextsAppliedEvent([sys], contextRunSettings([sys])), {
      type: "contexts_applied",
      contexts: [{ id: "z", name: "EU AI Governance", level: "system", version_label: "v1.1" }],
      model: "claude-opus-5-5",
      effort: "xhigh",
    });
  });
});
