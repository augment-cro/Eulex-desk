import React, { useEffect, useState } from "react";
import {
    Check,
    ChevronDown,
    ChevronUp,
    Download,
    FileText,
    X,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Components } from "react-markdown";
import type {
    ChatMessage as ChatMessageData,
    EditProposal,
} from "../hooks/useChat";
import {
    applyEditsAsComments,
    applyTrackedChangeWithComment,
} from "../lib/wordComments";
import {
    acceptAllChanges,
    getRevisionCount,
    rejectAllChanges,
} from "../hooks/useWordDoc";
import { useTranslation } from "../i18n/I18nProvider";
import { normalizeFilenameForDisplay } from "../lib/filenameUtf8";

// Custom renderers for the assistant markdown. The default ReactMarkdown
// elements lean on Tailwind's `prose` plugin, which now handles 90 % of
// the typography (see tailwind.config.js → typography). Tables are the
// big exception — we wrap them in an x-scrollable container because the
// Office task-pane is narrow (~330–360 px in default zoom) and a 4–5
// column EU-law comparison table would otherwise either clip its
// rightmost column or wrap every cell to a single character.
const MARKDOWN_COMPONENTS: Components = {
    table: (props) => (
        <div className="my-2 -mx-1 overflow-x-auto rounded-md border border-gray-200">
            <table className="min-w-full border-collapse text-xs" {...props} />
        </div>
    ),
    thead: (props) => <thead className="bg-gray-50" {...props} />,
    th: (props) => (
        <th
            className="px-2 py-1.5 text-left font-semibold text-gray-900 border-b border-gray-200 align-top"
            {...props}
        />
    ),
    td: (props) => (
        <td
            className="px-2 py-1.5 text-gray-800 border-b border-gray-100 align-top"
            {...props}
        />
    ),
    a: (props) => (
        <a
            target="_blank"
            rel="noreferrer"
            className="text-mike-600 underline underline-offset-2"
            {...props}
        />
    ),
};

// ---------------------------------------------------------------------------
// Tiny helpers
// ---------------------------------------------------------------------------

function Spinner({ className = "" }: { className?: string }) {
    return (
        <span
            className={
                "inline-block h-3 w-3 border-2 border-current border-t-transparent rounded-full animate-spin " +
                className
            }
        />
    );
}

function isWordAvailable(): boolean {
    return (
        typeof window !== "undefined" &&
        typeof (window as unknown as { Office?: unknown }).Office !==
            "undefined"
    );
}

function clip(text: string, max = 80): string {
    return text.length > max ? text.slice(0, max) + "…" : text;
}

// ---------------------------------------------------------------------------
// EditRow — single proposed edit, two Apply buttons + sticky success state
// ---------------------------------------------------------------------------

type AppliedAs = "track" | "comment" | null;

