import { MODELS, type ModelOption } from "../components/assistant/ModelToggle";

export type ModelProvider = "claude" | "gemini" | "openai" | "mistral";

export type ApiKeys = {
    claudeApiKey: string | null;
    geminiApiKey: string | null;
    openaiApiKey: string | null;
    mistralApiKey: string | null;
    /**
     * Optional per-provider "server has a fallback key" flags from
     * GET /user/profile (see backend `serverKeyAvailability()`). When
     * a provider has a server-level key we treat the model as
     * available even if the user hasn't pasted their own — the
     * backend will pick up `process.env.<PROVIDER>_API_KEY` for them.
     */
    serverKeys?: {
        claude?: boolean;
        gemini?: boolean;
        openai?: boolean;
        mistral?: boolean;
    };
};

export function getModelProvider(modelId: string): ModelProvider | null {
    const model = MODELS.find((m) => m.id === modelId);
    if (!model) return null;
    if (model.group === "Anthropic") return "claude";
    if (model.group === "OpenAI" || model.group === "LocalLLM") return "openai";
    if (model.group === "Mistral") return "mistral";
    return "gemini";
}

function hasKey(
    provider: ModelProvider,
    apiKeys: ApiKeys,
): boolean {
    if (provider === "claude")
        return !!apiKeys.claudeApiKey?.trim() || !!apiKeys.serverKeys?.claude;
    if (provider === "openai")
        return !!apiKeys.openaiApiKey?.trim() || !!apiKeys.serverKeys?.openai;
    if (provider === "mistral")
        return !!apiKeys.mistralApiKey?.trim() || !!apiKeys.serverKeys?.mistral;
    return !!apiKeys.geminiApiKey?.trim() || !!apiKeys.serverKeys?.gemini;
}

export function isModelAvailable(
    modelId: string,
    apiKeys: ApiKeys,
): boolean {
    const provider = getModelProvider(modelId);
    if (!provider) return false;
    // LocalLLM models are server-configured, always available
    const model = MODELS.find((m) => m.id === modelId);
    if (model?.group === "LocalLLM") return true;
    return hasKey(provider, apiKeys);
}

export function isProviderAvailable(
    provider: ModelProvider,
    apiKeys: ApiKeys,
): boolean {
    return hasKey(provider, apiKeys);
}

export function providerLabel(provider: ModelProvider): string {
    if (provider === "claude") return "Anthropic (Claude)";
    if (provider === "openai") return "OpenAI (GPT)";
    if (provider === "mistral") return "Mistral AI";
    return "Google (Gemini)";
}

export function modelGroupToProvider(
    group: ModelOption["group"],
): ModelProvider {
    if (group === "Anthropic") return "claude";
    if (group === "OpenAI" || group === "LocalLLM") return "openai";
    if (group === "Mistral") return "mistral";
    return "gemini";
}
