/**
 * Prompt-pack fetch-and-cache client (governance/prompt service design §2
 * channel A; contract: contracts/prompt-pack.openapi.json).
 *
 * Optional seam: inert without GOVERNANCE_URL (standalone-core rule).
 * Block texts are OPAQUE to the core except the documented placeholder
 * tokens ({{GROUNDING_POINT_1}}, {{ACTIVE_JURISDICTIONS}}) substituted at
 * assembly time — no legal-methodology content lives in this repo.
 *
 * Posture (never throws into the hot path):
 *   - request path reads ONLY the in-memory cache (`getPromptPack()` is sync);
 *   - a background refresh runs at module init and every ~5 min, revalidating
 *     with ETag (304 → keep the cached pack);
 *   - refresh failure → keep serving the last-known pack;
 *   - no cache yet and service unreachable / env unset → null, and callers
 *     fall back to the short GENERIC block set below.
 */
import { mintServiceToken } from "./serviceIdentity";

export interface PromptPackBlocks {
    method: string;
    citations_legal: string;
    grounding: string;
    grounding_point1_eulex: string;
    grounding_point1_generic: string;
    jurisdictions: string;
    layered_research: string;
    topic_routing: string;
    locale_legal: { hr: string; en: string };
}

export interface WorkflowPack {
    id: string;
    title: string;
    /**
     * Verbatim workflow prompt (assistant packs). Tabular packs may carry
     * null/absent prompt_md and drive the UI via columns_config instead.
     */
    prompt_md?: string | null;
    /**
     * Provider-defined extra fields (type, practice, columns_config, …)
     * pass through UNTOUCHED to GET /workflows/builtin — the core never
     * interprets them beyond the read_workflow prompt lookup.
     */
    [extra: string]: unknown;
}

export interface PromptPack {
    version: number;
    blocks: PromptPackBlocks;
    workflow_packs: WorkflowPack[];
    enrichment_prompt: string;
}

const REFRESH_INTERVAL_MS = 5 * 60_000;
const FETCH_TIMEOUT_MS = 10_000;

/**
 * Generic fallback blocks — served when no pack has ever been fetched
 * (env unset, or the service has been unreachable since boot). Deliberately
 * short and jurisdiction-neutral: the core stays a functional, careful
 * legal assistant, visibly less specialized. Empty string = insert nothing
 * at that assembly position.
 */
export const GENERIC_PROMPT_BLOCKS: PromptPackBlocks = {
    method: [
        "LEGAL METHOD (generic):",
        "You are a careful legal assistant. Identify the precise legal question and state the jurisdiction(s) your answer relies on before answering.",
        "Ground answers in the sources available to you (provided documents and retrieval tools); when no source is available, present the answer as general legal information, not as verified law in force.",
        "Never fabricate citations, article numbers, case numbers, dates, deadlines, rates, thresholds, or official references — omit them or mark them as unverified instead.",
        "Separate the text of the law from your own interpretation, and quote operative wording exactly when you rely on it.",
        "You assist a qualified professional: recommend independent review by a qualified lawyer before any output is relied on.",
    ].join("\n"),
    citations_legal: [
        "LEGAL SOURCE CITATIONS — IN PROSE, NEVER A [N] MARKER:",
        "Cite statutes, regulations, and case law inline in prose by their full name and provision number; the [N] + <CITATIONS> mechanism is exclusively for the user's uploaded or generated documents. Only cite provisions actually returned by a tool or a provided document this turn.",
    ].join("\n"),
    grounding:
        "\n\n---\nGROUNDING SOURCES — live research tools are available for this user. Treat them as the primary source for any claim they cover: query them before relying on memory, quote and cite from their returned text, and say plainly when they return nothing relevant instead of substituting unverified knowledge.\n---\n",
    grounding_point1_eulex: "",
    grounding_point1_generic: "",
    jurisdictions:
        "\n\n---\n<available_legal_sources>\nActive legal jurisdictions / domain sources for this session: {{ACTIVE_JURISDICTIONS}}.\nState which of these your answer relies on, and do not fabricate the law of a jurisdiction outside this set — say plainly that the source is not enabled.\n</available_legal_sources>\n---\n",
    layered_research: "",
    topic_routing: "",
    locale_legal: { hr: "", en: "" },
};

let cached: PromptPack | null = null;
let cachedEtag: string | null = null;
let refreshTimer: NodeJS.Timeout | null = null;

function governanceUrl(): string | null {
    const url = process.env.GOVERNANCE_URL?.trim();
    return url ? url.replace(/\/+$/, "") : null;
}

/** The cached pack, or null when none has ever been fetched. Sync — safe on the request path. */
export function getPromptPack(): PromptPack | null {
    return cached;
}

