/**
 * Normalize multipart upload filenames: URL-decode when percent-encoded, and
 * fix UTF-8 bytes misinterpreted as Latin-1 (common from Word add-in clients).
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

export function normalizeUploadFilename(name: string): string {
  if (!name || typeof name !== "string") return name;
  let s = name.trim().replace(/^[/\\]+/, "");
  if (/%(?:[0-9A-Fa-f]{2})/.test(s)) {
    try {
      s = decodeURIComponent(s.replace(/\+/g, " "));
    } catch {
      /* keep */
    }
  }
  return fixMisdecodedUtf8AsLatin1(s);
}
