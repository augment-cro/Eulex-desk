import { getPromptPackVersion } from "./seams/promptPack";

/**
 * /health payload. `sha` identifies the deployed build (evals enabler,
 * approved 2026-07-03) — without it the SUT's version is unpinnable and a
 * run manifest cannot separate product regression from deploy drift.
 * BUILD_GIT_SHA is injected at deploy time (cloudbuild *.yaml); `null` on
 * manual submits without git context is honest-unknown, not an error.
 *
 * `promptPackVersion` pins the governance prompt-pack version serving this
 * instance (spec §9.3): every ALFA/bench result traces to the exact prompt
 * version that produced it. `null` when no pack is loaded (env unset or
 * service unreachable since boot — the generic fallback prompt is active).
 */
export function healthPayload(env: Record<string, string | undefined> = process.env) {
    return {
        ok: true as const,
        sha: env.BUILD_GIT_SHA || null,
        promptPackVersion: getPromptPackVersion(),
    };
}
