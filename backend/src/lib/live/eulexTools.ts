/**
 * EULEX pravne baze za gpt-live delegaciju.
 *
 * Isti EULEX MCP server (mcp.eulex.ai, partner JWT po korisniku) koji chat i
 * Realtime put već koriste — ovdje se njegovi alati (1) izlistaju i pretvore u
 * Responses *function* definicije za backend model sesije, i (2) izvršavaju
 * na zahtjev aplikacije (POST /realtime/live/tool), jer u Responses delegaciji
 * function pozive izvršava klijent. Partner JWT nikad ne napušta server.
 */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";

import { harvestLegalSources } from "../chatTools";
import { McpHttpClient } from "../mcp/client";
import { mintEulexPartnerToken, type EulexPartnerTier } from "../mcp/partnerJwt";
import {
    boundToolOutput,
    functionName,
    progressHint,
    sourceLabels,
    toFunctionTool,
    type LiveFunctionTool,
    type LiveSourceLabel,
    type ProgressHint,
} from "./protocol";

export const EULEX_MCP_URL = "https://mcp.eulex.ai/mcp";
const LIST_TTL_MS = 10 * 60 * 1000;

type CachedList = { tools: Tool[]; fetchedAt: number };
// Popis alata je isti za sve korisnike istog tiera; token je samo za pristup.
const listCache = new Map<EulexPartnerTier, CachedList>();

function eulexClient(userId: string, tier: EulexPartnerTier): McpHttpClient {
    const token = mintEulexPartnerToken(userId, tier);
    if (!token) throw new Error("EULEX partner integration not configured");
    return new McpHttpClient(EULEX_MCP_URL, { Authorization: `Bearer ${token}` });
}

async function listEulexTools(userId: string, tier: EulexPartnerTier): Promise<Tool[]> {
    const cached = listCache.get(tier);
    if (cached && Date.now() - cached.fetchedAt < LIST_TTL_MS) return cached.tools;
    const client = eulexClient(userId, tier);
    try {
        await client.connect();
        const tools = await client.listTools();
        listCache.set(tier, { tools, fetchedAt: Date.now() });
        return tools;
    } finally {
        await client.close();
    }
}

/** Function definicije za `delegation.responses.tools`. */
export async function listEulexFunctionTools(
    userId: string,
    tier: EulexPartnerTier,
): Promise<LiveFunctionTool[]> {
    const tools = await listEulexTools(userId, tier);
    return tools.map(toFunctionTool);
}

// NAPOMENA (provjereno 4.9.2026. na alphi): Responses delegacija prihvaća SAMO
// `function` i `web_search` alate — hosted `mcp` alat validator odbija
// ("Invalid value: 'mcp'"), pa EULEX ide isključivo kroz function pozive.

export type EulexToolResult = {
    output: string;
    sources: LiveSourceLabel[];
    tool: string;
    /** Kratka napomena za naglas ("gledam Zakon o…") dok odgovor još dolazi. */
    progress: ProgressHint | null;
};

/**
 * Izvrši jedan function poziv iz sesije. Ime dolazi sanitizirano (functionName),
 * pa se preslikava natrag na originalno MCP ime iz (keširanog) popisa. Greške
 * se vraćaju kao tekst — model ih mora vidjeti, a sesija ne smije pasti.
 */
export async function callEulexTool(
    userId: string,
    tier: EulexPartnerTier,
    name: string,
    rawArguments: unknown,
): Promise<EulexToolResult> {
    const tools = await listEulexTools(userId, tier);
    const match = tools.find((t) => t.name === name || functionName(t.name) === name);
    if (!match) {
        return { output: JSON.stringify({ error: `unknown tool '${name}'` }), sources: [], tool: name, progress: null };
    }
    let args: Record<string, unknown> = {};
    if (typeof rawArguments === "string") {
        try {
            args = rawArguments.trim() ? (JSON.parse(rawArguments) as Record<string, unknown>) : {};
        } catch {
            return {
                output: JSON.stringify({ error: "arguments are not valid JSON" }),
                sources: [],
                tool: match.name,
                progress: null,
            };
        }
    } else if (rawArguments && typeof rawArguments === "object") {
        args = rawArguments as Record<string, unknown>;
    }

    const client = eulexClient(userId, tier);
    try {
        await client.connect();
        const { text, structured } = await client.callToolRich(match.name, args);
        // Izvori se beru iz NEskraćenog outputa (rezanje bi pojelo rep JSON-a).
        const sources = sourceLabels(harvestLegalSources({ text, structured }));
        return {
            output: boundToolOutput(text),
            sources,
            tool: match.name,
            progress: progressHint({ tool: match.name, args, sources }),
        };
    } finally {
        await client.close();
    }
}

/** Za testove / hladni start: očisti keš popisa alata. */
export function __resetEulexToolCache(): void {
    listCache.clear();
}
