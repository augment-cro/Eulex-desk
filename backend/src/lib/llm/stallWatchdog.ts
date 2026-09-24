/**
 * Idle-deadline watchdog for LLM provider streams (tracker #25).
 *
 * The per-turn `turnAbort` AbortController historically fired ONLY on
 * client disconnect, and the SSE routes deliberately disable Node's
 * per-request socket timeouts — so a provider that stopped emitting
 * chunks mid-stream held the connection open until Cloud Run's 3600 s
 * service ceiling. The watchdog closes that gap: after
 * `LLM_STREAM_DEADLINE_MS` of *total silence* it fires `onStall` exactly
 * once, and the caller aborts the EXISTING turn controller.
 *
 * This is an IDLE deadline, not a total-duration one. `touch()` re-arms
 * the timer and is called on every surfaced provider event (content /
 * reasoning deltas, tool-call starts, tool-run boundaries — see
 * streamChatWithTools) plus every SSE event runLLMStream writes, so long
 * legitimate generations and deep tool-research turns never trip it.
 * Only genuine silence longer than the deadline does.
 */

export const DEFAULT_LLM_STREAM_DEADLINE_MS = 240_000;

/**
 * Parse `LLM_STREAM_DEADLINE_MS`. The watchdog is a safety net, so
 * "disabled" is not a supported state: unset, empty, non-numeric, zero
 * or negative values all resolve to the default rather than turning the
 * deadline off.
 */
export function resolveLlmStreamDeadlineMs(
    raw: string | undefined = process.env.LLM_STREAM_DEADLINE_MS,
): number {
    if (!raw) return DEFAULT_LLM_STREAM_DEADLINE_MS;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return DEFAULT_LLM_STREAM_DEADLINE_MS;
    return Math.floor(n);
}

/**
 * Thrown out of runLLMStream when the watchdog fired. The chat routes map
 * it onto the same terminal `{type:"error", message, code}` SSE event the
 * frontend already renders (useAssistantChat.ts handles any code with the
 * generic localized stream-error banner).
 */
export class LlmStreamStallError extends Error {
    readonly code = "STREAM_STALLED";
    readonly deadlineMs: number;

    constructor(deadlineMs: number) {
        super(
            `LLM stream stalled: no provider activity for ${Math.round(
                deadlineMs / 1000,
            )}s`,
        );
        this.name = "LlmStreamStallError";
        this.deadlineMs = deadlineMs;
    }
}

export type StallWatchdog = {
    /**
     * Re-arm the idle deadline. Call on every chunk/event received from
     * the provider stream. No-op after `stop()` or once stalled.
     */
    touch: () => void;
    /**
     * Clear the timer. Must run on EVERY exit path (success, provider
     * error, client disconnect) — idempotent, safe to call twice.
     */
    stop: () => void;
    /** True once the deadline elapsed and `onStall` fired (at most once). */
    readonly stalled: boolean;
};

export function createStallWatchdog(opts: {
    onStall: () => void;
    /** Defaults to resolveLlmStreamDeadlineMs() (env-driven). */
    deadlineMs?: number;
}): StallWatchdog {
    const deadlineMs = opts.deadlineMs ?? resolveLlmStreamDeadlineMs();
    let stalled = false;
    let stopped = false;
    let timer: NodeJS.Timeout | null = null;

    const fire = () => {
        timer = null;
        if (stalled || stopped) return;
        stalled = true;
        opts.onStall();
    };

    const arm = () => {
        if (stalled || stopped) return;
        if (timer) clearTimeout(timer);
        timer = setTimeout(fire, deadlineMs);
        // Never let a pending watchdog keep the process alive on its own
        // (graceful SIGTERM drain, test runners). Optional-called because
        // fake-timer implementations may return a bare handle.
        timer.unref?.();
    };

    arm();

    return {
        touch: arm,
        stop: () => {
            stopped = true;
            if (timer) {
                clearTimeout(timer);
                timer = null;
            }
        },
        get stalled() {
            return stalled;
        },
    };
}
