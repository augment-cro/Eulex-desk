-- ============================================================
-- MikeOSS User Migration: Supabase auth.users → public.users
-- Run AFTER 100_cloud_sql_bootstrap.sql
-- Run AFTER exporting data from Supabase
-- ============================================================

-- Step 1: Import existing users (wp_user_id starts NULL)
-- The user_id UUIDs are preserved to maintain FK integrity
INSERT INTO public.users (id, email, display_name, created_at)
SELECT
  au.id,
  au.email,
  COALESCE(up.display_name, split_part(au.email, '@', 1)),
  au.created_at
FROM supabase_export.auth_users au  -- loaded from CSV/dump
LEFT JOIN supabase_export.user_profiles up ON up.user_id = au.id
ON CONFLICT (id) DO NOTHING;

-- Step 2: Auto-fill wp_user_id on first OAuth login
-- (handled in auth.ts middleware — see code below)
--
-- UPDATE public.users 
-- SET wp_user_id = $1
-- WHERE email = $2 AND wp_user_id IS NULL;

-- Step 3: After all active users have logged in at least once:
-- ALTER TABLE public.users ALTER COLUMN wp_user_id SET NOT NULL;

-- Migrate user_profiles (preserve UUIDs)
INSERT INTO public.user_profiles (
  id, user_id, display_name,
  claude_api_key, openai_api_key, gemini_api_key, mistral_api_key,
  message_credits_used, tier, created_at, updated_at
)
SELECT
  id, user_id, COALESCE(display_name, ''),
  COALESCE(claude_api_key, ''), COALESCE(openai_api_key, ''),
  COALESCE(gemini_api_key, ''), COALESCE(mistral_api_key, ''),
  COALESCE(message_credits_used, 0), COALESCE(tier, 'free'),
  created_at, updated_at
FROM supabase_export.user_profiles
ON CONFLICT (user_id) DO NOTHING;
