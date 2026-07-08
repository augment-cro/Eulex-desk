/* global Office */
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
    ArrowUp,
    FolderClosed,
    GitCompare,
    History,
    Loader2,
    Paperclip,
    Plus,
    Sparkles,
    Square,
    X,
} from "lucide-react";
import {
    uploadDocumentBlob,
    type BuiltinMcpServer,
    type McpServer,
} from "../lib/api";
import { normalizeFilenameForDisplay } from "../lib/filenameUtf8";
import { getOpenDocumentBytes } from "../lib/wordDocBytes";
import { getSelectionState, type WordSelectionState } from "../hooks/useWordDoc";
import EditModeToggle from "./EditModeToggle";
import DocumentPickerModal, { type DocRef } from "./DocumentPickerModal";
import McpToggleButton from "./McpToggleButton";
import { useTranslation } from "../i18n/I18nProvider";
import ProjectPickerModal from "./ProjectPickerModal";
import WorkflowPickerModal, {
    type PickedWorkflow,
} from "./WorkflowPickerModal";
import type { EditMode } from "../lib/wordComments";
import {
    getTrackedChangesViaApi,
    formatTrackedChangesForLLM,
} from "../lib/wordOoxml";

interface AttachedFile {
    document_id: string;
    filename: string;
}

export interface ChatInputSendArgs {
    files: AttachedFile[];
    selection: { text: string; has_selection: boolean };
    editMode: EditMode;
    /**
     * Optional model override. The add-in no longer ships a model picker;
     * left optional so the backend's per-user default applies.
     */
    model?: string;
    workflow?: { id: string; title: string };
    /** Formatted summary of existing tracked changes in the document. */
    trackedChangesContext?: string;
}

interface Props {
    activeProjectId: string | null;
    onChangeProject: (id: string | null) => void;
    isStreaming: boolean;
    onSend: (text: string, opts: ChatInputSendArgs) => void;
    onStop: () => void;
    onOpenHistory: () => void;
    onNewChat: () => void;
    /**
     * True when no messages have been exchanged in the current chat yet.
     * Used to auto-attach the open Word document on the very first send
     * so the user doesn't have to click Attach for every new conversation.
     */
    isFirstMessageInChat?: boolean;
    /** Workflow consumed via the cross-tab "Use in chat" handoff. */
    pendingWorkflow?: { id: string; title: string } | null;
    onClearPendingWorkflow?: () => void;
    /**
     * MCP connectors — matches Eulex Desk web assistant: Plug icon + dropdown toggles
     * for built-ins and user connectors; backend honours `enabled` on each chat.
     */
    mcpUserServers: McpServer[];
    mcpBuiltinServers: BuiltinMcpServer[];
    mcpLoading: boolean;
    mcpRefresh: () => Promise<void>;
}

