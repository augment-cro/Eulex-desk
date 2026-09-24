import type { LlmUsage } from "./types";

export function emptyUsage(): LlmUsage {
    return {
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        iterations: 0,
    };
}

export function sumUsage(...items: (LlmUsage | undefined)[]): LlmUsage {
    const sum = emptyUsage();
    for (const item of items) {
        if (!item) continue;
        sum.inputTokens += item.inputTokens;
        sum.outputTokens += item.outputTokens;
        sum.cacheCreationInputTokens += item.cacheCreationInputTokens;
        sum.cacheReadInputTokens += item.cacheReadInputTokens;
        sum.iterations += item.iterations;
        if (item.calls?.length) (sum.calls ??= []).push(...item.calls);
        if (item.incomplete) sum.incomplete = true;
    }
    return sum;
}

export type UsageContext = {
    usage: LlmUsage;
    model?: string;
    extraCostUsd?: number;
};
const errorUsage = new WeakMap<object, UsageContext>();

export function attachUsage(error: unknown, context: UsageContext): Error {
    const err = error instanceof Error ? error : new Error(String(error));
    errorUsage.set(err, context);
    return err;
}

export function getErrorUsage(error: unknown): UsageContext | undefined {
    return error !== null && typeof error === "object"
        ? errorUsage.get(error)
        : undefined;
}
