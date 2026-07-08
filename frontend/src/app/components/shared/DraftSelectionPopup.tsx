"use client";

/**
 * DraftSelectionPopup — Floating mini-editor for Draft Mode.
 *
 * Renders as a fixed-position popup anchored above the selected text
 * in the SuperDoc editor. Uses coordinates from SuperDoc's
 * `ui.selection.getAnchorRect({ placement: 'end' })`.
 *
 * Features:
 * - Quick-action chips for common legal editing patterns
 * - Auto-resize textarea for the custom prompt
 * - Enter to submit, Escape to dismiss
 * - Loading spinner during API call
 * - Error display with retry
 */

import {
    useCallback,
    useEffect,
    useRef,
    useState,
} from "react";
import {
    AlertCircle,
    ChevronRight,
    Loader2,
    PenLine,
    X,
} from "lucide-react";
import type { DraftSelection } from "@/app/hooks/useDraftMode";

interface Props {
    selection: DraftSelection;
    isSubmitting: boolean;
    lastError: string | null;
    onSubmit: (instruction: string) => void;
    onDismiss: () => void;
}

const QUICK_ACTIONS = [
    { label: "Ublaži formulaciju", en: "Soften the wording" },
    { label: "Pojačaj odgovornost", en: "Strengthen liability" },
    { label: "Preformuliraj neutralno", en: "Rephrase neutrally" },
    { label: "Skrati", en: "Shorten" },
];

