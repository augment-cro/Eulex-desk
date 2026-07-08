/**
 * PII-Shield mode gating helpers.
 *
 * The "mode" is the user-controlled privacy posture for a chat
 * session. Three values matter to the rest of the backend:
 *
 *   - "off"            — bypass the sidecar entirely.
 *   - "standard"       — anonymize at upload time, deanonymize on
 *                        response; tool args/results follow the policy
 *                        registry; no review modal.
 *   - "strict_legal"   — same as standard PLUS user review on each
 *                        new document; PERSON / ORG / ADDRESS are
 *                        masked by default.
 *   - "strict"         — same as strict_legal PLUS unknown placeholder
 *                        rejection (no fail-open) and tool-arg block.
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
    pii_review_required: boolean;
    pii_disclosure_policy: "allow" | "deny" | "ask";
}

export const DEFAULT_USER_PII_PREFS: UserPiiPrefs = {
    pii_default_mode: "off",
    pii_review_required: false,
    pii_disclosure_policy: "ask",
};

export function effectiveMode(
    chatMode: string | null | undefined,
    userPrefs: Pick<UserPiiPrefs, "pii_default_mode"> | null | undefined,
): EffectiveMode {
    const candidate = (chatMode ?? userPrefs?.pii_default_mode ?? "off").toString();
    switch (candidate) {
        case "standard":
        case "strict_legal":
        case "strict":
        case "off":
            return candidate;
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
    return mode === "strict";
}

export function requiresUserReview(
    mode: EffectiveMode | null | undefined,
    userPrefs: UserPiiPrefs | null | undefined,
): boolean {
    if (!piiActive(mode)) return false;
    if (mode === "strict_legal" || mode === "strict") return true;
    return !!userPrefs?.pii_review_required;
}
