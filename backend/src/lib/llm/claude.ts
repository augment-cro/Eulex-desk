import Anthropic from "@anthropic-ai/sdk";
import type { Tool } from "@anthropic-ai/sdk/resources/messages/messages";
import type {
    StreamChatParams,
    StreamChatResult,
    LlmUsage,
    NormalizedToolCall,
    NormalizedToolResult,
} from "./types";
import { toClaudeTools } from "./tools";

const DEBUG_LLM_STREAM = process.env.DEBUG_LLM_STREAM === "true";

type ContentBlock =
    | { type: "text"; text: string }
    | { type: "tool_use"; id: string; name: string; input: unknown }
    | { type: string; [key: string]: unknown };

type NativeMessage = {
    role: "user" | "assistant";
    content: string | ContentBlock[];
};

// Per-API-call output ceiling. We hit the previous 16384 limit on a real
// 9-min, 27k-character turn (chat a1da7265…, 2026-05-13 16:30 UTC) where
// Claude exhausted the budget mid-answer and self-stopped with
// stop_reason="max_tokens" — the user saw it as a truncated reply.
//
// Sonnet 5 supports up to 128_000 output tokens per call (June 2026 API
// docs); we keep the call ceiling at 64_000. Pricing is on consumed, not
// allowed, tokens, so the ceiling has no effective cost when the model
// would have stopped earlier anyway. Worst-case full-budget turn is
// ~64_000 × $15/1M ≈ $0.96 — acceptable for the rare long legal-research
// dump that previously broke. Raise toward 128_000 if longer dumps truncate.
const MAX_TOKENS = 64_000;

// Anthropic native server-side web search tool. Server-tool means Claude
// runs the search inside its inference and returns a `web_search_tool_result`
// content block in the same response — we do NOT see a tool_use callback
// for it, and we are billed $10 per 1k searches on top of token cost
// (≈ $0.05 per turn at max_uses=5). Must be enabled per-org in the
// Anthropic Console before the API will accept it.
//
// The `name` here is intentionally `web_search_native` to avoid colliding
// with our own multi-provider `web_search` custom tool (see WEB_SEARCH_TOOLS
// in chatTools.ts). Anthropic rejects requests with two tools sharing the
// same name. The description tweak below nudges Claude to prefer the
// custom tool when both are present, since it offers richer controls
// (recency_days, source_keys, provider routing).
const NATIVE_WEB_SEARCH_TOOL = {
    type: "web_search_20250305",
    name: "web_search_native",
    max_uses: 5,
    description:
        "Anthropic-hosted web search. Use only when no custom `web_search` tool is available, or when the user asks for a quick general fact-check. Prefer the custom `web_search` tool when present — it supports provider choice, recency filters, and curated source allowlists for legal/regulatory queries.",
} as const;

function shouldAttachNativeWebSearch(flag: boolean | undefined): boolean {
    const explicit = flag ?? null;
    if (explicit !== null) return explicit;
    if (process.env.CLAUDE_NATIVE_WEB_SEARCH === "true") return true;
    return false;
}

function client(override?: string | null): Anthropic {
    const apiKey = override?.trim() || process.env.ANTHROPIC_API_KEY || "";
    // SDK defaults to maxRetries = 2 with exponential backoff, which is
    // not enough for the transient `UND_ERR_SOCKET: other side closed`
    // failures we see on Cloud Run mid-stream (revision swaps, idle
    // socket resets — see https://github.com/anthropics/claude-code/issues/37930).
    // Bumped to 5 + a generous per-request timeout (10 min) so the SDK
    // re-establishes the stream before the user-visible "load failed".
    return new Anthropic({
        apiKey,
        maxRetries: 5,
        timeout: 600_000,
    });
}

function toNativeMessages(
    messages: StreamChatParams["messages"],
): NativeMessage[] {
    return messages.map((m) => ({ role: m.role, content: m.content }));
}

// ---------------------------------------------------------------------------
// Prompt caching helpers
// ---------------------------------------------------------------------------

/**
 * Wrap the system prompt as a single-element array so we can attach
 * `cache_control: { type: "ephemeral" }` to it. Anthropic caches the
 * marked block for 5 minutes — every request within that window pays
 * only cache_read_input_tokens (≈10% of the normal rate). For a typical
 * 1k-token system prompt sent across many chat turns this cuts system
 * prompt input costs by ~90%.
 *
 * The cache is keyed on the exact content bytes, so any mutation
 * (injected timestamp, dynamic document snippets embedded in the system
 * prompt) breaks the cache for that request. To keep the big static
 * prompt cacheable even when per-turn context changes, we split the
 * system into TWO blocks: `staticPrompt` (the large stable instructions +
 * capability addenda, with cache_control) and an optional `dynamicSuffix`
 * (e.g. the AVAILABLE DOCUMENTS list, whose doc-N slugs are reassigned
 * per turn) placed AFTER it with NO cache_control. Anthropic reads the
 * longest previously-cached prefix, so the static block keeps hitting the
 * cache even when the dynamic tail changes.
 */
