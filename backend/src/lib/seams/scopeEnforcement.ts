/**
 * Opaque scope enforcement over the `scope_allowlist[]` a configured
 * context provider returns from POST /contexts/{id}/resolve
 * (contracts/context-provider.openapi.json).
 *
 * The allowlist entries are OPAQUE strings: the provider pre-mints every
 * canonical form an identifier can take (including instrument stems and
 * any namespace-prefixed variants), so this module never derives canon
 * forms of its own. Its whole vocabulary is:
 *   - lower-case a candidate id,
 *   - membership: `has(id) || has(stem(id))` where `stem` cuts at the
 *     first `#` (the contract's documented fragment separator),
 *   - character-class shapes LEARNED from the allowlist strings
 *     themselves (see precheckToolArgs).
 * No identifier scheme (CELEX, ELI, national registers, …) is known here.
 */

function norm(id: string): string {
    return id.trim().toLowerCase();
}

/** Cut a candidate id at its `#` fragment for the stem membership check. */
export function stemOf(id: string): string {
    const n = norm(id);
    const hash = n.indexOf("#");
    return hash > 0 ? n.slice(0, hash) : n;
}

/**
 * Union the resolve responses' allowlists into one lower-cased set.
 * Empty/undefined inputs collapse to an empty set, which turns every
 * enforcement hook below into a no-op.
 */
export function buildScopeSet(
    allowlists: (readonly string[] | undefined)[],
): Set<string> {
    const set = new Set<string>();
    for (const list of allowlists) {
        for (const entry of list ?? []) {
            const n = norm(entry);
            if (n) set.add(n);
        }
    }
    return set;
}

export function identifierInScope(id: string, allowlist: Set<string>): boolean {
    const n = norm(id);
    return allowlist.has(n) || allowlist.has(stemOf(n));
}

function isPlainObj(v: unknown): v is Record<string, unknown> {
    return !!v && typeof v === "object" && !Array.isArray(v);
}

/**
 * L2 redaction — strips out-of-scope legal material from a tool result's
 * text AND structured payloads before they reach the model, the harvest,
 * or the legal_sources UI event. With an empty allowlist (no active
 * context) or when everything harvests in-scope, the inputs pass through
 * untouched. The suppression marker is only emitted when material was
 * actually removed — never a cosmetic marker over unredacted content.
 *
 * Production `structuredContent` is an OBJECT whose `sources` (HR/FR
 * EulexSource[]) and/or `results` (EU SearchResult[]) arrays hold the
 * items — the same shapes chatTools.harvestLegalSources consumes. Items
 * are filtered per-array; in-scope items survive. The original text is
 * preserved (marker appended) unless the text itself harvests an
 * out-of-scope identifier — then it is replaced wholesale, since raw text
 * can interleave out-of-scope passages that cannot be attributed.
 *
 * `keptSources` is the deduped in-scope harvest of the payload — callers
 * push these to the legal_sources UI event directly instead of
 * re-harvesting the redacted payload.
 */
export function redactToolResult<S extends { id: string }>(params: {
    text: string;
    structured: unknown;
    whitelist: Set<string>;
    harvest: (payload: { text: string; structured?: unknown }) => S[];
}): { text: string; structured: unknown; suppressed: number; keptSources: S[] } {
    const { text, structured, whitelist, harvest } = params;
    const all = harvest({ text, structured });
    // Dedupe by normalized id — the same source often harvests from both the
    // text and the structured channel; report it once.
    const dedupeByNormId = (list: S[]): S[] => {
        const seen = new Set<string>();
        const out: S[] = [];
        for (const s of list) {
            const k = norm(s.id);
            if (seen.has(k)) continue;
            seen.add(k);
            out.push(s);
        }
        return out;
    };
    if (whitelist.size === 0) {
        return { text, structured, suppressed: 0, keptSources: dedupeByNormId(all) };
    }
    const inScope = (id: string) => identifierInScope(id, whitelist);
    const outOfScope = new Set(all.filter((r) => !inScope(r.id)).map((r) => norm(r.id)));
    const keptSources = dedupeByNormId(all.filter((r) => inScope(r.id)));
    if (outOfScope.size === 0) {
        return { text, structured, suppressed: 0, keptSources };
    }

    // Per-item scope check: wrap the item in both shapes the harvester
    // accepts ({results:[item]} → EU celex_id items, {sources:[item]} →
    // HR/FR EulexSource items) and require every harvested id in scope.
    // Items that harvest nothing are dropped — they cannot be attributed.
    const itemInScope = (item: unknown): boolean => {
        const ids = [
            ...harvest({ text: "", structured: { results: [item] } }),
            ...harvest({ text: "", structured: { sources: [item] } }),
        ];
        return ids.length > 0 && ids.every((r) => inScope(r.id));
    };

    let keptStructured: unknown = structured;
    let keptCount = 0;
    if (Array.isArray(structured)) {
        const kept = structured.filter(itemInScope);
        keptCount = kept.length;
        keptStructured = kept;
    } else if (isPlainObj(structured)) {
        const next: Record<string, unknown> = { ...structured };
        for (const key of ["sources", "results"] as const) {
            const arr = next[key];
            if (!Array.isArray(arr)) continue;
            const kept = arr.filter(itemInScope);
            keptCount += kept.length;
            next[key] = kept;
        }
        // Residual guard — identifiers living OUTSIDE the sources/results
        // arrays (e.g. a top-level document id from a single-article fetch)
        // that are out of scope taint the whole object: drop it entirely.
        const residual = harvest({ text: "", structured: next });
        if (residual.some((r) => !inScope(r.id))) {
            keptStructured = undefined;
            keptCount = 0;
        } else {
            keptStructured = next;
        }
    }

    const marker =
        `[${outOfScope.size} result(s) outside the active context were suppressed. ` +
        "Tell the user these results are out of scope and offer to search outside the context.]";

    // Text channel: only replace it when the text ITSELF harvests an
    // out-of-scope identifier (typically a JSON payload mirroring the
    // structured content). Prose / in-scope-only text is preserved with the
    // marker appended.
    const textSources = harvest({ text, structured: undefined });
    const textHasOut = textSources.some((r) => !inScope(r.id));
    let keptText: string;
    if (!textHasOut) {
        keptText = `${text}\n\n${marker}`;
    } else {
        const parts = [marker];
        if (textSources.some((r) => inScope(r.id))) {
            parts.push(
                "[In-scope material in the original text was withheld with it — it could not be separated from out-of-scope content.]",
            );
        }
        if (keptCount > 0) {
            parts.push(`[${keptCount} in-scope result(s) retained in the structured content.]`);
        }
        keptText = parts.join("\n");
    }
    return { text: keptText, structured: keptStructured, suppressed: outOfScope.size, keptSources };
}

