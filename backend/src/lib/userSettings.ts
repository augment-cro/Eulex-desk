import { createServerSupabase } from "./supabase";
import {
    resolveModel,
    DEFAULT_MAIN_MODEL,
    DEFAULT_TITLE_MODEL,
    DEFAULT_TABULAR_MODEL,
    type UserApiKeys,
} from "./llm";
export type UserModelSettings = {
    title_model: string;
    tabular_model: string;
    api_keys: UserApiKeys;
    /**
     * UI locale the user selected (mirrors the value the frontend uses
     * via next-intl). We honor this in title generation and any other
     * lightweight LLM call where the result lands directly in the UI,
     * so a Croatian-speaking user gets Croatian chat titles even when
     * their first message was in English.
     */
    preferred_language: string;
    /**
     * PII Shield user defaults. See migration 120 columns on
     * `user_profiles` and `backend/src/lib/pii/gate.ts` for semantics.
     *
     *   pii_default_mode    — applied when a new chat doesn't specify
     *                          its own mode. "off" disables the sidecar
     *                          for everything that user does.
     *   pii_review_required — force the document-preview modal even
     *                          in "standard" mode.
     *   pii_disclosure_policy — what happens when an LLM tool argument
     *                          would expose PII: "allow", "deny",
     *                          "ask" (frontend prompt).
     */
    pii_default_mode: "off" | "standard" | "strict_legal" | "strict";
    pii_review_required: boolean;
    pii_disclosure_policy: "allow" | "deny" | "ask";
};

/**
 * Pick a sensible main-chat model when the client didn't send one.
 *
 * The Word add-in deliberately ships without a model picker — the user
 * configures preferred providers in the Eulex Desk web app once, and the
 * add-in should "just work". Order of preference:
 *
 *   1. Claude   — Sonnet 4.6 (primary; prod always has a server key wired
 *                via Secret Manager, see cloudbuild.yaml).
 *   2. LocalLLM — if the operator wired up an in-house endpoint and the
 *                user has no Claude entitlement.
 *   3. Gemini   — 3.1 Pro
 *   4. Mistral  — Large
 *   5. OpenAI   — gpt-5.5 (last because OpenAI cost / latency is highest)
 *
 * If none of the above are available, we fall back to `DEFAULT_MAIN_MODEL`
 * and let the downstream client surface its own credentials error, which
 * is at least obvious in logs.
 */
export function resolveDefaultMainModel(apiKeys?: UserApiKeys): string {
    if (apiKeys?.claude?.trim()) return "claude-sonnet-5";
    if (process.env.VLLM_BASE_URL?.trim()) return "localllm-main";
    if (apiKeys?.gemini?.trim()) return "gemini-3.1-pro-preview";
    if (apiKeys?.mistral?.trim()) return "mistral-large-latest";
    if (apiKeys?.openai?.trim()) return "gpt-5.5";
    return DEFAULT_MAIN_MODEL;
}

/**
 * Pick a frontier-tier model for the AI Column Suggester (the floating
 * AI prompt above tabular reviews).
 *
 * Why this exists separately from `tabular_model`:
 *   - `tabular_model` is used for per-cell extraction — a narrow,
 *     well-bounded task that even small / self-hosted models handle
 *     fine. We let users save costs by routing it to `localllm-main`.
 *   - The column SUGGESTER, however, is an agentic flow that has to:
 *       1. parse a free-form user instruction,
 *       2. optionally web-search,
 *       3. emit a tool call with strict JSON shape,
 *       4. obey strong language directives (HR / EN),
 *       5. follow few-shot examples to the letter.
 *     Smaller / OSS models routinely fail step 4 (drop language) and
 *     step 5 (ignore examples), which is exactly the "why is the LLM
 *     answering in English?" bug we kept hitting.
 *
 * So here we *deliberately* skip `localllm-main` and any cheap-tier
 * variants, and pick the strongest available frontier model from
 * whatever provider keys are wired up.
 */
