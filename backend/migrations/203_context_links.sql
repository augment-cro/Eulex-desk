-- 203: Custom Contexts attach links (Plan 5). Safe to run repeatedly. Mirrored in ensureSchema.ts.

CREATE TABLE IF NOT EXISTS public.context_workflow_links (
  context_id  uuid NOT NULL REFERENCES public.custom_contexts(id) ON DELETE CASCADE,
  workflow_id uuid NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (context_id, workflow_id)
);
CREATE INDEX IF NOT EXISTS idx_context_workflow_links_wf ON public.context_workflow_links (workflow_id);

CREATE TABLE IF NOT EXISTS public.context_project_links (
  context_id uuid NOT NULL REFERENCES public.custom_contexts(id) ON DELETE CASCADE,
  project_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (context_id, project_id)
);
CREATE INDEX IF NOT EXISTS idx_context_project_links_proj ON public.context_project_links (project_id);