function toCachedSystem(
    staticPrompt: string | undefined,
    dynamicSuffix?: string,
    cache = true,
): Anthropic.TextBlockParam[] | undefined {
    if (!staticPrompt && !dynamicSuffix) return undefined;
    const blocks: Anthropic.TextBlockParam[] = [];
    if (staticPrompt) {
        blocks.push({
            type: "text",
            text: staticPrompt,
            // Skip the breakpoint for one-shot callers (completeClaudeText):
            // a cache WRITE costs 25% more than a plain input token, and a
            // short prompt that isn't re-sent within the 5-min TTL never
            // recoups it. Only the multi-turn chat path (cache=true) reuses
            // the prefix often enough to win.
            ...(cache ? { cache_control: { type: "ephemeral" } } : {}),
        });
    }
    if (dynamicSuffix) {
        // No cache_control: this block changes between turns (or simply
        // doesn't need its own breakpoint). Trailing position means the
        // cached static prefix above is unaffected.
        blocks.push({ type: "text", text: dynamicSuffix });
    }
    return blocks;
}

/**
 * Pin a cache breakpoint on the LAST message's final content block.
 *
 * At request-build time the tail is ALWAYS a `user` message — either the
 * new user turn, or (inside the tool-use loop) the `tool_result` turn we
 * just appended. Anthropic caches the whole prefix up to and including
 * this block and, on the next request, reads the longest previously
 * written matching prefix. One rolling tail breakpoint therefore caches:
 *   • across turns: the entire completed conversation, and
 *   • within the tool loop: every accumulated tool_result block (document
 *     text, search results) — the most expensive growing context.
 *
 * The previous implementation marked the *second-to-last user* message,
 * which left the largest block — the last assistant turn / latest
 * tool_result — outside the cached prefix on every call, and skipped
 * around between tool iterations as the history grew. Marking the tail
 * fixes both.
 *
 * Anthropic allows up to 4 cache breakpoints; the system prompt
 * (toCachedSystem) uses one, this uses one, leaving headroom.
 *
 * Returns a NEW array — never mutates the input.
 */
// Anthropic 400s on cache_control over an empty block. The tail of a
// tool_result turn can be empty when a tool returns "" — so we must check
// tool_result content, not just text.
function isEmptyCacheTarget(block: ContentBlock): boolean {
    if (block.type === "text") {
        return !((block as { text?: string }).text ?? "").length;
    }
    if (block.type === "tool_result") {
        const c = (block as { content?: unknown }).content;
        if (c == null) return true;
        if (typeof c === "string") return c.length === 0;
        if (Array.isArray(c)) return c.length === 0;
        return false;
    }
    return false;
}

function withCacheBreakpoints(messages: NativeMessage[]): NativeMessage[] {
    if (messages.length === 0) return messages;
    const out = messages.map((m) => ({ ...m }));
    const i = out.length - 1;
    const msg = out[i];

    if (typeof msg.content === "string") {
        // Anthropic rejects cache_control on an empty text block.
        if (msg.content.length === 0) return out;
        out[i] = {
            ...msg,
            content: [
                {
                    type: "text",
                    text: msg.content,
                    cache_control: { type: "ephemeral" },
                },
            ],
        };
        return out;
    }

    if (Array.isArray(msg.content) && msg.content.length > 0) {
        const blocks = [...msg.content] as ContentBlock[];
        // Pin the LAST non-empty block. Pinning the very last block 400s when
        // a tool returns "" as the final tool_result; an earlier non-empty
        // block still caches essentially the whole prefix.
        let target = blocks.length - 1;
        while (target >= 0 && isEmptyCacheTarget(blocks[target])) target--;
        if (target < 0) return out; // every block empty — nothing to pin
        blocks[target] = {
            ...blocks[target],
            cache_control: { type: "ephemeral" },
        } as ContentBlock;
        out[i] = { ...msg, content: blocks };
    }
    return out;
}