function EditRow({
    proposal,
    preferred,
    appliedAs,
    onApplied,
}: {
    proposal: EditProposal;
    preferred: "track" | "comments";
    appliedAs: AppliedAs;
    onApplied: (mode: "track" | "comment") => void;
}) {
    const t = useTranslation();
    const [busy, setBusy] = useState<"track" | "comment" | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [contextOpen, setContextOpen] = useState(false);

    // Auto-fade transient errors after 3s. The success state ("appliedAs")
    // is sticky on purpose — the user wants the card to stay green so
    // they can see at a glance which suggestions they've already applied.
    useEffect(() => {
        if (!error) return;
        const t = setTimeout(() => setError(null), 3000);
        return () => clearTimeout(t);
    }, [error]);

    const wordOk = isWordAvailable();
    const trackPrimary = preferred !== "comments";

    const onTrack = async () => {
        if (busy || appliedAs) return;
        setBusy("track");
        setError(null);
        try {
            const { applied, notFound } = await applyTrackedChangeWithComment(
                proposal,
            );
            if (applied > 0) onApplied("track");
            else if (notFound > 0) setError(t("edits.couldNotFind"));
        } catch (e) {
            setError((e as Error).message || t("common.error"));
        } finally {
            setBusy(null);
        }
    };

    const onComment = async () => {
        if (busy || appliedAs) return;
        setBusy("comment");
        setError(null);
        try {
            const { applied, notFound } = await applyEditsAsComments([
                proposal,
            ]);
            if (applied > 0) onApplied("comment");
            else if (notFound.length > 0) setError(t("edits.couldNotFind"));
        } catch (e) {
            setError((e as Error).message || t("common.error"));
        } finally {
            setBusy(null);
        }
    };

    const trackBtnClass = trackPrimary
        ? "bg-gray-900 text-white border border-gray-900 hover:bg-gray-800"
        : "bg-white border border-gray-300 text-gray-800 hover:bg-gray-50";
    const commentBtnClass = !trackPrimary
        ? "bg-gray-900 text-white border border-gray-900 hover:bg-gray-800"
        : "bg-white border border-gray-300 text-gray-800 hover:bg-gray-50";

    const disabled = busy !== null || !wordOk || appliedAs !== null;
    const cardClass = appliedAs
        ? "rounded-xl border border-green-300 bg-green-50 p-2.5"
        : "rounded-xl border border-gray-200 bg-white p-2.5";

    const hasContext =
        (proposal.context_before && proposal.context_before.trim().length) ||
        (proposal.context_after && proposal.context_after.trim().length);

    return (
        <li className={cardClass}>
            <div className="text-xs text-gray-700 leading-relaxed">
                <span className="line-through text-red-600">
                    {clip(proposal.find)}
                </span>
                <span className="text-gray-400"> → </span>
                <span className="text-green-700">{clip(proposal.replace)}</span>
            </div>

            {proposal.reason ? (
                <p className="mt-1 text-[11px] italic text-gray-500">
                    {proposal.reason}
                </p>
            ) : null}

            {hasContext ? (
                <div className="mt-1.5">
                    <button
                        type="button"
                        onClick={() => setContextOpen((v) => !v)}
                        className="inline-flex items-center gap-1 text-[10px] text-gray-500 hover:text-gray-700"
                    >
                        {contextOpen ? (
                            <ChevronUp className="h-3 w-3" />
                        ) : (
                            <ChevronDown className="h-3 w-3" />
                        )}
                        {t("edits.context")}
                    </button>
                    {contextOpen ? (
                        <div className="mt-1 rounded-md border border-gray-100 bg-gray-50 px-2 py-1 text-[11px] text-gray-600 leading-snug">
                            <span className="text-gray-400">…</span>
                            <span>{proposal.context_before ?? ""}</span>
                            <span className="font-semibold text-gray-900">
                                {clip(proposal.find, 60)}
                            </span>
                            <span>{proposal.context_after ?? ""}</span>
                            <span className="text-gray-400">…</span>
                        </div>
                    ) : null}
                </div>
            ) : null}

            <div className="mt-2 flex flex-wrap items-center gap-1.5">
                {appliedAs ? (
                    <span className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-lg bg-green-600 text-white">
                        <Check className="h-3 w-3" />
                        {appliedAs === "track"
                            ? t("edits.appliedTrack")
                            : t("edits.appliedComment")}
                    </span>
                ) : (
                    <>
                        <button
                            type="button"
                            onClick={onTrack}
                            disabled={disabled}
                            className={
                                "inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-lg transition-colors disabled:opacity-50 " +
                                trackBtnClass
                            }
                        >
                            {busy === "track" && <Spinner />}
                            {t("edits.applyTrack")}
                        </button>
                        <button
                            type="button"
                            onClick={onComment}
                            disabled={disabled}
                            className={
                                "inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-lg transition-colors disabled:opacity-50 " +
                                commentBtnClass
                            }
                        >
                            {busy === "comment" && <Spinner />}
                            {t("edits.addComment")}
                        </button>
                    </>
                )}
            </div>

            {!wordOk ? (
                <p className="mt-1.5 text-[11px] text-gray-500">
                    {t("edits.wordRequired")}
                </p>
            ) : null}
            {error ? (
                <p className="mt-1.5 text-[11px] text-red-600">{error}</p>
            ) : null}
        </li>
    );
}

// ---------------------------------------------------------------------------
// EditProposalCard — groups N proposals with bulk-apply + finalize buttons
// ---------------------------------------------------------------------------

