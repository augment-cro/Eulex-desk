import type { StatusKind } from "./statusTokens";

/**
 * Colours and type of generated Word documents (generate_docx), in the eulex.ai
 * paper style and in step with the EULEX template set (contexts-service
 * scripts/templates/kit.ts): ink text instead of pure black, thin warm
 * table borders, a light paper header fill — and the model's status emoji
 * as small pastel dots. Hex, as Word needs it; the status colours follow
 * the paper theme's dots (frontend globals.css --status-*), a step deeper,
 * because a dot glyph on a white page has no edge to hold it.
 */
export const DOCX_PALETTE = {
    /** Text, title and headings — the paper theme's ink (--foreground). */
    ink: "32270D",
    /** Table borders — warm, as in the EULEX templates (≈ --border, a step deeper for print). */
    border: "CFC7B6",
    /** Table header fill — the EULEX templates' label fill (≈ --muted). */
    headerFill: "F3EEE3",
    // Paper mixes (oklab, into #FFFCF5): --destructive 74 %, --warning 50 %,
    // --success 62 %; --action is too light for a glyph on white, so it is
    // mixed 85 % with the ink instead; ⚪ is an --input ring (○).
    status: {
        problem: "E47955",
        gap: "DEA889",
        assessment: "62CCD7",
        insufficient: "978D7D",
        clear: "8EAC70",
    } satisfies Record<StatusKind, string>,
} as const;

/**
 * Type: Georgia — the serif fallback in Max's own font stack (Sentient,
 * Georgia, serif), installed with Windows, macOS and Office, so nothing is
 * embedded. Max's Sentient is NOT used in documents: its licence (ITF Free
 * Font License) forbids making the font available through a SaaS to third
 * parties generating their own content, and fonts embedded in a .docx can
 * be extracted.
 */
export const DOCX_FONT = "Georgia";

/** Sizes in half-points: body 12 pt, title 20 pt, headings 15 / 13 / 12 / 12 pt, tables 10.5 pt. */
export const DOCX_SIZES = {
    body: 24,
    title: 40,
    heading: [30, 26, 24, 24],
    table: 21,
} as const;

/** Line spacing ≈ 1.15 (in 240ths of a line). */
export const DOCX_LINE_SPACING = 276;

/** A status dot's size relative to the text around it. */
export const STATUS_DOT_SCALE = 0.72;
/** Font of the dot glyphs: ● and ○ are in Arial on every platform. */
export const STATUS_DOT_FONT = "Arial";
/** Table cell padding, in twips (as the EULEX templates). */
export const DOCX_CELL_MARGINS = { top: 60, bottom: 60, left: 100, right: 100 } as const;
