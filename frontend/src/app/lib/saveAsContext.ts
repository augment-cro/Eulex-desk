import type { LegalSource, MikeMessage } from "../components/shared/types";
import type { NewContextSourceInput } from "./mikeApi";

/** Longest transcript slice sent to the auto-draft endpoint (chars). */
export const MAX_TRANSCRIPT_CHARS = 12_000;

/**
 * Map the legal sources cited in a chat turn to context-source inputs for
 * POST /contexts/from-chat. EU sources keep their CELEX number as the ref
 * (that is the id the change-alert feed keys on); HR/FR keep their stable
 * in-app id. Refs are deduped here and again server-side.
 */
export function toContextSourceInputs(
    sources: LegalSource[],
): NewContextSourceInput[] {
    const out: NewContextSourceInput[] = [];
    const seen = new Set<string>();
    for (const s of sources) {
        const ref = (s.scope === "@eu" && s.celex ? s.celex : s.id).trim();
        const key = ref.toLowerCase();
        if (!ref || seen.has(key)) continue;
        seen.add(key);
        out.push({
            kind: "legal_instrument",
            ref,
            mode: "retrieved",
            label: s.articleLabel ? `${s.title} — ${s.articleLabel}` : s.title,
            citation: s.citation ?? undefined,
        });
    }
    return out;
}

/**
 * Flatten the chat into the plain USER/AI transcript the summariser reads.
 * Keeps the most recent turns when the chat exceeds the size cap (the tail
 * is where the cited sources were used).
 */
export function buildTranscript(messages: MikeMessage[]): string {
    const full = messages
        .filter((m) => (m.content ?? "").trim().length > 0)
        .map((m) => `${m.role === "user" ? "USER" : "AI"}: ${m.content.trim()}`)
        .join("\n\n");
    return full.length > MAX_TRANSCRIPT_CHARS
        ? full.slice(full.length - MAX_TRANSCRIPT_CHARS)
        : full;
}