export function resolveColumnSuggesterModel(apiKeys?: UserApiKeys): string {
    if (apiKeys?.claude?.trim()) return "claude-sonnet-5";
    if (apiKeys?.gemini?.trim()) return "gemini-3.1-pro-preview";
    if (apiKeys?.mistral?.trim()) return "mistral-large-latest";
    if (apiKeys?.openai?.trim()) return "gpt-5.5";
    // Last resort — only fall back to localllm if literally nothing
    // else is configured; otherwise honor DEFAULT_MAIN_MODEL.
    if (process.env.VLLM_BASE_URL?.trim()) return "localllm-main";
    return DEFAULT_MAIN_MODEL;
}

// Title generation is a lightweight task — routed to the default title model
// (Claude Sonnet) which prod always has wired via Secret Manager, then falls
// back through cheaper per-provider models.
function resolveTitleModel(apiKeys: UserApiKeys): string {
    // Claude first — prod always has ANTHROPIC_API_KEY
    if (apiKeys.claude?.trim()) return DEFAULT_TITLE_MODEL;
    // LocalLLM for self-hosters
    if (process.env.VLLM_BASE_URL?.trim()) return "localllm-lite";
    // Other providers — cheapest tier each
    if (apiKeys.gemini?.trim()) return "gemini-3.1-flash-lite-preview";
    if (apiKeys.openai?.trim()) return "gpt-5.4-nano";
    if (apiKeys.mistral?.trim()) return "mistral-small-latest";
    // Fall back to server-level env keys
    if (
        process.env.ANTHROPIC_API_KEY?.trim() ||
        process.env.CLAUDE_API_KEY?.trim()
    )
        return DEFAULT_TITLE_MODEL;
    if (process.env.GEMINI_API_KEY?.trim()) return "gemini-3.1-flash-lite-preview";
    if (process.env.OPENAI_API_KEY?.trim()) return "gpt-5.4-nano";
    if (process.env.MISTRAL_API_KEY?.trim()) return "mistral-small-latest";
    return DEFAULT_TITLE_MODEL;
}

/**
 * Fast model for INLINE ghost text (autocomplete + inline question
 * refinement). Unlike resolveTitleModel — which returns Sonnet for Claude —
 * this picks each provider's low/fast tier so inline suggestions feel snappy.
 * The task is easy (complete a sentence / rephrase one question), so latency
 * matters more than raw capability. Output language is pinned by
 * shortLocaleRule, which keeps even the small models on Croatian.
 */
export function resolveInlineModel(apiKeys: UserApiKeys): string {
    if (apiKeys.claude?.trim()) return "claude-haiku-4-5";
    if (process.env.VLLM_BASE_URL?.trim()) return "localllm-lite";
    if (apiKeys.gemini?.trim()) return "gemini-3.1-flash-lite-preview";
    if (apiKeys.openai?.trim()) return "gpt-5.4-nano";
    if (apiKeys.mistral?.trim()) return "mistral-small-latest";
    if (
        process.env.ANTHROPIC_API_KEY?.trim() ||
        process.env.CLAUDE_API_KEY?.trim()
    )
        return "claude-haiku-4-5";
    if (process.env.GEMINI_API_KEY?.trim()) return "gemini-3.1-flash-lite-preview";
    if (process.env.OPENAI_API_KEY?.trim()) return "gpt-5.4-nano";
    if (process.env.MISTRAL_API_KEY?.trim()) return "mistral-small-latest";
    return "claude-haiku-4-5";
}

/**
 * Resolve the effective key for a single provider.
 *
 * Hosted Eulex Desk runs every user through shared server-level keys (Secret
 * Manager) — that's the only source of truth for billing, audit, and
 * the tier-based rate limiter. We deliberately ignore any user-stored
 * `*_api_key` rows (legacy BYOK feature, removed 2026-05). The unused
 * `_userKey` argument is kept so call-sites don't all have to change
 * shape; rename it once we drop the columns from DB.
 */
function pickKey(
    _userKey: string | null | undefined,
    serverKey: string | null | undefined,
): string | null {
    return serverKey?.trim() ?? null;
}