function EditProposalCard({
    proposals,
    preferred,
}: {
    proposals: EditProposal[];
    preferred: "track" | "comments";
}) {
    const t = useTranslation();
    const [appliedStates, setAppliedStates] = useState<AppliedAs[]>(() =>
        proposals.map(() => null),
    );
    const [bulkBusy, setBulkBusy] = useState<"track" | "comment" | null>(null);
    const [bulkProgress, setBulkProgress] = useState<{
        done: number;
        total: number;
        failed: number;
    } | null>(null);
    const [revCount, setRevCount] = useState<number | null>(null);
    const [finalizeBusy, setFinalizeBusy] = useState<
        "accept" | "reject" | null
    >(null);
    const [finalizeStatus, setFinalizeStatus] = useState<string | null>(null);

    // If the proposals array changes (new SSE annotations arrive on a
    // streaming message), grow `appliedStates` to match — preserving any
    // per-row state we already have so previously-applied cards keep
    // their green badge.
    useEffect(() => {
        setAppliedStates((prev) => {
            if (prev.length === proposals.length) return prev;
            const next = [...prev];
            while (next.length < proposals.length) next.push(null);
            return next.slice(0, proposals.length);
        });
    }, [proposals.length]);

    // Refresh revision count whenever a Apply / Apply-all completes so the
    // "Pending revisions" chip stays in sync without a tight setInterval.
    const refreshRevCount = () => {
        getRevisionCount()
            .then((n) => setRevCount(n))
            .catch(() => setRevCount(null));
    };
    useEffect(() => {
        refreshRevCount();
    }, []);

    const wordOk = isWordAvailable();
    const remaining = appliedStates.filter((s) => s === null).length;
    const trackPrimary = preferred !== "comments";

    const setApplied = (i: number, mode: "track" | "comment") => {
        setAppliedStates((prev) => {
            const next = [...prev];
            next[i] = mode;
            return next;
        });
        refreshRevCount();
    };

    const runBulk = async (mode: "track" | "comment") => {
        if (bulkBusy || remaining === 0) return;
        setBulkBusy(mode);
        let done = 0;
        let failed = 0;
        const total = remaining;
        setBulkProgress({ done, total, failed });

        // We deliberately run sequentially rather than in a single
        // Word.run() because the per-row `applyTrackedChangeWithComment`
        // already opens its own Word.run with one context.sync(). For a
        // typical 5–15 edit batch the layout-recalc cost is dominated
        // by Word's redraw of each insertion anyway, and serial
        // iteration lets us update progress + per-row green badges
        // incrementally — much better UX than a single 4-second hang
        // while a batched run executes silently.
        for (let i = 0; i < proposals.length; i++) {
            if (appliedStates[i]) continue;
            const proposal = proposals[i];
            try {
                if (mode === "track") {
                    const { applied, notFound } =
                        await applyTrackedChangeWithComment(proposal);
                    if (applied > 0) setApplied(i, "track");
                    else if (notFound > 0) failed += 1;
                } else {
                    const { applied, notFound } = await applyEditsAsComments([
                        proposal,
                    ]);
                    if (applied > 0) setApplied(i, "comment");
                    else if (notFound.length > 0) failed += 1;
                }
            } catch {
                failed += 1;
            }
            done += 1;
            setBulkProgress({ done, total, failed });
        }

        setBulkBusy(null);
        // Hide the progress chip after a beat so the green per-row
        // badges remain as the at-a-glance record.
        setTimeout(() => setBulkProgress(null), 2500);
    };

    const onAcceptAll = async () => {
        if (finalizeBusy) return;
        setFinalizeBusy("accept");
        setFinalizeStatus(null);
        try {
            const r = await acceptAllChanges();
            if (r.fallback) {
                setFinalizeStatus(t("edits.fallbackAccept"));
            } else {
                setFinalizeStatus(
                    r.count > 0
                        ? t("edits.acceptedCount", { count: r.count })
                        : t("edits.noPending"),
                );
            }
        } finally {
            setFinalizeBusy(null);
            refreshRevCount();
        }
    };

    const onRejectAll = async () => {
        if (finalizeBusy) return;
        setFinalizeBusy("reject");
        setFinalizeStatus(null);
        try {
            const r = await rejectAllChanges();
            if (r.fallback) {
                setFinalizeStatus(t("edits.fallbackReject"));
            } else {
                setFinalizeStatus(
                    r.count > 0
                        ? t("edits.rejectedCount", { count: r.count })
                        : t("edits.noPending"),
                );
            }
        } finally {
            setFinalizeBusy(null);
            refreshRevCount();
        }
    };

    const allDisabled = bulkBusy !== null || !wordOk;

    return (
        <div className="mt-2 rounded-2xl border border-gray-200 bg-white p-2.5">
            <div className="flex items-center justify-between mb-2 gap-2">
                <p className="text-xs font-semibold text-gray-800 truncate">
                    {proposals.length === 1
                        ? t("edits.suggestionsOne", { count: proposals.length })
                        : t("edits.suggestionsOther", {
                              count: proposals.length,
                          })}
                    {remaining > 0 && remaining !== proposals.length ? (
                        <span className="ml-1.5 text-[10px] font-normal text-gray-500">
                            · {t("edits.pending", { count: remaining })}
                        </span>
                    ) : null}
                </p>
                {remaining === 0 ? (
                    <span className="text-[10px] text-green-700 font-medium">
                        {t("edits.allApplied")}
                    </span>
                ) : null}
            </div>

            {remaining > 0 ? (
                <div className="mb-2 flex flex-wrap items-center gap-1.5">
                    <button
                        type="button"
                        onClick={() => runBulk("track")}
                        disabled={allDisabled}
                        className={
                            "inline-flex items-center gap-1.5 text-[11px] px-2.5 py-1 rounded-lg transition-colors disabled:opacity-50 " +
                            (trackPrimary
                                ? "bg-gray-900 text-white hover:bg-gray-800"
                                : "bg-white border border-gray-300 text-gray-800 hover:bg-gray-50")
                        }
                    >
                        {bulkBusy === "track" && <Spinner />}
                        {t("edits.applyAllTrack")}
                    </button>
                    <button
                        type="button"
                        onClick={() => runBulk("comment")}
                        disabled={allDisabled}
                        className={
                            "inline-flex items-center gap-1.5 text-[11px] px-2.5 py-1 rounded-lg transition-colors disabled:opacity-50 " +
                            (!trackPrimary
                                ? "bg-gray-900 text-white hover:bg-gray-800"
                                : "bg-white border border-gray-300 text-gray-800 hover:bg-gray-50")
                        }
                    >
                        {bulkBusy === "comment" && <Spinner />}
                        {t("edits.applyAllComments")}
                    </button>
                    {bulkProgress ? (
                        <span className="text-[10px] text-gray-500">
                            {bulkProgress.failed > 0
                                ? t("edits.progressFailed", {
                                      done: bulkProgress.done,
                                      total: bulkProgress.total,
                                      failed: bulkProgress.failed,
                                  })
                                : t("edits.progress", {
                                      done: bulkProgress.done,
                                      total: bulkProgress.total,
                                  })}
                        </span>
                    ) : null}
                </div>
            ) : null}

            <ul className="space-y-1.5">
                {proposals.map((p, i) => (
                    <EditRow
                        key={p.id ?? i}
                        proposal={p}
                        preferred={preferred}
                        appliedAs={appliedStates[i] ?? null}
                        onApplied={(mode) => setApplied(i, mode)}
                    />
                ))}
            </ul>

            {/* Finalize bar — Accept / Reject all pending revisions in
                the open document. We show this whenever the doc has
                pending revisions OR the user has applied at least one
                of the suggestions on this card. The count comes from
                body.getTrackedChanges() and refreshes after each Apply,
                so it reflects the user's manual edits too. */}
            {wordOk &&
            (revCount === null
                ? appliedStates.some((s) => s === "track")
                : revCount > 0) ? (
                <div className="mt-3 pt-2.5 border-t border-gray-100 space-y-1.5">
                    <div className="flex items-center justify-between gap-2">
                        <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide">
                            {t("edits.finalize")}
                        </p>
                        {revCount !== null ? (
                            <span
                                className={
                                    "text-[10px] font-semibold px-1.5 py-0.5 rounded-full " +
                                    (revCount > 0
                                        ? "bg-orange-100 text-orange-700"
                                        : "bg-gray-100 text-gray-500")
                                }
                            >
                                {t("edits.pendingRevisions", {
                                    count: revCount,
                                })}
                            </span>
                        ) : null}
                    </div>
                    <div className="flex gap-1.5">
                        <button
                            type="button"
                            onClick={onAcceptAll}
                            disabled={finalizeBusy !== null}
                            className="flex-1 inline-flex items-center justify-center gap-1 py-1 text-[11px] bg-green-100 text-green-700 hover:bg-green-200 rounded-lg font-medium transition-colors disabled:opacity-50"
                        >
                            {finalizeBusy === "accept" ? (
                                <Spinner />
                            ) : (
                                <Check className="h-3 w-3" />
                            )}
                            {t("edits.acceptAll")}
                        </button>
                        <button
                            type="button"
                            onClick={onRejectAll}
                            disabled={finalizeBusy !== null}
                            className="flex-1 inline-flex items-center justify-center gap-1 py-1 text-[11px] bg-red-100 text-red-700 hover:bg-red-200 rounded-lg font-medium transition-colors disabled:opacity-50"
                        >
                            {finalizeBusy === "reject" ? (
                                <Spinner />
                            ) : (
                                <X className="h-3 w-3" />
                            )}
                            {t("edits.rejectAll")}
                        </button>
                    </div>
                    {finalizeStatus ? (
                        <p className="text-[10px] text-center text-gray-500 bg-gray-50 rounded py-1 border border-gray-100">
                            {finalizeStatus}
                        </p>
                    ) : null}
                </div>
            ) : null}
        </div>
    );
}

