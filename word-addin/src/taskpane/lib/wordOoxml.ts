/* global Word */

/**
 * Extract existing tracked changes from the open Word document.
 *
 * Two extraction strategies are available:
 *
 * 1. **TrackedChange API** (preferred) — uses `body.getTrackedChanges()`
 *    (WordApi 1.6, cross-platform) to read each change's author, date,
 *    type and text. Faster and simpler, but limited to what the API
 *    exposes (no move tracking).
 *
 * 2. **OOXML parsing** (fallback) — parses `body.getOoxml()` with the
 *    browser's DOMParser to extract `w:ins`, `w:del`, `w:moveFrom`,
 *    `w:moveTo` elements. Richer data (move ops) but slower on large
 *    documents.
 *
 * Both return a unified `TrackedChangeInfo[]` shape.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ChangeType =
    | "insertion"
    | "deletion"
    | "replacement"
    | "move"
    | "formatChange";

export interface TrackedChangeInfo {
    type: ChangeType;
    author: string;
    date: string;
    /** The inserted or current text (for deletions, the deleted text). */
    text: string;
    /** For replacements: the original text that was replaced. */
    replacedText?: string;
    /** ~40 chars before the change for location context. */
    context?: string;
}

// ---------------------------------------------------------------------------
// Strategy A: TrackedChange API
// ---------------------------------------------------------------------------

/**
 * Extract tracked changes via `body.getTrackedChanges()`
 * (Word.TrackedChangeCollection, API set WordApi 1.6 — cross-platform,
 * unlike the desktop-only `document.revisions`).
 *
 * Each change exposes `author` / `date` / `text` / `type`, where `type` is
 * one of "Added" | "Deleted" | "Formatted" | "None". Adjacent Deleted +
 * Added pairs from the same author are merged into a single "replacement"
 * entry (the common redline shape). Move tracking isn't represented in this
 * API; the OOXML fallback still recovers it.
 */
export async function getTrackedChangesViaApi(): Promise<TrackedChangeInfo[]> {
    try {
        return await Word.run(async (context) => {
            const tracked = context.document.body.getTrackedChanges();
            tracked.load("items");
            await context.sync();

            if (tracked.items.length === 0) return [];

            // Load detail on every tracked change in one batch.
            for (const tc of tracked.items) {
                tc.load("author, date, text, type");
            }
            await context.sync();

            const raw: {
                type: string;
                author: string;
                date: string;
                text: string;
            }[] = tracked.items.map((t) => ({
                type: String(t.type),
                author: t.author ?? "Unknown",
                date: t.date ? new Date(t.date).toISOString() : "",
                text: t.text ?? "",
            }));

            // Pair adjacent Deleted + Added from the same author as a
            // replacement.
            const result: TrackedChangeInfo[] = [];
            let i = 0;
            while (i < raw.length) {
                const curr = raw[i];
                const next = i + 1 < raw.length ? raw[i + 1] : null;

                const currIsDel = curr.type === "Deleted";
                const nextIsAdd = next && next.type === "Added";

                if (currIsDel && nextIsAdd && next.author === curr.author) {
                    result.push({
                        type: "replacement",
                        author: curr.author,
                        date: curr.date || next.date,
                        text: next.text,
                        replacedText: curr.text,
                    });
                    i += 2;
                    continue;
                }

                if (curr.type === "Added") {
                    result.push({
                        type: "insertion",
                        author: curr.author,
                        date: curr.date,
                        text: curr.text,
                    });
                } else if (curr.type === "Deleted") {
                    result.push({
                        type: "deletion",
                        author: curr.author,
                        date: curr.date,
                        text: curr.text,
                    });
                } else if (curr.type === "Formatted") {
                    result.push({
                        type: "formatChange",
                        author: curr.author,
                        date: curr.date,
                        text: curr.text,
                    });
                }
                // "None" / unknown — skip (no meaningful redline content).
                i++;
            }

            return result;
        });
    } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(
            "[wordOoxml] TrackedChange API extraction failed, trying OOXML fallback:",
            err,
        );
        return getTrackedChangesViaOoxml();
    }
}