export function DraftSelectionPopup({
    selection,
    isSubmitting,
    lastError,
    onSubmit,
    onDismiss,
}: Props) {
    const [instruction, setInstruction] = useState("");
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);

    // Focus textarea on mount
    useEffect(() => {
        requestAnimationFrame(() => {
            textareaRef.current?.focus();
        });
    }, []);

    // Dismiss on Escape (global listener so it catches even when not focused)
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape" && !isSubmitting) {
                onDismiss();
            }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [onDismiss, isSubmitting]);

    // Click-outside to dismiss
    useEffect(() => {
        const onPointerDown = (e: PointerEvent) => {
            if (
                containerRef.current &&
                !containerRef.current.contains(e.target as Node) &&
                !isSubmitting
            ) {
                onDismiss();
            }
        };
        // Small delay so the initial click that opened the popup doesn't close it
        const timer = setTimeout(() => {
            document.addEventListener("pointerdown", onPointerDown);
        }, 150);
        return () => {
            clearTimeout(timer);
            document.removeEventListener("pointerdown", onPointerDown);
        };
    }, [onDismiss, isSubmitting]);

    const handleTextareaChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
        setInstruction(e.target.value);
        // Auto-resize
        const el = e.target;
        el.style.height = "auto";
        el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            handleSubmit();
        }
    };

    const handleSubmit = useCallback(() => {
        const trimmed = instruction.trim();
        if (!trimmed || isSubmitting) return;
        onSubmit(trimmed);
    }, [instruction, isSubmitting, onSubmit]);

    const handleQuickAction = (label: string) => {
        if (isSubmitting) return;
        setInstruction(label);
        onSubmit(label);
    };

    // Calculate popup position — anchor just below the selection end
    const { anchorRect } = selection;
    // Popup appears below the selection (below the end of the last line)
    const popupTop = anchorRect.top + anchorRect.height + 8;
    const popupLeft = Math.max(8, anchorRect.left);

    const previewText =
        selection.selectedText.length > 80
            ? selection.selectedText.slice(0, 80) + "…"
            : selection.selectedText;

    return (
        <div
            ref={containerRef}
            id="draft-selection-popup"
            role="dialog"
            aria-label="Draft Mode editor"
            style={{
                position: "fixed",
                top: popupTop,
                left: popupLeft,
                zIndex: 9999,
                width: 340,
            }}
            className="bg-surface-elevated rounded-2xl border border-border overflow-hidden"
        >
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-gradient-to-r from-accent to-surface-elevated">
                <div className="flex items-center gap-2">
                    <div className="flex items-center justify-center w-6 h-6 rounded-full bg-primary">
                        <PenLine className="w-3 h-3 text-primary-foreground" />
                    </div>
                    <span className="text-xs font-semibold text-foreground tracking-wide uppercase">
                        Draft
                    </span>
                </div>
                <button
                    id="draft-popup-dismiss-btn"
                    type="button"
                    onClick={onDismiss}
                    disabled={isSubmitting}
                    className="w-6 h-6 flex items-center justify-center rounded-full text-muted-foreground/70 hover:text-foreground hover:bg-accent transition-colors disabled:opacity-40"
                    aria-label="Zatvori"
                >
                    <X className="w-3.5 h-3.5" />
                </button>
            </div>

            {/* Selection preview */}
            <div className="px-4 py-2.5 bg-muted border-b border-border">
                <p className="text-[11px] text-muted-foreground/70 font-medium uppercase tracking-wide mb-1">
                    Selektirani tekst
                </p>
                <p className="text-xs text-muted-foreground italic leading-relaxed line-clamp-2">
                    "{previewText}"
                </p>
            </div>

            {/* Quick actions */}
            <div className="px-4 pt-3 pb-2 flex flex-wrap gap-1.5">
                {QUICK_ACTIONS.map((qa) => (
                    <button
                        key={qa.label}
                        type="button"
                        id={`draft-quick-action-${qa.label.toLowerCase().replace(/\s+/g, "-")}`}
                        onClick={() => handleQuickAction(qa.label)}
                        disabled={isSubmitting}
                        className="text-[11px] px-2.5 py-1 rounded-full bg-accent text-foreground hover:bg-secondary border border-border transition-all disabled:opacity-40 disabled:cursor-not-allowed font-medium"
                    >
                        {qa.label}
                    </button>
                ))}
            </div>

            {/* Custom instruction textarea */}
            <div className="px-4 pb-3">
                <div className="relative flex items-end gap-2 bg-surface-elevated rounded-xl border border-input focus-within:border-ring focus-within:ring-2 focus-within:ring-ring transition-all">
                    <textarea
                        ref={textareaRef}
                        id="draft-popup-instruction-textarea"
                        rows={1}
                        value={instruction}
                        onChange={handleTextareaChange}
                        onKeyDown={handleKeyDown}
                        disabled={isSubmitting}
                        placeholder="Napiši upute za izmjenu…"
                        className="flex-1 resize-none bg-transparent text-sm text-foreground placeholder:text-muted-foreground/70 px-3 py-2.5 outline-none min-h-[40px] max-h-[120px] leading-5 disabled:cursor-not-allowed"
                        aria-label="Upute za Draft Mode izmjenu"
                    />
                    <button
                        id="draft-popup-submit-btn"
                        type="button"
                        onClick={handleSubmit}
                        disabled={!instruction.trim() || isSubmitting}
                        className="mb-2 mr-2 flex items-center justify-center w-7 h-7 rounded-full bg-primary text-primary-foreground hover:bg-primary/90 transition-all disabled:opacity-40 disabled:cursor-not-allowed flex-shrink-0"
                        aria-label="Generiraj izmjenu"
                    >
                        {isSubmitting ? (
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                            <ChevronRight className="w-3.5 h-3.5" />
                        )}
                    </button>
                </div>

                {/* Loading state */}
                {isSubmitting && (
                    <div className="mt-2 flex items-center gap-2 text-xs text-foreground">
                        <Loader2 className="w-3 h-3 animate-spin" />
                        <span>Generiranje izmjene…</span>
                    </div>
                )}

                {/* Error state */}
                {lastError && !isSubmitting && (
                    <div className="mt-2 flex items-start gap-1.5 text-xs text-destructive bg-destructive/10 border border-destructive/20 rounded-lg px-2.5 py-2">
                        <AlertCircle className="w-3 h-3 mt-0.5 flex-shrink-0" />
                        <span className="leading-relaxed">{lastError}</span>
                    </div>
                )}
            </div>

            {/* Footer hint */}
            {!isSubmitting && !lastError && (
                <div className="px-4 pb-3 flex items-center justify-between">
                    <span className="text-[10px] text-muted-foreground/70">
                        Enter za potvrdu · Esc za odustajanje
                    </span>
                </div>
            )}
        </div>
    );
}