export async function streamClaude(
    params: StreamChatParams,
): Promise<StreamChatResult> {
    const {
        model,
        systemPrompt,
        tools = [],
        callbacks = {},
        runTools,
        apiKeys,
        enableThinking,
        enableWebSearch,
        reasoningEffort,
    } = params;
    const effort: "low" | "medium" | "high" = reasoningEffort ?? "high";
    const maxIter = params.maxIterations ?? 10;
    const anthropic = client(apiKeys?.claude);
    const claudeTools = toClaudeTools(tools);

    // Optionally append Anthropic's native web search tool. Kept separate
    // from `claudeTools` (which is OpenAI-shape converted via toClaudeTools)
    // because the native tool uses a server-tool shape (`type: "web_search_…"`)
    // that does not flow through our normalizer.
    // Don't attach Anthropic's native ($10/1k) web search when our own
    // custom search tools are already in the toolset: the model could call
    // both, and we'd double-bill — worse, the native cost isn't tracked in
    // runLLMStream's webSearchCostUsd, so it would silently escape cost
    // forensics. Custom tools win (cheaper, provider routing, recency
    // filters, source allowlists), matching the native tool's own
    // "prefer the custom tool" description.
    const wantNativeSearch = shouldAttachNativeWebSearch(enableWebSearch);
    const hasCustomSearch = tools.some(
        (t) =>
            t.function.name === "web_search" ||
            t.function.name.startsWith("search_"),
    );
    const attachNativeSearch = wantNativeSearch && !hasCustomSearch;
    const allTools: unknown[] = attachNativeSearch
        ? [...claudeTools, NATIVE_WEB_SEARCH_TOOL]
        : claudeTools;
    if (DEBUG_LLM_STREAM) {
        if (attachNativeSearch) {
            console.debug(
                "[claude] native web_search tool attached (name=web_search_native, max_uses=5)",
            );
        } else if (wantNativeSearch && hasCustomSearch) {
            console.debug(
                "[claude] native web_search suppressed — custom search tools present (avoids double-billing)",
            );
        }
    }

    const messages: NativeMessage[] = toNativeMessages(params.messages);
    let fullText = "";
    // Accumulate token usage across every Anthropic API call we make
    // inside this turn. One user turn can trigger several calls (one
    // per tool-use iteration), each with its own usage block; we sum
    // them so the caller logs/persists a single number per turn.
    const usage: LlmUsage = {
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        iterations: 0,
    };

    // Wrap the system prompt as an array with cache_control so Anthropic
    // caches the static block for 5 min (≈90% cheaper on cache reads).
    // `systemDynamicSuffix` (per-turn AVAILABLE DOCUMENTS list) is kept as
    // a separate trailing UNcached block so it can't bust the static cache.
    const cachedSystem = toCachedSystem(systemPrompt, params.systemDynamicSuffix);

    for (let iter = 0; iter < maxIter; iter++) {
        // On every iteration (including tool-call follow-ups) inject
        // cache breakpoints into the growing message history so
        // Anthropic can cache the completed exchange prefix.
        const cachedMessages = withCacheBreakpoints(messages);

        const stream = anthropic.messages.stream({
            model,
            system: cachedSystem as unknown as Anthropic.TextBlockParam[],
            messages: cachedMessages as Anthropic.MessageParam[],
            tools: allTools.length
                ? (allTools as unknown as Tool[])
                : undefined,
            max_tokens: MAX_TOKENS,
            // Claude 4.x models require `thinking.type: "adaptive"` and
            // drive effort via `output_config.effort` rather than a fixed
            // token budget. We only opt in when the caller requested it.
            ...(enableThinking
                ? ({
                      // `display: "summarized"` is REQUIRED, not optional.
                      // Sonnet 5 flipped the `thinking.display` default from
                      // "summarized" (Sonnet 4.6) to "omitted": with the
                      // default, the API stops streaming thinking text and
                      // returns empty `thinking` blocks (signature only), so
                      // `stream.on("thinking")` never fires and the reasoning
                      // panel goes dark while the model's between-tool
                      // narration leaks into the visible answer body. Setting
                      // it explicitly restores summarized thinking deltas and
                      // is valid on both Sonnet 4.6 and Sonnet 5.
                      thinking: { type: "adaptive", display: "summarized" },
                      output_config: { effort },
                  } as unknown as Record<string, unknown>)
                : {}),
            // Extended thinking requires temperature to be default (omitted).
        });

        let sawThinking = false;

        stream.on("streamEvent", (event) => {
            if (DEBUG_LLM_STREAM) {
                console.debug("[claude raw stream]", JSON.stringify(event));
            }
        });

        stream.on("text", (delta) => {
            callbacks.onContentDelta?.(delta);
        });
        if (enableThinking) {
            stream.on("thinking", (delta) => {
                sawThinking = true;
                callbacks.onReasoningDelta?.(delta);
            });
        }

        const final = await stream.finalMessage();
        if (sawThinking) callbacks.onReasoningBlockEnd?.();
        const stopReason = final.stop_reason;
        const assistantBlocks = final.content as ContentBlock[];

        // Surface "I ran out of room" stops to the log so we can spot
        // truncated answers in cost forensics. The user sees it as a
        // mid-sentence cutoff but the platform logs nothing — without
        // this line we cannot tell why a turn ended short.
        if (stopReason === "max_tokens") {
            console.warn(
                `[claude] hit max_tokens ceiling (iter=${iter}, MAX_TOKENS=${MAX_TOKENS}). ` +
                    `Output may be truncated. Consider raising MAX_TOKENS or asking the user for a continuation.`,
            );
        }

        // Accumulate per-call usage. Anthropic guarantees this on every
        // non-error response; missing fields default to 0 (e.g. prompt
        // caching off).
        const u = final.usage as
            | {
                  input_tokens?: number;
                  output_tokens?: number;
                  cache_creation_input_tokens?: number;
                  cache_read_input_tokens?: number;
              }
            | undefined;
        if (u) {
            usage.iterations += 1;
            usage.inputTokens += u.input_tokens ?? 0;
            usage.outputTokens += u.output_tokens ?? 0;
            usage.cacheCreationInputTokens += u.cache_creation_input_tokens ?? 0;
            usage.cacheReadInputTokens += u.cache_read_input_tokens ?? 0;
        }

        // Extract text content and tool_use calls from the final assistant
        // message so we can accumulate text and drive the tool-call loop.
        const toolCalls: NormalizedToolCall[] = [];
        for (const block of assistantBlocks) {
            if (block.type === "text") {
                const txt = (block as { text: string }).text;
                if (typeof txt === "string") fullText += txt;
            } else if (block.type === "tool_use") {
                const tu = block as {
                    id: string;
                    name: string;
                    input: unknown;
                };
                const call: NormalizedToolCall = {
                    id: tu.id,
                    name: tu.name,
                    input: (tu.input as Record<string, unknown>) ?? {},
                };
                callbacks.onToolCallStart?.(call);
                toolCalls.push(call);
            }
        }

        if (stopReason !== "tool_use" || !toolCalls.length || !runTools) {
            break;
        }

        // If tool execution throws mid-loop, end the turn gracefully rather
        // than letting the exception unwind past the `return` below — that
        // would discard all token usage accumulated so far, blinding the
        // cost-forensics in `recordLlmUsage`. The assistant text produced up
        // to this point has already been streamed to the client, so breaking
        // here leaves no partial/corrupt state for the next turn (which
        // rebuilds the message history from scratch).
        let results: NormalizedToolResult[];
        try {
            results = await runTools(toolCalls);
        } catch (err) {
            console.error(
                `[claude] runTools threw (iter=${iter}); ending turn with partial usage:`,
                err,
            );
            break;
        }

        // Record the assistant turn (preserving the original content blocks,
        // which Claude requires on the follow-up) and the user turn that
        // carries the tool_result blocks.
        messages.push({ role: "assistant", content: assistantBlocks });
        messages.push({
            role: "user",
            content: results.map((r) => ({
                type: "tool_result",
                tool_use_id: r.tool_use_id,
                content: r.content,
            })),
        });
    }

    return { fullText, usage: usage.iterations > 0 ? usage : undefined };
}