/** Active pack version for telemetry (/health, evals manifests); null when no pack is loaded. */
export function getPromptPackVersion(): number | null {
    return cached?.version ?? null;
}

/**
 * Blocks for prompt assembly: the cached pack's, else the generic fallback.
 * Callers substitute placeholders and skip empty blocks — never null.
 */
export function getPromptBlocks(): PromptPackBlocks {
    return cached?.blocks ?? GENERIC_PROMPT_BLOCKS;
}

/** Workflow packs from the cached pack; empty without one (standalone posture). */
export function getWorkflowPacks(): WorkflowPack[] {
    return cached?.workflow_packs ?? [];
}

function parsePack(raw: unknown): PromptPack | null {
    if (!raw || typeof raw !== "object") return null;
    const o = raw as Record<string, unknown>;
    if (typeof o.version !== "number") return null;
    const blocks = o.blocks as Record<string, unknown> | undefined;
    if (!blocks || typeof blocks !== "object") return null;
    const locale = blocks.locale_legal as Record<string, unknown> | undefined;
    const str = (v: unknown): string => (typeof v === "string" ? v : "");
    return {
        version: o.version,
        blocks: {
            method: str(blocks.method),
            citations_legal: str(blocks.citations_legal),
            grounding: str(blocks.grounding),
            grounding_point1_eulex: str(blocks.grounding_point1_eulex),
            grounding_point1_generic: str(blocks.grounding_point1_generic),
            jurisdictions: str(blocks.jurisdictions),
            layered_research: str(blocks.layered_research),
            topic_routing: str(blocks.topic_routing),
            locale_legal: { hr: str(locale?.hr), en: str(locale?.en) },
        },
        workflow_packs: Array.isArray(o.workflow_packs)
            ? (o.workflow_packs as unknown[])
                  // Keep entries as-is (rich shape passes through); only
                  // id + title are required by the core.
                  .filter(
                      (w): w is WorkflowPack =>
                          !!w &&
                          typeof w === "object" &&
                          typeof (w as WorkflowPack).id === "string" &&
                          typeof (w as WorkflowPack).title === "string",
                  )
            : [],
        enrichment_prompt: str(o.enrichment_prompt),
    };
}

/**
 * One revalidation round-trip. Never throws; every failure path keeps the
 * last-known pack. Exposed for tests and for an explicit boot kick.
 */
export async function refreshPromptPack(): Promise<void> {
    const base = governanceUrl();
    if (!base) return;
    try {
        const headers: Record<string, string> = { accept: "application/json" };
        // System-level fetch — one pack per deployment, not per user.
        const token = mintServiceToken("governance", "core");
        if (token) headers.authorization = `Bearer ${token}`;
        if (cachedEtag) headers["if-none-match"] = cachedEtag;

        const resp = await fetch(`${base}/prompt-pack`, {
            headers,
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        if (resp.status === 304) return; // unchanged — keep cached copy
        if (!resp.ok) {
            console.warn(
                `[promptPack] refresh failed (HTTP ${resp.status}) — keeping last-known pack`,
            );
            return;
        }
        const pack = parsePack(await resp.json());
        if (!pack) {
            console.warn("[promptPack] malformed pack payload — keeping last-known pack");
            return;
        }
        const isNew = cached?.version !== pack.version;
        cached = pack;
        cachedEtag = resp.headers.get("etag");
        if (isNew) console.log(`[promptPack] loaded pack version ${pack.version}`);
    } catch (err) {
        console.warn(
            "[promptPack] refresh failed — keeping last-known pack:",
            err instanceof Error ? err.message : String(err),
        );
    }
}

/**
 * Kick off the initial fetch + the ~5 min background revalidation loop.
 * No-op when GOVERNANCE_URL is unset or the loop is already running; the
 * interval is unref'd so it never keeps the process alive.
 */
export function startPromptPackRefresh(): void {
    if (!governanceUrl() || refreshTimer) return;
    void refreshPromptPack();
    refreshTimer = setInterval(() => void refreshPromptPack(), REFRESH_INTERVAL_MS);
    refreshTimer.unref?.();
}

// Boot posture: refresh starts at module load (request handlers only ever
// read the cache). With GOVERNANCE_URL unset this is a pure no-op — no
// timer, no socket (standalone-core rule).
startPromptPackRefresh();

/** Test/harness hook: pin the cached pack without any network. */
export function __setPromptPackForTests(pack: PromptPack | null): void {
    cached = pack;
    cachedEtag = null;
}

/** Test hook: drop cache, etag, and the refresh loop. */
export function __resetPromptPackForTests(): void {
    cached = null;
    cachedEtag = null;
    if (refreshTimer) {
        clearInterval(refreshTimer);
        refreshTimer = null;
    }
}
