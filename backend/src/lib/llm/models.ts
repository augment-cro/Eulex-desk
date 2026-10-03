import type { Provider, ReasoningEffort, StandardEffort } from "./types";

// ---------------------------------------------------------------------------
// Canonical model IDs
// ---------------------------------------------------------------------------
// Main-chat tier (top-end) — user picks one of these per message.
export const CLAUDE_MAIN_MODELS = [
    "claude-opus-5-5",
    "claude-opus-4-8",
    "claude-sonnet-5-5",
] as const;
export const GEMINI_MAIN_MODELS = [
    "gemini-3.1-pro-preview",
    "gemini-3.5-flash",
] as const;
export const OPENAI_MAIN_MODELS = ["gpt-5.5", "gpt-5.4-mini"] as const;
export const LOCAL_LLM_MAIN_MODELS = ["localllm-main"] as const;
export const MISTRAL_MAIN_MODELS = ["mistral-large-latest", "mistral-medium-latest"] as const;

// Mid-tier (used for tabular review) — user picks one in account settings.
export const CLAUDE_MID_MODELS = ["claude-sonnet-5-5"] as const;
export const GEMINI_MID_MODELS = ["gemini-3-flash-preview"] as const;
export const OPENAI_MID_MODELS = ["gpt-5.4-nano"] as const;
export const LOCAL_LLM_MID_MODELS = ["localllm-main"] as const;
export const MISTRAL_MID_MODELS = ["mistral-small-latest"] as const;

// Low-tier (used for title generation, lightweight extractions) — user picks
// one in account settings. Claude's is Sonnet 5.5 since 2026-09-29 (Haiku
// retired here: it mistranslated legal terms and Croatian grammar); speed-
// bound helpers call it at effort "low" / "medium" instead.
export const CLAUDE_LOW_MODELS = ["claude-sonnet-5-5"] as const;
export const GEMINI_LOW_MODELS = ["gemini-3.1-flash-lite-preview"] as const;
export const OPENAI_LOW_MODELS = ["gpt-5.4-nano"] as const;
export const LOCAL_LLM_LOW_MODELS = ["localllm-lite"] as const;
export const MISTRAL_LOW_MODELS = ["mistral-small-latest"] as const;

// Default main model is Claude Opus 5.5 (Sonnet 5 until 2026-09-22) — chosen
// because the prod backend always has ANTHROPIC_API_KEY wired via Secret
// Manager (see cloudbuild.yaml and scripts/deploy.sh `--update-secrets`).
// LocalLLM remains a valid fallback for self-hosters but no longer steals the
// slot when a Claude key is present (resolveDefaultMainModel handles that
// priority). With CLAUDE_PROVIDER=vertex the model must be enabled in Model
// Garden for VERTEX_CLAUDE_PROJECT — otherwise every call 404s and falls back
// to the direct Anthropic API (outside the `eu` region). Titles and tabular
// run on Sonnet 5.5 (Sonnet 5 until 2026-09-29; enabled in Model Garden
// that day).
export const DEFAULT_MAIN_MODEL = "claude-opus-5-5";
export const DEFAULT_TITLE_MODEL = "claude-sonnet-5-5";
// Tabular review default. Must match the `user_profiles.tabular_model`
// column default (migrations 000/104, updated in 131) so a profile-less
// user and a freshly-provisioned profile resolve to the SAME model.
// Claude Sonnet is the tabular tier since migration 131 (Sonnet 5.5 since
// 2026-09-29): legal extraction quality is the product's selling point and
// prod always has ANTHROPIC_API_KEY wired (Secret Manager). The column
// default in the DB is still 'claude-sonnet-5' — MODEL_ALIASES resolves it
// forward, so no migration is needed. NEVER set this to localllm-main:
// prod has no VLLM_BASE_URL, so that would make every fallback tabular run
// fail.
export const DEFAULT_TABULAR_MODEL = "claude-sonnet-5-5";

const ALL_MODELS = new Set<string>([
    ...CLAUDE_MAIN_MODELS,
    ...GEMINI_MAIN_MODELS,
    ...OPENAI_MAIN_MODELS,
    ...LOCAL_LLM_MAIN_MODELS,
    ...MISTRAL_MAIN_MODELS,
    ...CLAUDE_MID_MODELS,
    ...GEMINI_MID_MODELS,
    ...OPENAI_MID_MODELS,
    ...LOCAL_LLM_MID_MODELS,
    ...MISTRAL_MID_MODELS,
    ...CLAUDE_LOW_MODELS,
    ...GEMINI_LOW_MODELS,
    ...OPENAI_LOW_MODELS,
    ...LOCAL_LLM_LOW_MODELS,
    ...MISTRAL_LOW_MODELS,
]);

// ---------------------------------------------------------------------------
// Provider inference
// ---------------------------------------------------------------------------

export function providerForModel(model: string): Provider {
    if (model.startsWith("localllm")) return "openai";
    if (model.startsWith("claude")) return "claude";
    if (model.startsWith("gemini")) return "gemini";
    if (model.startsWith("mistral")) return "mistral";
    if (model.startsWith("gpt-") || model.startsWith("o1-") || model.startsWith("o3-") || model.startsWith("o4-")) return "openai";
    throw new Error(`Unknown model id: ${model}`);
}

/** "xhigh" and "max" are Claude levels; every other provider gets "high". */
export function standardEffort(effort: ReasoningEffort | undefined): StandardEffort | undefined {
    return effort === "xhigh" || effort === "max" ? "high" : effort;
}

/** Retired model IDs still sent by older clients — map to the current GA id.
 * Sonnet 4.6 / 5 and Haiku 4.5 are aliased to Sonnet 5.5 so legacy client
 * selections (Word add-in) and stored `user_profiles.tabular_model` rows
 * (column default 'claude-sonnet-5') resolve forward without a DB
 * migration. */
const MODEL_ALIASES: Record<string, string> = {
    "claude-opus-4-7": "claude-opus-4-8",
    "claude-sonnet-4-6": "claude-sonnet-5-5",
    "claude-sonnet-5": "claude-sonnet-5-5",
    "claude-haiku-4-5": "claude-sonnet-5-5",
};

export function resolveModel(id: string | null | undefined, fallback: string): string {
    if (id) {
        const resolved = MODEL_ALIASES[id] ?? id;
        if (ALL_MODELS.has(resolved)) return resolved;
    }
    return fallback;
}
