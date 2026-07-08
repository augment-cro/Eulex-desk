-- 202: Custom Contexts alerting (Plan 4). Max's inbox of eulex-emitted change
-- events + the per-context fan-out (written at intake). The daily digest drain
-- reads context_alert_events.notified_at. Safe to run repeatedly. Mirrored in
-- ensureSchema.ts.

CREATE TABLE IF NOT EXISTS public.source_change_events (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id    text        NOT NULL,
  change_type  text        NOT NULL
               CHECK (change_type IN ('new_consolidated','amendment','effective_date','repeal')),
  version_hash text        NOT NULL,
  detected_at  timestamptz NOT NULL DEFAULT now(),
  received_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_id, version_hash)
);

CREATE TABLE IF NOT EXISTS public.context_alert_events (
  id                     uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  context_id             uuid        NOT NULL REFERENCES public.custom_contexts(id) ON DELETE CASCADE,
  source_id              text        NOT NULL,
  source_change_event_id uuid        REFERENCES public.source_change_events(id) ON DELETE SET NULL,
  change_type            text        NOT NULL,
  detected_at            timestamptz NOT NULL DEFAULT now(),
  summary                text,
  notified_at            timestamptz
);
CREATE INDEX IF NOT EXISTS idx_context_alert_events_context
    ON public.context_alert_events (context_id, detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_context_alert_events_unnotified
    ON public.context_alert_events (detected_at) WHERE notified_at IS NULL;

-- Alert matcher hot path: contextIdsTrackingSource / updateSourceVersion
-- filter context_sources on split_part(lower(ref), '#', 1) — the shared
-- ref-stem rule (lib/contexts/scope.refStem). Expression index so the
-- webhook intake doesn't seq-scan.
CREATE INDEX IF NOT EXISTS idx_context_sources_ref_stem
    ON public.context_sources ((split_part(lower(ref), '#', 1)));
