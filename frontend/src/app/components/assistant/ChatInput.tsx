"use client";

import {
    useState,
    useCallback,
    useRef,
    forwardRef,
    useImperativeHandle,
} from "react";
import {
    ArrowRight,
    Check,
    // Alias — a bare `File` import would shadow the global File
    // constructor used by the long-paste upload flow.
    File as FileIcon,
    FileText,
    FolderOpen,
    Globe,
    Library,
    Loader2,
    ShieldAlert,
    Sparkles,
    Square,
    X,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { AddDocButton } from "./AddDocButton";
import { AddDocumentsModal } from "../shared/AddDocumentsModal";
import { IntegrationFilePicker } from "../shared/IntegrationFilePicker";
import { GoogleDrivePickerLauncher } from "../shared/GoogleDrivePickerLauncher";
import {
    piiPreviewDocumentById,
    piiPreviewText,
    uploadStandaloneDocument,
    type IntegrationProviderId,
    type PiiPreviewResult,
} from "@/app/lib/mikeApi";
import { shouldReviewPii, toSidecarMode } from "@/app/lib/piiReview";
import DocumentAnonymizationPreviewModal from "./DocumentAnonymizationPreviewModal";
import { AssistantWorkflowModal } from "./AssistantWorkflowModal";
import { EnrichmentPanel, EnrichmentLoading } from "./EnrichmentPanel";
import { ApiKeyMissingModal } from "../shared/ApiKeyMissingModal";
import { RateLimitBanner } from "../shared/RateLimitBanner";
import { DailyUsageRing } from "../shared/DailyUsageRing";
import { McpToggleButton } from "./McpToggleButton";
import { ContextsToggleButton } from "./ContextsToggleButton";
import { ShieldBadge } from "./ShieldBadge";
import {
    Tooltip,
    TooltipContent,
    TooltipTrigger,
} from "@/components/ui/tooltip";
import { useQueryEnrichment } from "@/app/hooks/useQueryEnrichment";
import { useSelectedModel } from "@/app/hooks/useSelectedModel";
import { useUserProfile } from "@/contexts/UserProfileContext";
import {
    getModelProvider,
    isModelAvailable,
    type ModelProvider,
} from "@/app/lib/modelAvailability";
import type { MikeDocument, MikeMessage, MikeWorkflow } from "../shared/types";
import { track } from "@/app/lib/analytics";
import { cn } from "@/lib/utils";

export interface ChatInputHandle {
    addDoc: (doc: MikeDocument) => void;
}

// A paste at or past either threshold becomes an attached .txt document
// instead of landing in the textarea (claude.ai converts at ~4k chars,
// ChatGPT at 5k). Below both, the paste behaves like normal typing.
const PASTE_TO_DOC_CHAR_THRESHOLD = 4000;
const PASTE_TO_DOC_LINE_THRESHOLD = 80;

interface Props {
    onSubmit: (message: MikeMessage) => void;
    onCancel: () => void;
    isLoading: boolean;
    hideAddDocButton?: boolean;
    hideWorkflowButton?: boolean;
    onProjectsClick?: () => void;
    projectName?: string;
    projectCmNumber?: string | null;
    /**
     * Forces the composer into a non-interactive state with a "Loading…"
     * placeholder. Set this while the app is still hydrating dependent
     * data (chat history, MCP connectors, profile) so the user can't
     * fire a request before those are in memory — submit-button and
     * textarea both go disabled and Enter/click both become no-ops.
     * Independent of `isLoading`, which represents a request in flight.
     */
    disabled?: boolean;
    /**
     * Height preset. "hero" is the tall composer on the centered
     * assistant landing view; "compact" (default) is the low chat-bottom
     * composer. Both auto-grow with the draft up to the same cap.
     */
    variant?: "hero" | "compact";
    /**
     * Active chat id, when one exists (existing chat page; null on a
     * fresh assistant page where the first turn hasn't been sent yet).
     * Used so the PII review modal can pin its session to this chat.
     * When null, the sidecar still creates a session — backend just
     * doesn't tie it to a chat row until the first user turn lands.
     */
    chatId?: string | null;
}

export const ChatInput = forwardRef<ChatInputHandle, Props>(function ChatInput(
    {
        onSubmit,
        onCancel,
        isLoading,
        hideAddDocButton,
        hideWorkflowButton,
        onProjectsClick,
        projectName,
        projectCmNumber,
        disabled = false,
        variant = "compact",
        chatId = null,
    }: Props,
    ref,
) {
    const t = useTranslations("assistant");
    const [value, setValue] = useState("");
    const [attachedDocs, setAttachedDocs] = useState<MikeDocument[]>([]);
    const [selectedWorkflow, setSelectedWorkflow] = useState<{
        id: string;
        title: string;
        type: MikeWorkflow["type"];
    } | null>(null);
    // Model + reasoning-effort still flow to the backend (default/persisted
    // values from the profile); the inline Brain picker UI was removed.
    const [model, , effort] = useSelectedModel();
    // Web-search toggle (globe icon). Persisted in localStorage so the
    // user's choice sticks across reloads. Default on. Sent per-turn as
    // `web_search`; backend drops the search tools when false.
    const [webSearchEnabled, setWebSearchEnabled] = useState<boolean>(() => {
        if (typeof window === "undefined") return true;
        return window.localStorage.getItem("max:webSearchEnabled") !== "0";
    });
    const toggleWebSearch = useCallback(() => {
        setWebSearchEnabled((prev) => {
            const next = !prev;
            try {
                window.localStorage.setItem(
                    "max:webSearchEnabled",
                    next ? "1" : "0",
                );
            } catch {
                /* private mode / storage disabled — keep in-memory state */
            }
            return next;
        });
    }, []);
    const { profile } = useUserProfile();
    const {
        result: enrichResult,
        variants: enrichVariants,
        streamingTexts: enrichStreamingTexts,
        isEnriching,
        error: enrichError,
        enrich,
        reset: resetEnrich,
    } = useQueryEnrichment();

    const apiKeys = {
        claudeApiKey: profile?.claudeApiKey ?? null,
        geminiApiKey: profile?.geminiApiKey ?? null,
        openaiApiKey: profile?.openaiApiKey ?? null,
        mistralApiKey: profile?.mistralApiKey ?? null,
        serverKeys: profile?.serverKeys,
    };
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    // Long pastes being uploaded as .txt documents — rendered as spinner
    // chips until the upload (+ optional PII review) finishes and the doc
    // moves into `attachedDocs`. Send is blocked while any are in flight
    // so a message can't dispatch without its pasted context.
    const [pendingPastes, setPendingPastes] = useState<
        { key: number; label: string }[]
    >([]);
    const pasteCounterRef = useRef(0);
    const [docSelectorOpen, setDocSelectorOpen] = useState(false);
    const [workflowModalOpen, setWorkflowModalOpen] = useState(false);
    const [apiKeyModalProvider, setApiKeyModalProvider] =
        useState<ModelProvider | null>(null);
    const [integrationPicker, setIntegrationPicker] = useState<{
        provider: IntegrationProviderId;
        displayName: string;
    } | null>(null);
    const [googleDrivePickerOpen, setGoogleDrivePickerOpen] = useState(false);

    // ─────────────────────────────────────────────────────────────────
    // PII review modal state.
    //
    // When the user uploads a document in strict mode, we intercept the
    // post-upload step, run the doc through the sidecar, and present
    // the entity list before the chip lands in `attachedDocs`. The
    // Promise resolver is stashed so `handlePiiReview` can return a
    // boolean (approved / cancelled) that AddDocButton awaits.
    //
    // - `previewLoading` covers the round-trip to /pii/documents/:id/preview
    //   (slow for PDFs because of Gemini OCR). Surfaced as an inline
    //   overlay so the user knows a click was registered and a doc
    //   is being processed; without it the upload spinner closes
    //   instantly and there's a confusing 10-20 s blank window.
    //
    // - `previewError` flips on when the sidecar call itself fails
    //   (network, 503, extraction returned empty). We fail-OPEN in
    //   `standard` mode (attach the doc anyway, surface the error)
    //   and fail-CLOSED in strict modes (drop the doc, force re-upload).
    //   That trade-off matches the security posture each mode signals.
    // ─────────────────────────────────────────────────────────────────
    const [pendingPreview, setPendingPreview] = useState<
        (PiiPreviewResult & { filename?: string }) | null
    >(null);
    const previewResolverRef = useRef<((approved: boolean) => void) | null>(
        null,
    );
    const [previewLoading, setPreviewLoading] = useState<{
        filename: string;
    } | null>(null);
    // Which flow tripped the sidecar error decides the banner copy —
    // "document not attached" vs "message not sent" (#16). The raw
    // error text stays in the console only (issue #90).
    const [previewError, setPreviewError] = useState<{
        source: "document" | "typed";
    } | null>(null);
    // Fresh-page session threading (#16 follow-up): on the fresh
    // assistant page (chatId null) the preview calls run BEFORE the
    // chat exists. Every preview reuses this one standalone session so
    // mappings + disclosure overrides accumulate in a single place;
    // dispatchSubmit then rides the id on the outgoing message and
    // handleNewChat attaches the session to the freshly created chat.
    // Unused (and never set) once a real chatId is present.
    const freshSessionRef = useRef<string | null>(null);

    const piiMode = profile?.piiDefaultMode ?? "off";
    const piiActive = shouldReviewPii({ mode: piiMode });

    const handlePiiReview = useCallback(
        async (doc: MikeDocument): Promise<boolean> => {
            // Mode off/standard → silent pass (review is strict-only, #14).
            if (!piiActive) return true;
            // Already-attached doc was previewed before; skip re-prompt.
            if (attachedDocs.some((d) => d.id === doc.id)) return true;

            setPreviewLoading({ filename: doc.filename });
            setPreviewError(null);
            try {
                const result = await piiPreviewDocumentById(doc.id, {
                    chat_id: chatId ?? null,
                    session_id: chatId ? null : freshSessionRef.current,
                    mode: toSidecarMode(piiMode),
                    language: "hr",
                });
                setPreviewLoading(null);
                if (!chatId) freshSessionRef.current = result.session_id;

                // No entities → nothing to review, skip the modal but
                // still surface the empty session so coreference works
                // for the eventual LLM turn. Logged-only badge state.
                if (!result.entities || result.entities.length === 0) {
                    return true;
                }

                track("pii_shield_previewed", { entity_count: result.entities.length });
                setPendingPreview(result);
                return new Promise<boolean>((resolve) => {
                    previewResolverRef.current = resolve;
                });
            } catch (err) {
                setPreviewLoading(null);
                console.error("[pii/preview] document preview failed", err);
                setPreviewError({ source: "document" });
                if (piiMode === "strict") return false;
                return true;
            }
        },
        [piiActive, piiMode, attachedDocs, chatId],
    );

    const finishPiiReview = useCallback((approved: boolean) => {
        const resolver = previewResolverRef.current;
        previewResolverRef.current = null;
        setPendingPreview(null);
        if (resolver) resolver(approved);
    }, []);

    useImperativeHandle(ref, () => ({
        addDoc: (doc: MikeDocument) => {
            setAttachedDocs((prev) => {
                if (prev.some((d) => d.id === doc.id)) return prev;
                return [...prev, doc];
            });
        },
    }));

    const handleAddDocFromProject = useCallback((doc: MikeDocument) => {
        setAttachedDocs((prev) => {
            if (prev.some((d) => d.id === doc.id)) return prev;
            return [...prev, doc];
        });
    }, []);

    const handleAddDocsFromSelector = useCallback(
        (selectedDocs: MikeDocument[]) => {
            setAttachedDocs((prev) => {
                const existing = new Set(prev.map((d) => d.id));
                return [
                    ...prev,
                    ...selectedDocs.filter((d) => !existing.has(d.id)),
                ];
            });
        },
        [],
    );

    const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
        setValue(e.target.value);
        const el = e.target;
        el.style.height = "auto";
        el.style.height = `${el.scrollHeight}px`;
    };

    // ─────────────────────────────────────────────────────────────────
    // Long-paste → attachment (claude.ai style). The pasted text is
    // uploaded as a standalone .txt document so it rides the exact same
    // pipeline as an attached file: PII review gate, `files` on the
    // outgoing message, backend read_document context. On upload failure
    // the text is put back into the composer so nothing is lost.
    // ─────────────────────────────────────────────────────────────────
    const attachPastedText = useCallback(
        async (text: string) => {
            pasteCounterRef.current += 1;
            const key = pasteCounterRef.current;
            const base = t("pastedText");
            const label = key > 1 ? `${base} ${key}` : base;
            setPendingPastes((prev) => [...prev, { key, label }]);
            try {
                const file = new File([text], `${label}.txt`, {
                    type: "text/plain",
                });
                const doc = await uploadStandaloneDocument(file);
                track("document_uploaded", {
                    surface: "pasted_text",
                    file_type: "txt",
                    result: "success",
                });
                if (piiActive) {
                    const approved = await handlePiiReview(doc);
                    if (!approved) return;
                }
                setAttachedDocs((prev) =>
                    prev.some((d) => d.id === doc.id) ? prev : [...prev, doc],
                );
            } catch (err) {
                console.error("[paste] pasted-text upload failed", err);
                track("document_uploaded", {
                    surface: "pasted_text",
                    file_type: "txt",
                    result: "error",
                });
                setValue((prev) => (prev ? `${prev}\n${text}` : text));
                requestAnimationFrame(() => {
                    const el = textareaRef.current;
                    if (el) {
                        el.style.height = "auto";
                        el.style.height = `${el.scrollHeight}px`;
                    }
                });
            } finally {
                setPendingPastes((prev) => prev.filter((p) => p.key !== key));
            }
        },
        [t, piiActive, handlePiiReview],
    );

    const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
        if (disabled) return;
        const text = e.clipboardData?.getData("text/plain") ?? "";
        if (!text) return;
        const lineCount = text.split("\n").length;
        if (
            text.length < PASTE_TO_DOC_CHAR_THRESHOLD &&
            lineCount < PASTE_TO_DOC_LINE_THRESHOLD
        )
            return;
        e.preventDefault();
        void attachPastedText(text);
    };

    // A turn is sendable with no typed text as long as there's context to act
    // on — an attached document or a selected workflow (Analiza). The backend
    // stores empty content fine and lets the model work from the files/workflow.
    const hasContext = attachedDocs.length > 0 || selectedWorkflow !== null;

    // Actually dispatch the turn. Split out of `handleSubmit` so the
    // strict-mode review gate below can run BEFORE the composer is
    // cleared — a cancelled review must leave the draft intact.
    const dispatchSubmit = (query: string) => {
        setValue("");
        if (textareaRef.current) {
            textareaRef.current.style.height = "auto";
        }

        const files = attachedDocs.map((d) => ({
            filename: d.filename,
            document_id: d.id,
        }));
        setAttachedDocs([]);
        const wf = selectedWorkflow;
        setSelectedWorkflow(null);

        if (wf) {
            track("workflow_applied", { workflow_type: wf.type });
        }

        const piiSessionId =
            !chatId && freshSessionRef.current
                ? freshSessionRef.current
                : undefined;
        freshSessionRef.current = null;

        onSubmit?.({
            role: "user",
            content: query,
            files: files.length > 0 ? files : undefined,
            workflow: wf ?? undefined,
            model,
            effort,
            webSearch: webSearchEnabled,
            piiSessionId,
        });
    };

    // ─────────────────────────────────────────────────────────────────
    // Strict-mode review gate for TYPED input (#16).
    //
    // Documents get their review at attach time (handlePiiReview); the
    // typed message goes through the same modal here, right before the
    // send. The preview call runs the text through the sidecar against
    // the chat's session (HMAC coreference ⇒ the send's own /anonymize
    // reuses the same placeholders), the modal records disclosure
    // overrides via /apply-overrides, and only a confirm dispatches.
    //
    // Failure semantics mirror the document path: review is strict-only,
    // and strict fails CLOSED — a sidecar error keeps the draft in the
    // composer and surfaces the error banner instead of sending raw.
    // ─────────────────────────────────────────────────────────────────
    const reviewTypedThenSubmit = async (query: string) => {
        setPreviewLoading({
            filename: t("piiPreview.messageLabel", { default: "Vaša poruka" }),
        });
        setPreviewError(null);
        try {
            const result = await piiPreviewText({
                chat_id: chatId ?? null,
                session_id: chatId ? null : freshSessionRef.current,
                text: query,
                mode: toSidecarMode(piiMode),
                language: "hr",
            });
            setPreviewLoading(null);
            if (!chatId) freshSessionRef.current = result.session_id;

            if (!result.entities || result.entities.length === 0) {
                dispatchSubmit(query);
                return;
            }

            track("pii_shield_previewed", {
                entity_count: result.entities.length,
                source: "typed_input",
            });
            setPendingPreview({
                ...result,
                filename: t("piiPreview.messageLabel", {
                    default: "Vaša poruka",
                }),
            });
            const approved = await new Promise<boolean>((resolve) => {
                previewResolverRef.current = resolve;
            });
            if (approved) dispatchSubmit(query);
            // Cancelled → composer keeps the draft untouched.
        } catch (err) {
            setPreviewLoading(null);
            console.error("[pii/preview] typed-input preview failed", err);
            setPreviewError({ source: "typed" });
        }
    };

    const handleSubmit = () => {
        if (disabled) return;
        const query = value.trim();
        if ((!query && !hasContext) || isLoading) return;
        // A review round-trip (or open modal) is in flight — the second
        // Enter must not race a duplicate preview/send.
        if (previewLoading || pendingPreview) return;
        // A pasted-text upload hasn't landed in `attachedDocs` yet —
        // sending now would drop that context from the turn.
        if (pendingPastes.length > 0) return;
        if (!isModelAvailable(model, apiKeys)) {
            setApiKeyModalProvider(getModelProvider(model));
            return;
        }
        if (piiActive && query) {
            void reviewTypedThenSubmit(query);
            return;
        }
        dispatchSubmit(query);
    };

    const handleActionClick = () => {
        if (disabled) return;
        if (isLoading) {
            onCancel();
        } else {
            handleSubmit();
        }
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        // Enter that confirms an IME candidate (Japanese/Chinese/Korean,
        // macOS diacritics) must not send the half-composed message (#91).
        if (e.nativeEvent.isComposing) return;
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            handleSubmit();
        }
    };

    return (
        <>
            <div className="w-full">
                <RateLimitBanner />
                <div className="relative border border-border rounded-lg bg-surface-elevated">
                    {/* Attached chips */}
                    {(selectedWorkflow ||
                        attachedDocs.length > 0 ||
                        pendingPastes.length > 0) && (
                        <div className="flex flex-wrap gap-1.5 px-2 pt-2">
                            {selectedWorkflow && (
                                <div className="inline-flex items-center gap-1 pl-2.5 pr-1 py-0.5 rounded-full text-xs bg-primary text-primary-foreground border border-primary-foreground/20 backdrop-blur-sm">
                                    <Library className="h-2.5 w-2.5 shrink-0" />
                                    <span className="max-w-[140px] truncate">
                                        {selectedWorkflow.title}
                                    </span>
                                    <button
                                        type="button"
                                        onClick={() =>
                                            setSelectedWorkflow(null)
                                        }
                                        className="rounded-full p-0.5 ml-0.5 text-primary-foreground/60 hover:text-primary-foreground hover:bg-primary-foreground/20 transition-colors"
                                    >
                                        <X className="h-2.5 w-2.5" />
                                    </button>
                                </div>
                            )}
                            {attachedDocs.map((doc) => {
                                const ft = doc.file_type?.toLowerCase();
                                const isPdf = ft === "pdf";
                                return (
                                    <div
                                        key={doc.id}
                                        className="inline-flex items-center gap-1 pl-2 pr-1 py-0.5 rounded-full text-xs text-primary-foreground border border-primary-foreground/20 bg-primary backdrop-blur-sm"
                                    >
                                        {isPdf ? (
                                            <FileText className="h-2.5 w-2.5 shrink-0 text-primary-foreground/70" />
                                        ) : (
                                            <FileIcon className="h-2.5 w-2.5 shrink-0 text-primary-foreground/70" />
                                        )}
                                        <span className="max-w-[140px] truncate">
                                            {doc.filename}
                                        </span>
                                        <button
                                            type="button"
                                            onClick={() =>
                                                setAttachedDocs((prev) =>
                                                    prev.filter(
                                                        (d) => d.id !== doc.id,
                                                    ),
                                                )
                                            }
                                            className="rounded-full p-0.5 ml-0.5 text-primary-foreground/60 hover:text-primary-foreground hover:bg-primary-foreground/20 transition-colors"
                                        >
                                            <X className="h-2.5 w-2.5" />
                                        </button>
                                    </div>
                                );
                            })}
                            {pendingPastes.map((paste) => (
                                <div
                                    key={paste.key}
                                    className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs text-primary-foreground/80 border border-primary-foreground/20 bg-primary/80 backdrop-blur-sm"
                                >
                                    <Loader2 className="h-2.5 w-2.5 shrink-0 animate-spin" />
                                    <span className="max-w-[140px] truncate">
                                        {paste.label}
                                    </span>
                                </div>
                            ))}
                        </div>
                    )}

                    {/* Input area */}
                    <div className="px-4 pt-4">
                        <textarea
                            ref={textareaRef}
                            data-testid="chat-input"
                            rows={1}
                            placeholder={
                                disabled
                                    ? t("loadingPlaceholder")
                                    : t("placeholder")
                            }
                            value={value}
                            onChange={handleChange}
                            onKeyDown={handleKeyDown}
                            onPaste={handlePaste}
                            disabled={disabled}
                            aria-busy={disabled || undefined}
                            className={cn(
                                "w-full resize-none text-sm overflow-y-auto border-0 text-base p-0 bg-transparent outline-none placeholder:text-muted-foreground/70 leading-6 max-h-64 disabled:cursor-not-allowed disabled:text-muted-foreground/70",
                                variant === "hero" ? "min-h-24" : "min-h-12",
                            )}
                        />
                    </div>

                    {/* Enrichment panel — shows as soon as the first card
                        arrives from the stream; loading skeleton only while
                        no cards have landed yet. */}
                    {isEnriching && enrichVariants.length === 0 && (
                        <div className="px-4 pb-2">
                            <EnrichmentLoading />
                        </div>
                    )}
                    {/* Enrichment failure was previously silent — the
                        skeleton vanished and the button looked dead (#91). */}
                    {enrichError && !isEnriching && !enrichResult && (
                        <div className="px-4 pb-2">
                            <p className="text-xs text-destructive">
                                {enrichError}
                            </p>
                        </div>
                    )}
                    {enrichResult && (
                        <div className="px-4 pb-2">
                            <EnrichmentPanel
                                result={enrichResult}
                                streamingTexts={enrichStreamingTexts}
                                isStreaming={isEnriching}
                                onSelect={(q) => {
                                    track("query_enriched");
                                    setValue(q);
                                    resetEnrich();
                                    // Auto-resize textarea
                                    requestAnimationFrame(() => {
                                        if (textareaRef.current) {
                                            textareaRef.current.style.height = "auto";
                                            textareaRef.current.style.height = `${textareaRef.current.scrollHeight}px`;
                                            textareaRef.current.focus();
                                        }
                                    });
                                }}
                                onClose={resetEnrich}
                            />
                        </div>
                    )}

                    {/* Controls — @container so button labels collapse to
                        icon-only based on the COMPOSER width, not the viewport
                        (a narrow composer inside an open doc panel / split view
                        must not crowd). Below ~46rem labels hide → icons +
                        tooltips; the left cluster is min-w-0 + scrollable so it
                        can never overlap the send button. */}
                    <div className="@container/composer flex items-center justify-between md:p-2.5 p-2">
                        <div className="flex items-center gap-1 min-w-0 overflow-x-auto [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden">
                            {!hideAddDocButton && (
                                <AddDocButton
                                    onSelectDoc={handleAddDocFromProject}
                                    onBrowseAll={() => setDocSelectorOpen(true)}
                                    onOpenIntegrationPicker={(
                                        provider,
                                        displayName,
                                    ) => {
                                        // Google Drive uses the dedicated
                                        // Picker iframe (drive.file scope
                                        // only sees Picker-selected files).
                                        if (provider === "google_drive") {
                                            setGoogleDrivePickerOpen(true);
                                            return;
                                        }
                                        setIntegrationPicker({
                                            provider,
                                            displayName,
                                        });
                                    }}
                                    selectedDocIds={attachedDocs.map(
                                        (d) => d.id,
                                    )}
                                    onPiiReview={
                                        piiActive ? handlePiiReview : undefined
                                    }
                                />
                            )}
                            {onProjectsClick && (
                                <Tooltip>
                                    <TooltipTrigger asChild>
                                        <button
                                            type="button"
                                            onClick={onProjectsClick}
                                            aria-label={t("openProjects")}
                                            className="flex shrink-0 items-center gap-1.5 rounded-lg px-2 h-8 text-sm text-foreground hover:bg-accent transition-colors"
                                        >
                                            <FolderOpen className="h-3.5 w-3.5 shrink-0" />
                                            <span className="hidden @[46rem]/composer:inline">
                                                {t("projects")}
                                            </span>
                                        </button>
                                    </TooltipTrigger>
                                    <TooltipContent side="top" className="max-w-60">
                                        {t("projectsTooltip")}
                                    </TooltipContent>
                                </Tooltip>
                            )}
                            {!hideWorkflowButton && (
                                <Tooltip>
                                    <TooltipTrigger asChild>
                                        <button
                                            type="button"
                                            onClick={() => setWorkflowModalOpen(true)}
                                            aria-label={t("openWorkflows")}
                                            className={`flex shrink-0 items-center gap-1.5 rounded-lg px-2 h-8 text-sm transition-colors ${selectedWorkflow ? "bg-brand text-brand-foreground hover:bg-brand/90" : "text-foreground hover:bg-accent"}`}
                                        >
                                            {selectedWorkflow ? (
                                                <Check className="h-3.5 w-3.5 shrink-0" />
                                            ) : (
                                                <Library className="h-3.5 w-3.5 shrink-0" />
                                            )}
                                            <span className="hidden @[46rem]/composer:inline">
                                                {t("workflows")}
                                            </span>
                                        </button>
                                    </TooltipTrigger>
                                    <TooltipContent side="top" className="max-w-60">
                                        {t("workflowsTooltip")}
                                    </TooltipContent>
                                </Tooltip>
                            )}
                            <McpToggleButton />
                            <ContextsToggleButton />
                            <Tooltip>
                                <TooltipTrigger asChild>
                                    <button
                                        type="button"
                                        onClick={toggleWebSearch}
                                        aria-label={t("webSearch.label")}
                                        aria-pressed={webSearchEnabled}
                                        className={`flex shrink-0 items-center gap-1.5 rounded-lg px-2 h-8 text-sm transition-colors ${webSearchEnabled ? "bg-brand text-brand-foreground hover:bg-brand/90" : "text-foreground hover:bg-accent"}`}
                                    >
                                        <Globe className="h-3.5 w-3.5 shrink-0" />
                                        <span className="hidden @[46rem]/composer:inline">
                                            {t("webSearch.label")}
                                        </span>
                                    </button>
                                </TooltipTrigger>
                                <TooltipContent side="top" className="max-w-60">
                                    {webSearchEnabled
                                        ? t("webSearch.tooltipOn")
                                        : t("webSearch.tooltipOff")}
                                </TooltipContent>
                            </Tooltip>
                            <ShieldBadge />
                            {value.trim().length >= 10 && !isLoading && (
                                <Tooltip>
                                    <TooltipTrigger asChild>
                                        <button
                                            type="button"
                                            onClick={() => {
                                                void enrich(value.trim(), {
                                                    documentNames: attachedDocs.map(
                                                        (d) => d.filename,
                                                    ),
                                                });
                                            }}
                                            disabled={disabled || isEnriching}
                                            className="flex shrink-0 items-center gap-1.5 rounded-lg px-2 h-8 text-sm text-foreground hover:bg-accent transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                                            aria-label={t("enrichment.buttonAria")}
                                        >
                                            {isEnriching ? (
                                                <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
                                            ) : (
                                                <Sparkles className="h-3.5 w-3.5 shrink-0" />
                                            )}
                                            {/* With the PII badge in the row
                                                (any mode != off) the label
                                                doesn't fit — icon only, the
                                                tooltip carries the words
                                                (issue #132). */}
                                            {piiMode === "off" && (
                                                <span className="hidden @[46rem]/composer:inline">
                                                    {t("enrichment.button")}
                                                </span>
                                            )}
                                        </button>
                                    </TooltipTrigger>
                                    <TooltipContent side="top" className="max-w-60">
                                        {t("enrichment.tooltip")}
                                    </TooltipContent>
                                </Tooltip>
                            )}
                        </div>

                        <div className="flex items-center gap-1">
                            <DailyUsageRing />
                            <button
                                type="button"
                                data-testid="chat-send"
                                data-streaming={isLoading ? "true" : "false"}
                                className="relative bg-primary text-primary-foreground rounded-md h-8 w-8 flex items-center justify-center cursor-pointer disabled:cursor-default disabled:opacity-60 backdrop-blur-xl border border-primary-foreground/30 active:enabled:scale-95 transition-all duration-150"
                                onClick={handleActionClick}
                                disabled={
                                    disabled ||
                                    pendingPastes.length > 0 ||
                                    (!isLoading && !value.trim() && !hasContext)
                                }
                                aria-busy={disabled || undefined}
                            >
                                {isLoading ? (
                                    <Square
                                        className="h-4 w-4"
                                        fill="currentColor"
                                        strokeWidth={0}
                                    />
                                ) : (
                                    <ArrowRight className="h-4 w-4" />
                                )}
                            </button>
                        </div>
                    </div>
                </div>
            </div>

            {/* PII review modal — gated by `pendingPreview`. The modal
                drives the apply-overrides call internally; we just have
                to translate confirm/close back to the awaiting
                Promise so AddDocButton resumes the upload loop. */}
            <DocumentAnonymizationPreviewModal
                open={pendingPreview !== null}
                onClose={() => finishPiiReview(false)}
                preview={pendingPreview}
                filename={pendingPreview?.filename}
                onConfirm={() => finishPiiReview(true)}
            />

            {/* Loading overlay during the OCR + sidecar round-trip.
                Inline-fixed rather than a separate modal so the user
                still sees the chat behind it; we also suppress further
                clicks via pointer-events. */}
            {previewLoading && (
                <div
                    role="status"
                    aria-live="polite"
                    className="fixed inset-0 z-40 flex items-center justify-center bg-foreground/30 backdrop-blur-sm"
                >
                    <div className="bg-background border border-border rounded-2xl px-6 py-5 flex items-center gap-3 max-w-md">
                        <Loader2 className="h-5 w-5 animate-spin text-foreground" />
                        <div className="text-sm">
                            <div className="font-medium text-foreground">
                                {t("piiPreview.loading", {
                                    default: "Provjera PII podataka…",
                                })}
                            </div>
                            <div className="text-xs text-muted-foreground mt-0.5">
                                {previewLoading.filename}
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {/* Error banner — non-blocking, dismiss-on-next-action. */}
            {previewError && (
                <div className="mt-2 px-3 py-2 rounded-lg bg-warning/10 border border-warning/20 flex items-start gap-2">
                    <ShieldAlert className="h-4 w-4 text-warning shrink-0 mt-0.5" />
                    <div className="flex-1 text-xs text-warning">
                        <div className="font-medium">
                            {t("piiPreview.errorTitle", {
                                default: "PII pregled nije uspio",
                            })}
                        </div>
                        <div className="mt-0.5">
                            {previewError.source === "typed"
                                ? t("piiPreview.errorStrictTyped", {
                                      default:
                                          "Poruka NIJE poslana (strogi način). Nacrt je ostao u polju za unos — pokušaj ponovno.",
                                  })
                                : piiMode === "strict"
                                  ? t("piiPreview.errorStrict", {
                                        default:
                                            "Dokument NIJE prikvačen (strogi način). Pokušaj ponovno ili promijeni način rada na /account/privacy.",
                                    })
                                  : t("piiPreview.errorOpen", {
                                        default:
                                            "Dokument je prikvačen bez PII pregleda. Provjeri vezu i pokušaj ponovno za potpunu zaštitu.",
                                    })}
                        </div>
                    </div>
                    <button
                        type="button"
                        onClick={() => setPreviewError(null)}
                        className="text-warning hover:text-foreground"
                        aria-label={t("dismiss")}
                    >
                        <X className="h-3.5 w-3.5" />
                    </button>
                </div>
            )}

            <AddDocumentsModal
                open={docSelectorOpen}
                onClose={() => setDocSelectorOpen(false)}
                onSelect={handleAddDocsFromSelector}
                breadcrumb={[t("projects"), t("addDocuments")]}
            />
            <AssistantWorkflowModal
                open={workflowModalOpen}
                onClose={() => setWorkflowModalOpen(false)}
                onSelect={(wf) => {
                    setSelectedWorkflow({ id: wf.id, title: wf.title, type: wf.type });
                    setWorkflowModalOpen(false);
                }}
                projectName={projectName}
                projectCmNumber={projectCmNumber}
            />
            <ApiKeyMissingModal
                open={apiKeyModalProvider !== null}
                provider={apiKeyModalProvider}
                onClose={() => setApiKeyModalProvider(null)}
            />
            <IntegrationFilePicker
                open={integrationPicker !== null}
                provider={integrationPicker?.provider ?? null}
                providerDisplayName={integrationPicker?.displayName ?? null}
                onClose={() => setIntegrationPicker(null)}
                onImport={handleAddDocFromProject}
            />
            <GoogleDrivePickerLauncher
                open={googleDrivePickerOpen}
                onClose={() => setGoogleDrivePickerOpen(false)}
                onImport={handleAddDocFromProject}
            />
        </>
    );
});
