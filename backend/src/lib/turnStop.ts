/**
 * Explicit Stop for streaming turns (tracker #96).
 *
 * The routes aborted a turn from `req.on("close")`, but behind Cloud Run the
 * client's disconnect never reaches the container — the front end keeps the
 * upstream HTTP/1.1 request open until the response ends — so Stop cut the
 * browser's stream while the model kept generating (and billing) to the end.
 *
 * The client now also POSTs /chat/:chatId/stop. That request can land on a
 * different instance than the one generating, so:
 *   - same instance: the registered controller is aborted at once;
 *   - otherwise: the request is written to public.turn_stop_requests, and
 *     every instance that has live turns polls that table (one query per
 *     instance every POLL_MS, and only while it has turns) and aborts its
 *     own.
 *
 * Aborting the turn's controller is the same path the stall watchdog and a
 * local disconnect already use (issue #92): adapters cancel the provider
 * request and no further tool iteration starts.
 */

import { query as dbQuery } from "./db";

// Swappable for tests (no database in unit tests).
let query = dbQuery;
export function setTurnStopQueryForTests(fn: typeof dbQuery): void {
    query = fn;
}

const POLL_MS = 2000;
/** A stop recorded this long before a turn started belongs to an older turn. */
const STALE_SKEW_MS = 1000;

type Turn = {
    controller: AbortController;
    userId: string;
    startedAt: number;
};

const turns = new Map<string, Turn>();
let pollTimer: NodeJS.Timeout | null = null;
let polling = false;
let lastPollErrorAt = 0;

/**
 * Register a live turn under its chat id. Returns the unregister function,
 * which must run on every exit path. A newer turn on the same chat replaces
 * the older registration; the older unregister then leaves it alone.
 */
export function registerTurn(
    chatId: string,
    userId: string,
    controller: AbortController,
): () => void {
    const turn: Turn = { controller, userId, startedAt: Date.now() };
    turns.set(chatId, turn);
    ensurePolling();
    return () => {
        if (turns.get(chatId) === turn) turns.delete(chatId);
        if (turns.size === 0) stopPolling();
    };
}

/**
 * Stop the caller's live turn on `chatId`. "stopped" when this instance ran
 * it; "requested" when it was handed to the instance that does.
 */
export async function requestTurnStop(
    chatId: string,
    userId: string,
): Promise<"stopped" | "requested"> {
    const turn = turns.get(chatId);
    if (turn && turn.userId === userId) {
        turn.controller.abort();
        return "stopped";
    }
    await query(
        `INSERT INTO public.turn_stop_requests (chat_id, user_id, requested_at)
              VALUES ($1, $2, now())
         ON CONFLICT (chat_id)
           DO UPDATE SET user_id = EXCLUDED.user_id, requested_at = now()`,
        [chatId, userId],
    );
    // Requests nobody consumed (the turn had already finished) — keep the
    // table from growing.
    void query(
        `DELETE FROM public.turn_stop_requests
          WHERE requested_at < now() - interval '1 hour'`,
    ).catch(() => {});
    return "requested";
}

/** Consume stop requests addressed to this instance's live turns. */
export async function pollTurnStops(): Promise<void> {
    if (turns.size === 0) return;
    const { rows } = await query<{
        chat_id: string;
        user_id: string;
        requested_at: Date;
    }>(
        `DELETE FROM public.turn_stop_requests
          WHERE chat_id = ANY($1::text[])
      RETURNING chat_id, user_id, requested_at`,
        [[...turns.keys()]],
    );
    for (const r of rows) {
        const turn = turns.get(r.chat_id);
        if (!turn || turn.userId !== r.user_id) continue;
        if (new Date(r.requested_at).getTime() < turn.startedAt - STALE_SKEW_MS)
            continue;
        turn.controller.abort();
    }
}

function ensurePolling(): void {
    if (pollTimer) return;
    pollTimer = setInterval(() => {
        if (polling) return;
        polling = true;
        pollTurnStops()
            .catch((err) => {
                // Log at most once a minute — a DB hiccup must not flood.
                if (Date.now() - lastPollErrorAt > 60_000) {
                    lastPollErrorAt = Date.now();
                    console.warn(
                        "[turnStop] poll failed:",
                        err instanceof Error ? err.message : err,
                    );
                }
            })
            .finally(() => {
                polling = false;
            });
    }, POLL_MS);
    pollTimer.unref?.();
}

function stopPolling(): void {
    if (!pollTimer) return;
    clearInterval(pollTimer);
    pollTimer = null;
}

/** Test hook: live turn count. */
export function activeTurnCount(): number {
    return turns.size;
}
