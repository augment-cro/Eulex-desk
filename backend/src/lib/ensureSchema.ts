/**
 * Idempotent schema bootstrap that runs once on backend startup.
 *
 * The repo carries proper SQL migrations under backend/migrations/, but
 * Cloud Run deploys do not have a separate migration step yet. Anything
 * the app *requires to function* and is cheap enough to assert at every
 * cold start lives here, behind `CREATE … IF NOT EXISTS` guards.
 *
 * Treat this file as a safety net, not a replacement for migrations:
 *  - keep statements idempotent (IF NOT EXISTS, ADD COLUMN IF NOT EXISTS),
 *  - do not destructively alter existing data,
 *  - log clearly so a deploy failing on schema is obvious in Cloud Logging.
 */
import { query } from "./db";

const STATEMENTS: ReadonlyArray<{ name: string; sql: string }> = [
    {
        name: "auth_pair_codes",
        sql: `
            CREATE TABLE IF NOT EXISTS public.auth_pair_codes (
              code        TEXT PRIMARY KEY,
              user_id     UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
              token       TEXT NOT NULL,
              attempts    INT  NOT NULL DEFAULT 0,
              expires_at  TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '5 minutes'),
              created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
            );
        `,
    },
    {
        name: "auth_pair_codes_expires_at_idx",
        sql: `
            CREATE INDEX IF NOT EXISTS auth_pair_codes_expires_at_idx
                ON public.auth_pair_codes (expires_at);
        `,
    },
    {
        name: "auth_pair_codes_user_id_idx",
        sql: `
            CREATE INDEX IF NOT EXISTS auth_pair_codes_user_id_idx
                ON public.auth_pair_codes (user_id);
        `,
    },
    {
        // The Word add-in's Office.js WebView is sandboxed away from the
        // browser cookies the web frontend uses for next-intl's
        // NEXT_LOCALE, so it has to fetch the locale from the user
        // profile instead. Defaults to "hr" to match
        // frontend/src/i18n/request.ts. Idempotent.
        name: "user_profiles.preferred_language",
        sql: `
            ALTER TABLE public.user_profiles
                ADD COLUMN IF NOT EXISTS preferred_language text NOT NULL DEFAULT 'hr';
        `,
    },
    // NOTE: An earlier iteration provisioned `projects.web_search_sources`
    // here for per-project source-key allowlists. That responsibility
    // moved to backend/src/lib/search/search_config.json (declarative,
    // edit + redeploy) so the column is no longer read by the app. The
    // column is intentionally left in place for any tenants that may
    // already store data there — drop in a follow-up migration once we
    // confirm no one depends on it.
    {
        // Native file-source connectors (Google Drive / OneDrive / Box).
        // Mirrors backend/migrations/108_integration_accounts.sql.
        // Tokens stored encrypted via lib/crypto.encryptApiKey().
        name: "integration_accounts",
        sql: `
            CREATE TABLE IF NOT EXISTS public.integration_accounts (
                id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
                user_id         uuid        NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
                provider        text        NOT NULL CHECK (provider IN ('google_drive', 'onedrive', 'box')),
                account_email   text,
                account_name    text,
                access_token    text        NOT NULL,
                refresh_token   text,
                token_type      text        DEFAULT 'Bearer',
                expires_at      timestamptz,
                scopes          text[]      DEFAULT ARRAY[]::text[],
                created_at      timestamptz NOT NULL DEFAULT now(),
                updated_at      timestamptz NOT NULL DEFAULT now(),
                UNIQUE (user_id, provider)
            );
        `,
    },
    {
        name: "integration_accounts_user_idx",
        sql: `
            CREATE INDEX IF NOT EXISTS idx_integration_accounts_user
                ON public.integration_accounts (user_id);
        `,
    },
    {
        // Provenance on imported documents — lets the UI show
        // "Imported from Google Drive" and detect drift on re-import.
        name: "documents.source_columns",
        sql: `
            ALTER TABLE public.documents
                ADD COLUMN IF NOT EXISTS source_provider     text,
                ADD COLUMN IF NOT EXISTS source_external_id  text,
                ADD COLUMN IF NOT EXISTS source_revision     text,
                ADD COLUMN IF NOT EXISTS source_imported_at  timestamptz;
        `,
    },
    {
        name: "documents_source_external_idx",
        sql: `
            CREATE INDEX IF NOT EXISTS idx_documents_source_external
                ON public.documents (user_id, source_provider, source_external_id)
                WHERE source_external_id IS NOT NULL;
        `,
    },
    {
        // Email-bound share invites for chats. Mirrors
        // backend/migrations/109_chat_shares.sql. The accept handler
        // appends the recipient's email to chats.shared_with so the
        // existing chat.ts access check sees them as collaborators.
        name: "chat_shares",
        sql: `
            CREATE TABLE IF NOT EXISTS public.chat_shares (
                id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
                chat_id             uuid        NOT NULL REFERENCES public.chats(id) ON DELETE CASCADE,
                shared_by_user_id   uuid        NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
                shared_with_email   text        NOT NULL,
                token_hash          text        NOT NULL UNIQUE,
                snapshot_at         timestamptz NOT NULL DEFAULT now(),
                expires_at          timestamptz NOT NULL DEFAULT (now() + interval '30 days'),
                accepted_at         timestamptz,
                accepted_user_id    uuid        REFERENCES public.users(id) ON DELETE SET NULL,
                revoked_at          timestamptz,
                created_at          timestamptz NOT NULL DEFAULT now()
            );
        `,
    },
    {
        name: "chat_shares_chat_idx",
        sql: `
            CREATE INDEX IF NOT EXISTS idx_chat_shares_chat
                ON public.chat_shares (chat_id);
        `,
    },
    {
        name: "chat_shares_email_idx",
        sql: `
            CREATE INDEX IF NOT EXISTS idx_chat_shares_email
                ON public.chat_shares (shared_with_email);
        `,
    },
    {
        name: "chat_shares_chat_email_active_uniq",
        sql: `
            CREATE UNIQUE INDEX IF NOT EXISTS chat_shares_chat_email_active_uniq
                ON public.chat_shares (chat_id, shared_with_email)
                WHERE revoked_at IS NULL;
        `,
    },
    {
        name: "chats.shared_with",
        sql: `
            ALTER TABLE public.chats
                ADD COLUMN IF NOT EXISTS shared_with jsonb NOT NULL DEFAULT '[]'::jsonb;
        `,
    },
    {
        name: "chats_shared_with_idx",
        sql: `
            CREATE INDEX IF NOT EXISTS chats_shared_with_idx
                ON public.chats USING gin (shared_with);
        `,
    },
    {
        // Per-chat PII Shield mode override. NULL = inherit user default
        // (resolved by lib/pii/gate.ts → effectiveMode). Without this
        // column the backend logs a benign warning on every chat hit;
        // the override path itself falls back gracefully but we want a
        // clean log + a real way to override per chat.
        name: "chats.pii_mode",
        sql: `
            ALTER TABLE public.chats
                ADD COLUMN IF NOT EXISTS pii_mode text;
        `,
    },
    {
        // Per-message "not appropriate answer" flag — see migration 110.
        // Denormalised boolean on chat_messages keeps the GET /chat reads
        // cheap; the audit table (next entries) holds the toggle history.
        name: "chat_messages.flag_columns",
        sql: `
            ALTER TABLE public.chat_messages
                ADD COLUMN IF NOT EXISTS is_flagged boolean NOT NULL DEFAULT false,
                ADD COLUMN IF NOT EXISTS flagged_at timestamptz,
                ADD COLUMN IF NOT EXISTS flagged_by uuid;
        `,
    },
    {
        name: "chat_message_flags",
        sql: `
            CREATE TABLE IF NOT EXISTS public.chat_message_flags (
                id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
                chat_message_id uuid        NOT NULL REFERENCES public.chat_messages(id) ON DELETE CASCADE,
                chat_id         uuid        NOT NULL REFERENCES public.chats(id) ON DELETE CASCADE,
                user_id         uuid        NOT NULL,
                action          text        NOT NULL CHECK (action IN ('flag', 'unflag')),
                reason          text,
                created_at      timestamptz NOT NULL DEFAULT now()
            );
        `,
    },
    {
        name: "chat_message_flags_message_idx",
        sql: `
            CREATE INDEX IF NOT EXISTS idx_chat_message_flags_message
                ON public.chat_message_flags (chat_message_id);
        `,
    },
    {
        name: "chat_message_flags_chat_idx",
        sql: `
            CREATE INDEX IF NOT EXISTS idx_chat_message_flags_chat
                ON public.chat_message_flags (chat_id);
        `,
    },
    {
        name: "chat_messages_flagged_idx",
        sql: `
            CREATE INDEX IF NOT EXISTS idx_chat_messages_flagged
                ON public.chat_messages (chat_id)
                WHERE is_flagged = true;
        `,
    },
    {
        // Per-user override for built-in MCP connectors loaded from
        // mike/mcp.json. Absent row = default-enabled. See migration 111.
        // The composite PK lets us upsert on (user_id, slug) without an
        // extra unique index.
        name: "user_mcp_builtin_prefs",
        sql: `
            CREATE TABLE IF NOT EXISTS public.user_mcp_builtin_prefs (
                user_id     uuid        NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
                slug        text        NOT NULL,
                enabled     boolean     NOT NULL,
                created_at  timestamptz NOT NULL DEFAULT now(),
                updated_at  timestamptz NOT NULL DEFAULT now(),
                PRIMARY KEY (user_id, slug)
            );
        `,
    },
    {
        name: "user_mcp_builtin_prefs_user_idx",
        sql: `
            CREATE INDEX IF NOT EXISTS idx_user_mcp_builtin_prefs_user
                ON public.user_mcp_builtin_prefs (user_id);
        `,
    },
    {
        // Per-request LLM usage log for cost tracking. See migration 112.
        // Anthropic returns authoritative token counts; USD is computed
        // in app code from the published Opus 4.8 / Sonnet 4.6 / Haiku 4.5
        // rates (see PRICING table in lib/llmUsage.ts).
        name: "llm_usage",
        sql: `
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
                client                      text,
                created_at                  timestamptz NOT NULL DEFAULT now()
            );
        `,
    },
    {
        // Attribute each usage row to the surface that produced it
        // ("web" | "word"). Usage is counted toward the user's quota
        // regardless of client; this column only adds reporting visibility.
        // Idempotent ALTER so existing production tables pick it up too.
        name: "llm_usage.client",
        sql: `
            ALTER TABLE public.llm_usage
                ADD COLUMN IF NOT EXISTS client text;
        `,
    },
    {
        name: "llm_usage_user_created_idx",
        sql: `
            CREATE INDEX IF NOT EXISTS idx_llm_usage_user_created
                ON public.llm_usage (user_id, created_at DESC);
        `,
    },
    {
        name: "llm_usage_chat_idx",
        sql: `
            CREATE INDEX IF NOT EXISTS idx_llm_usage_chat
                ON public.llm_usage (chat_id, created_at DESC)
                WHERE chat_id IS NOT NULL;
        `,
    },
    {
        name: "llm_usage_model_created_idx",
        sql: `
            CREATE INDEX IF NOT EXISTS idx_llm_usage_model_created
                ON public.llm_usage (model, created_at DESC);
        `,
    },
    {
        // Per-tier rate limit configuration. Mirrors migration 114.
        // Authoritative key is `tier_level_id` from the JWT; slugs and
        // labels are display-only. AdminMax can edit `daily_tokens` and
        // `display_label` at runtime.
        name: "tier_limits",
        sql: `
            CREATE TABLE IF NOT EXISTS public.tier_limits (
                tier_level_id   bigint      PRIMARY KEY,
                tier_slug       text        NOT NULL,
                display_label   text        NOT NULL,
                daily_tokens    bigint      NOT NULL CHECK (daily_tokens >= 0),
                updated_at      timestamptz NOT NULL DEFAULT now()
            );
        `,
    },
    {
        // Per-tier feature flags (jsonb). Catalog of valid keys + per-tier
        // defaults lives in code (lib/entitlements.ts); this column holds
        // the runtime-editable values (AdminMax). seedEntitlementDefaults()
        // fills the defaults right after ensureSchema() without clobbering
        // any admin edits. Mirrors migration 122.
        name: "tier_limits.entitlements",
        sql: `
            ALTER TABLE public.tier_limits
                ADD COLUMN IF NOT EXISTS entitlements jsonb NOT NULL DEFAULT '{}'::jsonb;
        `,
    },
    {
        // Bilingual marketing copy per tier (name, tagline, price string,
        // feature bullets, order, popular). Code-default catalog lives in
        // lib/planCatalog.ts; this column holds AdminMax-editable overrides
        // and is the single source the public GET /billing/plans endpoint
        // (Eulex Desk PlanCards + eulex.ai pricing) reads. Mirrors migration 123.
        name: "tier_limits.marketing",
        sql: `
            ALTER TABLE public.tier_limits
                ADD COLUMN IF NOT EXISTS marketing jsonb NOT NULL DEFAULT '{}'::jsonb;
        `,
    },
    // NOTE (#15 Phase A): the tier_limits_seed_* INSERT blocks that used to
    // live here were dead placeholders by design (prod values are operator-
    // set via AdminMax; see the tier-quota model note) and have been removed.
    // Tier definitions are authored in Supabase (backend/supabase/
    // tier_limits.sql + migrations/copy-tier-limits-to-supabase.ts) and read
    // through lib/tierLimitsStore.ts; the mike table above stays only as the
    // transition fallback while TIERS_FROM_SUPABASE is off. Unknown tier ids
    // are still lazy-upserted with free-tier defaults by resolveTierLimits.
    {
        // Drop legacy duplicate tier rows that predate the canonical ids:
        // id 1 ('free') duplicates id 3 ('eulex_free'); id 5 ('plus')
        // duplicates id 2 ('eulex_plus'). GUARDED: only delete a row that
        // no user currently sits on, so an assigned tier is never orphaned.
        // Idempotent — a no-op once the rows are gone.
        name: "tier_limits_dedup_legacy",
        sql: `
            DELETE FROM public.tier_limits tl
             WHERE tl.tier_level_id IN (1, 5)
               AND tl.tier_slug IN ('free', 'plus')
               AND NOT EXISTS (
                     SELECT 1 FROM public.user_tier_state s
                      WHERE s.active_tier_level_id = tl.tier_level_id
                   );
        `,
    },
    {
        // Generic one-time-migration marker table. Used by code-side
        // boot steps (e.g. applyMarketingRelaunchOnce) that must run a
        // data change exactly once without clobbering later admin edits.
        name: "app_migrations",
        sql: `
            CREATE TABLE IF NOT EXISTS public.app_migrations (
                name        text        PRIMARY KEY,
                applied_at  timestamptz NOT NULL DEFAULT now()
            );
        `,
    },
    {
        // Per-user bonus token credit packs (top-up). Three sources:
        // Stripe webhook (self-service), bank_transfer (admin manual
        // after seeing statement) and admin_manual (discretionary).
        // Voiding is non-destructive (voided_at preserves audit trail).
        // Mirrors migration 115.
        name: "user_token_credits",
        sql: `
            CREATE TABLE IF NOT EXISTS public.user_token_credits (
                id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
                user_id             uuid        NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
                tokens_granted      bigint      NOT NULL CHECK (tokens_granted > 0),
                tokens_consumed     bigint      NOT NULL DEFAULT 0
                                                CHECK (tokens_consumed >= 0
                                                   AND tokens_consumed <= tokens_granted),
                payment_method      text        NOT NULL
                                                CHECK (payment_method IN
                                                      ('stripe', 'bank_transfer', 'admin_manual')),
                external_reference  text,
                stripe_event_id     text        UNIQUE,
                amount_eur_cents    integer,
                granted_by_admin_id uuid        REFERENCES public.users(id) ON DELETE SET NULL,
                granted_at          timestamptz NOT NULL DEFAULT now(),
                expires_at          timestamptz,
                voided_at           timestamptz,
                voided_reason       text,
                notes               text
            );
        `,
    },
    {
        name: "user_token_credits_active_idx",
        sql: `
            CREATE INDEX IF NOT EXISTS idx_user_token_credits_active
                ON public.user_token_credits (user_id, granted_at)
                WHERE voided_at IS NULL;
        `,
    },
    {
        name: "user_token_credits_granted_by_idx",
        sql: `
            CREATE INDEX IF NOT EXISTS idx_user_token_credits_granted_by
                ON public.user_token_credits (granted_by_admin_id, granted_at DESC)
                WHERE granted_by_admin_id IS NOT NULL;
        `,
    },
    {
        // Tier override + Stripe customer — lives in a *separate* table so
        // Cloud Run's IAM DB user can CREATE it even when `public.users`
        // is owned by `postgres` (ALTER TABLE users is denied). See
        // migrations/118_user_tier_state_and_ump.sql.
        name: "user_tier_state",
        sql: `
            CREATE TABLE IF NOT EXISTS public.user_tier_state (
                user_id     uuid PRIMARY KEY
                    REFERENCES public.users(id) ON DELETE CASCADE,
                active_tier_level_id   integer,
                active_tier_until      timestamptz,
                stripe_customer_id     text,
                active_tier_synced_at  timestamptz
            );
        `,
    },
    {
        name: "user_tier_state_stripe_uq",
        sql: `
            CREATE UNIQUE INDEX IF NOT EXISTS user_tier_state_stripe_customer_id_uq
                ON public.user_tier_state (stripe_customer_id)
                WHERE stripe_customer_id IS NOT NULL;
        `,
    },
    {
        // Supabase Auth identity mapping. Supabase `sub` (auth.users UUID)
        // → public.users.id. Separate table because the IAM DB user can't
        // ALTER public.users (owned by postgres) — same constraint as
        // user_tier_state. Mirror of migration 125_user_supabase_identity.
        name: "user_supabase_identity",
        sql: `
            CREATE TABLE IF NOT EXISTS public.user_supabase_identity (
                supabase_user_id uuid PRIMARY KEY,
                user_id          uuid NOT NULL
                    REFERENCES public.users(id) ON DELETE CASCADE,
                email            text,
                created_at       timestamptz NOT NULL DEFAULT now()
            );
        `,
    },
    {
        name: "user_supabase_identity_user_uq",
        sql: `
            CREATE UNIQUE INDEX IF NOT EXISTS user_supabase_identity_user_id_uq
                ON public.user_supabase_identity (user_id);
        `,
    },
    {
        name: "user_supabase_identity_email_idx",
        sql: `
            CREATE INDEX IF NOT EXISTS user_supabase_identity_email_idx
                ON public.user_supabase_identity (email);
        `,
    },
    {
        // Idempotency ledger for the order-confirmation email. The Stripe
        // webhook fires several active-making events per subscription
        // (created → updated → invoice.paid, plus renewals), but we want
        // exactly ONE "order confirmed" email per order. The handler does
        // INSERT … ON CONFLICT DO NOTHING and only emails when a row was
        // actually claimed. `order_key` = subscription id (subscriptions)
        // or checkout session id (token packs).
        name: "billing_order_emails",
        sql: `
            CREATE TABLE IF NOT EXISTS public.billing_order_emails (
                order_key  text PRIMARY KEY,
                user_id    uuid,
                plan       text,
                sent_at    timestamptz NOT NULL DEFAULT now()
            );
        `,
    },
    {
        // ISO-3166-1 alpha-2 country code (e.g. 'HR', 'DE'). Lives on
        // user_tier_state because public.user_profiles is owned by the
        // postgres role and the IAM DB user can't ALTER it (same
        // constraint that drove the tier-state split). Used to:
        //   • pre-fill Stripe customer.address.country so
        //     automatic_tax resolves on the very first invoice; and
        //   • stash UMP-pulled country whenever the partner site
        //     supplies one (see lib/membership.applyPulledStatus).
        // The column is added with a separate ALTER so older
        // user_tier_state rows from migration 118 pick it up too.
        name: "user_tier_state.country",
        sql: `
            ALTER TABLE public.user_tier_state
                ADD COLUMN IF NOT EXISTS country text;
        `,
    },
    {
        // EU VAT registration number (e.g. 'HR12345678901').
        // Shown / editable in the user profile; passed to Stripe
        // customer.tax_id so automatic_tax can zero-rate B2B invoices.
        // Pulled from UMP billing_vat_number meta when the partner
        // plugin supplies it (see lib/membership.applyPulledStatus).
        // Lives on user_tier_state (same IAM-ownership reason as country).
        name: "user_tier_state.vat_number",
        sql: `
            ALTER TABLE public.user_tier_state
                ADD COLUMN IF NOT EXISTS vat_number text;
        `,
    },
    {
        // Optional catalog of UMP level definitions (future: sync from WP).
        name: "ump_membership_levels",
        sql: `
            CREATE TABLE IF NOT EXISTS public.ump_membership_levels (
                level_id   bigint PRIMARY KEY,
                slug       text,
                label      text,
                synced_at  timestamptz NOT NULL DEFAULT now()
            );
        `,
    },
    {
        // Mirror of UMP assignments we know about (Stripe webhook, UMP pull).
        // Rebuilt on each update; empty ⇒ no mirrored levels. Full multi-level
        // sync can replace all rows for a user in one transaction later.
        name: "ump_user_level_assignments",
        sql: `
            CREATE TABLE IF NOT EXISTS public.ump_user_level_assignments (
                user_id    uuid NOT NULL
                    REFERENCES public.users(id) ON DELETE CASCADE,
                wp_user_id bigint NOT NULL,
                level_id   integer NOT NULL,
                expire_at  timestamptz,
                status     text,
                synced_at  timestamptz NOT NULL DEFAULT now(),
                PRIMARY KEY (user_id, level_id)
            );
        `,
    },
    {
        name: "ump_user_level_assignments_wp_idx",
        sql: `
            CREATE INDEX IF NOT EXISTS idx_ump_user_level_wp
                ON public.ump_user_level_assignments (wp_user_id);
        `,
    },
    // -----------------------------------------------------------------------
    // PII Shield user preferences. Only the core-owned columns live here:
    // per-user defaults on user_profiles (+ chats.pii_mode above). The
    // pii_* tables themselves (sessions, mappings, analyses, audit log) are
    // owned and bootstrapped by mike-pii-shield in its own database since
    // #14 — the AGPL core never touches them at the SQL level.
    // -----------------------------------------------------------------------
    {
        name: "user_profiles.pii_default_mode",
        sql: `
            ALTER TABLE public.user_profiles
                ADD COLUMN IF NOT EXISTS pii_default_mode text
                    NOT NULL DEFAULT 'off'
                    CHECK (pii_default_mode IN ('off', 'standard', 'strict_legal', 'strict'));
        `,
    },
    {
        name: "user_profiles.pii_review_required",
        sql: `
            ALTER TABLE public.user_profiles
                ADD COLUMN IF NOT EXISTS pii_review_required boolean
                    NOT NULL DEFAULT true;
        `,
    },
    {
        name: "user_profiles.pii_disclosure_policy",
        sql: `
            ALTER TABLE public.user_profiles
                ADD COLUMN IF NOT EXISTS pii_disclosure_policy jsonb
                    NOT NULL DEFAULT '{}'::jsonb;
        `,
    },
    // ── Team subsystem (MVP) ────────────────────────────────────────────
    // A team is a seat-bound roster owned by a Team-tier subscriber. Adding
    // a member to a specific predmet (project) still uses
    // projects.shared_with (existing access path); teams add the managed,
    // gated roster + seat accounting. See lib/teams.ts + routes/teams.ts.
    {
        name: "teams",
        sql: `
            CREATE TABLE IF NOT EXISTS public.teams (
                id                     uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
                name                   text        NOT NULL DEFAULT 'My Team',
                owner_user_id          uuid        NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
                seats                  integer     NOT NULL DEFAULT 5,
                stripe_subscription_id text,
                created_at             timestamptz NOT NULL DEFAULT now(),
                updated_at             timestamptz NOT NULL DEFAULT now()
            );
        `,
    },
    {
        // One team per owner (the buyer). Lets ensureTeamForOwner upsert.
        name: "teams_owner_uniq",
        sql: `
            CREATE UNIQUE INDEX IF NOT EXISTS teams_owner_uniq
                ON public.teams(owner_user_id);
        `,
    },
    {
        name: "team_members",
        sql: `
            CREATE TABLE IF NOT EXISTS public.team_members (
                id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
                team_id     uuid        NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,
                user_id     uuid        REFERENCES public.users(id) ON DELETE SET NULL,
                email       text        NOT NULL,
                role        text        NOT NULL DEFAULT 'member',
                status      text        NOT NULL DEFAULT 'invited',
                invited_by  uuid        REFERENCES public.users(id) ON DELETE SET NULL,
                invited_at  timestamptz NOT NULL DEFAULT now(),
                joined_at   timestamptz
            );
        `,
    },
    {
        // One membership row per (team, email).
        name: "team_members_team_email_uniq",
        sql: `
            CREATE UNIQUE INDEX IF NOT EXISTS team_members_team_email_uniq
                ON public.team_members(team_id, lower(email));
        `,
    },
    {
        name: "team_members_team_idx",
        sql: `
            CREATE INDEX IF NOT EXISTS idx_team_members_team
                ON public.team_members(team_id);
        `,
    },
    {
        name: "team_members_email_idx",
        sql: `
            CREATE INDEX IF NOT EXISTS idx_team_members_email
                ON public.team_members(lower(email));
        `,
    },
    {
        name: "team_members_user_idx",
        sql: `
            CREATE INDEX IF NOT EXISTS idx_team_members_user
                ON public.team_members(user_id);
        `,
    },
    {
        // Tiny KV store for AdminMax operator state — e.g. the
        // `new_users_last_checked_at` timestamp behind the "new users
        // since last look" corner badge. AdminMax auth is a single shared
        // password (no per-admin identity), so state is global. Mirrors
        // migration 126.
        name: "admin_state",
        sql: `
            CREATE TABLE IF NOT EXISTS public.admin_state (
                key        text        PRIMARY KEY,
                value      jsonb       NOT NULL DEFAULT '{}'::jsonb,
                updated_at timestamptz NOT NULL DEFAULT now()
            );
        `,
    },
    {
        // Append-only audit of tier transitions (Stripe webhook, UMP pull,
        // AdminMax manual set). Written by lib/membership.ts whenever the
        // effective tier actually changes. Mirrors migration 126.
        name: "tier_change_history",
        sql: `
            CREATE TABLE IF NOT EXISTS public.tier_change_history (
                id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
                user_id            uuid        NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
                old_tier_level_id  integer,
                new_tier_level_id  integer,
                old_until          timestamptz,
                new_until          timestamptz,
                source             text        NOT NULL
                                               CHECK (source IN ('stripe', 'ump_sync', 'admin')),
                reason             text,
                created_at         timestamptz NOT NULL DEFAULT now()
            );
        `,
    },
    {
        name: "tier_change_history_user_idx",
        sql: `
            CREATE INDEX IF NOT EXISTS idx_tier_change_history_user
                ON public.tier_change_history (user_id, created_at DESC);
        `,
    },
    {
        name: "tier_change_history_created_idx",
        sql: `
            CREATE INDEX IF NOT EXISTS idx_tier_change_history_created
                ON public.tier_change_history (created_at DESC);
        `,
    },
    {
        // last_login_at / login_count per user, updated (throttled) by the
        // auth middleware. Separate table because the IAM DB user cannot
        // ALTER public.users (owned by postgres). Mirrors migration 126.
        name: "user_login_state",
        sql: `
            CREATE TABLE IF NOT EXISTS public.user_login_state (
                user_id       uuid        PRIMARY KEY
                    REFERENCES public.users(id) ON DELETE CASCADE,
                last_login_at timestamptz NOT NULL DEFAULT now(),
                login_count   bigint      NOT NULL DEFAULT 1
            );
        `,
    },
    {
        name: "user_login_state_last_login_idx",
        sql: `
            CREATE INDEX IF NOT EXISTS idx_user_login_state_last_login
                ON public.user_login_state (last_login_at DESC);
        `,
    },
    {
        // Subscription revenue ledger — Stripe webhook mirrors every PAID
        // subscription invoice here so analytics can sum real income
        // (token packs live in user_token_credits). Mirrors migration 127.
        name: "billing_revenue",
        sql: `
            CREATE TABLE IF NOT EXISTS public.billing_revenue (
                id                      uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
                user_id                 uuid        REFERENCES public.users(id) ON DELETE SET NULL,
                stripe_customer_id      text,
                stripe_invoice_id       text        UNIQUE,
                stripe_subscription_id  text,
                plan                    text,
                amount_cents            integer     NOT NULL CHECK (amount_cents > 0),
                currency                text        NOT NULL DEFAULT 'eur',
                paid_at                 timestamptz NOT NULL DEFAULT now(),
                created_at              timestamptz NOT NULL DEFAULT now()
            );
        `,
    },
    {
        name: "billing_revenue_paid_idx",
        sql: `
            CREATE INDEX IF NOT EXISTS idx_billing_revenue_paid
                ON public.billing_revenue (paid_at DESC);
        `,
    },
    {
        name: "billing_revenue_user_idx",
        sql: `
            CREATE INDEX IF NOT EXISTS idx_billing_revenue_user
                ON public.billing_revenue (user_id, paid_at DESC)
                WHERE user_id IS NOT NULL;
        `,
    },
    {
        // Cross-instance lease for POST /tabular-review/:id/generate. The
        // in-memory activeGenerateRuns set only guards one process; with
        // Cloud Run maxScale > 1 a second click can land on another
        // instance. Acquired via conditional UPDATE (atomic per row);
        // the timestamp doubles as a TTL so a crashed holder can't wedge
        // the review forever.
        name: "tabular_reviews.generate_lock_until",
        sql: `
            ALTER TABLE public.tabular_reviews
                ADD COLUMN IF NOT EXISTS generate_lock_until timestamptz;
        `,
    },
    {
        // Authoritative list of documents attached to a review. Historically
        // a review's documents existed ONLY implicitly as the distinct
        // document_ids in tabular_cells (doc × column matrix). That meant a
        // review created/updated with documents but ZERO columns produced
        // zero cells and silently lost its documents. This column persists
        // the document set independently of the cell matrix; cells stay the
        // matrix, document_ids is the source of truth for "which docs".
        name: "tabular_reviews.document_ids",
        sql: `
            ALTER TABLE public.tabular_reviews
                ADD COLUMN IF NOT EXISTS document_ids jsonb NOT NULL DEFAULT '[]'::jsonb;
        `,
    },
    {
        // Contexts runtime — per-user toggle prefs for the optional context
        // provider (CONTEXTS_URL). context_id is an OPAQUE provider id: no
        // FK, the provider owns the content datastore. Mirrors
        // migrations/201_custom_contexts.sql + 205 (FK removal).
        name: "user_context_prefs",
        sql: `
            CREATE TABLE IF NOT EXISTS public.user_context_prefs (
                user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
                context_id uuid NOT NULL,
                enabled boolean NOT NULL,
                created_at timestamptz NOT NULL DEFAULT now(),
                updated_at timestamptz NOT NULL DEFAULT now(),
                PRIMARY KEY (user_id, context_id)
            );
        `,
    },
    {
        // Contexts runtime — attach links: a context attached to a
        // workflow/project joins that run's active set, access re-checked
        // per requester by the provider's resolve. Opaque context ids, no
        // FK. Mirrors migrations/203_context_links.sql + 205 (FK removal).
        name: "context_workflow_links",
        sql: `
            CREATE TABLE IF NOT EXISTS public.context_workflow_links (
                context_id uuid NOT NULL,
                workflow_id uuid NOT NULL,
                created_at timestamptz NOT NULL DEFAULT now(),
                PRIMARY KEY (context_id, workflow_id)
            );
        `,
    },
    {
        name: "idx_context_workflow_links_wf",
        sql: `
            CREATE INDEX IF NOT EXISTS idx_context_workflow_links_wf
                ON public.context_workflow_links (workflow_id);
        `,
    },
    {
        name: "context_project_links",
        sql: `
            CREATE TABLE IF NOT EXISTS public.context_project_links (
                context_id uuid NOT NULL,
                project_id uuid NOT NULL,
                created_at timestamptz NOT NULL DEFAULT now(),
                PRIMARY KEY (context_id, project_id)
            );
        `,
    },
    {
        name: "idx_context_project_links_proj",
        sql: `
            CREATE INDEX IF NOT EXISTS idx_context_project_links_proj
                ON public.context_project_links (project_id);
        `,
    },
    {
        // Databases created before migration 205 carry FKs from the runtime
        // tables into the deprecated custom_contexts content table; provider
        // context ids are opaque and never rows there, so the FKs must go.
        // Mirrors migrations/205_deprecate_context_content_tables.sql.
        name: "context_runtime_tables_no_content_fk",
        sql: `
            ALTER TABLE public.user_context_prefs
                DROP CONSTRAINT IF EXISTS user_context_prefs_context_id_fkey;
            ALTER TABLE public.context_workflow_links
                DROP CONSTRAINT IF EXISTS context_workflow_links_context_id_fkey;
            ALTER TABLE public.context_project_links
                DROP CONSTRAINT IF EXISTS context_project_links_context_id_fkey;
        `,
    },
    {
        // Generic notification store for the license-boundary seams
        // (design §4.2): configured services POST /internal/notifications
        // and the core stores rows it does not interpret.
        // Mirrors migrations/204_service_notifications.sql.
        name: "service_notifications",
        sql: `
            CREATE TABLE IF NOT EXISTS public.service_notifications (
              id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
              user_id        UUID REFERENCES public.users(id) ON DELETE CASCADE,
              context_ref    TEXT,
              title          TEXT NOT NULL,
              body_md        TEXT,
              link           TEXT,
              source_service TEXT NOT NULL,
              read_at        TIMESTAMPTZ,
              created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
            );
        `,
    },
    {
        name: "service_notifications_user_idx",
        sql: `
            CREATE INDEX IF NOT EXISTS service_notifications_user_idx
                ON public.service_notifications (user_id, created_at DESC);
        `,
    },
];

