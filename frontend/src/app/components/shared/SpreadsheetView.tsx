"use client";

// Ported from open-legal-products/mike 9014da5355de40b92eeedaa6e8c0b384d89243e0
// frontend/src/app/components/shared/views/SpreadsheetView.tsx
//
// Adapted for Max:
//   - takes the .xlsx bytes `DocView` already fetched from /display (no
//     second fetch; `useFetchSingleDoc` owns the request);
//   - highlight targets come from `CitationQuote` (sheet + cell), with a
//     best-effort quote-text search when a citation carries no cell;
//   - i18n copy, design tokens (`--spreadsheet-*` in globals.css, resolved
//     for canvas painting and re-resolved when `data-theme` changes);
//   - A1 parsing lives in `@/app/lib/spreadsheetAddress`;
//   - a parse watchdog, because Luckyexcel never calls back on bad bytes.
//
// DocView loads this module through `next/dynamic` (ssr: false), so
// Fortune-sheet, Luckyexcel and their CSS are only fetched when a
// spreadsheet actually opens.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import LuckyExcel, { type LuckyExcelSheet } from "luckyexcel";
import type { WorkbookInstance } from "@fortune-sheet/react";
import type { Cell, Sheet } from "@fortune-sheet/core";
import "@fortune-sheet/react/dist/index.css";
import { MikeIcon } from "@/components/chat/mike-icon";
import { cn } from "@/lib/utils";
import { normalizeSpreadsheetImages } from "@/app/lib/spreadsheetImages";
import { parseA1Range, type CellRange } from "@/app/lib/spreadsheetAddress";
import type { CitationQuote } from "./types";
import {
    SpreadsheetWorkbook,
    type SpreadsheetSession,
} from "./SpreadsheetWorkbook";

type WorkbookComponent = typeof import("@fortune-sheet/react").Workbook;

interface Props {
    /** .xlsx bytes from /display (xls/csv are converted server-side). */
    buffer: ArrayBuffer;
    /** Citation targets; the first one with a sheet/cell (or quote) wins. */
    quotes?: CitationQuote[];
    rounded?: boolean;
    bordered?: boolean;
    /**
     * False while the owning tab is hidden. Fortune-sheet registers
     * document-wide input handlers, so only the active workbook is mounted;
     * the viewport is saved and restored across re-activation.
     */
    active?: boolean;
}

/** Luckyexcel never reports a failed parse; give up after this long. */
const PARSE_TIMEOUT_MS = 60_000;

/** Zip local-file-header signature "PK\x03\x04" — every .xlsx starts with it. */
function isZip(buffer: ArrayBuffer): boolean {
    const b = new Uint8Array(buffer, 0, Math.min(4, buffer.byteLength));
    return (
        b.length === 4 &&
        b[0] === 0x50 &&
        b[1] === 0x4b &&
        b[2] === 0x03 &&
        b[3] === 0x04
    );
}

/** Resolved highlight: which sheet to activate and which cells to paint. */
type HighlightTarget = { sheetIndex: number | null; range: CellRange | null };

type MergeInfo = { r: number; c: number; rs: number; cs: number };
type CellData = { r: number; c: number; v: Record<string, unknown> };

/**
 * Expand a highlight range to cover any merged ranges it intersects. Fortune-
 * sheet paints a merge as one block anchored at its top-left cell and never
 * paints the covered cells, so a citation to a covered cell (e.g. B1 inside
 * A1:C1) would otherwise highlight nothing. The model is asked to cite the full
 * merged range, but this is a deterministic fallback for when it cites a covered
 * cell anyway. Expanding to the anchor makes `afterRenderCell` paint the block.
 */
function expandRangeForMerges(sheet: Sheet, range: CellRange): CellRange {
    const merges = (sheet.config as { merge?: Record<string, MergeInfo> })
        ?.merge;
    if (!merges) return range;
    let [r0, r1] = range.row;
    let [c0, c1] = range.column;
    for (const m of Object.values(merges)) {
        const mr1 = m.r + m.rs - 1;
        const mc1 = m.c + m.cs - 1;
        if (r0 <= mr1 && r1 >= m.r && c0 <= mc1 && c1 >= m.c) {
            r0 = Math.min(r0, m.r);
            r1 = Math.max(r1, mr1);
            c0 = Math.min(c0, m.c);
            c1 = Math.max(c1, mc1);
        }
    }
    return { row: [r0, r1], column: [c0, c1] };
}

