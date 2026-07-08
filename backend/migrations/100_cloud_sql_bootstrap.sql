-- ============================================================
-- MikeOSS Cloud SQL Bootstrap
-- Project: <GCP_PROJECT> | Instance: <CLOUD_SQL_INSTANCE> | Database: mike
-- Run as: postgres (admin) after instance creation
-- ============================================================

-- ============================================================
-- 1. ROLES (Least Privilege)
-- ============================================================

-- Role 1: mike_owner — DDL only (migrations, CI/CD)
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'mike_owner') THEN
    CREATE ROLE mike_owner LOGIN PASSWORD 'rotate-via-secret-manager';
  END IF;
END $$;
GRANT CONNECT ON DATABASE mike TO mike_owner;
GRANT CREATE ON SCHEMA public TO mike_owner;

-- Role 2: mike_app — runtime (Cloud Run backend, IAM auth)
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'mike_app') THEN
    CREATE ROLE mike_app LOGIN;
  END IF;
END $$;
GRANT CONNECT ON DATABASE mike TO mike_app;

-- Role 3: mike_readonly — monitoring, debugging
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'mike_readonly') THEN
    CREATE ROLE mike_readonly LOGIN PASSWORD 'rotate-via-secret-manager';
  END IF;
END $$;
GRANT CONNECT ON DATABASE mike TO mike_readonly;

-- Map IAM Service Account to mike_app role
-- (mike-backend@<GCP_PROJECT>.iam connects via Cloud SQL Connector)
GRANT mike_app TO "mike-backend@<GCP_PROJECT>.iam";

-- ============================================================
-- 2. EXTENSIONS
-- ============================================================
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
-- pgcrypto for gen_random_uuid() (built-in in PG13+, but explicit)

-- ============================================================
-- 3. TABLES (owned by mike_owner)
-- ============================================================
SET ROLE mike_owner;

-- Users (replaces Supabase auth.users)
CREATE TABLE IF NOT EXISTS public.users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wp_user_id bigint UNIQUE,  -- nullable until first OAuth login
  email text NOT NULL,
  display_name text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_users_wp ON public.users(wp_user_id);
CREATE INDEX IF NOT EXISTS idx_users_email ON public.users(email);

-- User profiles
CREATE TABLE IF NOT EXISTS public.user_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  display_name text DEFAULT '',
  claude_api_key text DEFAULT '',
  openai_api_key text DEFAULT '',
  gemini_api_key text DEFAULT '',
  mistral_api_key text DEFAULT '',
  message_credits_used integer DEFAULT 0,
  tier text DEFAULT 'free',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE(user_id)
);

-- Projects
CREATE TABLE IF NOT EXISTS public.projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  name text NOT NULL DEFAULT 'Untitled Project',
  description text DEFAULT '',
  cm_number text,
  visibility text NOT NULL DEFAULT 'private',
  shared_with jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_projects_user ON public.projects(user_id);
CREATE INDEX IF NOT EXISTS projects_shared_with_idx ON public.projects USING gin (shared_with);

-- Project subfolders
CREATE TABLE IF NOT EXISTS public.project_subfolders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  name text NOT NULL,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_subfolders_project ON public.project_subfolders(project_id);

-- Documents
CREATE TABLE IF NOT EXISTS public.documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  subfolder_id uuid REFERENCES public.project_subfolders(id) ON DELETE SET NULL,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  name text NOT NULL,
  storage_key text NOT NULL,
  mime_type text DEFAULT 'application/octet-stream',
  size_bytes bigint DEFAULT 0,
  pdf_storage_key text,
  pdf_ready boolean DEFAULT false,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_docs_project ON public.documents(project_id);
CREATE INDEX IF NOT EXISTS idx_docs_user ON public.documents(user_id);

-- Document versions
CREATE TABLE IF NOT EXISTS public.document_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES public.documents(id) ON DELETE CASCADE,
  version_number integer NOT NULL,
  storage_key text NOT NULL,
  description text DEFAULT '',
  created_by uuid REFERENCES public.users(id),
  created_at timestamptz DEFAULT now(),
  UNIQUE(document_id, version_number)
);

-- Document edits
CREATE TABLE IF NOT EXISTS public.document_edits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES public.documents(id) ON DELETE CASCADE,
  edit_type text NOT NULL,
  content jsonb DEFAULT '{}',
  created_by uuid REFERENCES public.users(id),
  created_at timestamptz DEFAULT now()
);

