import {
  CLAUDE_MAIN_MODELS, GEMINI_MAIN_MODELS, OPENAI_MAIN_MODELS, MISTRAL_MAIN_MODELS,
  CLAUDE_MID_MODELS, GEMINI_MID_MODELS, OPENAI_MID_MODELS, MISTRAL_MID_MODELS,
  CLAUDE_LOW_MODELS, GEMINI_LOW_MODELS, OPENAI_LOW_MODELS, MISTRAL_LOW_MODELS,
  DEFAULT_MAIN_MODEL, DEFAULT_TABULAR_MODEL, DEFAULT_TITLE_MODEL, providerForModel,
} from "./models";

/** Max's own model registry (this build) — what "Max · <model>" benchmark
 *  contestants can be. Served by Max itself (GET /operator/v1/models): an
 *  external console or benchmark service cannot know it. Local-LLM ids are
 *  left out (not benchmarkable against hosted models). */
export function maxModelCatalogue() {
  const tier = (ids: readonly string[]) =>
    [...new Set(ids)].map((id) => ({ id, provider: providerForModel(id) }));
  return {
    defaults: { main: DEFAULT_MAIN_MODEL, tabular: DEFAULT_TABULAR_MODEL, title: DEFAULT_TITLE_MODEL },
    tiers: {
      main: tier([...CLAUDE_MAIN_MODELS, ...GEMINI_MAIN_MODELS, ...OPENAI_MAIN_MODELS, ...MISTRAL_MAIN_MODELS]),
      mid: tier([...CLAUDE_MID_MODELS, ...GEMINI_MID_MODELS, ...OPENAI_MID_MODELS, ...MISTRAL_MID_MODELS]),
      low: tier([...CLAUDE_LOW_MODELS, ...GEMINI_LOW_MODELS, ...OPENAI_LOW_MODELS, ...MISTRAL_LOW_MODELS]),
    },
    build: process.env.BUILD_GIT_SHA || null,
  };
}
