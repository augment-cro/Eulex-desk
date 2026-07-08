-- 128_tabular_review_document_ids.sql
-- Persist a review's document set independently of the tabular_cells matrix.
--
-- Before this, a review's documents existed only implicitly as the distinct
-- document_ids appearing in tabular_cells (one row per document × column).
-- A review created or updated with documents but ZERO columns produced zero
-- cells, so its documents were silently dropped. This column makes the
-- document set authoritative and decoupled from columns; cells remain the
-- doc × column matrix, document_ids answers "which documents".
--
-- Mirrored idempotently in backend/src/lib/ensureSchema.ts
-- (tabular_reviews.document_ids) so fresh/auto-migrated deploys converge.

ALTER TABLE public.tabular_reviews
    ADD COLUMN IF NOT EXISTS document_ids jsonb NOT NULL DEFAULT '[]'::jsonb;
