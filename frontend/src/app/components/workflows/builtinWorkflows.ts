import { useEffect, useState } from "react";
import type { MikeWorkflow } from "../shared/types";
import { listBuiltinWorkflows } from "@/app/lib/mikeApi";

/**
 * Built-in workflows come from the backend's GET /workflows/builtin, which
 * re-serves the governance prompt-pack's workflow set (the proprietary
 * workflow copy no longer lives in this repo — see
 * contracts/prompt-pack.openapi.json). Standalone posture: when the
 * endpoint returns [] (no pack configured) the UI simply renders no
 * built-ins section.
 *
 * Only the localization plumbing stays here: id → i18n-key maps and the
 * title/practice localizers (translations live in messages/{en,hr}.json).
 */

/** Built-in ids are namespaced ("builtin-…"); user workflows are UUIDs. */
export function isBuiltinWorkflowId(id: string): boolean {
    return id.startsWith("builtin-");
}

// Module-level cache: the set is static per deployment, so one fetch per
// page load is enough. Failures are NOT cached — the next caller retries.
let cache: MikeWorkflow[] | null = null;
let inflight: Promise<MikeWorkflow[]> | null = null;

/** Fetch (and memoize) the built-in workflows. Never rejects — [] on failure. */
export function fetchBuiltinWorkflows(): Promise<MikeWorkflow[]> {
    if (cache) return Promise.resolve(cache);
    if (!inflight) {
        inflight = listBuiltinWorkflows()
            .then((workflows) => {
                cache = workflows;
                return workflows;
            })
            .catch(() => [] as MikeWorkflow[])
            .finally(() => {
                inflight = null;
            });
    }
    return inflight;
}

/**
 * Hook form for list surfaces: starts from the cache (instant on revisit)
 * and resolves to the fetched set. While loading — and when the backend
 * serves no packs — the built-ins section is simply empty.
 */
export function useBuiltinWorkflows(): MikeWorkflow[] {
    const [builtIns, setBuiltIns] = useState<MikeWorkflow[]>(cache ?? []);
    useEffect(() => {
        let alive = true;
        void fetchBuiltinWorkflows().then((workflows) => {
            if (alive && workflows.length > 0) setBuiltIns(workflows);
        });
        return () => {
            alive = false;
        };
    }, []);
    return builtIns;
}

/**
 * Map from built-in workflow id → i18n key under the `builtinWorkflows`
 * namespace in messages/{en,hr}.json. Used by getLocalizedWorkflowTitle()
 * so the title rendered in the UI matches the user's locale even though
 * the underlying data arrives with English titles.
 *
 * When a new built-in ships in the pack:
 *   1. add an entry here,
 *   2. add the matching string to en.json AND hr.json under
 *      "builtinWorkflows": { "<key>": "<translated title>" }.
 */
export const BUILTIN_TITLE_KEYS: Record<string, string> = {
    "builtin-cp-checklist": "cpChecklist",
    "builtin-coc-dd": "changeOfControlReview",
    "builtin-credit-summary": "creditAgreementSummary",
    "builtin-commercial-agreement": "commercialAgreementReview",
    "builtin-credit-agreement": "creditAgreementReview",
    "builtin-ediscovery": "eDiscoveryReview",
    "builtin-supply-agreement": "supplyAgreementReview",
    "builtin-spa": "spaReview",
    "builtin-nda": "ndaReview",
    "builtin-commercial-lease": "commercialLeaseReview",
    "builtin-lpa": "lpaReview",
    "builtin-sha-summary": "shareholderAgreementSummary",
    "builtin-shareholder-agreement": "shareholderAgreementReview",
    "builtin-employment-agreement": "employmentAgreementReview",
};

/**
 * Practice areas appear as small text next to workflows. Limited set of
 * known values arriving in English; we slug them to look up
 * translations under the `builtinPractices` namespace.
 */
const PRACTICE_KEYS: Record<string, string> = {
    "General Transactions": "generalTransactions",
    Corporate: "corporate",
    Finance: "finance",
    Litigation: "litigation",
    "Real Estate": "realEstate",
    "Private Equity": "privateEquity",
    Employment: "employment",
};

/**
 * Returns the title for a workflow in the user's locale. Falls back to
 * the raw `title` field for custom workflows (user-created), workflows
 * without a localization key, or whenever a translation is missing.
 *
 * Pass next-intl's `useTranslations("builtinWorkflows")` result as `t`.
 */
export function getLocalizedWorkflowTitle(
    workflow: { id: string; title: string },
    t: (key: string) => string,
): string {
    const key = BUILTIN_TITLE_KEYS[workflow.id];
    if (!key) return workflow.title;
    try {
        const translated = t(key);
        // next-intl returns the raw key if a translation is missing —
        // detect that and fall back to the English literal so the UI
        // never shows a debug-style key like "cpChecklist".
        return translated === key ? workflow.title : translated;
    } catch {
        return workflow.title;
    }
}

/**
 * Same idea for the practice tag. `t` is `useTranslations("builtinPractices")`.
 */
export function getLocalizedPractice(
    practice: string | null | undefined,
    t: (key: string) => string,
): string {
    if (!practice) return "";
    const key = PRACTICE_KEYS[practice];
    if (!key) return practice;
    try {
        const translated = t(key);
        return translated === key ? practice : translated;
    } catch {
        return practice;
    }
}
