-- 130_chats_legacy_wp_case_id.sql
--
-- One-time backfill of legacy WordPress chat history (eulex-ai-20 plugin) into
-- the assistant `chats`/`chat_messages` tables. This column records which old
-- WP `wp_eulex_chat_context.id` a migrated chat originated from, so the backfill
-- script (`backend/scripts/migrate-wp-chat-history.mjs`) is idempotent and the
-- provenance of migrated rows stays traceable.
--
-- Nullable: only migrated rows carry a value; all native chats stay NULL.
-- The partial UNIQUE index prevents a re-run from inserting a duplicate chat for
-- a case that was already migrated.

alter table public.chats
  add column if not exists legacy_wp_case_id bigint;

create unique index if not exists chats_legacy_wp_case_id_uq
  on public.chats (legacy_wp_case_id)
  where legacy_wp_case_id is not null;
