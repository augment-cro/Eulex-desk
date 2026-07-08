"use client";

/**
 * Document anonymization review modal.
 *
 * Shown after upload in `strict_legal` / `strict` mode, or whenever
 * `pii_review_required` is true on the user's profile. Lets the user:
 *   - Browse the entities Presidio detected, grouped by type.
 *   - Toggle "keep masked" (default) or "approve for disclosure" per
 *     entity. Approved entities will be sent to the LLM in plaintext.
 *   - Add a free-text reason (audited) when approving disclosure.
 *
 * The modal does NOT call /anonymize itself — that already ran when
 * the document hit the upload endpoint. The modal posts the choices to
 * /pii/sessions/:id/apply-overrides so the audit log records who
 * approved which placeholder and why.
 */

import { useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { piiApplyOverrides, type PiiEntity, type PiiPreviewResult } from "@/app/lib/mikeApi";

interface Props {
    open: boolean;
    onClose: () => void;
    preview: PiiPreviewResult | null;
    /** Called after the user confirms; receives the response so the
     * caller can update its local cache (entity_summary etc.). */
    onConfirm?: (sessionId: string, summary: Record<string, number>) => void;
    /** When provided, the modal shows the filename in the header to
     * disambiguate which document is being reviewed. */
    filename?: string;
    /** When true, the modal short-circuits the /apply-overrides API
     *  call and just fires `onConfirm` directly. Used on the privacy
     *  settings page so users can preview the modal without uploading
     *  a real strict-legal document. The toggle buttons stay functional
     *  so the UX itself is identical. */
    demo?: boolean;
}

interface EntityRow {
    placeholder: string;
    entity_type: string;
    original: string;
    score: number;
    keepMasked: boolean;
    disclosureReason: string;
}

function groupByType(entities: PiiEntity[]): Record<string, PiiEntity[]> {
    const out: Record<string, PiiEntity[]> = {};
    // Deduplicate placeholders so coreferent occurrences appear once.
    const seen = new Set<string>();
    for (const e of entities) {
        if (seen.has(e.placeholder)) continue;
        seen.add(e.placeholder);
        (out[e.entity_type] ??= []).push(e);
    }
    return out;
}

export default function DocumentAnonymizationPreviewModal(props: Props) {
    const t = useTranslations("pii.previewModal");
    const [rows, setRows] = useState<EntityRow[]>(() =>
        (props.preview?.entities ?? []).map((e) => ({
            placeholder: e.placeholder,
            entity_type: e.entity_type,
            original: e.original_text,
            score: e.score,
            keepMasked: true,
            disclosureReason: "",
        })),
    );
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // The lazy useState initializer above runs only on first mount, when
    // `preview` is still null (the modal is always mounted, gated by `open`).
    // Re-derive the rows whenever a new preview arrives (keyed on session_id)
    // so the detected entities actually render instead of an empty list.
    useEffect(() => {
        setRows(
            (props.preview?.entities ?? []).map((e) => ({
                placeholder: e.placeholder,
                entity_type: e.entity_type,
                original: e.original_text,
                score: e.score,
                keepMasked: true,
                disclosureReason: "",
            })),
        );
        // Keyed on session_id only (not the entities array): one reset per new
        // preview, so the user's keep-masked toggles survive parent re-renders.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [props.preview?.session_id]);

    const groups = useMemo(() => {
        const map: Record<string, EntityRow[]> = {};
        const seen = new Set<string>();
        for (const r of rows) {
            if (seen.has(r.placeholder)) continue;
            seen.add(r.placeholder);
            (map[r.entity_type] ??= []).push(r);
        }
        return map;
    }, [rows]);

    if (!props.open || !props.preview) return null;

    const toggleRow = (placeholder: string) => {
        setRows((prev) =>
            prev.map((r) =>
                r.placeholder === placeholder
                    ? { ...r, keepMasked: !r.keepMasked }
                    : r,
            ),
        );
    };
    const setReason = (placeholder: string, reason: string) => {
        setRows((prev) =>
            prev.map((r) =>
                r.placeholder === placeholder
                    ? { ...r, disclosureReason: reason }
                    : r,
            ),
        );
    };

    const onConfirm = async () => {
        if (!props.preview) return;
        setSubmitting(true);
        setError(null);
        try {
            if (props.demo) {
                // No live session — short-circuit and just close. The
                // parent passes a fake `session_id`; running through the
                // real API would 404. Surface the local "summary" we
                // have so the parent's onConfirm signature stays the
                // same as production.
                props.onConfirm?.(props.preview.session_id, props.preview.entity_summary ?? {});
                props.onClose();
                return;
            }
            const masked = rows.filter((r) => r.keepMasked).map((r) => r.placeholder);
            const approved = rows.filter((r) => !r.keepMasked).map((r) => r.placeholder);
            const res = await piiApplyOverrides({
                session_id: props.preview.session_id,
                masked_placeholders: masked,
                approved_for_disclosure: approved,
                text: props.preview.preview_text,
            });
            props.onConfirm?.(props.preview.session_id, res.entity_summary ?? {});
            props.onClose();
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/40">
            <div className="w-full max-w-3xl rounded-lg bg-background border border-border">
                <div className="border-b px-6 py-4">
                    <h2 className="text-lg font-semibold">
                        {t("title", { default: "Pregled anonimizacije" })}
                    </h2>
                    {props.filename && (
                        <p className="mt-1 text-sm text-muted-foreground">{props.filename}</p>
                    )}
                    <p className="mt-2 text-sm text-foreground">
                        {t("subtitle", {
                            default:
                                "Pregledajte koje podatke smo prepoznali. Neoznačeni će ostati skriveni od AI-a; one koje označite za otkrivanje će biti vidljivi u prompt-u.",
                        })}
                    </p>
                </div>
                <div className="max-h-[55vh] overflow-y-auto px-6 py-4">
                    {Object.keys(groups).length === 0 ? (
                        <p className="text-sm text-muted-foreground">
                            {t("noEntities", {
                                default: "Nismo prepoznali nijedan osjetljivi podatak.",
                            })}
                        </p>
                    ) : (
                        Object.entries(groups).map(([type, items]) => (
                            <section key={type} className="mb-4">
                                <h3 className="mb-2 text-sm font-semibold text-foreground">
                                    {t.has(`entityType.${type}`) ? t(`entityType.${type}`) : type} ({items.length})
                                </h3>
                                <ul className="space-y-2">
                                    {items.map((row) => (
                                        <li
                                            key={row.placeholder}
                                            className="rounded border bg-muted px-3 py-2 text-sm"
                                        >
                                            <div className="flex items-center justify-between gap-3">
                                                <div className="min-w-0 flex-1">
                                                    <code className="break-all font-mono text-xs text-foreground">
                                                        {row.placeholder}
                                                    </code>
                                                    <div className="mt-0.5 truncate text-foreground">
                                                        {row.original}
                                                    </div>
                                                </div>
                                                <label className="flex shrink-0 items-center gap-2 text-xs">
                                                    <input
                                                        type="checkbox"
                                                        checked={!row.keepMasked}
                                                        onChange={() => toggleRow(row.placeholder)}
                                                    />
                                                    {t("approveDisclosure", {
                                                        default: "Otkrij AI-u",
                                                    })}
                                                </label>
                                            </div>
                                            {!row.keepMasked && (
                                                <input
                                                    type="text"
                                                    placeholder={t("reasonPlaceholder", {
                                                        default: "Razlog otkrivanja (audit)…",
                                                    })}
                                                    value={row.disclosureReason}
                                                    onChange={(e) =>
                                                        setReason(row.placeholder, e.target.value)
                                                    }
                                                    className="mt-2 w-full rounded border px-2 py-1 text-xs"
                                                />
                                            )}
                                        </li>
                                    ))}
                                </ul>
                            </section>
                        ))
                    )}
                </div>
                {error && (
                    <p className="border-t bg-destructive/10 px-6 py-2 text-sm text-destructive">
                        {error}
                    </p>
                )}
                <div className="flex justify-end gap-2 border-t px-6 py-4">
                    <button
                        type="button"
                        onClick={props.onClose}
                        disabled={submitting}
                        className="rounded border px-4 py-2 text-sm hover:bg-accent disabled:opacity-50"
                    >
                        {t("cancel", { default: "Odustani" })}
                    </button>
                    <button
                        type="button"
                        onClick={onConfirm}
                        disabled={submitting}
                        className="rounded bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                    >
                        {submitting
                            ? t("submitting", { default: "Spremam…" })
                            : t("confirm", { default: "Potvrdi i nastavi" })}
                    </button>
                </div>
            </div>
        </div>
    );
}
