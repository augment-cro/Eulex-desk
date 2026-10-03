import { createHash } from "node:crypto";

/**
 * Key of a document's cached PII analysis in the shield.
 *
 * The shield caches `/anonymize` output per (session, key) and the backend
 * serves a hit instead of re-running the analyzer. A cached row is only
 * valid when a fresh call would produce the same text, so the key covers
 * everything that decides the output: the version identity, the exact
 * text sent to the shield and the analysis language. Two backend paths
 * overwrite a version's bytes IN PLACE without a new version id
 * (tracked-change accept/reject in `routes/documents.ts`, same-turn
 * `edit_document` reuse in `chatTools.ts`), which is why the version id
 * alone is not enough; the text hash makes such an overwrite a cache miss.
 *
 * Formatted as a version-5-style UUID so the shield's uuid column takes
 * it unchanged.
 */
export function analysisKeyFor(args: {
    versionId: string;
    text: string;
    language: string;
}): string {
    const textSha = createHash("sha256").update(args.text, "utf8").digest("hex");
    const digest = createHash("sha256")
        .update(`pii-analysis-v1\n${args.versionId}\n${args.language}\n${textSha}`, "utf8")
        .digest("hex");
    const hex = digest.slice(0, 32).split("");
    hex[12] = "5";
    hex[16] = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
    const h = hex.join("");
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