// Errors that indicate the connection itself died (Cloud SQL Auth Proxy
// hiccup, IAM token refresh race, idle drop). Retrying these against a
// fresh pooled connection almost always succeeds; we should not give up
// after a single attempt because the statement is idempotent.
const TRANSIENT_PATTERNS = [
    /connection terminated/i,
    /connection reset/i,
    /timeout/i,
    /ECONNRESET/,
    /ECONNREFUSED/,
    /server closed the connection/i,
];

function isTransient(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return TRANSIENT_PATTERNS.some((re) => re.test(msg));
}

async function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function applyWithRetry(
    name: string,
    sql: string,
    maxAttempts = 5,
): Promise<void> {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            await query(sql);
            if (attempt > 1) {
                console.log(
                    `[ensureSchema] '${name}' applied on attempt ${attempt}`,
                );
            }
            return;
        } catch (err) {
            lastErr = err;
            const transient = isTransient(err);
            const msg = err instanceof Error ? err.message : String(err);
            console.warn(
                `[ensureSchema] '${name}' attempt ${attempt}/${maxAttempts} failed (${transient ? "transient" : "permanent"}): ${msg}`,
            );
            if (!transient) break;
            // Exponential backoff: 250ms, 500ms, 1s, 2s — well under the
            // 10s Cloud Run startup probe so the listener stays healthy.
            await sleep(250 * 2 ** (attempt - 1));
        }
    }
    console.error(
        `[ensureSchema] giving up on '${name}':`,
        lastErr instanceof Error ? lastErr.message : lastErr,
    );
}

async function verifyUserTierStateTable(): Promise<void> {
    try {
        const r = await query<{ exists: boolean }>(
            `SELECT EXISTS (
                SELECT 1 FROM information_schema.tables
                 WHERE table_schema = 'public'
                   AND table_name = 'user_tier_state'
            ) AS exists`,
        );
        if (!r.rows[0]?.exists) {
            console.error(
                "[ensureSchema] CRITICAL: public.user_tier_state is missing — Plus tier override + Stripe customer cannot persist.",
            );
        }
    } catch (err) {
        console.warn(
            "[ensureSchema] could not verify user_tier_state:",
            err instanceof Error ? err.message : err,
        );
    }
}

// NOTE: PII retention (pii_audit_log 13-month trim, expired-session
// cleanup, stale analyses) moved into mike-pii-shield with the DB split
// (#14) — the shield owns the pii_* schema and its retention job.

export async function ensureSchema(): Promise<void> {
    for (const stmt of STATEMENTS) {
        await applyWithRetry(stmt.name, stmt.sql);
    }
    await verifyUserTierStateTable();
    console.log("[ensureSchema] done");
}
