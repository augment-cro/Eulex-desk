/**
 * Recursive PII redaction over arbitrary JSON values.
 *
 * Used by:
 *   - `runToolCalls` — when a tool's PII policy is "passthrough" we
 *     keep placeholders in args; this helper walks the args to drop
 *     any *originals* that may have leaked back via an LLM hallucination
 *     (defense-in-depth).
 *   - `redactJsonForLog` — server-side logging so audit logs never
 *     contain the original PII the placeholder represents.
 */

import { extractPlaceholders } from "./placeholders";

/** Walk a JSON tree; replace any string that exactly equals an
 * `original` value (from the `originals` Set) with the string
 * `"<redacted>"`. Object keys are not redacted.
 */
export function redactJsonDeep<T>(input: T, originals: ReadonlySet<string>): T {
    if (input == null) return input;
    if (typeof input === "string") {
        return (originals.has(input) ? "<redacted>" : input) as T;
    }
    if (Array.isArray(input)) {
        return (input.map((v) => redactJsonDeep(v, originals)) as unknown) as T;
    }
    if (typeof input === "object") {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(input)) {
            out[k] = redactJsonDeep(v, originals);
        }
        return out as T;
    }
    return input;
}

/**
 * Collect every placeholder mentioned in the JSON value. Used to feed
 * the sidecar's /deanonymize-json call: if no placeholders are present
 * we skip the network round-trip entirely.
 */
export function collectPlaceholdersDeep(value: unknown): string[] {
    const seen = new Set<string>();

    function walk(node: unknown): void {
        if (node == null) return;
        if (typeof node === "string") {
            for (const ph of extractPlaceholders(node)) seen.add(ph);
            return;
        }
        if (Array.isArray(node)) {
            for (const item of node) walk(item);
            return;
        }
        if (typeof node === "object") {
            for (const v of Object.values(node)) walk(v);
        }
    }

    walk(value);
    return Array.from(seen);
}
