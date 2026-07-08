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
 * Rules
 * =====
 * | mode          | reviewRequired | open modal? |
 * |---------------|----------------|-------------|
 * | off           | any            | NEVER       |
 * | standard      | false          | NEVER       |
 * | standard      | true           | YES         |
 * | strict_legal  | any            | YES         |
 * | strict        | any            | YES         |
 *
 * Why `standard + reviewRequired=false` skips the modal:
 *   The whole point of "standard" mode is silent best-effort masking
 *   with high recall. Opening a modal for every upload would defeat
 *   the purpose. Users who want the gate explicitly opt-in via the
 *   "uvijek tražiti pregled" toggle on /account/privacy.
 */

export type PiiReviewMode = "off" | "standard" | "strict_legal" | "strict";

export function shouldReviewPii(args: {
    mode: PiiReviewMode | null | undefined;
    reviewRequired: boolean | null | undefined;
}): boolean {
    const mode = args.mode ?? "off";
    if (mode === "off") return false;
    if (mode === "standard") return !!args.reviewRequired;
    return true;
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
