-- Per-project web-search source allowlist.
--
-- Each entry is a key from backend/src/lib/search/external_sources.json
-- (e.g. "gdpr", "dora", "ai_act"). When the array is non-empty the
-- web_search tool resolves the keys to concrete domains and passes
-- them as include_domains to the chosen provider, restricting the
-- search to that curated set. NULL or [] means "open web".
ALTER TABLE public.projects
    ADD COLUMN IF NOT EXISTS web_search_sources jsonb;
