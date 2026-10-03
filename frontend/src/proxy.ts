import { NextResponse, type NextRequest } from "next/server";

/**
 * /adminmax/* → the external operator console, when one is configured.
 *
 * ADMINMAX_URL (runtime env on the frontend service, e.g.
 * https://admin.eulex.ai) — set: every /adminmax path is redirected there
 * with the same path and query, so old bookmarks keep working; unset: the
 * request continues and this app answers 404 (the console is a separate
 * program, see contracts/operator.openapi.json).
 *
 * Read per request (Proxy always runs on the Node.js runtime), so changing
 * the variable on the service needs no rebuild. A redirect, not a rewrite:
 * the console sets its own session and must own its origin.
 */
export function proxy(request: NextRequest) {
    const target = process.env["ADMINMAX_URL"]?.trim().replace(/\/+$/, "");
    if (!target || !/^https?:\/\//.test(target)) return NextResponse.next();
    const { pathname, search } = request.nextUrl;
    return NextResponse.redirect(`${target}${pathname}${search}`, 308);
}

export const config = {
    matcher: ["/adminmax", "/adminmax/:path*"],
};
