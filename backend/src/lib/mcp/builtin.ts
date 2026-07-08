// Built-in (server-side) MCP server loader.
//
// Reads MCP server definitions from a JSON file on disk and exposes them to
// every chat request — identical wire format to user-configured connectors
// (loaders return the same `LoadedMcpServer` shape), but **never** persisted
// to Postgres and **never** surfaced via /user/mcp-servers. They show up
// only as additional tools in the LLM's tool list.
//
// Lookup order (first match wins):
//   1. process.env.MIKE_MCP_CONFIG  (absolute path)
//   2. <cwd>/mike/mcp.json
//   3. <cwd>/../mike/mcp.json     (backend started from `backend/`)
//   4. /app/mike/mcp.json         (Docker default)
//
// The file is reparsed lazily when its mtime changes, so an operator can edit
// `mike/mcp.json` and the change picks up on the next chat request — no
// process restart needed.

import { promises as fs } from "fs";
import path from "path";
import { createHash } from "crypto";
import type { OpenAIToolSchema } from "../llm/types";
import type { createServerSupabase } from "../supabase";
import { query } from "../db";
import { McpHttpClient } from "./client";
import { prefixedToolName } from "./servers";
import type { LoadedMcpServer, McpServerRow } from "./types";
import { mintEulexPartnerToken, isEulexPartnerConfigured } from "./partnerJwt";

const SLUG_RE = /^[a-z0-9_-]{1,20}$/;
const BUILTIN_SLUG_PREFIX = "sys-";
const ENV_VAR_RE = /\$\{([A-Z0-9_]+)\}/g;

type Db = ReturnType<typeof createServerSupabase>;

type BuiltinMcpEntry = {
    name?: string;
    url: string;
    headers?: Record<string, string>;
    // `enabled: false` is the operator hard off-switch — the server is skipped
    // entirely (not loaded, not listed, invisible to users).
    enabled?: boolean;
    // `defaultEnabled: false` keeps the connector VISIBLE and toggleable but
    // OFF until a user opts in (a `user_mcp_builtin_prefs` row with
    // enabled = true). Omitted/true → default-on with opt-out (legacy behaviour).
    defaultEnabled?: boolean;
};

type BuiltinMcpFile = {
    mcpServers?: Record<string, BuiltinMcpEntry>;
};

type ParsedEntry = {
    slug: string;
    name: string;
    url: string;
    headers: Record<string, string>;
    // Effective default when the user has no explicit pref row. true =
    // default-on (opt-out), false = default-off (opt-in but still listed).
    defaultEnabled: boolean;
};

type Cache = {
    path: string;
    mtimeMs: number;
    entries: ParsedEntry[];
};

let cache: Cache | null = null;
let missLogged = false;

// ---------------------------------------------------------------------------
// Hardcoded partner connector: EULEX
// ---------------------------------------------------------------------------
// Eulex is NOT in mcp.json — it uses a dynamically minted partner JWT per user
// instead of a static header. When MAX_EULEX_PARTNER_SECRET is set, this
// function returns a ParsedEntry with a freshly minted Bearer token.

const EULEX_SLUG = `${BUILTIN_SLUG_PREFIX}eulex`;
const EULEX_NAME = "EU";
const EULEX_URL = "https://mcp.eulex.ai/mcp";

function buildEulexPartnerEntry(userId: string): ParsedEntry | null {
    const token = mintEulexPartnerToken(userId);
    if (!token) return null;
    return {
        slug: EULEX_SLUG,
        name: EULEX_NAME,
        url: EULEX_URL,
        headers: { Authorization: `Bearer ${token}` },
        defaultEnabled: true,
    };
}

function candidatePaths(): string[] {
    const out: string[] = [];
    const fromEnv = process.env.MIKE_MCP_CONFIG?.trim();
    if (fromEnv) out.push(fromEnv);
    const cwd = process.cwd();
    out.push(path.join(cwd, "mike", "mcp.json"));
    out.push(path.join(cwd, "..", "mike", "mcp.json"));
    out.push("/app/mike/mcp.json");
    return out;
}