// ---------------------------------------------------------------------------
// CreatedDocCard — "Open in Word" affordance for assistant-generated docs.
// Uses the `ms-word:` URI scheme so macOS/Windows route directly to Word
// (no browser tab, no download flow).
// ---------------------------------------------------------------------------

function CreatedDocCard({
    doc,
}: {
    doc: { filename: string; download_url?: string };
}) {
    const t = useTranslation();
    const [status, setStatus] = useState<"idle" | "opening">("idle");

    const onOpen = () => {
        if (!doc.download_url) return;
        setStatus("opening");
        // ms-word:ofe|u|<url>  →  Open For Editing in Word.
        // Word for Mac and Windows both honor this scheme.
        const wordUri = `ms-word:ofe|u|${doc.download_url}`;
        window.open(wordUri, "_self");
        setTimeout(() => setStatus("idle"), 2500);
    };

    return (
        <div className="mt-2 flex items-center gap-2 rounded-xl border border-gray-200 bg-white p-2">
            <FileText className="h-4 w-4 text-gray-500 shrink-0" />
            <div className="flex-1 min-w-0">
                <div className="text-xs font-medium text-gray-900 truncate">
                    {normalizeFilenameForDisplay(doc.filename)}
                </div>
                <div className="text-[10px] text-gray-500">
                    {t("createdDoc.savedBackup")}
                </div>
            </div>
            {doc.download_url ? (
                <>
                    <button
                        type="button"
                        onClick={onOpen}
                        className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] bg-gray-900 text-white hover:bg-gray-800"
                        title={t("createdDoc.openInWord")}
                    >
                        {status === "opening"
                            ? t("createdDoc.opening")
                            : t("createdDoc.openInWord")}
                    </button>
                    <a
                        href={doc.download_url}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-0.5 text-[11px] text-mike-600 hover:underline"
                        title={t("createdDoc.downloadTooltip")}
                    >
                        <Download className="h-3 w-3" />
                    </a>
                </>
            ) : null}
        </div>
    );
}

