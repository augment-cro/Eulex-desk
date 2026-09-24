-- Receipts contain usage and provider metadata only, never prompts or credentials.
ALTER TABLE public.llm_usage ADD COLUMN IF NOT EXISTS cost_breakdown jsonb;
DO $$ BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'llm_usage'
          AND column_name = 'cost_usd'
          AND (numeric_scale <> 10 OR is_nullable = 'NO' OR column_default IS NOT NULL)
    ) THEN
        ALTER TABLE public.llm_usage
            ALTER COLUMN cost_usd TYPE numeric(18, 10),
            ALTER COLUMN cost_usd DROP NOT NULL,
            ALTER COLUMN cost_usd DROP DEFAULT;
    END IF;
END $$;
