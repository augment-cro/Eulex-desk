/**
 * Helpers for normalizing share recipient email lists.
 *
 * Used by every "share with people" surface (projects, tabular reviews,
 * workflows) so the rules are identical: trim + lowercase, dedupe, drop
 * empties, and never include the owner's own email (sharing with yourself is a
 * no-op, not an error).
 */

/**
 * Normalize a raw `shared_with` / recipient email list:
 * - coerce to strings, trim + lowercase
 * - drop empties and duplicates (order preserved)
 * - drop the owner's own email when `ownerEmail` is provided
 */
export function normalizeSharedEmails(
    raw: unknown,
    ownerEmail?: string | null,
): string[] {
    if (!Array.isArray(raw)) return [];
    const owner = ownerEmail?.trim().toLowerCase() || null;
    const seen = new Set<string>();
    const cleaned: string[] = [];
    for (const item of raw) {
        if (typeof item !== "string") continue;
        const e = item.trim().toLowerCase();
        if (!e || seen.has(e)) continue;
        if (owner && e === owner) continue; // no self-share
        seen.add(e);
        cleaned.push(e);
    }
    return cleaned;
}
