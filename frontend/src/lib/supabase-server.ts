/**
 * Server-side auth helpers.
 *
 * Replaces the old Supabase service-role client with JWT decode.
 * Signature verification is handled by the Node.js backend;
 * these helpers only extract identity for Next.js API routes.
 *
 * @deprecated – Consider moving all server auth to the Node.js backend
 */

/**
 * Extract user ID from the Authorization header JWT.
 * Returns the `sub` claim (WordPress user ID), or throws 401.
 */
export async function getUserIdFromRequest(req: Request): Promise<string> {
    const auth = req.headers.get("authorization") ?? "";
    if (!auth.startsWith("Bearer ")) {
        throw new Response("Missing or invalid Authorization header", { status: 401 });
    }
    const token = auth.slice(7).trim();

    try {
        const parts = token.split(".");
        if (parts.length !== 3) {
            throw new Error("Invalid JWT format");
        }

        const payload = JSON.parse(
            Buffer.from(parts[1], "base64url").toString("utf-8"),
        );

        if (!payload.sub) {
            throw new Error("JWT missing sub claim");
        }

        // Check expiry
        if (payload.exp && Date.now() / 1000 > payload.exp) {
            throw new Response("Token expired", { status: 401 });
        }

        return String(payload.sub);
    } catch (err) {
        if (err instanceof Response) throw err;
        throw new Response("Invalid or expired token", { status: 401 });
    }
}
