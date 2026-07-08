"use client";

/**
 * useDraftMode — state management for the Draft Mode inline editing flow.
 *
 * Tracks the current text selection (captured from SuperDoc via
 * useSuperDocSelection + ui.selection.capture()), submission state,
 * and the resulting edit annotation after the backend responds.
 *
 * The hook owns the draft API call lifecycle and exposes:
 *   - `pendingSelection`    — captured selection info ready for editing
 *   - `isSubmitting`        — true while the API call is in-flight
 *   - `lastError`           — last error message if submission failed
 *   - `setSelection`        — called by DraftModeOverlay with captured data
 *   - `clearSelection`      — resets state (called on Escape or after accept)
 *   - `submitEdit`          — initiates the API call
 */

import { useCallback, useRef, useState } from "react";
import { draftSelectionEdit } from "@/app/lib/mikeApi";
import type { DraftSelectionEditResult } from "@/app/lib/mikeApi";

export interface DraftSelection {
    /** The selected text from the document */
    selectedText: string;
    /** ~200 chars before the selection for context */
    contextBefore: string;
    /** ~200 chars after the selection for context */
    contextAfter: string;
    /** Viewport-relative rect for positioning the popup */
    anchorRect: { top: number; left: number; width: number; height: number };
    /** Document ID this selection is from */
    documentId: string;
}

interface UseDraftModeResult {
    pendingSelection: DraftSelection | null;
    isSubmitting: boolean;
    lastError: string | null;
    setSelection: (sel: DraftSelection | null) => void;
    clearSelection: () => void;
    submitEdit: (
        instruction: string,
        onSuccess: (result: DraftSelectionEditResult) => void,
    ) => Promise<void>;
}

export function useDraftMode(): UseDraftModeResult {
    const [pendingSelection, setPendingSelection] =
        useState<DraftSelection | null>(null);
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [lastError, setLastError] = useState<string | null>(null);

    const abortRef = useRef<AbortController | null>(null);

    const setSelection = useCallback((sel: DraftSelection | null) => {
        // Cancel any in-flight edit if user changes selection
        if (abortRef.current) {
            abortRef.current.abort();
            abortRef.current = null;
        }
        setLastError(null);
        setPendingSelection(sel);
    }, []);

    const clearSelection = useCallback(() => {
        if (abortRef.current) {
            abortRef.current.abort();
            abortRef.current = null;
        }
        setPendingSelection(null);
        setLastError(null);
        setIsSubmitting(false);
    }, []);

    const submitEdit = useCallback(
        async (
            instruction: string,
            onSuccess: (result: DraftSelectionEditResult) => void,
        ) => {
            if (!pendingSelection) return;
            if (isSubmitting) return;

            const controller = new AbortController();
            abortRef.current = controller;
            setIsSubmitting(true);
            setLastError(null);

            try {
                const result = await draftSelectionEdit(
                    {
                        document_id: pendingSelection.documentId,
                        selected_text: pendingSelection.selectedText,
                        context_before: pendingSelection.contextBefore,
                        context_after: pendingSelection.contextAfter,
                        instruction,
                    },
                    controller.signal,
                );

                if (controller.signal.aborted) return;

                // Clear selection after success so the popup closes
                setPendingSelection(null);
                onSuccess(result);
            } catch (err) {
                if (controller.signal.aborted) return;
                const message =
                    err instanceof Error
                        ? err.message
                        : "Edit failed. Please try again.";
                // Try to parse backend detail JSON
                let detail = message;
                try {
                    const parsed = JSON.parse(message) as {
                        detail?: string;
                    };
                    if (parsed?.detail) detail = parsed.detail;
                } catch {
                    /* not JSON */
                }
                setLastError(detail);
            } finally {
                if (!controller.signal.aborted) {
                    setIsSubmitting(false);
                    abortRef.current = null;
                }
            }
        },
        [pendingSelection, isSubmitting],
    );

    return {
        pendingSelection,
        isSubmitting,
        lastError,
        setSelection,
        clearSelection,
        submitEdit,
    };
}
