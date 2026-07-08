-- 114: Tier-based rate limit configuration.
--
-- Per-tier daily token quota for the rate limiter. Rolling 24h window
-- enforced over public.llm_usage; this table is the source of truth
-- for "how much can a user in tier X spend per 24h".
--
-- Authoritative key is `tier_level_id` — the integer that comes through
-- on every JWT from eulex.ai (EulexJwtPayload.tier_level_id). Slugs
-- like 'eulex_free' / 'eulex_plus' are kept for AdminMax display and
-- audit logs; they may diverge from JWT `tier` ('free' / 'plus') so do
-- NOT join on slug.
--
-- Seed values (UMP production, May 2026):
--   tier_level_id 2 → eulex_plus   3,000,000 tokens / 24h
--   tier_level_id 3 → eulex_free   1,000,000 tokens / 24h
--   tier_level_id 1 / 4 / 5 / 6 — lazy-upserted at first login of that
--   tier with eulex_free defaults; admin tunes them in /adminmax/tiers.
--
-- Rate limit metric is "all four token types summed":
--   SUM(input_tokens + output_tokens
--     + cache_creation_input_tokens + cache_read_input_tokens)
-- mirrors the AdminMax billing total so user-visible numbers match
-- across banner, dashboard and CSV export. If the cache-aware variant
-- proves more fair (Anthropic itself drops cache_read from ITPM), the
-- formula switch is one SQL line in lib/rateLimit.ts — no migration.
--
-- Safe to run multiple times.

CREATE TABLE IF NOT EXISTS public.tier_limits (
    tier_level_id   bigint      PRIMARY KEY,
    tier_slug       text        NOT NULL,
    display_label   text        NOT NULL,
    daily_tokens    bigint      NOT NULL CHECK (daily_tokens >= 0),
    updated_at      timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.tier_limits (tier_level_id, tier_slug, display_label, daily_tokens)
VALUES
    (2, 'eulex_plus', 'Eulex Plus',  3000000),
    (3, 'eulex_free', 'Eulex FREE',  1000000)
ON CONFLICT (tier_level_id) DO NOTHING;
