-- 133: admin action audit trail (AdminMax)
-- Every mutating /adminmax/* action (tier changes, suspends, credit
-- grants/voids, tier-limit edits) plus data exports gets one append-only
-- row here. Complements the domain-specific user_tier_history table —
-- this is the cross-cutting "who did what, when" ledger console.log
-- lines used to be. Additive only.

CREATE TABLE IF NOT EXISTS public.admin_audit (
    id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    -- Operator identity. AdminMax has a single shared login today, so
    -- this is 'adminmax' until per-operator identity lands; admin-mcp
    -- writes proxy through the same REST API and are indistinguishable.
    actor       text        NOT NULL DEFAULT 'adminmax',
    -- Dot-namespaced verb, e.g. 'user.tier.set', 'credits.grant',
    -- 'export.usage_csv'.
    action      text        NOT NULL,
    target_type text,
    target_id   text,
    -- Small JSON snapshot of the relevant request values (before/after
    -- where cheap). Never store secrets or full document content here.
    payload     jsonb,
    ip          text,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_admin_audit_created
    ON public.admin_audit (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_admin_audit_target
    ON public.admin_audit (target_type, target_id, created_at DESC);