-- Chats
CREATE TABLE IF NOT EXISTS public.chats (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  title text DEFAULT 'New Chat',
  model text DEFAULT 'gpt-4o',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_chats_project ON public.chats(project_id);

-- Chat messages
CREATE TABLE IF NOT EXISTS public.chat_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id uuid NOT NULL REFERENCES public.chats(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'tool')),
  content text DEFAULT '',
  metadata jsonb DEFAULT '{}',
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_messages_chat ON public.chat_messages(chat_id);

-- Workflows
CREATE TABLE IF NOT EXISTS public.workflows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text DEFAULT '',
  steps jsonb DEFAULT '[]',
  is_public boolean DEFAULT false,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Workflow shares
CREATE TABLE IF NOT EXISTS public.workflow_shares (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id uuid NOT NULL REFERENCES public.workflows(id) ON DELETE CASCADE,
  shared_with uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  permission text DEFAULT 'view',
  created_at timestamptz DEFAULT now(),
  UNIQUE(workflow_id, shared_with)
);

-- Hidden workflows (user dismissed)
CREATE TABLE IF NOT EXISTS public.hidden_workflows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  workflow_id uuid NOT NULL REFERENCES public.workflows(id) ON DELETE CASCADE,
  created_at timestamptz DEFAULT now(),
  UNIQUE(user_id, workflow_id)
);

-- User MCP servers
CREATE TABLE IF NOT EXISTS public.user_mcp_servers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  name text NOT NULL,
  url text NOT NULL,
  api_key text DEFAULT '',
  enabled boolean DEFAULT true,
  created_at timestamptz DEFAULT now()
);

-- Tabular reviews
CREATE TABLE IF NOT EXISTS public.tabular_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  name text NOT NULL,
  config jsonb DEFAULT '{}',
  status text DEFAULT 'draft',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Tabular cells
CREATE TABLE IF NOT EXISTS public.tabular_cells (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  review_id uuid NOT NULL REFERENCES public.tabular_reviews(id) ON DELETE CASCADE,
  row_index integer NOT NULL,
  col_index integer NOT NULL,
  value text DEFAULT '',
  metadata jsonb DEFAULT '{}',
  updated_at timestamptz DEFAULT now(),
  UNIQUE(review_id, row_index, col_index)
);
CREATE INDEX IF NOT EXISTS idx_cells_review ON public.tabular_cells(review_id);

-- Tabular review chats
CREATE TABLE IF NOT EXISTS public.tabular_review_chats (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  review_id uuid NOT NULL REFERENCES public.tabular_reviews(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  title text DEFAULT 'Chat',
  created_at timestamptz DEFAULT now()
);

-- Tabular review chat messages
CREATE TABLE IF NOT EXISTS public.tabular_review_chat_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id uuid NOT NULL REFERENCES public.tabular_review_chats(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'tool')),
  content text DEFAULT '',
  metadata jsonb DEFAULT '{}',
  created_at timestamptz DEFAULT now()
);

RESET ROLE;

-- ============================================================
-- 4. GRANTS — mike_app (runtime DML only)
-- ============================================================
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  public.users,
  public.user_profiles,
  public.projects,
  public.project_subfolders,
  public.documents,
  public.document_versions,
  public.document_edits,
  public.chats,
  public.chat_messages,
  public.workflows,
  public.workflow_shares,
  public.hidden_workflows,
  public.user_mcp_servers,
  public.tabular_reviews,
  public.tabular_cells,
  public.tabular_review_chats,
  public.tabular_review_chat_messages
TO mike_app;

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO mike_app;

-- Future tables created by mike_owner auto-inherit grants
ALTER DEFAULT PRIVILEGES FOR ROLE mike_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO mike_app;
ALTER DEFAULT PRIVILEGES FOR ROLE mike_owner IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO mike_app;

-- ============================================================
-- 5. GRANTS — mike_readonly (SELECT only)
-- ============================================================
GRANT SELECT ON ALL TABLES IN SCHEMA public TO mike_readonly;
ALTER DEFAULT PRIVILEGES FOR ROLE mike_owner IN SCHEMA public
  GRANT SELECT ON TABLES TO mike_readonly;
