/**
 * PII-Shield mode gating helpers.
 *
 * The "mode" is the user-controlled privacy posture for a chat
 * session. Since #14 (PII settings simplification) exactly three
 * user-facing values exist:
 *
 *   - "off"      — bypass the sidecar entirely.
 *   - "standard" — anonymize at upload time, deanonymize on response;
 *                  tool args/results follow the policy registry; no
 *                  review modal. Fails OPEN on sidecar errors.
 *   - "strict"   — everything standard does PLUS user review before
 *                  every AI call (initial and later additions), unknown
 *                  placeholder rejection, tool-arg block, and
 *                  fail-CLOSED semantics on sidecar errors.
 *
 * "strict_legal" is a retired legacy value (it sat between standard and
 * strict). Old chats / profiles may still carry it until migration 207
 * rewrites them, so every helper here treats it as an alias of
 * "strict" — never drop that tolerance, a mis-read must err strict.
 *
 * The `effectiveMode` helper resolves a chat's mode from (1) explicit
 * chat metadata, (2) user defaults, (3) a global default — in that
 * order. Routes that have already loaded the chat row should pass the
 * `chat.pii_mode` themselves; routes that don't load the chat (tabular
 * /generate, pre-warm) can fall back to user defaults via the
 * userSettings helper.
 */

import { piiClient, type PiiMode } from "./client";

export type EffectiveMode = PiiMode | "off";

export interface UserPiiPrefs {
    pii_default_mode: EffectiveMode;
}

export const DEFAULT_USER_PII_PREFS: UserPiiPrefs = {
    pii_default_mode: "off",
};

export function effectiveMode(
    chatMode: string | null | undefined,
    userPrefs: Pick<UserPiiPrefs, "pii_default_mode"> | null | undefined,
): EffectiveMode {
    const candidate = (chatMode ?? userPrefs?.pii_default_mode ?? "off").toString();
    switch (candidate) {
        case "standard":
        case "off":
            return candidate;
        // Legacy alias — see the header note. Normalized here so the
        // rest of the request pipeline only ever sees the three modes.
        case "strict_legal":
        case "strict":
            return "strict";
        default:
            return "off";
    }
}

/**
 * Convenience predicate — returns true when PII Shield should
 * intercept the current request. Combines the env-var gate (sidecar
 * deployed?) with the user-facing mode. Wrong answer here means the
 * code below silently falls back to non-anonymized data, so keep this
 * single source of truth.
 */
export function piiActive(mode: EffectiveMode | null | undefined): mode is PiiMode {
    if (!piiClient.isConfigured()) return false;
    return mode === "standard" || mode === "strict_legal" || mode === "strict";
}

export function isStrict(mode: EffectiveMode | null | undefined): boolean {
    return mode === "strict" || mode === "strict_legal";
}

/**
 * True when the mode promises fail-CLOSED semantics: if the sidecar is
 * unreachable, raw user content must be WITHHELD from the LLM rather
 * than sent through unprotected (#48). Standard deliberately fails open
 * (with a `[pii]` warn at the call site).
 */
export function failsClosed(mode: EffectiveMode | null | undefined): boolean {
    return mode === "strict" || mode === "strict_legal";
}

/**
 * Review is a property of the mode alone since #14: strict always
 * reviews, standard never does (the retired `pii_review_required`
 * toggle migrated its opt-ins into strict — see migration 207).
 */
export function requiresUserReview(mode: EffectiveMode | null | undefined): boolean {
    if (!piiActive(mode)) return false;
    return mode === "strict" || mode === "strict_legal";
}