async function resolveConfigPath(): Promise<string | null> {
    for (const p of candidatePaths()) {
        try {
            const st = await fs.stat(p);
            if (st.isFile()) return p;
        } catch {
            /* not present — try next */
        }
    }
    return null;
}

function substituteEnv(value: string, ctx: string): string {
    return value.replace(ENV_VAR_RE, (_match, name: string) => {
        const v = process.env[name];
        if (v === undefined) {
            console.warn(
                `[mcp-builtin] env var \${${name}} referenced by ${ctx} is not set; substituting empty string`,
            );
            return "";
        }
        return v;
    });
}

function validateUrl(raw: string): boolean {
    try {
        const u = new URL(raw);
        if (u.protocol === "https:") return true;
        if (
            u.protocol === "http:" &&
            (u.hostname === "localhost" || u.hostname === "127.0.0.1")
        ) {
            return true;
        }
        return false;
    } catch {
        return false;
    }
}

function parseFile(raw: string, sourcePath: string): ParsedEntry[] {
    let json: BuiltinMcpFile;
    try {
        json = JSON.parse(raw) as BuiltinMcpFile;
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[mcp-builtin] failed to parse ${sourcePath}: ${msg}`);
        return [];
    }
    const servers = json.mcpServers;
    if (!servers || typeof servers !== "object") return [];

    const out: ParsedEntry[] = [];
    for (const [rawKey, entry] of Object.entries(servers)) {
        if (!entry || typeof entry !== "object") continue;
        if (entry.enabled === false) continue;

        const key = rawKey.trim().toLowerCase();
        if (!SLUG_RE.test(key)) {
            console.warn(
                `[mcp-builtin] skipping '${rawKey}' — slug must match ${SLUG_RE} (1–20 chars, lowercase)`,
            );
            continue;
        }

        if (typeof entry.url !== "string" || !entry.url.trim()) {
            console.warn(
                `[mcp-builtin] skipping '${rawKey}' — missing or empty 'url'`,
            );
            continue;
        }
        const url = substituteEnv(entry.url.trim(), `${rawKey}.url`);
        if (!validateUrl(url)) {
            console.warn(
                `[mcp-builtin] skipping '${rawKey}' — url '${url}' must use https (or http://localhost)`,
            );
            continue;
        }

        const headers: Record<string, string> = {};
        if (entry.headers && typeof entry.headers === "object") {
            for (const [hk, hv] of Object.entries(entry.headers)) {
                if (typeof hv !== "string") continue;
                headers[hk] = substituteEnv(hv, `${rawKey}.headers.${hk}`);
            }
        }

        const name = (typeof entry.name === "string" && entry.name.trim()) || key;
        const defaultEnabled = entry.defaultEnabled !== false;

        out.push({
            slug: `${BUILTIN_SLUG_PREFIX}${key}`,
            name,
            url,
            headers,
            defaultEnabled,
        });
    }
    return out;
}

async function loadConfig(): Promise<ParsedEntry[]> {
    const resolved = await resolveConfigPath();
    if (!resolved) {
        if (!missLogged) {
            console.info(
                "[mcp-builtin] no built-in MCP config found (looked at MIKE_MCP_CONFIG, ./mike/mcp.json, ../mike/mcp.json, /app/mike/mcp.json)",
            );
            missLogged = true;
        }
        cache = null;
        return [];
    }
    missLogged = false;

    const st = await fs.stat(resolved);
    if (cache && cache.path === resolved && cache.mtimeMs === st.mtimeMs) {
        return cache.entries;
    }

    const raw = await fs.readFile(resolved, "utf8");
    const entries = parseFile(raw, resolved);
    cache = { path: resolved, mtimeMs: st.mtimeMs, entries };
    console.info(
        `[mcp-builtin] loaded ${entries.length} server(s) from ${resolved}`,
    );
    return entries;
}

/**
 * Construct a minimal `McpServerRow` for a built-in entry. Most fields are
 * never read after loading (the chat dispatcher only touches `row.name`,
 * `row.slug`, and `row.url`), so we fill the rest with safe stubs and a
 * deterministic synthetic `id` derived from the slug.
 */
