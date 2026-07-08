"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ExternalLink, Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { getLegalDocument } from "@/app/lib/mikeApi";
import { highlightDocxQuote } from "./highlightDocxQuote";
import {
    articleNumberOf,
    groupLegalSegments,
    hrWholeRegulationPath,
} from "./legalSourceUtils";
import type { CitationPinpoint, LegalDocument, LegalSource } from "./types";

/**
 * Right-side panel body for a legal source (EU / HR / FR).
 *
 * Two states, both non-blocking (CLAUDE.md §4):
 *   1. Immediately render the passage harvested from the MCP tool output (or
 *      the cited quote) so the user can read straightaway.
 *   2. In the background fetch the FULL document via the `/legal-docs` proxy;
 *      when it lands, render every article and scroll to + highlight the cited
 *      passage. On failure, stay on the snippet with a quiet notice.
 * A button always opens the official source in a new tab.
 */
/**
 * Magenta pinpoint highlight (EULEX highlighter motif, same as the inline
 * citation underline in the prose). Strong = the exact cited stavak/točka;
 * soft = the stavak that CONTAINS the cited točka.
 */
const PIN_STRONG =
    "-mx-1 rounded-sm bg-magenta/35 px-1 ring-1 ring-magenta-600/30";
const PIN_SOFT = "-mx-1 rounded-sm bg-magenta/10 px-1";

/**
 * Typeset one law-text body: split on newlines and style each line by its
 * legal-structure marker — "(N)" stavak gets a semibold marker + spacing,
 * numbered/dashed/lettered točke get an indent, everything else is a plain
 * paragraph. Pure presentation; the text itself is untouched.
 *
 * When `pinpoint` is given (only for the CLICKED article), every cited
 * stavak/točka target is wrapped in magenta: a stavak-only target marks its
 * "(N)" line strongly; a stavak+točka target marks the "(N)" line softly and
 * the matching "a)"/"1." line strongly. A citation may carry SEVERAL targets
 * ("stavak 2. i 9.", "stavak 2. točka a) i stavak 9.") — each is highlighted
 * independently. `pinState` carries the current stavak across the article's
 * multiple body segments. Strong elements carry `data-pinpoint="true"`; the
 * scroll effect jumps to the FIRST one. Conservative: no structural match →
 * no magenta (never a wrong highlight).
 */
function renderLawText(
    text: string,
    keyPrefix: string,
    pinpoint?: CitationPinpoint | null,
    pinState?: { stavak: string | null },
) {
    const state = pinState ?? { stavak: null };
    const targets = pinpoint?.targets ?? [];
    return text
        .split("\n")
        .map((line) => line.trimEnd())
        .filter((line) => line.trim().length > 0)
        .map((line, i) => {
            const stavak = line.match(/^\((\d+[a-z]?)\)\s*/i);
            if (stavak) {
                state.stavak = stavak[1].toLowerCase();
                const id = state.stavak;
                // Strong when this stavak is cited as a whole; soft when
                // only some of its točke are (they get the strong mark).
                const strong = targets.some(
                    (t) => t.stavak === id && !t.tocka,
                );
                const soft =
                    !strong &&
                    targets.some((t) => t.stavak === id && !!t.tocka);
                return (
                    <p
                        key={`${keyPrefix}-${i}`}
                        className={cn(
                            "mb-2 mt-2",
                            strong && PIN_STRONG,
                            soft && PIN_SOFT,
                        )}
                        data-pinpoint={strong || undefined}
                    >
                        <span className="mr-1.5 font-semibold text-foreground/70">
                            ({stavak[1]})
                        </span>
                        {line.slice(stavak[0].length)}
                    </p>
                );
            }
            if (/^(\d+\.|[a-z]\)|[–-])\s/.test(line)) {
                // Točka line. Strong-highlight when some target's točka
                // matches its marker AND we're inside that target's stavak
                // (or the target names no stavak and none has appeared — the
                // single-stavak-article case). Dash alineje can't be cited
                // by id, so they never match.
                const marker = line.match(/^([a-z])\)|^(\d+)\./i);
                const tockaId = (marker?.[1] ?? marker?.[2])?.toLowerCase();
                const strong =
                    !!tockaId &&
                    targets.some(
                        (t) =>
                            t.tocka === tockaId &&
                            (t.stavak
                                ? t.stavak === state.stavak
                                : state.stavak === null),
                    );
                return (
                    <p
                        key={`${keyPrefix}-${i}`}
                        className={cn("mb-1.5 pl-5", strong && PIN_STRONG)}
                        data-pinpoint={strong || undefined}
                    >
                        {line}
                    </p>
                );
            }
            return (
                <p key={`${keyPrefix}-${i}`} className="mb-2">
                    {line}
                </p>
            );
        });
}