// ---------------------------------------------------------------------------
// Strategy B: OOXML parsing
// ---------------------------------------------------------------------------

/** Namespace URIs used in Word's OOXML. */
const NS_W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const NS_PKG = "http://schemas.microsoft.com/office/2006/xmlPackage";

/**
 * Query helper that works around cross-browser namespace issues.
 * Falls back to prefix-based queries if namespace-aware ones fail.
 */
function queryNs(
    parent: Element | Document,
    localName: string,
): Element[] {
    // Try namespace-aware first.
    const byNs = parent.getElementsByTagNameNS(NS_W, localName);
    if (byNs.length > 0) return Array.from(byNs);

    // Fallback: prefixed (w:ins, w:del, …)
    const byPrefix = parent.getElementsByTagName(`w:${localName}`);
    return Array.from(byPrefix);
}

/**
 * Extract the concatenated text content from all `w:t` elements
 * inside a parent element.
 */
function extractText(el: Element): string {
    const tNodes = el.getElementsByTagNameNS
        ? el.getElementsByTagNameNS(NS_W, "t")
        : el.getElementsByTagName("w:t");
    let text = "";
    for (let i = 0; i < tNodes.length; i++) {
        text += tNodes[i].textContent ?? "";
    }
    return text;
}

/**
 * Check if an element is inside a table-row properties block
 * (`w:trPr`). Revision marks inside `w:trPr` are structural
 * (row-level insert/delete) and should be skipped.
 */
function isInsideTrPr(el: Element): boolean {
    let p: Element | null = el.parentElement;
    while (p) {
        const local = p.localName ?? p.nodeName;
        if (local === "trPr" || local === "w:trPr") return true;
        p = p.parentElement;
    }
    return false;
}

/**
 * Extract tracked changes by parsing the document's OOXML.
 */
export async function getTrackedChangesViaOoxml(): Promise<
    TrackedChangeInfo[]
> {
    try {
        return await Word.run(async (context) => {
            const body = context.document.body;
            const ooxmlResult = body.getOoxml();
            await context.sync();

            const xmlString = ooxmlResult.value;
            if (!xmlString) return [];

            return parseOoxmlForChanges(xmlString);
        });
    } catch (err) {
        // eslint-disable-next-line no-console
        console.error("[wordOoxml] OOXML extraction failed:", err);
        return [];
    }
}

/**
 * Parse an OOXML string and extract tracked change information.
 * Exported for testability (no Office.js dependency).
 */