function stubRow(e: ParsedEntry): McpServerRow {
    const id =
        "builtin-" +
        createHash("sha256").update(e.slug).digest("hex").slice(0, 16);
    return {
        id,
        user_id: "__builtin__",
        slug: e.slug,
        name: e.name,
        url: e.url,
        headers: e.headers,
        enabled: true,
        last_error: null,
        auth_type: "headers",
        oauth_metadata: null,
        oauth_tokens: null,
        oauth_code_verifier: null,
    };
}

/**
 * Read the user's per-builtin pref map. Returns a Map<slug, enabled>
 * containing only the EXPLICIT toggles the user has saved; a missing slug
 * means "no preference" and the caller falls back to the connector's
 * configured default (`defaultEnabled` — default-on for legacy entries,
 * default-off for opt-in ones).
 *
 * Resilient on purpose: a DB hiccup must not block chat. Returns an empty
 * map (= every connector falls back to its configured default) on failure.
 */
async function readUserBuiltinPrefs(
    userId: string,
    db: Db,
): Promise<Map<string, boolean>> {
    try {
        const { data, error } = await db
            .from("user_mcp_builtin_prefs")
            .select("slug, enabled")
            .eq("user_id", userId);
        if (error || !data) return new Map();
        const out = new Map<string, boolean>();
        for (const row of data as { slug: string; enabled: boolean }[]) {
            out.set(row.slug, row.enabled === true);
        }
        return out;
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[mcp-builtin] prefs lookup failed for ${userId}: ${msg}`);
        return new Map();
    }
}

/**
 * Open Streamable-HTTP clients for every built-in server the user has
 * enabled, list their tools, and return them in Eulex Desk's standard
 * `LoadedMcpServer` shape so the chat handler can concatenate them with
 * the per-user connectors.
 *
 * Per-user filter: each builtin defaults to enabled; a row in
 * `user_mcp_builtin_prefs` with `enabled = false` opts the user out of
 * that specific connector for every chat request. When `userId`/`db` are
 * omitted (e.g. tests), all configured builtins load.
 *
 * Failures are isolated per server: a misbehaving builtin logs a warning
 * and is dropped from the result; the rest still load. Never throws.
 */
export async function loadBuiltinMcpServers(
    userId?: string,
    db?: Db,
): Promise<LoadedMcpServer[]> {
    let entries: ParsedEntry[];
    try {
        entries = await loadConfig();
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[mcp-builtin] config load failed: ${msg}`);
        return [];
    }

    // Inject the EULEX partner connector (hardcoded, not from mcp.json).
    // Requires MAX_EULEX_PARTNER_SECRET and a userId for JWT minting.
    if (userId && isEulexPartnerConfigured()) {
        const eulexEntry = buildEulexPartnerEntry(userId);
        if (eulexEntry) entries = [...entries, eulexEntry];
    }

    if (entries.length === 0) return [];

    if (userId && db) {
        const prefs = await readUserBuiltinPrefs(userId, db);
        // No pref row → fall back to the connector's configured default
        // (default-on for legacy entries, default-off for opt-in ones).
        entries = entries.filter((e) => {
            const pref = prefs.get(e.slug);
            return pref === undefined ? e.defaultEnabled : pref;
        });
        if (entries.length === 0) return [];
    }

    const settled = await Promise.allSettled(
        entries.map(async (e) => {
            const client = new McpHttpClient(e.url, e.headers);
            await client.connect();
            const mcpTools = await client.listTools();
            const row = stubRow(e);
            const tools: OpenAIToolSchema[] = [];
            const toolNameMap = new Map<string, string>();
            for (const t of mcpTools) {
                const prefixed = prefixedToolName(row.slug, t.name);
                toolNameMap.set(prefixed, t.name);
                tools.push({
                    type: "function",
                    function: {
                        name: prefixed,
                        description:
                            `[${row.name}] ${t.description ?? ""}`.trim(),
                        parameters:
                            (t.inputSchema as Record<string, unknown>) ?? {
                                type: "object",
                                properties: {},
                            },
                    },
                });
            }
            const loaded: LoadedMcpServer = {
                row,
                tools,
                toolNameMap,
                client: {
                    callTool: (name, args) => client.callTool(name, args),
                    // Built-in tools don't emit legal-source structuredContent;
                    // expose the rich shape as text-only for type parity.
                    callToolRich: async (name, args) => ({
                        text: await client.callTool(name, args),
                    }),
                    close: () => client.close(),
                },
            };
            return loaded;
        }),
    );

    const out: LoadedMcpServer[] = [];
    for (let i = 0; i < settled.length; i++) {
        const r = settled[i];
        const e = entries[i];
        if (r.status === "fulfilled") {
            out.push(r.value);
        } else {
            const msg =
                r.reason instanceof Error ? r.reason.message : String(r.reason);
            console.warn(
                `[mcp-builtin] failed to load '${e.slug}' (${e.url}): ${msg}`,
            );
        }
    }
    return out;
}