/**
 * Pixel offset (from the grid origin) and size of a row/col span, derived from
 * the sheet's column widths / row heights. Fortune-sheet defaults are 73px wide
 * and 19px tall; per-index overrides live in `config.columnlen`/`config.rowlen`.
 * Hidden rows/cols aren't accounted for, so this is best-effort (enough to
 * decide whether the cell is on screen and where to center it).
 */
function rangePixelRect(
    sheet: Sheet,
    range: CellRange,
): { x: number; y: number; w: number; h: number } {
    const cfg = (sheet.config ?? {}) as {
        columnlen?: Record<string, number>;
        rowlen?: Record<string, number>;
    };
    const colLen = cfg.columnlen ?? {};
    const rowLen = cfg.rowlen ?? {};
    const colW = (c: number) => colLen[c] ?? sheet.defaultColWidth ?? 73;
    const rowH = (r: number) => rowLen[r] ?? sheet.defaultRowHeight ?? 19;

    let x = 0;
    for (let c = 0; c < range.column[0]; c++) x += colW(c);
    let w = 0;
    for (let c = range.column[0]; c <= range.column[1]; c++) w += colW(c);
    let y = 0;
    for (let r = 0; r < range.row[0]; r++) y += rowH(r);
    let h = 0;
    for (let r = range.row[0]; r <= range.row[1]; r++) h += rowH(r);
    return { x, y, w, h };
}

/**
 * Expand `config.merge` onto the cells. Luckyexcel records merges in
 * `config.merge` but Fortune-sheet only renders a merge when the cells carry
 * `mc` (the anchor gets `{r,c,rs,cs}`; every covered cell points back with
 * `{r,c}`). Without this, merged ranges render as separate single cells.
 */
function applyMergeCells(sheets: LuckyExcelSheet[]): void {
    for (const sheet of sheets) {
        const merges = (sheet.config as { merge?: Record<string, MergeInfo> })
            ?.merge;
        if (!merges) continue;

        if (!Array.isArray(sheet.celldata)) sheet.celldata = [];
        const celldata = sheet.celldata as CellData[];

        const byKey = new Map<string, CellData>();
        for (const entry of celldata) {
            if (typeof entry?.r === "number" && typeof entry?.c === "number") {
                byKey.set(`${entry.r}_${entry.c}`, entry);
            }
        }
        const ensureCell = (r: number, c: number): CellData => {
            const key = `${r}_${c}`;
            let entry = byKey.get(key);
            if (!entry) {
                entry = { r, c, v: {} };
                celldata.push(entry);
                byKey.set(key, entry);
            }
            if (!entry.v || typeof entry.v !== "object") entry.v = {};
            return entry;
        };

        for (const mc of Object.values(merges)) {
            ensureCell(mc.r, mc.c).v.mc = {
                r: mc.r,
                c: mc.c,
                rs: mc.rs,
                cs: mc.cs,
            };
            for (let rr = mc.r; rr < mc.r + mc.rs; rr++) {
                for (let cc = mc.c; cc < mc.c + mc.cs; cc++) {
                    if (rr === mc.r && cc === mc.c) continue;
                    ensureCell(rr, cc).v.mc = { r: mc.r, c: mc.c };
                }
            }
        }
    }
}

/**
 * Make text cells overflow into empty adjacent cells, mirroring Excel's default.
 * Fortune-sheet only spills a cell's text when its `tb` (text-break) is "1";
 * Luckyexcel leaves text cells clipping, so we set `tb: "1"` on unwrapped,
 * non-merged text cells. Fortune-sheet still only paints the overflow over
 * genuinely empty neighbors, so this matches Excel (numbers/dates keep the
 * default and are not spilled).
 */
