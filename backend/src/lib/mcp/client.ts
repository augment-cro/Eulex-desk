// Thin wrapper around the MCP TypeScript SDK's Streamable-HTTP client.
//
// Eulex Desk opens one client per (user, MCP server) per chat request. Connections
// are short-lived: we initialize, list tools, run any tools the model calls,
// then close in a `finally` on the request handler. There is no connection
// pool — each chat request pays an `initialize` round-trip per enabled
// server. This keeps the design stateless and avoids needing a worker.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

const CONNECT_TIMEOUT_MS = 10_000;
const CALL_TIMEOUT_MS = 60_000;

/**
 * Picks the SDK transport class based on the upstream URL.
 *
 * MCP has two HTTP-style transports:
 *   1. **Streamable HTTP** — current spec, single endpoint (e.g. `/mcp`)
 *      that accepts both POST (request) and GET (SSE response) on the same
 *      path. New servers ship this.
 *   2. **SSE** — older spec, a GET on `/sse` opens a persistent stream
 *      and a separate POST endpoint (advertised via the first SSE event)
 *      receives requests. Many existing servers (e.g. capazme/mcp-legal-it,
 *      community Python servers) still expose only this.
 *
 * Heuristic: if the URL path ends in `/sse` (case-insensitive), use the SSE
 * transport. Otherwise default to Streamable HTTP. This keeps existing
 * `mike/mcp.json` entries working unchanged while letting operators add
 * SSE-only servers by just pasting their `…/sse` URL.
 */
function pickTransportType(url: string): "sse" | "streamable-http" {
    try {
        const u = new URL(url);
        if (u.pathname.toLowerCase().endsWith("/sse")) return "sse";
    } catch {
        /* fall through */
    }
    return "streamable-http";
}

export class McpHttpClient {
    private client: Client | null = null;
    private transport: Transport | null = null;

    constructor(
        private readonly url: string,
        private readonly headers: Record<string, string>,
        private readonly authProvider?: OAuthClientProvider,
    ) {}

    async connect(): Promise<void> {
        const kind = pickTransportType(this.url);
        if (kind === "sse") {
            this.transport = new SSEClientTransport(new URL(this.url), {
                // SSE transport uses two channels: the EventSource (GET) and a
                // POST channel. `eventSourceInit` covers the GET; `requestInit`
                // covers POSTs. We attach the same headers to both so e.g.
                // partner JWTs reach the server on both legs.
                eventSourceInit: {
                    fetch: (input, init) =>
                        fetch(input, {
                            ...init,
                            headers: { ...(init?.headers ?? {}), ...this.headers },
                        }),
                },
                requestInit: {
                    headers: this.headers,
                },
                ...(this.authProvider ? { authProvider: this.authProvider } : {}),
            });
        } else {
            this.transport = new StreamableHTTPClientTransport(new URL(this.url), {
                requestInit: {
                    headers: this.headers,
                },
                ...(this.authProvider ? { authProvider: this.authProvider } : {}),
            });
        }
        this.client = new Client(
            { name: "mike", version: "1.0.0" },
            { capabilities: {} },
        );
        await withTimeout(
            this.client.connect(this.transport),
            CONNECT_TIMEOUT_MS,
            "MCP connect",
        );
    }

    async listTools(): Promise<Tool[]> {
        if (!this.client) throw new Error("MCP client not connected");
        const result = await withTimeout(
            this.client.listTools(),
            CONNECT_TIMEOUT_MS,
            "MCP listTools",
        );

        // The SDK auto-validates `structuredContent` against each tool's
        // `outputSchema` on every `callTool`, throwing JSON-RPC -32602 on
        // mismatch. There is no public knob to disable that validation
        // (see typescript-sdk #1943), and several real-world servers ship
        // schemas that don't match their actual output (e.g. UK Lex MCP
        // returns `provenance_timestamp` in a non-RFC-3339 format while
        // declaring `string (date-time) | null`). We don't consume
        // `structuredContent` anyway — `callTool` below only reads
        // `content[].text` blocks, which the spec mandates servers also
        // include for backwards compat. Drop the cached validators so a
        // single misbehaving upstream server can't take a tool offline.
        const internal = this.client as unknown as {
            _cachedToolOutputValidators?: Map<string, unknown>;
        };
        internal._cachedToolOutputValidators?.clear();

        return result.tools as Tool[];
    }

    /**
     * Calls a tool and returns BOTH the joined text content AND the typed
     * `structuredContent` (when the server ships it). The text is what the
     * model consumes; `structured` is the un-flattened tool output (e.g. the
     * `sources[]` arrays the legal MCP servers return) that callers can read
     * without regex-parsing the text blob. `structured` is `undefined` when
     * the server only returns text blocks, or on any error.
     *
     * Note: the SDK's `outputSchema` validator is cleared in `listTools()`
     * (see comment there) precisely so consuming `structuredContent` here
     * can't be taken offline by a server whose schema doesn't match its
     * actual output. Do not re-enable that validation.
     */
    async callToolRich(
        name: string,
        args: Record<string, unknown>,
    ): Promise<{ text: string; structured?: unknown }> {
        if (!this.client) return { text: "MCP client not connected" };
        try {
            const result = await withTimeout(
                this.client.callTool({ name, arguments: args }),
                CALL_TIMEOUT_MS,
                `MCP callTool(${name})`,
            );
            const blocks = (result.content ?? []) as Array<{
                type?: string;
                text?: string;
            }>;
            const text = blocks
                .filter((b) => b?.type === "text" && typeof b.text === "string")
                .map((b) => b.text)
                .join("\n\n");
            const structured = (result as { structuredContent?: unknown })
                .structuredContent;
            if (result.isError) {
                return {
                    text: `MCP tool '${name}' returned error: ${text || "(no detail)"}`,
                };
            }
            return {
                text: text || "(tool returned no text content)",
                structured,
            };
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return { text: `MCP tool '${name}' failed: ${msg}` };
        }
    }

    /**
     * Calls a tool and returns its text content joined by blank lines.
     * Thin convenience wrapper over `callToolRich` for the many callers that
     * only need the text. Errors (transport failures, MCP `isError`) are
     * turned into a text response so the model can surface them rather than
     * crashing the chat.
     */
    async callTool(
        name: string,
        args: Record<string, unknown>,
    ): Promise<string> {
        const { text } = await this.callToolRich(name, args);
        return text;
    }

    async close(): Promise<void> {
        try {
            await this.client?.close();
        } catch {
            /* ignore */
        }
        try {
            await this.transport?.close();
        } catch {
            /* ignore */
        }
        this.client = null;
        this.transport = null;
    }
}

function withTimeout<T>(
    p: Promise<T>,
    ms: number,
    label: string,
): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const t = setTimeout(
            () => reject(new Error(`${label} timed out after ${ms}ms`)),
            ms,
        );
        p.then(
            (v) => {
                clearTimeout(t);
                resolve(v);
            },
            (e) => {
                clearTimeout(t);
                reject(e);
            },
        );
    });
}
