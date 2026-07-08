/**
 * Fix filenames where UTF-8 bytes were wrongly interpreted as Latin-1.
 *
 * Common with `Office.context.document.url` on Word for Mac: Croatian
 * letters like č/ć arrive as mojibake (e.g. "TrgovaÄki" instead of
 * "Trgovački"). We reinterpret each code unit U+00xx as a raw byte and
 * decode as UTF-8 when that yields a plausible fix.
 */

function fixMisdecodedUtf8AsLatin1(name: string): string {
    if (!name) return name;
    if (/[čćđšžČĆĐŠŽ]/.test(name)) return name;

    const bytes = new Uint8Array(name.length);
    for (let i = 0; i < name.length; i++) {
        const code = name.charCodeAt(i);
        if (code > 255) return name;
        bytes[i] = code;
    }

    const repaired = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    if (repaired.includes("\uFFFD")) return name;
    if (repaired === name) return name;
    if (/[čćđšžČĆĐŠŽ]/.test(repaired)) return repaired;

    const highByteChars = [...name].filter((ch) => {
        const c = ch.charCodeAt(0);
        return c >= 0x80 && c <= 0xff;
    }).length;
    if (highByteChars >= 2) return repaired;

    return name;
}

/**
 * Use when showing a filename from the API, URL basename, or multipart field.
 */
export function normalizeFilenameForDisplay(name: string): string {
    if (!name || typeof name !== "string") return name;
    let s = name.trim().replace(/^[/\\]+/, "");
    if (/%(?:[0-9A-Fa-f]{2})/.test(s)) {
        try {
            s = decodeURIComponent(s.replace(/\+/g, " "));
        } catch {
            /* keep s */
        }
    }
    return fixMisdecodedUtf8AsLatin1(s);
}
