// Shared types for the LLM provider adapter.
// Callers always speak OpenAI-style tools + { role, content } messages; each
// provider translates internally.

export type Provider = "claude" | "gemini" | "openai" | "mistral";

export type OpenAIToolSchema = {
    type: "function";
    function: {
        name: string;
        description: string;
        parameters: Record<string, unknown>;
    };
};

export type LlmMessage = {
    role: "user" | "assistant";
    content: string;
};

export type NormalizedToolCall = {
    id: string;
    name: string;
    input: Record<string, unknown>;
};

export type NormalizedToolResult = {
    tool_use_id: string;
    content: string;
};

export type StreamCallbacks = {
    onReasoningDelta?: (text: string) => void;
    onReasoningBlockEnd?: () => void;
    onContentDelta?: (text: string) => void;
    onToolCallStart?: (call: NormalizedToolCall) => void;
};

export type UserApiKeys = {
    claude?: string | null;
    gemini?: string | null;
    openai?: string | null;
    mistral?: string | null;
};

/**
 * User-facing reasoning intensity. Maps 1:1 to provider-native values:
 *   - Anthropic Claude 4.x: `output_config.effort` ("low" | "medium" | "high")
 *   - OpenAI GPT-5: `reasoning_effort` ("low" | "medium" | "high")
 *   - Google Gemini 3.x: `thinkingConfig.thinkingLevel` ("low" | "medium" | "high")
 *
 * Mistral Small/Medium expose only a binary `reasoning_effort: "none" | "high"`
 * (no low/medium/high dial): the adapter maps our "high" → "high" and anything
 * else → "none". Mistral Large and our LocalLLM (vLLM-served) tier ignore the
 * value entirely. `enableThinking` still controls whether thoughts are
 * surfaced (Gemini) / requested (Claude).
 */
export type ReasoningEffort = "low" | "medium" | "high";

export type StreamChatParams = {
    model: string;
    systemPrompt: string;
    /**
     * Optional dynamic tail appended AFTER `systemPrompt` in the system
     * message. Holds per-turn context that would otherwise bust prompt
     * caching of the large static prompt (e.g. the AVAILABLE DOCUMENTS
     * list, whose doc-N slugs are reassigned each turn). The Claude
     * adapter places it in a separate, UNcached system block so the static
     * prefix keeps hitting the cache; non-caching adapters simply fold it
     * back onto `systemPrompt` (see streamChatWithTools).
     */
    systemDynamicSuffix?: string;
    messages: LlmMessage[];
    tools?: OpenAIToolSchema[];
    maxIterations?: number;
    callbacks?: StreamCallbacks;
    runTools?: (calls: NormalizedToolCall[]) => Promise<NormalizedToolResult[]>;
    apiKeys?: UserApiKeys;
    /**
     * Enable provider-side reasoning/thinking. Off by default — should only
     * be turned on for interactive chat surfaces where the user actually
     * benefits from seeing the thought stream. Bulk extraction jobs and
     * one-shot completions should leave this off to save tokens and latency.
     */
    enableThinking?: boolean;
    /**
     * How hard the model should "think" before responding, when reasoning
     * is enabled. Defaults to "high" for backwards compatibility (the
     * value we hard-coded before this knob was wired to the UI). Ignored
     * by providers that have no effort dial (Mistral Large, LocalLLM);
     * Mistral Small/Medium collapse it to a binary none|high.
     */
    reasoningEffort?: ReasoningEffort;
    /**
     * Opt-in: attach Anthropic's native server-side `web_search` tool to the
     * Claude request. Independent of our multi-provider custom `web_search`
     * tool (Tavily/Exa/Parallel/You), which keeps working as before.
     *
     * Trade-offs vs. the custom tool:
     *  - billed at $10/1k searches by Anthropic on top of token cost
     *    (≈ $0.05 / turn at max_uses=5)
     *  - must be enabled in the Anthropic Console by an org admin
     *  - results are returned inline as `web_search_tool_result` blocks
     *    that Claude cites in-text — we do NOT map them to our SSE
     *    `web_search_started`/`web_search_result` events, so the UI shows
     *    a normal answer with citation links rather than a source panel
     *  - only attaches when `model` is a Claude model
     *
     * If left undefined we fall back to the env switch
     * `CLAUDE_NATIVE_WEB_SEARCH=true|false` so we can flip it on a single
     * Cloud Run deploy without redeploying every caller.
     */
    enableWebSearch?: boolean;
};

/**
 * Per-turn token usage. For Claude this is summed across the
 * entire tool-use loop (every Anthropic API call inside a single
 * user turn contributes its own usage block). Counts are the
 * authoritative numbers returned by the provider — we never
 * estimate them client-side.
 */
export type LlmUsage = {
    inputTokens: number;
    outputTokens: number;
    cacheCreationInputTokens: number;
    cacheReadInputTokens: number;
    /** Number of provider API calls that contributed to this usage. */
    iterations: number;
};

export type StreamChatResult = {
    fullText: string;
    /**
     * Token usage for the whole turn. Undefined when the provider
     * does not report usage (or when we did not yet wire it up for
     * that adapter). Cost (USD) is computed by the caller from this.
     */
    usage?: LlmUsage;
};
