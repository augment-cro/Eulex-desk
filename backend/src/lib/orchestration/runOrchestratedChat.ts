/** Two-stage MCP retrieval → evidence-grounded writing, with one usage ledger. */
import { streamChatWithTools } from "../llm";
import { emptyUsage, sumUsage, attachUsage } from "../llm/usage";
import { buildRetrieverParams, buildWriterParams } from "./params";
import type { StreamChatParams, StreamChatResult } from "../llm/types";

export type OrchestratedParams = {
    retrieverModel: string;
    writerModel: string;
    base: StreamChatParams;
    maxRetrieverIterations?: number;
};

export async function runOrchestratedChat(
    p: OrchestratedParams,
): Promise<StreamChatResult & { brief?: string }> {
    let usage = emptyUsage();
    let activeModel = p.retrieverModel;
    const base: StreamChatParams = {
        ...p.base,
        onUsage: (delta) => {
            usage = sumUsage(usage, delta);
            p.base.onUsage?.(delta);
        },
    };
    try {
        let retrieval: StreamChatResult | undefined;
        try {
            retrieval = await streamChatWithTools(
                buildRetrieverParams(
                    base,
                    p.retrieverModel,
                    p.maxRetrieverIterations,
                ),
            );
        } catch (err) {
            console.error(
                "[orchestration] retriever failed; falling back:",
                (err as Error).message,
            );
        }
        if (base.abortSignal?.aborted)
            return { fullText: "", usage, model: activeModel };
        const brief = retrieval?.fullText?.trim() ?? "";
        activeModel = p.writerModel;
        if (!brief) {
            const fallback = await streamChatWithTools({
                ...base,
                model: p.writerModel,
                usagePhase: "fallback",
            });
            return { ...fallback, usage };
        }
        console.log(
            `[orchestration] retriever=${p.retrieverModel} brief=${brief.length} chars, ` +
                `iterations=${retrieval?.usage?.iterations ?? "?"} → writer=${p.writerModel}`,
        );
        const writing = await streamChatWithTools(
            buildWriterParams(base, p.writerModel, brief),
        );
        return { ...writing, usage, brief };
    } catch (error) {
        throw attachUsage(error, { usage, model: activeModel });
    }
}