export async function getUserModelSettings(
    userId: string,
    db?: ReturnType<typeof createServerSupabase>,
): Promise<UserModelSettings> {
    const client = db ?? createServerSupabase();
    const { data, error } = await client
        .from("user_profiles")
        .select(
            "tabular_model, preferred_language, claude_api_key, gemini_api_key, openai_api_key, mistral_api_key, " +
            "pii_default_mode, pii_review_required, pii_disclosure_policy",
        )
        .eq("user_id", userId)
        .single();

    if (error) {
        // Most likely cause: a column referenced in SELECT doesn't exist yet
        // (schema out of sync with code). Log and continue with null data so
        // the caller gets safe defaults instead of crashing.
        console.error("[userSettings] user_profiles query failed:", error.message);
    }

    const api_keys: UserApiKeys = {
        claude: pickKey(data?.claude_api_key, serverClaudeKey()),
        gemini: pickKey(data?.gemini_api_key, process.env.GEMINI_API_KEY ?? null),
        openai: pickKey(
            data?.openai_api_key,
            process.env.OPENAI_API_KEY ?? process.env.VLLM_API_KEY ?? null,
        ),
        mistral: pickKey(data?.mistral_api_key, process.env.MISTRAL_API_KEY ?? null),
    };

    const SUPPORTED = new Set(["en", "hr"]);
    const lang =
        typeof data?.preferred_language === "string" &&
        SUPPORTED.has(data.preferred_language)
            ? data.preferred_language
            : "hr";

    const PII_MODES = new Set(["off", "standard", "strict_legal", "strict"] as const);
    const PII_DISCLOSURE = new Set(["allow", "deny", "ask"] as const);
    const piiMode =
        typeof data?.pii_default_mode === "string" &&
        PII_MODES.has(data.pii_default_mode as never)
            ? (data.pii_default_mode as UserModelSettings["pii_default_mode"])
            : "off";
    const piiDisclosure =
        typeof data?.pii_disclosure_policy === "string" &&
        PII_DISCLOSURE.has(data.pii_disclosure_policy as never)
            ? (data.pii_disclosure_policy as UserModelSettings["pii_disclosure_policy"])
            : "ask";

    return {
        title_model: resolveTitleModel(api_keys),
        tabular_model: resolveModel(data?.tabular_model, DEFAULT_TABULAR_MODEL),
        api_keys,
        preferred_language: lang,
        pii_default_mode: piiMode,
        pii_review_required: !!data?.pii_review_required,
        pii_disclosure_policy: piiDisclosure,
    };
}

/**
 * Server-level Anthropic key fallback. Prefer `ANTHROPIC_API_KEY` (the
 * canonical name Anthropic's own SDK + `.env.example` use); accept the
 * legacy `CLAUDE_API_KEY` for backwards compatibility with older
 * deployments. Returning a non-empty server key here means the user
 * doesn't need to paste their own key in Settings — Eulex Desk just works.
 */
function serverClaudeKey(): string | null {
    const fromAnthropic = process.env.ANTHROPIC_API_KEY?.trim();
    if (fromAnthropic) return fromAnthropic;
    const legacy = process.env.CLAUDE_API_KEY?.trim();
    if (legacy) return legacy;
    return null;
}

export async function getUserApiKeys(
    userId: string,
    db?: ReturnType<typeof createServerSupabase>,
): Promise<UserApiKeys> {
    const client = db ?? createServerSupabase();
    const { data, error } = await client
        .from("user_profiles")
        .select("claude_api_key, gemini_api_key, openai_api_key, mistral_api_key")
        .eq("user_id", userId)
        .single();
    if (error) {
        console.error("[userSettings] getUserApiKeys query failed:", error.message);
    }
    return {
        claude: pickKey(data?.claude_api_key, serverClaudeKey()),
        gemini: pickKey(data?.gemini_api_key, process.env.GEMINI_API_KEY ?? null),
        openai: pickKey(
            data?.openai_api_key,
            process.env.OPENAI_API_KEY ?? process.env.VLLM_API_KEY ?? null,
        ),
        mistral: pickKey(data?.mistral_api_key, process.env.MISTRAL_API_KEY ?? null),
    };
}