/**
 * Precheck/L1 scoping is for LEGAL research servers only. A Drive/Notion
 * connector legitimately passes UUID-shaped document ids that have nothing
 * to do with the provider's identifier space; refusing those calls whenever
 * a context is active breaks non-legal tooling. Mirrors the
 * legal-jurisdiction slug/name classification in
 * chatTools.deriveActiveJurisdictions.
 */
const LEGAL_SERVER_RE =
    /eulex|eur-?lex|zakon|narodne|hrvat|croat|legifrance|france|french|francus|ris-?at|austria|österreich|osterreich|uk-?legal|legislation\.gov\.uk|united kingdom/;

export function isLegalMcpServer(
    row: { slug?: string | null; name?: string | null } | null | undefined,
): boolean {
    const hay = `${(row?.slug || "").toLowerCase()} ${(row?.name || "").toLowerCase()}`;
    return LEGAL_SERVER_RE.test(hay);
}

/**
 * Character-class shape of an opaque id: digits → "9", letters → "a",
 * everything else kept. "Identifier-shaped" is decided by comparing a
 * candidate's shape against the shapes of the allowlist entries
 * themselves, so the core recognises the provider's id space without
 * knowing any id scheme.
 */
function shapeOf(id: string): string {
    return id.replace(/[0-9]/g, "9").replace(/[a-z]/g, "a");
}

function allowlistShapes(whitelist: Set<string>): Set<string> {
    const shapes = new Set<string>();
    for (const entry of whitelist) {
        shapes.add(shapeOf(entry));
        shapes.add(shapeOf(stemOf(entry)));
    }
    return shapes;
}

function collectStrings(x: unknown, out: string[] = []): string[] {
    if (typeof x === "string") out.push(x);
    else if (Array.isArray(x)) for (const v of x) collectStrings(v, out);
    else if (x && typeof x === "object") for (const v of Object.values(x)) collectStrings(v, out);
    return out;
}

/**
 * Pre-call arg check — refuses an out-of-scope single-document fetch before
 * the MCP round-trip. Walks every string value in the parsed args; a value
 * whose character-class shape matches an allowlist entry's shape (i.e. it
 * lives in the provider's opaque id space) but whose value is out of scope
 * refuses the call. Free-text args never share an id's shape, so they pass.
 * L2 redaction (redactToolResult) stays the guarantee behind this check.
 */
export function precheckToolArgs(
    args: unknown,
    whitelist: Set<string>,
): { ok: true } | { ok: false; refusedId: string } {
    if (whitelist.size === 0) return { ok: true };
    const shapes = allowlistShapes(whitelist);
    for (const v of collectStrings(args)) {
        const n = norm(v);
        const idShaped = shapes.has(shapeOf(n)) || shapes.has(shapeOf(stemOf(n)));
        if (idShaped && !identifierInScope(n, whitelist)) {
            return { ok: false, refusedId: n };
        }
    }
    return { ok: true };
}

/**
 * Opportunistic L1 — copies args with the sorted scope allowlist under
 * `paramName` (the EULEX_SCOPE_PARAM env). No-op when the name is unset or
 * the allowlist is empty. A lenient server ignoring the param is harmless —
 * L2 redaction stays the guarantee.
 */
export function injectScopeParam<T extends Record<string, unknown>>(
    args: T,
    whitelist: Set<string>,
    paramName: string | undefined,
): T {
    if (!paramName || whitelist.size === 0) return args;
    return { ...args, [paramName]: [...whitelist].sort() };
}