export type BuiltinEntrySummary = {
    slug: string;
    name: string;
    url: string;
    enabled: boolean;
};

/**
 * Return lightweight metadata for every configured built-in server (no
 * network calls). The `enabled` flag is the EFFECTIVE per-user state:
 * defaults to true for every parsed entry, flipped to false only when
 * the user has an explicit opt-out row in `user_mcp_builtin_prefs`.
 *
 * URL is included for diagnostics callers; the public HTTP route strips
 * it before returning to the browser since URLs may carry secrets.
 */
export async function listBuiltinMcpEntriesForUser(
    userId?: string,
    db?: Db,
): Promise<BuiltinEntrySummary[]> {
    let entries: ParsedEntry[];
    try {
        entries = await loadConfig();
    } catch {
        return [];
    }

    // Inject EULEX partner entry so the frontend shows it in the
    // built-in connectors list even though it's not in mcp.json.
    if (isEulexPartnerConfigured()) {
        entries = [
            ...entries,
            {
                slug: EULEX_SLUG,
                name: EULEX_NAME,
                url: EULEX_URL,
                headers: {},
                defaultEnabled: true,
            },
        ];
    }

    const prefs =
        userId && db ? await readUserBuiltinPrefs(userId, db) : new Map<string, boolean>();
    return entries.map((e) => ({
        slug: e.slug, // already includes the 'sys-' prefix from parseFile
        name: e.name,
        url: e.url,
        // Effective per-user state: explicit pref row wins; otherwise the
        // connector's configured default (default-on, or default-off opt-in).
        enabled: prefs.has(e.slug) ? prefs.get(e.slug) === true : e.defaultEnabled,
    }));
}

/** @deprecated Use `listBuiltinMcpEntriesForUser` so per-user toggles are honored. */
export async function listBuiltinMcpEntries(): Promise<BuiltinEntrySummary[]> {
    return listBuiltinMcpEntriesForUser();
}

/**
 * Persist a user's enable/disable choice for a single built-in connector.
 *
 * Validates the slug against the parsed mcp.json so the table never grows
 * orphan rows for slugs the operator never configured. Returns the
 * effective state after the upsert. Uses raw SQL because the dbShim
 * mishandles composite ON CONFLICT keys.
 */
export async function setBuiltinMcpEnabled(
    userId: string,
    slug: string,
    enabled: boolean,
): Promise<{ ok: true; enabled: boolean } | { ok: false; error: string }> {
    let entries: ParsedEntry[];
    try {
        entries = await loadConfig();
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, error: msg };
    }
    // Accept EULEX partner slug even though it's not in mcp.json.
    const knownSlugs = entries.map((e) => e.slug);
    if (isEulexPartnerConfigured()) knownSlugs.push(EULEX_SLUG);
    if (!knownSlugs.includes(slug)) {
        return { ok: false, error: "Unknown built-in connector slug" };
    }
    // Raw SQL on purpose: the in-house dbShim wraps composite onConflict
    // strings into a single quoted identifier, which Postgres rejects.
    // The composite PK upsert here is small and self-contained, so a
    // direct query is the most predictable path.
    try {
        await query(
            `
            INSERT INTO public.user_mcp_builtin_prefs (user_id, slug, enabled)
            VALUES ($1, $2, $3)
            ON CONFLICT (user_id, slug)
            DO UPDATE SET enabled = EXCLUDED.enabled,
                          updated_at = now()
            `,
            [userId, slug, enabled],
        );
        return { ok: true, enabled };
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, error: msg };
    }
}