// ---------------------------------------------------------------------------
// Message bubble
// ---------------------------------------------------------------------------

export default function ChatMessage({ msg }: { msg: ChatMessageData }) {
    const t = useTranslation();
    const isUser = msg.role === "user";
    const [reasoningOpen, setReasoningOpen] = useState(false);

    if (isUser) {
        return (
            <div className="flex justify-end">
                <div className="max-w-[85%] bg-mike-50 text-gray-900 px-3 py-2 rounded-lg text-sm whitespace-pre-wrap">
                    {msg.content}
                    {msg.files && msg.files.length > 0 ? (
                        <ul className="mt-1 text-xs text-gray-600 space-y-0.5">
                            {msg.files.map((f) => (
                                <li
                                    key={f.document_id ?? f.filename}
                                    className="flex items-center gap-1"
                                >
                                    <FileText className="h-3 w-3" />
                                    {normalizeFilenameForDisplay(f.filename)}
                                </li>
                            ))}
                        </ul>
                    ) : null}
                </div>
            </div>
        );
    }

    const edits = msg.edits ?? [];
    const preferred: "track" | "comments" = msg.editMode ?? "track";

    return (
        <div className="flex flex-col items-start gap-1.5">
            {msg.reasoning && msg.reasoning.length > 0 ? (
                <button
                    type="button"
                    onClick={() => setReasoningOpen((v) => !v)}
                    className="inline-flex items-center gap-1 text-xs text-gray-500 hover:text-gray-700"
                >
                    {reasoningOpen ? (
                        <ChevronUp className="h-3 w-3" />
                    ) : (
                        <ChevronDown className="h-3 w-3" />
                    )}
                    {msg.streaming
                        ? t("message.thinking")
                        : t("message.reasoning")}
                </button>
            ) : null}

            {reasoningOpen && msg.reasoning ? (
                <pre className="text-xs text-gray-500 bg-gray-50 border border-gray-200 rounded p-2 whitespace-pre-wrap w-full">
                    {msg.reasoning}
                </pre>
            ) : null}

            <div className="text-sm text-gray-900 prose prose-sm max-w-none break-words w-full">
                <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    components={MARKDOWN_COMPONENTS}
                >
                    {msg.content || (msg.streaming ? "…" : "")}
                </ReactMarkdown>
            </div>

            {edits.length > 0 ? (
                <div className="w-full">
                    <EditProposalCard
                        proposals={edits}
                        preferred={preferred}
                    />
                </div>
            ) : null}

            {msg.docs && msg.docs.length > 0 ? (
                <div className="w-full flex flex-col gap-1.5">
                    {msg.docs.map((d, i) => (
                        <CreatedDocCard key={d.filename + i} doc={d} />
                    ))}
                </div>
            ) : null}
        </div>
    );
}
