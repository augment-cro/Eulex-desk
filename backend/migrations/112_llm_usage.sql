-- 112: Per-request LLM usage log for cost tracking.
--
-- Anthropic returns authoritative token counts on every API response
-- (usage.input_tokens, output_tokens, cache_creation_input_tokens,
-- cache_read_input_tokens). One assistant turn can trigger multiple
-- Claude calls (tool-use loop), so we accumulate the per-call usage
-- across the whole turn and write a single row per chat message.
--
-- Pricing is computed in application code (Anthropic does not return
-- USD on the wire). For Claude Sonnet 4.6 we use the published rates:
--   input  $3.00 / 1M
--   output $15.00 / 1M
--   cache write (5min) $3.75 / 1M
--   cache read $0.30 / 1M
--
-- Design notes
-- ------------
-- * One row per assistant turn. `iterations` records how many Claude
--   calls happened inside the tool-use loop so we can spot runaway
--   contexts (each iter resends the full message history + tool results).
-- * `chat_message_id` and `project_chat_message_id` are nullable because
--   we want the row even when the response failed before we persisted
--   the assistant message — that is exactly the case where cost data
--   is most valuable for forensics.
-- * Indexes target the two queries we expect to run: per-user/day rollup
--   (billing dashboard) and per-chat trace (debug a specific session).
-- * No FK on chat_message_id / project_chat_message_id so a failed turn
--   that never produced a chat row still gets logged.
--
-- Safe to run multiple times.

CREATE TABLE IF NOT EXISTS public.llm_usage (
    id                          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id                     uuid        NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    provider                    text        NOT NULL,
    model                       text        NOT NULL,
    chat_id                     uuid,
    project_id                  uuid,
    chat_message_id             uuid,
    project_chat_message_id     uuid,
    iterations                  int         NOT NULL DEFAULT 1,
    input_tokens                int         NOT NULL DEFAULT 0,
    output_tokens               int         NOT NULL DEFAULT 0,
    cache_creation_input_tokens int         NOT NULL DEFAULT 0,
    cache_read_input_tokens     int         NOT NULL DEFAULT 0,
    cost_usd                    numeric(12, 6) NOT NULL DEFAULT 0,
    duration_ms                 int,
    status                      text        NOT NULL DEFAULT 'ok'
                                            CHECK (status IN ('ok', 'error', 'aborted')),
    error_message               text,
    created_at                  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_llm_usage_user_created
    ON public.llm_usage (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_llm_usage_chat
    ON public.llm_usage (chat_id, created_at DESC)
    WHERE chat_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_llm_usage_model_created
    ON public.llm_usage (model, created_at DESC);