function applyExcelTextOverflow(sheets: LuckyExcelSheet[]): void {
    for (const sheet of sheets) {
        const celldata = sheet.celldata;
        if (!Array.isArray(celldata)) continue;
        for (const entry of celldata) {
            const cell = (entry as { v?: Record<string, unknown> } | null)?.v;
            if (!cell || typeof cell !== "object") continue;
            if (cell.mc) continue; // part of a merge - leave as-is
            // Explicit wrap-text - keep. Luckyexcel emits the number 2.
            if (String(cell.tb) === "2") continue;
            if (typeof cell.v === "string" && cell.v.length > 0) {
                cell.tb = "1"; // text: overflow into empty neighbors
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Theme colours for canvas painting
// ---------------------------------------------------------------------------

/**
 * Canvas cannot resolve `var()` / `color-mix()` token definitions, so each
 * `--spreadsheet-*` token is resolved once through a probe element (the
 * computed `color` is a concrete colour) and cached until the theme changes.
 */
const themeColorCache = new Map<string, string | null>();

function themeColor(property: string): string | null {
    const cached = themeColorCache.get(property);
    if (cached !== undefined) return cached;
    if (typeof document === "undefined") return null;
    const probe = document.createElement("span");
    probe.style.display = "none";
    probe.style.color = `var(${property})`;
    document.body.appendChild(probe);
    const value = getComputedStyle(probe).color || null;
    probe.remove();
    themeColorCache.set(property, value);
    return value;
}

/**
 * Tint a row/column header cell via Fortune-sheet's own header render
 * hooks. Fortune-sheet paints the header labels (A/B/C, 1/2/3) onto the grid
 * canvas with a white fill and dark text; we lay a translucent ink over that
 * cell in the `afterRender…HeaderCell` pass. A low alpha darkens the white
 * background while leaving the dark labels legible — unlike an opaque CSS
 * background on the header overlay divs, which sits in front of the canvas
 * and hides the labels entirely.
 */
function tintHeaderCell(
    x: number,
    y: number,
    width: number,
    height: number,
    ctx: CanvasRenderingContext2D,
): void {
    const tint = themeColor("--spreadsheet-header-tint");
    if (!tint) return;
    ctx.save();
    ctx.fillStyle = tint;
    ctx.fillRect(x, y, width, height);
    ctx.restore();
}

// ---------------------------------------------------------------------------
// Citation target resolution
// ---------------------------------------------------------------------------

/** Display text of a Luckyexcel cell value (formatted, then rich, then raw). */
function cellDisplayText(v: Record<string, unknown> | null | undefined): string {
    if (!v || typeof v !== "object") return "";
    if (typeof v.m === "string" || typeof v.m === "number") return String(v.m);
    const rich = (v.ct as { s?: unknown } | undefined)?.s;
    if (Array.isArray(rich)) {
        return rich
            .map((seg) =>
                typeof (seg as { v?: unknown })?.v === "string"
                    ? (seg as { v: string }).v
                    : "",
            )
            .join("");
    }
    if (typeof v.v === "string" || typeof v.v === "number") return String(v.v);
    return "";
}

function normalizeForMatch(text: string): string {
    return text.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Numeric value of a plain number, with or without en-US thousands
 * separators ("1,250,000.00" → 1250000). Luckyexcel keeps the raw value
 * ("1250000") while quotes carry the formatted one, so numbers are
 * compared by value. NaN for anything else.
 */
function numericValue(text: string): number {
    const t = text.replace(/\s/g, "");
    return /^-?\d{1,3}(,\d{3})*(\.\d+)?$|^-?\d+(\.\d+)?$/.test(t)
        ? Number(t.replace(/,/g, ""))
        : Number.NaN;
}

/**
 * Best-effort fallback for a citation without a cell address: the first
 * cell (preferred sheet first) whose text contains the quote. A quote copied
 * from the markdown table ("Alfa d.o.o. | 14.05.2023.") is retried by its
 * longest `|`-separated segment.
 */
function findQuoteCell(
    sheets: Sheet[],
    preferredSheet: number | null,
    quote: string,
): { sheetIndex: number; range: CellRange } | null {
    const needles = [normalizeForMatch(quote)];
    const segments = quote
        .split("|")
        .map((s) => normalizeForMatch(s))
        .filter((s) => s.length >= 3)
        .sort((a, b) => b.length - a.length);
    if (segments.length > 1) needles.push(segments[0]);

    const order = sheets.map((_, i) => i);
    if (preferredSheet !== null) {
        order.splice(order.indexOf(preferredSheet), 1);
        order.unshift(preferredSheet);
    }
    for (const needle of needles) {
        if (!needle) continue;
        const needleNumber = numericValue(needle);
        for (const sheetIndex of order) {
            const celldata = sheets[sheetIndex]?.celldata as
                | CellData[]
                | undefined;
            if (!Array.isArray(celldata)) continue;
            for (const entry of celldata) {
                if (typeof entry?.r !== "number" || typeof entry?.c !== "number")
                    continue;
                const text = normalizeForMatch(cellDisplayText(entry.v));
                const matches =
                    !!text &&
                    (text.includes(needle) ||
                        (Number.isFinite(needleNumber) &&
                            numericValue(text) === needleNumber));
                if (matches) {
                    return {
                        sheetIndex,
                        range: {
                            row: [entry.r, entry.r],
                            column: [entry.c, entry.c],
                        },
                    };
                }
            }
        }
    }
    return null;
}

function findSheetIndex(sheets: Sheet[], name: string): number | null {
    const exact = sheets.findIndex((s) => s.name === name);
    if (exact >= 0) return exact;
    const wanted = name.trim().toLowerCase();
    const loose = sheets.findIndex(
        (s) => (s.name ?? "").trim().toLowerCase() === wanted,
    );
    return loose >= 0 ? loose : null;
}

/** The citation entry that drives the highlight: the first sheet/cell one, else the first quote. */
function primaryTarget(
    quotes: CitationQuote[] | undefined,
): CitationQuote | undefined {
    return (
        quotes?.find((q) => q.sheet || q.cell) ??
        quotes?.find((q) => q.quote.trim())
    );
}

function resolveHighlight(
    sheets: Sheet[],
    sheet: string | null,
    cell: string | null,
    quote: string,
): HighlightTarget | null {
    const sheetIndex = sheet ? findSheetIndex(sheets, sheet) : null;
    const parsed = cell ? parseA1Range(cell) : null;
    if (parsed) {
        const idx = sheetIndex ?? 0;
        return {
            sheetIndex: idx,
            range: sheets[idx]
                ? expandRangeForMerges(sheets[idx], parsed)
                : parsed,
        };
    }
    // No (valid) cell address — look the quote up in the cells.
    const found = quote.trim()
        ? findQuoteCell(sheets, sheetIndex, quote)
        : null;
    if (found) {
        return {
            sheetIndex: found.sheetIndex,
            range: expandRangeForMerges(sheets[found.sheetIndex], found.range),
        };
    }
    return sheetIndex !== null ? { sheetIndex, range: null } : null;
}

/**
 * Renders an Excel workbook as a read-only grid using Fortune-sheet. The
 * .xlsx bytes (from /display, via DocView) are converted to Fortune-sheet
 * data with Luckyexcel, preserving the original styling (fills, fonts,
 * borders, merges, widths, images).
 *
 * Spreadsheet citations are highlighted by cell: the cited sheet tab is
 * activated and the A1 address/range scrolled into view, where a canvas
 * hook paints the highlight.
 */
export function SpreadsheetView({
    buffer,
    quotes,
    rounded = true,
    bordered = true,
    active = true,
}: Props) {
    const t = useTranslations("docPanel");
    const workbookRef = useRef<WorkbookInstance>(null);
    const [session, setSession] = useState<SpreadsheetSession | null>(null);
    // The frame element, used to reach Fortune-sheet's scrollbars for measuring
    // the current scroll offset and viewport size when deciding whether to scroll.
    const containerRef = useRef<HTMLDivElement>(null);
    // Current highlight, read by the render hook. A ref (not state) so updating
    // it never re-mounts the Workbook or changes the settings object.
    const highlightRef = useRef<CellRange | null>(null);
    const [sheets, setSheets] = useState<Sheet[] | null>(null);
    const [workbookGeneration, setWorkbookGeneration] = useState(0);
    const [WorkbookComponent, setWorkbookComponent] =
        useState<WorkbookComponent | null>(null);
    const [parseFailed, setParseFailed] = useState(false);

    // Fortune-sheet touches browser-only APIs while loading, so keep the import
    // inside the client component even though this file also owns the view.
    useEffect(() => {
        let cancelled = false;
        import("@fortune-sheet/react").then((mod) => {
            if (!cancelled) setWorkbookComponent(() => mod.Workbook);
        });
        return () => {
            cancelled = true;
        };
    }, []);

    // Primitive deps so the highlight only re-resolves when the target
    // changes, not whenever a caller rebuilds its `quotes` array.
    const primary = primaryTarget(quotes);
    const targetSheet = primary?.sheet ?? null;
    const targetCell = primary?.cell ?? null;
    const targetQuote = primary?.quote ?? "";
    const target = useMemo(
        () =>
            sheets
                ? resolveHighlight(sheets, targetSheet, targetCell, targetQuote)
                : null,
        [sheets, targetSheet, targetCell, targetQuote],
    );

    // Parse the workbook with Luckyexcel, which converts the .xlsx to
    // Fortune-sheet data while preserving styling (fills, fonts, borders,
    // alignment, column widths).
    useEffect(() => {
        let cancelled = false;
        let settled = false;
        setSheets(null);
        setParseFailed(false);

        const fail = () => {
            if (cancelled || settled) return;
            settled = true;
            setParseFailed(true);
        };
        // .xlsx is a zip; anything else (e.g. unconverted .xls bytes) would
        // only ever hit the watchdog, so fail fast.
        if (!isZip(buffer)) {
            fail();
            return () => {
                cancelled = true;
            };
        }
        const watchdog = window.setTimeout(fail, PARSE_TIMEOUT_MS);

        try {
            const file = new File([buffer], "spreadsheet.xlsx");
            LuckyExcel.transformExcelToLucky(file, (exportJson) => {
                if (cancelled || settled) return;
                settled = true;
                window.clearTimeout(watchdog);
                if (exportJson?.sheets?.length) {
                    applyMergeCells(exportJson.sheets);
                    applyExcelTextOverflow(exportJson.sheets);
                    for (const sheet of exportJson.sheets) {
                        sheet.images = normalizeSpreadsheetImages(sheet.images);
                    }
                    setSheets(exportJson.sheets as unknown as Sheet[]);
                    setWorkbookGeneration((generation) => generation + 1);
                } else {
                    setParseFailed(true);
                }
            });
        } catch {
            window.clearTimeout(watchdog);
            fail();
        }

        return () => {
            cancelled = true;
            window.clearTimeout(watchdog);
        };
    }, [buffer]);

    // Draw the citation highlight on the canvas. Stable identity so the Workbook
    // settings never change; it reads the live target from `highlightRef`. We use
    // this instead of `setSelection`, whose in-place mutation of the range object
    // crashes under React Strict Mode's double-invoked immer producer.
    const afterRenderCell = useCallback(
        (
            _cell: Cell | null,
            info: {
                row: number;
                column: number;
                startX: number;
                startY: number;
                endX: number;
                endY: number;
            },
            ctx: CanvasRenderingContext2D,
        ) => {
            const range = highlightRef.current;
            if (!range) return;
            if (
                info.row < range.row[0] ||
                info.row > range.row[1] ||
                info.column < range.column[0] ||
                info.column > range.column[1]
            ) {
                return;
            }
            const w = info.endX - info.startX;
            const h = info.endY - info.startY;
            const fill = themeColor("--spreadsheet-highlight-background");
            const outline = themeColor("--spreadsheet-highlight-outline");
            if (!fill || !outline) return;
            ctx.save();
            ctx.fillStyle = fill;
            ctx.fillRect(info.startX, info.startY, w, h);
            ctx.strokeStyle = outline;
            ctx.lineWidth = 2;
            ctx.strokeRect(info.startX + 1, info.startY + 1, w - 2, h - 2);
            ctx.restore();
        },
        [],
    );
    const hooks = useMemo(
        () => ({
            afterRenderCell,
            // Tint the header strips while keeping the A/B/C, 1/2/3 labels
            // visible (see tintHeaderCell). Column cells fill from y=0; row
            // cells fill from x=0 — matching Fortune-sheet's own header rects.
            afterRenderColumnHeaderCell: (
                _char: string,
                _idx: number,
                left: number,
                width: number,
                height: number,
                ctx: CanvasRenderingContext2D,
            ) => tintHeaderCell(left, 0, width, height, ctx),
            afterRenderRowHeaderCell: (
                _num: string,
                _idx: number,
                top: number,
                width: number,
                height: number,
                ctx: CanvasRenderingContext2D,
            ) => tintHeaderCell(0, top, width, height, ctx),
        }),
        [afterRenderCell],
    );

    // Fortune-sheet paints its grid on canvas, so a theme switch (next-themes
    // sets `data-theme` on <html>) needs the cached colours dropped and an
    // explicit repaint.
    useEffect(() => {
        const repaint = () => {
            themeColorCache.clear();
            window.dispatchEvent(new Event("resize"));
        };
        const observer = new MutationObserver(repaint);
        observer.observe(document.documentElement, {
            attributes: true,
            attributeFilter: ["data-theme", "class"],
        });
        return () => observer.disconnect();
    }, []);

    // Activate the cited sheet, bring the cell into view, and repaint the
    // highlight. We only scroll when the cell is off screen (centering it);
    // when it's already visible we leave the viewport put and force a redraw so
    // the `afterRenderCell` hook repaints the new highlight (and clears the old
    // one). Both paths must trigger a redraw: `scroll()` repaints because the
    // position changes, and the synthetic "resize" repaints in place via
    // Fortune-sheet's window resize handler.
    useEffect(() => {
        if (!active || !sheets) return;
        const range = target?.range ?? null;
        const sheetIndex = target?.sheetIndex ?? null;
        highlightRef.current = range;
        if (!range && sheetIndex === null) return;

        const timer = window.setTimeout(() => {
            const inst = workbookRef.current;
            if (!inst) return;
            try {
                const index = sheetIndex ?? 0;
                inst.activateSheet({ index });
                if (!range) return;

                const container = containerRef.current;
                const sbX = container?.querySelector<HTMLElement>(
                    ".luckysheet-scrollbar-x",
                );
                const sbY = container?.querySelector<HTMLElement>(
                    ".luckysheet-scrollbar-y",
                );

                // Without the scrollbars we can't measure the viewport; fall back to
                // corner-scrolling, which at least brings the cell in and repaints.
                if (!sbX || !sbY) {
                    inst.scroll({
                        targetRow: range.row[0],
                        targetColumn: range.column[0],
                    });
                    return;
                }

                const rect = rangePixelRect(sheets[index], range);
                const curLeft = sbX.scrollLeft;
                const curTop = sbY.scrollTop;
                const viewW = sbX.clientWidth;
                const viewH = sbY.clientHeight;
                const visible =
                    rect.x >= curLeft &&
                    rect.x + rect.w <= curLeft + viewW &&
                    rect.y >= curTop &&
                    rect.y + rect.h <= curTop + viewH;

                if (visible) {
                    // On screen: keep the viewport still, just repaint the highlight.
                    window.dispatchEvent(new Event("resize"));
                } else {
                    // Off screen: center the cell. scroll() re-renders and repaints.
                    inst.scroll({
                        scrollLeft: Math.max(
                            0,
                            Math.round(rect.x - (viewW - rect.w) / 2),
                        ),
                        scrollTop: Math.max(
                            0,
                            Math.round(rect.y - (viewH - rect.h) / 2),
                        ),
                    });
                }
            } catch {
                /* highlighting is best-effort */
            }
        }, 200);
        return () => window.clearTimeout(timer);
    }, [active, sheets, target]);

    const frameClass = cn(
        "fortune-sheet-viewer relative flex min-h-0 flex-1 flex-col overflow-hidden",
        bordered && "border border-border",
        rounded && "rounded-xl",
    );

    if (parseFailed) {
        return (
            <div className={frameClass}>
                <div className="flex h-full items-center justify-center bg-muted px-6 text-center">
                    <p className="text-sm text-destructive">
                        {t("spreadsheetError")}
                    </p>
                </div>
            </div>
        );
    }

    if (!sheets || !WorkbookComponent) {
        return (
            <div className={frameClass}>
                <div className="flex h-full items-center justify-center bg-muted">
                    <MikeIcon spin mike size={28} />
                </div>
            </div>
        );
    }

    return (
        <div ref={containerRef} className={frameClass}>
            <div className="relative flex min-h-0 flex-1 flex-col">
                {active && (
                    <SpreadsheetWorkbook
                        key={workbookGeneration}
                        Workbook={WorkbookComponent}
                        workbookRef={workbookRef}
                        initialSession={session}
                        onSessionSave={setSession}
                        sheets={sheets}
                        hooks={hooks}
                    />
                )}
            </div>
        </div>
    );
}

export default SpreadsheetView;
