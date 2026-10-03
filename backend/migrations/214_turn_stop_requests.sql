-- 214: explicit Stop (tracker #96). Behind Cloud Run a client disconnect never
-- reaches the container, so Stop now POSTs /chat/:chatId/stop. When that
-- request lands on another instance than the one generating, the stop waits
-- here until the generating instance's poll (lib/turnStop.ts) consumes it.
-- Also applied at boot by lib/ensureSchema.ts.
CREATE TABLE IF NOT EXISTS public.turn_stop_requests (
    chat_id      text        PRIMARY KEY,
    user_id      text        NOT NULL,
    requested_at timestamptz NOT NULL DEFAULT now()
);