export default function ChatInput({
    activeProjectId,
    onChangeProject,
    isStreaming,
    onSend,
    onStop,
    onOpenHistory,
    onNewChat,
    isFirstMessageInChat,
    pendingWorkflow,
    onClearPendingWorkflow,
    mcpUserServers,
    mcpBuiltinServers,
    mcpLoading,
    mcpRefresh,
}: Props) {
    const [text, setText] = useState("");
    const [files, setFiles] = useState<AttachedFile[]>([]);
    const [extraDocRefs, setExtraDocRefs] = useState<DocRef[]>([]);
    const [uploading, setUploading] = useState(false);
    const [uploadError, setUploadError] = useState<string | null>(null);
    const [selection, setSelection] = useState<WordSelectionState>({
        text: "",
        isEmpty: true,
        length: 0,
        snippet: "",
    });
    const [showDocPicker, setShowDocPicker] = useState(false);
    const [showProjectPicker, setShowProjectPicker] = useState(false);
    const [showWorkflowPicker, setShowWorkflowPicker] = useState(false);
    const [editMode, setEditMode] = useState<EditMode>("track");
    const [pickedWorkflow, setPickedWorkflow] =
        useState<PickedWorkflow | null>(null);
    const [includeTrackedChanges, setIncludeTrackedChanges] = useState(false);
    const [extractingChanges, setExtractingChanges] = useState(false);
    const t = useTranslation();

    const taRef = useRef<HTMLTextAreaElement | null>(null);

    // Surface a workflow handed off from the Workflows tab as a chip in
    // the composer. Clears on send so it's truly one-shot.
    useEffect(() => {
        if (pendingWorkflow) {
            setPickedWorkflow({
                id: pendingWorkflow.id,
                title: pendingWorkflow.title,
                prompt_md: null,
            });
        }
    }, [pendingWorkflow]);

    // Keep the selection chip in sync with Word.
    //
    // The previous implementation polled `getSelectionState()` every
    // 1000ms. Each poll runs `Word.run → context.sync()` against the
    // host, which on macOS Word triggers a re-evaluation of the ribbon
    // style cache. Users reported the Quick Styles Gallery flickering
    // every second while the taskpane was open — a known Word-for-Mac
    // bug that gets aggravated by frequent Office.js RPC traffic.
    //
    // Microsoft's recommendation is to listen to
    // `Office.EventType.DocumentSelectionChanged`. We subscribe to that
    // event (cheap, host-driven, no RPC per cursor move) and keep a
    // long-period fallback poll at 10s so a missed event eventually
    // self-corrects without producing visible flicker.
    useEffect(() => {
        let cancelled = false;
        const tick = async () => {
            const state = await getSelectionState();
            if (!cancelled) setSelection(state);
        };

        void tick();

        let removeHandler: (() => void) | null = null;
        try {
            if (
                typeof Office !== "undefined" &&
                Office?.context?.document?.addHandlerAsync
            ) {
                const handler = () => {
                    void tick();
                };
                Office.context.document.addHandlerAsync(
                    Office.EventType.DocumentSelectionChanged,
                    handler,
                );
                removeHandler = () => {
                    try {
                        Office.context.document.removeHandlerAsync(
                            Office.EventType.DocumentSelectionChanged,
                            { handler },
                        );
                    } catch {
                        /* ignore — taskpane teardown is best-effort */
                    }
                };
            }
        } catch {
            /* ignore — fall back to the slow poll below */
        }

        const handle = setInterval(tick, 10000);
        return () => {
            cancelled = true;
            clearInterval(handle);
            removeHandler?.();
        };
    }, []);

    const adjustHeight = useCallback(() => {
        const ta = taRef.current;
        if (!ta) return;
        ta.style.height = "auto";
        ta.style.height = Math.min(160, ta.scrollHeight) + "px";
    }, []);

    useEffect(() => {
        adjustHeight();
    }, [text, adjustHeight]);

    const handleAttachOpenDoc = useCallback(async () => {
        setUploadError(null);
        setUploading(true);
        try {
            const { blob, filename } = await getOpenDocumentBytes();
            const result = await uploadDocumentBlob({
                blob,
                filename,
                projectId: activeProjectId,
            });
            const displayName = normalizeFilenameForDisplay(result.filename);
            setFiles((prev) => [
                ...prev,
                { document_id: result.id, filename: displayName },
            ]);
        } catch (err) {
            setUploadError(
                err instanceof Error ? err.message : t("errors.uploadFailed"),
            );
        } finally {
            setUploading(false);
        }
    }, [activeProjectId, t]);

    const handleRemoveFile = useCallback((idx: number) => {
        setFiles((prev) => prev.filter((_, i) => i !== idx));
    }, []);

    const handleRemoveDocRef = useCallback((idx: number) => {
        setExtraDocRefs((prev) => prev.filter((_, i) => i !== idx));
    }, []);

    const handleDocPickerConfirm = (refs: DocRef[]) => {
        // Refs without document_id (the live Word doc) are split out and
        // attached on send; the rest are stored as already-uploaded refs.
        const stored: DocRef[] = refs.filter(
            (r) => r.document_id && !r.isCurrentDoc,
        );
        setExtraDocRefs(stored);
        setShowDocPicker(false);
        // If the user ticked "Current Word document", upload its bytes now.
        const wantsCurrent = refs.some((r) => r.isCurrentDoc);
        if (wantsCurrent) {
            void handleAttachOpenDoc();
        }
    };

    const handleSubmit = useCallback(
        async (e: React.FormEvent) => {
            e.preventDefault();
            // Block sends while a document upload is in flight — letting one
            // through races the auto-attach branch below and ships a chat
            // message that doesn't reference the file the user is staring
            // at as "uploading…". The Enter handler enforces the same gate
            // so keyboard-driven sends behave like the button.
            if (isStreaming || uploading) return;
            const trimmed = text.trim();
            if (!trimmed) return;

            const allFiles: AttachedFile[] = [...files];
            for (const r of extraDocRefs) {
                if (r.document_id) {
                    allFiles.push({
                        document_id: r.document_id,
                        filename: r.filename,
                    });
                }
            }

            // Auto-attach the currently open Word document on the very
            // first turn of a chat so the agent has the document as
            // context without the user having to click Attach. Skipped
            // when the user already attached something (incl. a project
            // doc reference), or when Office isn't available, or when
            // reading the document fails for any reason — we never want
            // a failed auto-attach to block the user's actual message.
            if (
                isFirstMessageInChat &&
                allFiles.length === 0 &&
                typeof Office !== "undefined" &&
                Office?.context?.document
            ) {
                setUploadError(null);
                setUploading(true);
                try {
                    const { blob, filename } = await getOpenDocumentBytes();
                    const result = await uploadDocumentBlob({
                        blob,
                        filename,
                        projectId: activeProjectId,
                    });
                    const displayName = normalizeFilenameForDisplay(
                        result.filename,
                    );
                    allFiles.push({
                        document_id: result.id,
                        filename: displayName,
                    });
                    // Surface the attached chip so the user sees what
                    // Eulex Desk just received — the chip clears with the
                    // rest of the form state right below.
                    setFiles([
                        {
                            document_id: result.id,
                            filename: displayName,
                        },
                    ]);
                } catch (err) {
                    // Log but do not abort — the user can still chat
                    // about the selection, or attach manually.
                    // eslint-disable-next-line no-console
                    console.warn(
                        "[ChatInput] auto-attach of current Word document failed:",
                        err instanceof Error ? err.message : err,
                    );
                } finally {
                    setUploading(false);
                }
            }

            // Extract tracked changes context if toggled on.
            let trackedChangesContext: string | undefined;
            if (includeTrackedChanges) {
                try {
                    setExtractingChanges(true);
                    const changes = await getTrackedChangesViaApi();
                    if (changes.length > 0) {
                        trackedChangesContext =
                            formatTrackedChangesForLLM(changes);
                    }
                } catch (err) {
                    // eslint-disable-next-line no-console
                    console.warn(
                        "[ChatInput] tracked changes extraction failed:",
                        err,
                    );
                } finally {
                    setExtractingChanges(false);
                }
            }

            onSend(trimmed, {
                files: allFiles,
                selection: {
                    text: selection.text,
                    has_selection: !selection.isEmpty,
                },
                editMode,
                workflow: pickedWorkflow
                    ? {
                          id: pickedWorkflow.id,
                          title: pickedWorkflow.title,
                      }
                    : undefined,
                trackedChangesContext,
            });
            setText("");
            setFiles([]);
            setExtraDocRefs([]);
            setPickedWorkflow(null);
            onClearPendingWorkflow?.();
        },
        [
            activeProjectId,
            editMode,
            extraDocRefs,
            files,
            isFirstMessageInChat,
            isStreaming,
            onClearPendingWorkflow,
            onSend,
            pickedWorkflow,
            selection,
            text,
            uploading,
        ],
    );

    return (
        <>
            <form
                onSubmit={handleSubmit}
                className="border-t border-gray-200 bg-white p-2 space-y-2 shrink-0"
            >
                <div className="flex flex-wrap items-center gap-1.5">
                    <button
                        type="button"
                        onClick={onOpenHistory}
                        title={t("chat.history")}
                        className="inline-flex items-center justify-center px-1.5 h-7 rounded-md border border-gray-200 text-gray-600 hover:bg-gray-50"
                    >
                        <History className="h-3.5 w-3.5" />
                    </button>
                    <button
                        type="button"
                        onClick={onNewChat}
                        title={t("chat.newChat")}
                        className="inline-flex items-center justify-center px-1.5 h-7 rounded-md border border-gray-200 text-gray-600 hover:bg-gray-50"
                    >
                        <Plus className="h-3.5 w-3.5" />
                    </button>

                    <button
                        type="button"
                        onClick={() => setShowProjectPicker(true)}
                        className={`inline-flex items-center gap-1 px-2 h-7 text-xs rounded-md border transition-colors ${
                            activeProjectId
                                ? "bg-mike-50 text-mike-700 border-mike-200"
                                : "border-gray-200 text-gray-600 hover:bg-gray-50"
                        }`}
                    >
                        <FolderClosed className="h-3 w-3" />
                        {activeProjectId ? t("chat.project") : t("chat.noProject")}
                    </button>

                    <button
                        type="button"
                        onClick={() => setShowDocPicker(true)}
                        disabled={uploading}
                        className="inline-flex items-center gap-1 px-2 h-7 text-xs border border-gray-200 rounded-md text-gray-600 hover:bg-gray-50 disabled:opacity-50"
                    >
                        {uploading ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                            <Paperclip className="h-3 w-3" />
                        )}
                        {t("chat.attach")}
                    </button>

                    <button
                        type="button"
                        onClick={() => setShowWorkflowPicker(true)}
                        className="inline-flex items-center gap-1 px-2 h-7 text-xs border border-gray-200 rounded-md text-gray-600 hover:bg-gray-50"
                        title={t("chat.workflowTip")}
                    >
                        <Sparkles className="h-3 w-3" />
                        {t("chat.workflow")}
                    </button>

                    <McpToggleButton
                        userServers={mcpUserServers}
                        builtinServers={mcpBuiltinServers}
                        loading={mcpLoading}
                        onRefresh={mcpRefresh}
                    />
                </div>

                {pickedWorkflow ? (
                    <div className="inline-flex items-center gap-1 px-2 py-1 text-xs bg-mike-50 text-mike-700 border border-mike-200 rounded-md">
                        <Sparkles className="h-3 w-3" />
                        <span className="truncate max-w-[200px]">
                            {pickedWorkflow.title}
                        </span>
                        <button
                            type="button"
                            onClick={() => {
                                setPickedWorkflow(null);
                                onClearPendingWorkflow?.();
                            }}
                            className="text-mike-700 hover:text-mike-900"
                            aria-label={t("chat.removeWorkflow")}
                        >
                            <X className="h-3 w-3" />
                        </button>
                    </div>
                ) : null}

                {!selection.isEmpty ? (
                    <div
                        className="inline-flex items-center px-2 py-1 text-xs rounded-md bg-amber-50 text-amber-700 border border-amber-200"
                        title={selection.text}
                    >
                        {t("chat.selection")}: {selection.snippet}
                    </div>
                ) : null}

                {(files.length > 0 || extraDocRefs.length > 0) && (
                    <ul className="flex flex-wrap gap-1">
                        {files.map((f, idx) => (
                            <li
                                key={`f-${f.document_id}-${idx}`}
                                className="inline-flex items-center gap-1 px-2 py-1 text-xs bg-gray-100 rounded-md"
                            >
                                <span className="truncate max-w-[160px]">
                                    {normalizeFilenameForDisplay(f.filename)}
                                </span>
                                <button
                                    type="button"
                                    onClick={() => handleRemoveFile(idx)}
                                    className="text-gray-500 hover:text-gray-900"
                                    aria-label={t("chat.removeFile")}
                                >
                                    <X className="h-3 w-3" />
                                </button>
                            </li>
                        ))}
                        {extraDocRefs.map((r, idx) => (
                            <li
                                key={`r-${r.document_id ?? "x"}-${idx}`}
                                className="inline-flex items-center gap-1 px-2 py-1 text-xs bg-gray-100 rounded-md"
                            >
                                <span className="truncate max-w-[160px]">
                                    {normalizeFilenameForDisplay(r.filename)}
                                </span>
                                <button
                                    type="button"
                                    onClick={() => handleRemoveDocRef(idx)}
                                    className="text-gray-500 hover:text-gray-900"
                                    aria-label={t("chat.removeFile")}
                                >
                                    <X className="h-3 w-3" />
                                </button>
                            </li>
                        ))}
                    </ul>
                )}

                {uploadError ? (
                    <p className="text-xs text-red-600">{uploadError}</p>
                ) : null}

                {uploading ? (
                    <div
                        role="status"
                        aria-live="polite"
                        className="flex items-center gap-2 px-2.5 py-2 text-xs font-medium text-mike-700 bg-mike-50 border border-mike-200 rounded-md overflow-hidden relative"
                    >
                        <Loader2 className="h-3.5 w-3.5 animate-spin shrink-0" />
                        <span>{t("chat.attaching")}</span>
                        {/* Indeterminate progress bar — Office's webview is
                            slow at painting opacity transitions, so we use a
                            translateX sweep on a gradient strip instead. The
                            keyframes live in globals.css under
                            `@keyframes mike-progress-sweep`. */}
                        <span
                            aria-hidden="true"
                            className="absolute bottom-0 left-0 h-0.5 w-1/3 bg-mike-500/70 animate-mike-progress-sweep"
                        />
                    </div>
                ) : null}

                <div className="flex items-end gap-1.5">
                    <textarea
                        ref={taRef}
                        value={text}
                        onChange={(e) => setText(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === "Enter" && !e.shiftKey) {
                                e.preventDefault();
                                if (uploading || isStreaming) return;
                                handleSubmit(e);
                            }
                        }}
                        placeholder={
                            uploading
                                ? t("chat.attaching")
                                : t("chat.placeholder")
                        }
                        rows={1}
                        disabled={uploading}
                        className="flex-1 min-h-[36px] max-h-[160px] px-3 py-2 text-sm border border-gray-200 rounded-md focus:border-mike-500 focus:outline-none focus:ring-2 focus:ring-mike-200 resize-none disabled:bg-gray-50 disabled:text-gray-500 disabled:cursor-not-allowed"
                    />
                    {isStreaming ? (
                        <button
                            type="button"
                            onClick={onStop}
                            className="h-9 w-9 flex items-center justify-center bg-gray-100 hover:bg-gray-200 rounded-md"
                            title={t("chat.stop")}
                        >
                            <Square className="h-3.5 w-3.5" />
                        </button>
                    ) : (
                        <button
                            type="submit"
                            disabled={uploading || text.trim().length === 0}
                            className="h-9 w-9 flex items-center justify-center bg-black hover:bg-gray-900 text-white rounded-md disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-black"
                            title={uploading ? t("chat.attaching") : t("chat.send")}
                            aria-disabled={uploading || text.trim().length === 0}
                        >
                            {uploading ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                                <ArrowUp className="h-4 w-4" />
                            )}
                        </button>
                    )}
                </div>

                <div className="flex items-center justify-between">
                    <span className="text-[10px] text-gray-400">
                        {t("chat.footerNote")}
                    </span>
                    <div className="flex items-center gap-1.5">
                        <button
                            type="button"
                            onClick={() =>
                                setIncludeTrackedChanges((v) => !v)
                            }
                            className={
                                "inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] transition-colors " +
                                (includeTrackedChanges
                                    ? "bg-orange-100 text-orange-700 border border-orange-300"
                                    : "bg-gray-50 text-gray-400 border border-gray-200 hover:text-gray-600 hover:bg-gray-100")
                            }
                            title={t("chat.trackedChangesContextTip")}
                        >
                            {extractingChanges ? (
                                <Loader2 className="h-2.5 w-2.5 animate-spin" />
                            ) : (
                                <GitCompare className="h-2.5 w-2.5" />
                            )}
                            {t("chat.trackedChangesContext")}
                        </button>
                        <EditModeToggle value={editMode} onChange={setEditMode} />
                    </div>
                </div>
            </form>

            <DocumentPickerModal
                open={showDocPicker}
                activeProjectId={activeProjectId}
                initialSelected={extraDocRefs}
                onClose={() => setShowDocPicker(false)}
                onConfirm={handleDocPickerConfirm}
            />

            <ProjectPickerModal
                open={showProjectPicker}
                onClose={() => setShowProjectPicker(false)}
                onSelect={(id) => onChangeProject(id)}
            />

            <WorkflowPickerModal
                open={showWorkflowPicker}
                onClose={() => setShowWorkflowPicker(false)}
                onSelect={(wf) => {
                    setPickedWorkflow(wf);
                    setShowWorkflowPicker(false);
                }}
            />
        </>
    );
}
