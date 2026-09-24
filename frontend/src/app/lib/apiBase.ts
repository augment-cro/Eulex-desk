/**
 * Single source of truth for the backend API origin (issue #69). Every
 * frontend fetch to the Express backend must build its URL from this constant
 * instead of re-reading the env var with its own copy of the fallback.
 *
 * `??` only coalesces on null/undefined — a blank env var (which happened
 * once when the Dockerfile exported `ENV NEXT_PUBLIC_API_BASE_URL=` even
 * without a build-arg) would slip through and make the base = "", which
 * silently routed every backend call to the frontend origin and surfaced
 * as 404 page-not-found HTML for /chat, /user/profile, /auth/pair/start.
 * Treat whitespace-only values as unset too.
 */
export const API_BASE =
    process.env.NEXT_PUBLIC_API_BASE_URL?.trim() || "http://localhost:3001";
