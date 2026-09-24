"use client";

import { useEffect, useMemo, useRef, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";
import { findQuoteRanges } from "./textQuoteRanges";

interface Props {
    text: string;
    /** Cited passages to highlight; the view scrolls to the first match. */
    quotes?: readonly string[];
    rounded?: boolean;
    bordered?: boolean;
}

/**
 * Viewer for plain-text (.txt) documents — `DocView` renders it when
 * `/display` answers `text/plain`. The raw text sits on a page-like sheet,
 * wrapped and scrollable; in citation mode the quoted passage is highlighted
 * and scrolled to the middle of the view.
 */
export function TextDocView({
    text,
    quotes,
    rounded = true,
    bordered = true,
}: Props) {
    const t = useTranslations("docPanel");
    const scrollRef = useRef<HTMLDivElement>(null);
    const firstMarkRef = useRef<HTMLElement>(null);
    const ranges = useMemo(
        () => findQuoteRanges(text, quotes ?? []),
        [text, quotes],
    );

    // Centre the first highlight in the scroll container (not
    // `scrollIntoView`, which would also scroll the surrounding panels).
    useEffect(() => {
        const scrollEl = scrollRef.current;
        const mark = firstMarkRef.current;
        if (!scrollEl || !mark) return;
        const containerRect = scrollEl.getBoundingClientRect();
        const markRect = mark.getBoundingClientRect();
        scrollEl.scrollTo({
            top: Math.max(
                0,
                scrollEl.scrollTop +
                    markRect.top -
                    containerRect.top -
                    scrollEl.clientHeight / 2 +
                    markRect.height / 2,
            ),
            behavior: "instant" as ScrollBehavior,
        });
    }, [ranges]);

    const parts: ReactNode[] = [];
    let cursor = 0;
    ranges.forEach(([start, end], i) => {
        if (start > cursor) parts.push(text.slice(cursor, start));
        parts.push(
            <mark
                key={start}
                ref={i === 0 ? firstMarkRef : undefined}
                className="rounded-sm bg-highlight/35 text-inherit"
            >
                {text.slice(start, end)}
            </mark>,
        );
        cursor = end;
    });
    if (cursor < text.length) parts.push(text.slice(cursor));

    return (
        <div
            className={cn(
                "relative flex flex-1 flex-col overflow-hidden",
                bordered && "border border-border",
                rounded && "rounded-xl",
            )}
        >
            <div
                ref={scrollRef}
                className="flex-1 overflow-auto bg-muted px-3 pt-5 pb-3"
            >
                <div className="mx-auto max-w-3xl border border-border bg-background px-6 py-5 sm:px-8 sm:py-6">
                    {text.trim() ? (
                        <div className="whitespace-pre-wrap break-words text-sm leading-relaxed text-foreground">
                            {parts}
                        </div>
                    ) : (
                        <p className="text-sm text-muted-foreground">
                            {t("emptyText")}
                        </p>
                    )}
                </div>
            </div>
        </div>
    );
}
