-- 101: Add missing columns to projects table
-- The Cloud SQL bootstrap (100) omitted cm_number and shared_with
-- that the original Supabase schema (000) had. The backend POST /projects
-- route relies on both columns.

ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS cm_number text,
  ADD COLUMN IF NOT EXISTS visibility text NOT NULL DEFAULT 'private',
  ADD COLUMN IF NOT EXISTS shared_with jsonb NOT NULL DEFAULT '[]'::jsonb;

CREATE INDEX IF NOT EXISTS projects_shared_with_idx
  ON public.projects USING gin (shared_with);