export function parseOoxmlForChanges(xml: string): TrackedChangeInfo[] {
    const parser = new DOMParser();
    let doc = parser.parseFromString(xml, "text/xml");

    // If the OOXML is wrapped in a `pkg:package` envelope, drill into
    // the word/document.xml part.
    const pkgParts = doc.getElementsByTagNameNS(NS_PKG, "part");
    if (pkgParts.length > 0) {
        for (let i = 0; i < pkgParts.length; i++) {
            const name = pkgParts[i].getAttribute("pkg:name") ?? "";
            if (name.includes("document.xml")) {
                const xmlData =
                    pkgParts[i].getElementsByTagNameNS(NS_PKG, "xmlData");
                if (xmlData.length > 0) {
                    // Re-parse just the document body.
                    const innerXml = xmlData[0].innerHTML;
                    if (innerXml) {
                        doc = parser.parseFromString(innerXml, "text/xml");
                    }
                }
                break;
            }
        }
    }

    // Normalize w:proofErr elements — they can split runs mid-word.
    const proofErrs = queryNs(doc.documentElement, "proofErr");
    for (const pe of proofErrs) {
        pe.parentElement?.removeChild(pe);
    }

    const insertions = queryNs(doc.documentElement, "ins");
    const deletions = queryNs(doc.documentElement, "del");
    const moveFroms = queryNs(doc.documentElement, "moveFrom");
    const moveTos = queryNs(doc.documentElement, "moveTo");

    const changes: TrackedChangeInfo[] = [];

    // Collect insertions.
    for (const ins of insertions) {
        if (isInsideTrPr(ins)) continue;
        const text = extractText(ins);
        if (!text.trim()) continue;
        changes.push({
            type: "insertion",
            author: ins.getAttribute("w:author") ?? "Unknown",
            date: ins.getAttribute("w:date") ?? "",
            text,
        });
    }

    // Collect deletions.
    for (const del of deletions) {
        if (isInsideTrPr(del)) continue;
        // Deleted text lives in w:delText, not w:t.
        const delTexts = del.getElementsByTagNameNS
            ? del.getElementsByTagNameNS(NS_W, "delText")
            : del.getElementsByTagName("w:delText");
        let text = "";
        for (let i = 0; i < delTexts.length; i++) {
            text += delTexts[i].textContent ?? "";
        }
        if (!text.trim()) continue;
        changes.push({
            type: "deletion",
            author: del.getAttribute("w:author") ?? "Unknown",
            date: del.getAttribute("w:date") ?? "",
            text,
        });
    }

    // Collect move-from (source of moved text).
    for (const mf of moveFroms) {
        if (isInsideTrPr(mf)) continue;
        const text = extractText(mf);
        if (!text.trim()) continue;
        changes.push({
            type: "move",
            author: mf.getAttribute("w:author") ?? "Unknown",
            date: mf.getAttribute("w:date") ?? "",
            text: `[moved from] ${text}`,
        });
    }

    // Collect move-to (destination of moved text).
    for (const mt of moveTos) {
        if (isInsideTrPr(mt)) continue;
        const text = extractText(mt);
        if (!text.trim()) continue;
        changes.push({
            type: "move",
            author: mt.getAttribute("w:author") ?? "Unknown",
            date: mt.getAttribute("w:date") ?? "",
            text: `[moved to] ${text}`,
        });
    }

    // Pair adjacent deletions + insertions from the same author as
    // replacements (a common pattern in tracked edits).
    return pairReplacements(changes);
}

/**
 * Scan the changes list and merge adjacent deletion + insertion from
 * the same author into a single "replacement" entry.
 */
function pairReplacements(changes: TrackedChangeInfo[]): TrackedChangeInfo[] {
    const result: TrackedChangeInfo[] = [];
    let i = 0;
    while (i < changes.length) {
        const curr = changes[i];
        const next = i + 1 < changes.length ? changes[i + 1] : null;

        if (
            curr.type === "deletion" &&
            next?.type === "insertion" &&
            next.author === curr.author
        ) {
            result.push({
                type: "replacement",
                author: curr.author,
                date: curr.date || next.date,
                text: next.text,
                replacedText: curr.text,
            });
            i += 2;
            continue;
        }

        result.push(curr);
        i++;
    }
    return result;
}

// ---------------------------------------------------------------------------
// Formatting helper
// ---------------------------------------------------------------------------

/**
 * Format a list of tracked changes into a human-readable text block
 * suitable for inclusion in an LLM system prompt.
 */
export function formatTrackedChangesForLLM(
    changes: TrackedChangeInfo[],
): string {
    if (changes.length === 0) return "";

    const lines: string[] = [
        `--- Tracked Changes (${changes.length} pending) ---`,
    ];

    for (const ch of changes) {
        const authorDate = ch.date
            ? `${ch.author} (${ch.date.slice(0, 10)})`
            : ch.author;

        switch (ch.type) {
            case "insertion":
                lines.push(`[+] ${authorDate}: Added "${clip(ch.text)}"`);
                break;
            case "deletion":
                lines.push(`[-] ${authorDate}: Deleted "${clip(ch.text)}"`);
                break;
            case "replacement":
                lines.push(
                    `[~] ${authorDate}: Changed "${clip(ch.replacedText ?? "")}" → "${clip(ch.text)}"`,
                );
                break;
            case "move":
                lines.push(`[↔] ${authorDate}: ${clip(ch.text)}`);
                break;
            case "formatChange":
                lines.push(
                    `[F] ${authorDate}: Format change on "${clip(ch.text)}"`,
                );
                break;
        }
    }

    lines.push("--- End Tracked Changes ---");
    return lines.join("\n");
}

function clip(text: string, max = 80): string {
    const cleaned = text.replace(/[\r\n]+/g, " ").trim();
    return cleaned.length > max ? cleaned.slice(0, max) + "…" : cleaned;
}
