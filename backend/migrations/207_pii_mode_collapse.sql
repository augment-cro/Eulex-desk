-- 207: PII settings simplification (#14) — one Anonymization mode.
--
-- The Settings → Privacy & PII screen collapses from three controls
-- (Default mode with four values + "always require review" toggle +
-- "disclosure policy for external tools") into a single Anonymization
-- mode: 'off' | 'standard' | 'strict'.
--
--  * 'strict_legal' folds into 'strict' — the strictest semantics of
--    both win (review on every input AND unknown-placeholder rejection
--    / tool-arg block). There is no longer a mode where the system may
--    add placeholders later without user confirmation.
--  * pii_review_required opt-ins on 'standard' migrate to 'strict' so
--    those users keep their review modals. The column itself is
--    retired (DEFAULT true meant every profile carried true; only an
--    explicit false — nobody in prod as of 2026-07-22 — opted out).
--  * pii_disclosure_policy is retired without a data migration: it was
--    stored and echoed to clients but never consulted at decision time
--    (tool behaviour is the per-tool registry in lib/pii/toolPolicy.ts).
--
-- Both retired columns stay in place for rollback; no code reads them.
-- The shield DB keeps accepting 'strict_legal' in pii_sessions.mode for
-- legacy session rows (they expire via TTL); the backend normalizes the
-- value to 'strict' everywhere it reads (lib/pii/gate.ts).
--
-- Safe to run multiple times. Mirrored in backend/src/lib/ensureSchema.ts
-- (statement "user_profiles.pii_mode_collapse_207").

UPDATE public.user_profiles
   SET pii_default_mode = 'strict'
 WHERE pii_default_mode = 'strict_legal'
    OR (pii_default_mode = 'standard' AND pii_review_required = true);

UPDATE public.chats
   SET pii_mode = 'strict'
 WHERE pii_mode = 'strict_legal';
