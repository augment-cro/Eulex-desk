/**
 * Decision helpers for the PII review-modal flow.
 *
 * Background
 * ==========
 * The chat composer's "AddDocButton" exposes an `onPiiReview` hook so a
 * parent can intercept the post-upload step and open the review modal.
 * The decision of whether to open the modal at all lives here so the
 * same rule can be reused in:
 *
 *   - lokalni file upload  (AddDocButton → input[type=file])
 *   - integrirani picker   (IntegrationFilePicker / GoogleDrivePicker)
 *   - drag-and-drop        (planiramo dodati)
 *   - tabular review       (TRAddNewModal)
 *
 * Single source of truth → identičan UX bez obzira na ulaznu točku.
 *
 * Rules (#14 — single Anonymization mode)
 * =======================================
 * | mode     | open modal? |
 * |----------|-------------|
 * | off      | NEVER       |
 * | standard | NEVER       |
 * | strict   | ALWAYS      |
 *
 * Why `standard` skips the modal:
 *   The whole point of "standard" mode is silent best-effort masking
 *   with high recall. Users who want the gate pick "strict" on
 *   /account/privacy — there is no separate review toggle anymore (the
 *   old `reviewRequired` opt-in migrated into strict, migration 207).
 *
 * "strict_legal" is a retired legacy wire value; treat it as strict.
 */

export type PiiReviewMode = "off" | "standard" | "strict_legal" | "strict";

export function shouldReviewPii(args: {
    mode: PiiReviewMode | null | undefined;
}): boolean {
    const mode = args.mode ?? "off";
    return mode === "strict" || mode === "strict_legal";
}

/**
 * Maps the UI mode to the wire-mode the sidecar accepts.
 *
 * The sidecar API rejects "off" because "off" means "don't call me",
 * but the frontend type carries it for completeness. Callers that
 * already gated through `shouldReviewPii` know the mode is non-off,
 * but TypeScript doesn't, so this helper narrows + asserts.
 */
export function toSidecarMode(
    mode: PiiReviewMode,
): "standard" | "strict_legal" | "strict" {
    if (mode === "off") {
        throw new Error(
            "PII Shield called with mode=off — gate with shouldReviewPii first",
        );
    }
    return mode;
}
