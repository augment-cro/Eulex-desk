-- 204: Generic notification store for the license-boundary seams
-- (license design 2026-07-04 §4.2). Configured external services POST
-- /internal/notifications with a service-identity token; the core stores
-- rows it does not interpret (opaque context_ref, opaque semantics).
-- Mirrored in backend/src/lib/ensureSchema.ts ("service_notifications").

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

CREATE INDEX IF NOT EXISTS service_notifications_user_idx
    ON public.service_notifications (user_id, created_at DESC);
