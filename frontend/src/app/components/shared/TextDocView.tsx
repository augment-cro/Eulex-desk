"use client";

import { useEffect, useMemo, useRef, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";
import { findQuoteRanges } from "./textQuoteRanges";
import { pageMarkerOf, rehypeMarkRanges, rehypePageMarkers } from "./rehypeMarkRanges";

interface Props {
    text: string;
    /** Cited passages to highlight; the view scrolls to the first match. */
    quotes?: readonly string[];
    /** Render the text as Markdown (a .md document) instead of raw text. */
    markdown?: boolean;
    rounded?: boolean;
    bordered?: boolean;
}

const MARK_CLASS = "rounded-sm bg-highlight/35 text-inherit";

/**
 * Viewer for plain-text (.txt, .md) documents and the extracted text of
 * e-mails (.eml, .msg) — `DocView` renders it when `/display` answers
 * `text/plain`. The text sits on a page-like sheet, wrapped and scrollable:
 * raw, or for a Markdown document rendered (headings, lists, tables, the
 * `[str. N]` page labels of context documents as quiet dividers). In
 * citation mode the quoted passage is highlighted and scrolled to the middle
 * of the view.
 */
export function TextDocView({
    text,
    quotes,
    markdown = false,
    rounded = true,
    bordered = true,
}: Props) {
    const t = useTranslations("docPanel");
    const tCommon = useTranslations("common");
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
        const mark =
            firstMarkRef.current ??
            scrollEl?.querySelector<HTMLElement>("mark[data-quote-mark]") ??
            null;
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
    }, [ranges, markdown]);

    const parts: ReactNode[] = [];
    if (!markdown) {
        let cursor = 0;
        ranges.forEach(([start, end], i) => {
            if (start > cursor) parts.push(text.slice(cursor, start));
            parts.push(
                <mark
                    key={start}
                    ref={i === 0 ? firstMarkRef : undefined}
                    className={MARK_CLASS}
                >
                    {text.slice(start, end)}
                </mark>,
            );
            cursor = end;
        });
        if (cursor < text.length) parts.push(text.slice(cursor));
    }

    const components: Components = useMemo(
        () => ({
            h1: ({ children }) => <h1 className="mt-5 mb-2 text-lg font-semibold text-foreground first:mt-0">{children}</h1>,
            h2: ({ children }) => <h2 className="mt-5 mb-2 text-base font-semibold text-foreground first:mt-0">{children}</h2>,
            h3: ({ children }) => <h3 className="mt-4 mb-1.5 text-sm font-semibold text-foreground first:mt-0">{children}</h3>,
            h4: ({ children }) => <h4 className="mt-3 mb-1 text-sm font-semibold text-foreground first:mt-0">{children}</h4>,
            h5: ({ children }) => <h5 className="mt-3 mb-1 text-sm font-medium text-foreground first:mt-0">{children}</h5>,
            h6: ({ children }) => <h6 className="mt-3 mb-1 text-sm font-medium text-muted-foreground first:mt-0">{children}</h6>,
            p: ({ children }) => <p className="mb-2.5 last:mb-0">{children}</p>,
            ul: ({ children }) => <ul className="mb-2.5 list-disc space-y-1 pl-5">{children}</ul>,
            ol: ({ children }) => <ol className="mb-2.5 list-decimal space-y-1 pl-5">{children}</ol>,
            strong: ({ children }) => <strong className="font-semibold text-foreground">{children}</strong>,
            a: ({ children, href }) => (
                <a href={href} target="_blank" rel="noreferrer" className="underline underline-offset-2">
                    {children}
                </a>
            ),
            blockquote: ({ children }) => (
                <blockquote className="mb-2.5 border-l-2 border-border pl-3 text-muted-foreground">{children}</blockquote>
            ),
            hr: () => <hr className="my-4 border-border" />,
            code: ({ children }) => <code className="rounded-sm bg-muted px-1 py-0.5 text-[0.85em]">{children}</code>,
            pre: ({ children }) => <pre className="mb-2.5 overflow-x-auto rounded-md bg-muted p-3 text-xs">{children}</pre>,
            table: ({ children }) => (
                <div className="mb-3 overflow-x-auto">
                    <table className="w-full border-collapse text-left text-xs">{children}</table>
                </div>
            ),
            th: ({ children }) => <th className="border border-border bg-muted px-2 py-1 align-top font-medium">{children}</th>,
            td: ({ children }) => <td className="border border-border px-2 py-1 align-top">{children}</td>,
            mark: ({ children }) => <mark data-quote-mark="" className={MARK_CLASS}>{children}</mark>,
            div: ({ node, children }) => {
                const page = pageMarkerOf(node);
                if (page === null) return <div>{children}</div>;
                return (
                    <div
                        data-page-marker={page}
                        className="mt-5 mb-2 border-t border-border pt-1 text-[11px] tabular-nums text-muted-foreground"
                    >
                        {tCommon("pageShort", { page })}
                    </div>
                );
            },
        }),
        [tCommon],
    );

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
                    {text.trim() && markdown ? (
                        <div data-slot="markdown-doc" className="break-words text-sm leading-relaxed text-foreground">
                            <ReactMarkdown
                                remarkPlugins={[remarkGfm]}
                                rehypePlugins={[rehypePageMarkers, [rehypeMarkRanges, { ranges }]]}
                                components={components}
                            >
                                {text}
                            </ReactMarkdown>
                        </div>
                    ) : text.trim() ? (
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
