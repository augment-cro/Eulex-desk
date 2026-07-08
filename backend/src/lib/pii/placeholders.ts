/**
 * PII Shield — placeholder sentinel format + utilities.
 *
 * Format: ⟦PII:ENTITY_TYPE_N⟧
 *   - U+27E6 / U+27E7 (mathematical white square brackets) chosen to avoid
 *     collision with Mustache/Handlebars `{{...}}` syntax that legal
 *     templates frequently contain (see plan §11 Gap #12 / R5).
 *   - The literal `PII:` prefix guards against bare `⟦` occurrences in
 *     mathematical text accidentally triggering de-anonymization.
 *
 * Examples:
 *   ⟦PII:PERSON_1⟧
 *   ⟦PII:HR_OIB_2⟧
 *   ⟦PII:EMAIL_ADDRESS_3⟧
 *
 * This module is the single source of truth for the placeholder grammar
 * across the backend. The sidecar (Python) mirrors these constants in
 * `mike-pii-shield/app/placeholders.py`. The frontend mirrors them in
 * `frontend/src/app/lib/piiPlaceholders.ts`. Keep all three in sync.
 */

export const PII_OPEN = "\u27E6"; // ⟦
export const PII_CLOSE = "\u27E7"; // ⟧
export const PII_PREFIX = "PII:";
export const PII_SENTINEL_OPEN = `${PII_OPEN}${PII_PREFIX}`; // ⟦PII:

/**
 * Regex that matches a complete placeholder.
 *
 * Capture group #1 is the inner identifier (e.g. `PERSON_1`, `HR_OIB_2`).
 *
 * Identifier grammar: `[A-Z][A-Z0-9_]*_\d+`
 *   - Uppercase + underscore + final `_<digit>+` counter.
 *   - Counter is monotonic per (session, entity_type) — enforced at DB
 *     level by `UNIQUE(session_id, entity_type, counter)` on pii_mappings.
 */
export const PII_PLACEHOLDER_RE = /\u27E6PII:([A-Z][A-Z0-9_]*_\d+)\u27E7/g;

/**
 * Same as PII_PLACEHOLDER_RE but with a single (non-global) match.
 * Useful for `String.prototype.match` style lookups.
 */
export const PII_PLACEHOLDER_SINGLE_RE = /\u27E6PII:([A-Z][A-Z0-9_]*_\d+)\u27E7/;

/**
 * Build a placeholder from (entity_type, counter).
 *
 * @example
 *   buildPlaceholder("PERSON", 1) // "⟦PII:PERSON_1⟧"
 *   buildPlaceholder("HR_OIB", 7) // "⟦PII:HR_OIB_7⟧"
 */
export function buildPlaceholder(entityType: string, counter: number): string {
    return `${PII_OPEN}${PII_PREFIX}${entityType}_${counter}${PII_CLOSE}`;
}

/**
 * Parse a placeholder back into (entity_type, counter) or null when the
 * input is not a valid placeholder.
 */
export function parsePlaceholder(
    placeholder: string,
): { entityType: string; counter: number } | null {
    const m = placeholder.match(PII_PLACEHOLDER_SINGLE_RE);
    if (!m) return null;
    const inner = m[1];
    const lastUnderscore = inner.lastIndexOf("_");
    if (lastUnderscore < 1) return null;
    const entityType = inner.slice(0, lastUnderscore);
    const counter = Number(inner.slice(lastUnderscore + 1));
    if (!Number.isFinite(counter)) return null;
    return { entityType, counter };
}

/**
 * Extract every placeholder occurrence in `text`. Returns each match once
 * per occurrence (duplicates preserved) — caller can dedupe via Set if
 * needed.
 */
export function extractPlaceholders(text: string): string[] {
    const out: string[] = [];
    const re = new RegExp(PII_PLACEHOLDER_RE.source, "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
        out.push(m[0]);
    }
    return out;
}

/**
 * True when the text contains *any* placeholder. Faster than a full
 * regex exec when the caller only needs a yes/no answer.
 */
export function containsPlaceholder(text: string): boolean {
    return text.indexOf(PII_SENTINEL_OPEN) !== -1;
}

/**
 * Drip-layer buffer guard. Used by the frontend streaming layer to avoid
 * rendering half-emitted placeholders mid-stream — see plan §9 Correction
 * #1. Returns the safe prefix of `text` that ends *before* any open but
 * unterminated `⟦PII:…` sentinel.
 *
 * Implemented here so the backend can use the same logic when buffering
 * tool-call argument streams.
 *
 * @example
 *   safeTextForDrip("Hello ⟦PII:PERSON_1⟧ how are")        // entire string
 *   safeTextForDrip("Hello ⟦PII:PERSON")                    // "Hello "
 *   safeTextForDrip("⟦PII:PERSON_1⟧ called ⟦PII:HR_OIB")  // "⟦PII:PERSON_1⟧ called "
 */
export function safeTextForDrip(text: string): string {
    const openIdx = text.lastIndexOf(PII_SENTINEL_OPEN);
    if (openIdx === -1) return text;
    const after = text.slice(openIdx);
    if (after.indexOf(PII_CLOSE) !== -1) return text;
    return text.slice(0, openIdx);
}

/**
 * De-anonymization replacement helper. Sorts the mapping by placeholder
 * length DESC so that `⟦PII:PERSON_1⟧` does not clobber `⟦PII:PERSON_10⟧`
 * when both appear in the same text. See plan §9 Correction #7.
 *
 * Pure string replacement — no regex special-char handling needed because
 * the placeholder grammar is strict ASCII outside of the brackets.
 */
export function replacePlaceholders(
    text: string,
    mapping: ReadonlyMap<string, string> | Record<string, string>,
): string {
    const entries: [string, string][] =
        mapping instanceof Map
            ? Array.from(mapping.entries())
            : Object.entries(mapping);
    entries.sort((a, b) => b[0].length - a[0].length);
    let out = text;
    for (const [placeholder, original] of entries) {
        if (out.indexOf(placeholder) === -1) continue;
        out = out.split(placeholder).join(original);
    }
    return out;
}

/**
 * Identify placeholders that appear in `text` but are NOT in `mapping`.
 * These are LLM hallucinations (plan §11 Gap #13 / R3). Returns the unique
 * set of hallucinated placeholder strings.
 */
export function findHallucinatedPlaceholders(
    text: string,
    mapping: ReadonlyMap<string, string> | Record<string, string>,
): string[] {
    const known = new Set<string>(
        mapping instanceof Map
            ? mapping.keys()
            : Object.keys(mapping),
    );
    const seen = new Set<string>();
    const re = new RegExp(PII_PLACEHOLDER_RE.source, "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
        if (!known.has(m[0])) seen.add(m[0]);
    }
    return Array.from(seen);
}
