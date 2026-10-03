"use client";

import { memo, useCallback, useMemo, type ComponentProps } from "react";
import { DocxViewer } from "@/app/components/shared/DocxViewer";
import { DocView } from "@/app/components/shared/DocView";

type DocxProps = ComponentProps<typeof DocxViewer>;
type SavedArgs = Parameters<NonNullable<DocxProps["onSaved"]>>[0];

/**
 * Document pane of the project chat (Asistent predmeta).
 *
 * Memoized with document-bound callbacks: while an answer drips in, the chat
 * page re-renders on every animation frame, and the SuperDoc viewer used to
 * re-render with it for 5–9 s after each answer (~60 renders/s, prod
 * 30. 9. 2026) because the page passed fresh inline callbacks. The page now
 * passes stable per-document handlers (`…For`), bound here.
 */
export const ProjectDocxPane = memo(function ProjectDocxPane({
    documentId,
    versionId,
    refetchKey,
    quotes,
    highlightEdit,
    warning,
    initialScrollTop,
    onReadyFor,
    onWarningDismissFor,
    onScrollChangeFor,
    onSavedFor,
}: {
    documentId: string;
    versionId?: DocxProps["versionId"];
    refetchKey?: DocxProps["refetchKey"];
    quotes?: DocxProps["quotes"];
    highlightEdit?: DocxProps["highlightEdit"];
    warning?: DocxProps["warning"];
    initialScrollTop?: DocxProps["initialScrollTop"];
    onReadyFor: (documentId: string) => void;
    onWarningDismissFor: (documentId: string) => void;
    onScrollChangeFor: (documentId: string, scrollTop: number) => void;
    onSavedFor: (documentId: string, args: SavedArgs) => void;
}) {
    const onReady = useCallback(
        () => onReadyFor(documentId),
        [onReadyFor, documentId],
    );
    const onWarningDismiss = useCallback(
        () => onWarningDismissFor(documentId),
        [onWarningDismissFor, documentId],
    );
    const onScrollChange = useCallback(
        (top: number) => onScrollChangeFor(documentId, top),
        [onScrollChangeFor, documentId],
    );
    const onSaved = useCallback(
        (args: SavedArgs) => onSavedFor(documentId, args),
        [onSavedFor, documentId],
    );
    return (
        <DocxViewer
            documentId={documentId}
            versionId={versionId}
            refetchKey={refetchKey}
            quotes={quotes}
            highlightEdit={highlightEdit}
            onReady={onReady}
            warning={warning}
            onWarningDismiss={onWarningDismiss}
            initialScrollTop={initialScrollTop}
            onScrollChange={onScrollChange}
            onSaved={onSaved}
            rounded={false}
            bordered={false}
        />
    );
});

/** Non-DOCX documents (PDF, text) in the same pane — memoized for the same reason. */
export const ProjectDocView = memo(function ProjectDocView({
    documentId,
    quotes,
}: {
    documentId: string;
    quotes?: ComponentProps<typeof DocView>["quotes"];
}) {
    const doc = useMemo(() => ({ document_id: documentId }), [documentId]);
    return <DocView doc={doc} quotes={quotes} rounded={false} bordered={false} />;
});
