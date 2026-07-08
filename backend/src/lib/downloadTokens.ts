import crypto from "crypto";

/**
 * HMAC-signed download tokens with a bounded lifetime (default 30 days).
 *
 * The token encodes the storage path + filename + an expiry; the backend route
 * `/download/:token` validates the signature + expiry and streams the file.
 * This gives stable links safe to store in chat history without signed-URL
 * CORS headaches, while still capping how long a leaked link stays valid.
 * Legacy tokens minted before the expiry field have no expiry and still verify.
 */

function getSecret(): string {
    // Fail closed: no insecure literal fallback. A dedicated
    // DOWNLOAD_SIGNING_SECRET is preferred, but EULEX_MCP_JWT_SECRET is always
    // set in prod (auth middleware hard-fails without it), so existing tokens
    // signed with it keep verifying.
    const secret =
        process.env.DOWNLOAD_SIGNING_SECRET ?? process.env.EULEX_MCP_JWT_SECRET;
    if (!secret) {
        throw new Error(
            "DOWNLOAD_SIGNING_SECRET (or EULEX_MCP_JWT_SECRET) not configured",
        );
    }
    return secret;
}

function b64urlEncode(buf: Buffer): string {
    return buf
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/g, "");
}

function b64urlDecode(s: string): Buffer {
    let t = s.replace(/-/g, "+").replace(/_/g, "/");
    while (t.length % 4) t += "=";
    return Buffer.from(t, "base64");
}

function timingSafeEqStr(a: string, b: string): boolean {
    // Pad to equal length so the comparison is constant-time and never leaks
    // length via an early return; the trailing length check keeps it correct.
    const ab = Buffer.from(a);
    const bb = Buffer.from(b);
    const len = Math.max(ab.length, bb.length);
    const pa = Buffer.alloc(len);
    const pb = Buffer.alloc(len);
    ab.copy(pa);
    bb.copy(pb);
    return crypto.timingSafeEqual(pa, pb) && ab.length === bb.length;
}

/** Default download-token lifetime: 30 days. */
const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export function signDownload(
    path: string,
    filename: string,
    ttlMs: number = DEFAULT_TTL_MS,
): string {
    const payload = JSON.stringify({
        p: path,
        f: filename,
        e: Date.now() + ttlMs, // expiry (epoch ms)
    });
    const enc = b64urlEncode(Buffer.from(payload, "utf8"));
    const sig = crypto
        .createHmac("sha256", getSecret())
        .update(enc)
        .digest();
    return `${enc}.${b64urlEncode(sig)}`;
}

export function verifyDownload(
    token: string,
): { path: string; filename: string } | null {
    const parts = token.split(".");
    if (parts.length !== 2) return null;
    const [enc, sigEnc] = parts;
    const expected = crypto
        .createHmac("sha256", getSecret())
        .update(enc)
        .digest();
    if (!timingSafeEqStr(sigEnc, b64urlEncode(expected))) return null;
    try {
        const parsed = JSON.parse(b64urlDecode(enc).toString("utf8")) as {
            p: string;
            f: string;
            e?: number;
        };
        if (!parsed?.p || !parsed?.f) return null;
        // Reject expired tokens. Legacy tokens without `e` have no expiry and
        // still verify (backward compatible).
        if (typeof parsed.e === "number" && Date.now() > parsed.e) return null;
        return { path: parsed.p, filename: parsed.f };
    } catch {
        return null;
    }
}

/**
 * Returns a relative download URL (e.g. "/download/abc.def"). The frontend
 * prefixes it with NEXT_PUBLIC_API_BASE_URL when rendering `<a href=…>`.
 */
export function buildDownloadUrl(path: string, filename: string): string {
    return `/download/${signDownload(path, filename)}`;
}
