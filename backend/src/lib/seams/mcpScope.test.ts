import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { runToolCalls, type ToolCall } from "../chatTools.js";
import type { LoadedMcpServer } from "../mcp/types.js";
import { buildScopeSet } from "./scopeEnforcement.js";

// Integration coverage for the MCP dispatch path in runToolCalls:
//  - precheck/L1 scope only LEGAL servers — a UUID-shaped arg to a
//    Drive/Notion tool passes through untouched while a context is active.
//  - a scope refusal is pushed into mcpResults (persisted chip) and
//    preceded by an mcp_tool_call event, like the success path.
//  - end-to-end: redaction feeds legal_sources from keptSources.

/**
 * Provider-minted allowlist for one CELEX instrument, as the resolve
 * response wires it (norm + "@eu/celex/" minted form; stem == norm for a
 * bare instrument ref).
 */
function allowlist(celex: string): Set<string> {
  const n = celex.toLowerCase();
  return buildScopeSet([[n, `@eu/celex/${n}`]]);
}

function fakeServer(
  slug: string,
  name: string,
  tool: string,
  respond: (args: Record<string, unknown>) => { text: string; structured?: unknown },
  calls: { tool: string; args: Record<string, unknown> }[],
): LoadedMcpServer {
  return {
    row: {
      id: `srv-${slug}`, user_id: "u1", slug, name, url: `https://${slug}.example`,
      headers: {}, enabled: true, last_error: null, auth_type: "headers",
      oauth_metadata: null, oauth_tokens: null, oauth_code_verifier: null,
    },
    tools: [],
    toolNameMap: new Map([[`mcp__${slug}__${tool}`, tool]]),
    client: {
      callTool: async () => "",
      callToolRich: async (toolName, args) => {
        calls.push({ tool: toolName, args });
        return respond(args);
      },
      close: async () => {},
    },
  };
}

function tc(name: string, args: Record<string, unknown>): ToolCall {
  return { id: `tc-${name}`, function: { name, arguments: JSON.stringify(args) } };
}

function run(
  toolCalls: ToolCall[],
  mcpServers: LoadedMcpServer[],
  whitelist: Set<string>,
  events: unknown[],
) {
  const write = (s: string) => {
    for (const line of s.split("\n")) {
      if (line.startsWith("data: ")) events.push(JSON.parse(line.slice(6)));
    }
  };
  return runToolCalls(
    toolCalls, new Map(), "u1",
    // db is unused on the MCP dispatch path
    null as unknown as Parameters<typeof runToolCalls>[3],
    write,
    undefined, undefined, undefined, undefined, null,
    mcpServers, undefined, undefined, undefined, null,
    whitelist,
  );
}

const OUT_UUID = "aaaaaaaa-bbbb-cccc-dddd-eeeeffff0000"; // not in any context

describe("runToolCalls — MCP scope enforcement", () => {
  const prevScopeParam = process.env.EULEX_SCOPE_PARAM;
  afterEach(() => {
    if (prevScopeParam === undefined) delete process.env.EULEX_SCOPE_PARAM;
    else process.env.EULEX_SCOPE_PARAM = prevScopeParam;
  });

  it("passes a UUID arg to a NON-legal server untouched while a context is active (no precheck, no L1 param)", async () => {
    process.env.EULEX_SCOPE_PARAM = "allowed_sources";
    const whitelist = allowlist("32016R0679");
    const calls: { tool: string; args: Record<string, unknown> }[] = [];
    const drive = fakeServer("gdrive", "Google Drive", "read_file", () => ({ text: "file body" }), calls);
    const events: unknown[] = [];
    const out = await run([tc("mcp__gdrive__read_file", { file_id: OUT_UUID })], [drive], whitelist, events);
    assert.equal(calls.length, 1);                                   // not refused
    assert.deepEqual(calls[0].args, { file_id: OUT_UUID });          // untouched: no L1 param injected
    assert.equal((out.toolResults[0] as { content: string }).content, "file body");
    assert.equal(out.mcpResults[0].ok, true);
  });

  it("still prechecks (refuses) an out-of-scope id on a LEGAL server, and injects the L1 param on allowed calls", async () => {
    process.env.EULEX_SCOPE_PARAM = "allowed_sources";
    const whitelist = allowlist("32016R0679");
    const calls: { tool: string; args: Record<string, unknown> }[] = [];
    const eulex = fakeServer("eulex", "EULEX AI", "get_section", () => ({ text: "…" }), calls);
    const events: unknown[] = [];

    const refused = await run([tc("mcp__eulex__get_section", { celex_id: "32019R0881" })], [eulex], whitelist, events);
    assert.equal(calls.length, 0);                                   // refused before the round-trip
    assert.match((refused.toolResults[0] as { content: string }).content, /Refused: 32019r0881/);

    const allowed = await run([tc("mcp__eulex__get_section", { celex_id: "32016R0679" })], [eulex], whitelist, []);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args.allowed_sources, [...whitelist].sort()); // L1 param present
    assert.equal(allowed.mcpResults[0].ok, true);
  });

  it("persists the refusal chip: mcpResults carries the preview and an mcp_tool_call event precedes it", async () => {
    const whitelist = allowlist("32016R0679");
    const eulex = fakeServer("eulex", "EULEX AI", "get_section", () => ({ text: "…" }), []);
    const events: { type?: string }[] = [];
    const out = await run([tc("mcp__eulex__get_section", { celex_id: "32019R0881" })], [eulex], whitelist, events as unknown[]);
    // Persistence: the refused call survives reload via the mcpResults loop.
    assert.equal(out.mcpResults.length, 1);
    assert.equal(out.mcpResults[0].ok, false);
    assert.match(out.mcpResults[0].output, /outside the active context/);
    // SSE parity with the success path: call event, then result event.
    assert.deepEqual(events.map((e) => e.type), ["mcp_tool_call", "mcp_tool_result"]);
  });

  it("end-to-end: object structuredContent is redacted and legal_sources gets only in-scope ids", async () => {
    const whitelist = allowlist("32016R0679");
    const structured = {
      results: [
        { celex_id: "32016R0679", title: "GDPR" },
        { celex_id: "32019R0881", title: "CSA" },
      ],
    };
    const eulex = fakeServer("eulex", "EULEX AI", "search", () => ({ text: JSON.stringify(structured), structured }), []);
    const out = await run([tc("mcp__eulex__search", { query: "security" })], [eulex], whitelist, []);
    assert.deepEqual(out.legalSources.map((s) => s.id), ["@eu/celex/32016R0679"]);
    assert.doesNotMatch(out.mcpResults[0].output, /32019R0881/);
    assert.doesNotMatch((out.toolResults[0] as { content: string }).content, /32019R0881/);
  });
});
