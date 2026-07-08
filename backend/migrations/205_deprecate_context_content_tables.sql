-- 205: Context content tables deprecated — context content (definitions,
-- sources, shares, alert intelligence) is owned by the external contexts
-- service and its own datastore; the core keeps only generic runtime state
-- (user_context_prefs, context_workflow_links, context_project_links,
-- service_notifications) keyed by opaque context ids.
--
-- No drops, no data changes: existing rows stay in place; data migration is
-- owner-managed. Safe to run repeatedly, and a no-op for the content tables
-- on databases that never created them (fresh installs no longer do).
-- Mirrored in backend/src/lib/ensureSchema.ts (FK removal only).

DO $$
DECLARE
    t text;
BEGIN
    FOREACH t IN ARRAY ARRAY[
        'custom_contexts', 'context_sources', 'context_shares',
        'source_change_events', 'context_alert_events'
    ] LOOP
        IF to_regclass('public.' || t) IS NOT NULL THEN
            EXECUTE format(
                'COMMENT ON TABLE public.%I IS %L',
                t,
                'DEPRECATED: context content is owned by the external contexts service '
                    || 'and its own datastore; data migration owner-managed. '
                    || 'Not read or written by the core.'
            );
        END IF;
    END LOOP;
END $$;

-- The runtime tables stay live but their context ids are now OPAQUE
-- provider ids — never rows in the deprecated custom_contexts table — so
-- the FKs into it must go.
ALTER TABLE public.user_context_prefs
    DROP CONSTRAINT IF EXISTS user_context_prefs_context_id_fkey;
ALTER TABLE public.context_workflow_links
    DROP CONSTRAINT IF EXISTS context_workflow_links_context_id_fkey;
ALTER TABLE public.context_project_links
    DROP CONSTRAINT IF EXISTS context_project_links_context_id_fkey;