export function LegalSourcePanel({
    source,
    quote,
    citedArticleNumbers,
    pinpoint,
    focusNonce,
}: {
    source: LegalSource;
    quote: string;
    citedArticleNumbers?: string[];
    /** Stavak/točka of the clicked reference — magenta pinpoint highlight
     *  inside the (green) cited article. Absent → article-level only. */
    pinpoint?: CitationPinpoint | null;
    /** Bumped per click — re-runs the scroll-to-article even when nothing
     *  else changed (re-clicking the same citation on an open tab). */
    focusNonce?: number;
}) {
    const t = useTranslations("legalSource");
    const bodyRef = useRef<HTMLDivElement>(null);

    // The clicked article's own number — the magenta pinpoint applies ONLY
    // inside this article, never in sibling cited articles.
    const ownNum = articleNumberOf(source.articleLabel);

    const snippet = source.snippet?.trim() || quote.trim();

    // For HR we fetch the WHOLE regulation (via `hr_get_full_document`) even
    // when the click came from a single cited article — then mark every cited
    // article. Rewrite an article-level fetchPath to the whole-law path so the
    // proxy takes the full-document branch.
    const fetchSource = useMemo<LegalSource>(() => {
        if (source.scope !== "@hr") return source;
        const wholePath = hrWholeRegulationPath(source.fetchPath);
        return wholePath && wholePath !== source.fetchPath
            ? { ...source, fetchPath: wholePath }
            : source;
    }, [source]);

    // Article numbers to mark: every cited article for this regulation, plus
    // the clicked source's own article. Lowercased to match `articleNumberOf`.
    const citedNumbers = useMemo(() => {
        const set = new Set<string>(
            (citedArticleNumbers ?? []).map((n) => n.toLowerCase()),
        );
        const own = articleNumberOf(source.articleLabel);
        if (own) set.add(own);
        return set;
    }, [citedArticleNumbers, source.articleLabel]);

    const [fullDoc, setFullDoc] = useState<LegalDocument | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(false);

    // Fold the flat segment list into hierarchical render blocks (article cards
    // + structural headings) for readable display.
    const blocks = useMemo(
        () => (fullDoc ? groupLegalSegments(fullDoc.articles) : []),
        [fullDoc],
    );

    // Header subtitle under the bold law title. For the whole law prefer the
    // full list of NN gazette references (all versions); else a citation with
    // the per-article "čl. N" stripped (we're showing the WHOLE law now).
    const lawCitation = useMemo(() => {
        const strip = (c: string | null | undefined) =>
            (c ?? "")
                .replace(/,?\s*čl\.?\s*\d+[a-z]?\.?/gi, "")
                .replace(/\s{2,}/g, " ")
                .replace(/^[\s,]+|[\s,]+$/g, "")
                .trim();
        if (fullDoc?.gazetteRefs && fullDoc.gazetteRefs.length > 0) {
            return fullDoc.gazetteRefs.join(" · ");
        }
        let c = strip(fullDoc?.citation ?? source.citation);
        // Drop a leading duplicate of the title ("Obiteljski zakon, NN …" → "NN …").
        const title = (fullDoc?.title || source.title)?.trim();
        if (title && c.startsWith(title)) {
            c = c.slice(title.length).replace(/^[\s,]+/, "").trim();
        }
        return c;
    }, [fullDoc, source.citation, source.title]);

    // Background fetch of the full document.
    useEffect(() => {
        let cancelled = false;
        setFullDoc(null);
        setError(false);
        if (!fetchSource.fetchPath) return;
        setLoading(true);
        getLegalDocument(fetchSource)
            .then((doc) => {
                if (cancelled) return;
                if (doc && doc.articles.length > 0) setFullDoc(doc);
            })
            .catch(() => {
                if (!cancelled) setError(true);
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [fetchSource]);

    // Locate the cited passage once content (snippet or full doc) is in the
    // DOM. Priority:
    //   1. Highlight the MCP passage (source.snippet) — it's in the SAME
    //      language as the document, so it matches even when the model's
    //      quote was translated (e.g. EU docs are English-only but the
    //      answer/quote is Croatian).
    //   2. Otherwise highlight the model's quote.
    //   3. If neither text-matches, scroll to the cited article by number
    //      (language-independent — e.g. jump to "Article 5" of the GDPR).
    useEffect(() => {
        const root = bodyRef.current;
        if (!root) return;

        // 0. A magenta stavak/točka pinpoint beats everything — land the
        //    user on the exact cited line, centered.
        if (pinpoint) {
            const pinEl = root.querySelector("[data-pinpoint='true']");
            if (pinEl) {
                pinEl.scrollIntoView({ block: "center", behavior: "auto" });
                return;
            }
        }

        // 1. Otherwise scroll to the CLICKED article by its number —
        //    that's what the user expects (click "čl. 75" → land on Article 75
        //    in the full law), language-independent and exact.
        if (ownNum) {
            const el = root.querySelector(`[data-article-number="${ownNum}"]`);
            if (el) {
                el.scrollIntoView({ block: "start", behavior: "auto" });
                return;
            }
        }

        // 2. Otherwise highlight the cited passage text (snippet matches the
        //    document language even when the model's quote was translated).
        const candidates = [source.snippet, quote].filter(
            (c): c is string => !!c && c.trim().length > 0,
        );
        for (const c of candidates) {
            const node = highlightDocxQuote(root, c);
            if (node) {
                node.scrollIntoView({ block: "center", behavior: "auto" });
                return;
            }
        }

        // 3. Last resort: the first cited (marked) article.
        root.querySelector("[data-article-cited='true']")?.scrollIntoView({
            block: "start",
            behavior: "auto",
        });
    }, [quote, fullDoc, source, focusNonce, pinpoint, ownNum]);

    const badgeLabel =
        source.scope === "@eu"
            ? t("badge.eu")
            : source.scope === "@hr"
              ? t("badge.hr")
              : t("badge.fr");

    const externalLabel =
        source.scope === "@eu"
            ? t("viewOnEurLex")
            : source.scope === "@hr"
              ? t("viewOnNarodneNovine")
              : t("viewOnLegifrance");

    return (
        <div className="flex h-full flex-col bg-card">
            {/* Header */}
            <div className="border-b border-border px-4 pb-3 pt-3">
                <div className="mb-1.5 flex items-center gap-2">
                    <Badge
                        variant="secondary"
                        className={cn(
                            "uppercase tracking-wide",
                            source.scope === "@eu" &&
                                "bg-accent text-foreground",
                        )}
                    >
                        {badgeLabel}
                    </Badge>
                    {typeof source.inForce === "boolean" && (
                        <Badge
                            variant="outline"
                            className={cn(
                                source.inForce
                                    ? "text-success"
                                    : "text-muted-foreground",
                            )}
                        >
                            {source.inForce ? t("inForce") : t("notInForce")}
                        </Badge>
                    )}
                    {loading && (
                        <span className="ml-auto inline-flex items-center gap-1 text-[11px] text-muted-foreground">
                            <Loader2 className="h-3 w-3 animate-spin" />
                            {t("loadingFullText")}
                        </span>
                    )}
                </div>
                <h2 className="text-[15px] font-semibold leading-snug text-foreground">
                    {fullDoc?.title || source.title}
                </h2>
                {lawCitation && lawCitation !== (fullDoc?.title || source.title) && (
                    <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                        {lawCitation}
                    </p>
                )}
            </div>

            {/* Body — full document when available, else the cited passage. */}
            <ScrollArea className="min-h-0 flex-1">
              <div className="px-4 py-3">
                {fullDoc ? (
                    <div
                        ref={bodyRef}
                        className="legal-source-body font-serif text-[1.0625rem] leading-8 text-foreground"
                    >
                        {blocks.map((b) => {
                            if (b.kind === "heading") {
                                return (
                                    <p
                                        key={b.id}
                                        className="mb-2 mt-7 text-sm font-semibold tracking-wide text-foreground/70 first:mt-0"
                                    >
                                        {b.text}
                                    </p>
                                );
                            }
                            const num = b.number?.toLowerCase();
                            const cited = num ? citedNumbers.has(num) : false;
                            const dimmed = !cited && citedNumbers.size > 0;
                            // Magenta pinpoint only inside the CLICKED article.
                            const pin =
                                pinpoint && num && num === ownNum
                                    ? pinpoint
                                    : undefined;
                            // Carries the current stavak across this article's
                            // body segments (one object per article render).
                            const pinState = { stavak: null as string | null };
                            if (b.kind === "body") {
                                return (
                                    <div
                                        key={b.id}
                                        className={cn(
                                            "mb-3",
                                            dimmed && "text-muted-foreground",
                                        )}
                                        data-article-number={b.number ?? undefined}
                                        data-article-cited={cited || undefined}
                                    >
                                        {renderLawText(b.text, b.id, pin, pinState)}
                                    </div>
                                );
                            }
                            // article card
                            return (
                                <div
                                    key={b.id}
                                    className={cn(
                                        "mb-6 transition-colors",
                                        cited &&
                                            "-mx-1 rounded-lg border-l-4 border-brand bg-brand/10 py-3 pl-4 pr-3 ring-1 ring-brand/30",
                                        dimmed && "text-muted-foreground",
                                    )}
                                    data-article-number={b.number ?? undefined}
                                    data-article-cited={cited || undefined}
                                >
                                    {b.heading && (
                                        <div className="mb-1.5 flex items-center gap-2">
                                            <h3 className="text-base font-semibold text-foreground">
                                                {b.heading}
                                            </h3>
                                            {cited && (
                                                <Badge
                                                    variant="secondary"
                                                    className="bg-brand text-[10px] uppercase tracking-wide text-foreground"
                                                >
                                                    {t("cited")}
                                                </Badge>
                                            )}
                                        </div>
                                    )}
                                    {b.subtitle && (
                                        <p className="mb-2 text-[0.95rem] font-medium text-muted-foreground">
                                            {b.subtitle}
                                        </p>
                                    )}
                                    {b.bodies.map((body) => (
                                        <div
                                            key={body.id}
                                            className="last:[&>p:last-child]:mb-0"
                                        >
                                            {renderLawText(
                                                body.text,
                                                body.id,
                                                pin,
                                                pinState,
                                            )}
                                        </div>
                                    ))}
                                </div>
                            );
                        })}
                    </div>
                ) : loading ? (
                    // Loading the full law — show progress, never "no text".
                    <div className="flex flex-col items-center justify-center gap-2 py-16 text-muted-foreground">
                        <Loader2 className="h-5 w-5 animate-spin text-foreground" />
                        <p className="text-sm">{t("loadingLaw")}</p>
                    </div>
                ) : (
                    <>
                        <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                            {t("citedPassage")}
                        </p>
                        {snippet ? (
                            <div
                                ref={bodyRef}
                                className="legal-source-body whitespace-pre-wrap font-serif text-sm leading-relaxed text-foreground"
                            >
                                {snippet}
                            </div>
                        ) : (
                            <p className="text-sm italic text-muted-foreground">
                                {t("noText")}
                            </p>
                        )}
                        {error && (
                            <p className="mt-3 text-xs text-muted-foreground">
                                {t("fullTextError")}
                            </p>
                        )}
                    </>
                )}
              </div>
            </ScrollArea>

            {/* Footer — open the official source. */}
            {source.externalUrl && (
                <div className="border-t border-border px-4 py-3">
                    <Button
                        asChild
                        variant="outline"
                        size="sm"
                        className="w-full"
                    >
                        <a
                            href={source.externalUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                        >
                            <ExternalLink className="h-3.5 w-3.5" />
                            {externalLabel}
                        </a>
                    </Button>
                </div>
            )}
        </div>
    );
}