export async function completeClaudeText(params: {
    model: string;
    systemPrompt?: string;
    user: string;
    maxTokens?: number;
    apiKeys?: { claude?: string | null };
}): Promise<{ text: string; usage?: LlmUsage }> {
    const anthropic = client(params.apiKeys?.claude);
    const resp = await anthropic.messages.create({
        model: params.model,
        max_tokens: params.maxTokens ?? 512,
        // cache=false: these are short, usually one-off completions (title
        // generation, drafts, tabular cells) — caching the system prompt
        // would just burn the 25% cache-write premium with no reuse.
        system: toCachedSystem(params.systemPrompt, undefined, false) as unknown as Anthropic.TextBlockParam[],
        messages: [{ role: "user", content: params.user }],
    });
    const text = resp.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("");

    // Anthropic returns authoritative token counts on every response.
    // Mirrors the loop accumulator in streamClaude — same field names,
    // single-iteration here because there's no tool-use loop.
    const u = resp.usage as
        | {
              input_tokens?: number;
              output_tokens?: number;
              cache_creation_input_tokens?: number;
              cache_read_input_tokens?: number;
          }
        | undefined;
    const usage: LlmUsage | undefined = u
        ? {
              iterations: 1,
              inputTokens: u.input_tokens ?? 0,
              outputTokens: u.output_tokens ?? 0,
              cacheCreationInputTokens: u.cache_creation_input_tokens ?? 0,
              cacheReadInputTokens: u.cache_read_input_tokens ?? 0,
          }
        : undefined;
    return { text, usage };
}

// Helper re-export for callers wanting to hand normalized results back in.
export type { NormalizedToolResult };
