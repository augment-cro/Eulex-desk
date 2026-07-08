/**
 * Email-bound chat share invites.
 *
 * Endpoint shape:
 *
 *   POST   /chat/:chatId/share            create + email invites
 *   GET    /chat/:chatId/shares           list invites (owner / project member)
 *   DELETE /chat/:chatId/shares/:shareId  soft-revoke an unaccepted invite
 *
 *   GET    /share/:token                  preview snapshot (requireAuth + email match)
 *   POST   /share/:token/accept           join chat as collaborator
 *
 * Tokens are random 32-byte values rendered as base64url. We persist
 * sha256(token); the plaintext only ever lives in the email link.
 * Pre-accept, the recipient sees messages with created_at <= snapshot_at
 * (virtual snapshot — no message duplication). Accepting appends the
 * recipient's email to chats.shared_with so the existing chat.ts access
 * check treats them as a collaborator going forward.
 */

import { Router } from "express";
import crypto from "crypto";
import { requireAuth } from "../middleware/auth";
import { requireEntitlement } from "../lib/entitlements";
import { createServerSupabase } from "../lib/supabase";
import { checkProjectAccess } from "../lib/access";
import { getEmailProvider } from "../lib/email/provider";
import { renderChatShareEmail } from "../lib/email/templates/chatShare";

export const chatSharesRouter = Router();

// --- Config -----------------------------------------------------------------

function ttlDays(): number {
    const raw = Number.parseInt(process.env.CHAT_SHARE_TTL_DAYS ?? "30", 10);
    return Number.isFinite(raw) && raw > 0 ? raw : 30;
}

function frontendBaseUrl(): string {
    // FRONTEND_URL is a comma-separated CORS-origins list (see index.ts) —
    // e.g. "https://max.eulex.ai,https://mike-frontend-…run.app". A share
    // link needs exactly ONE canonical origin, so take the first non-empty
    // entry (the public domain). Using the whole string produced a
    // comma-joined, unusable link in emailed invites:
    //   https://max.eulex.ai,https://mike-frontend-…run.app/share/<token>
    const first =
        (process.env.FRONTEND_URL ?? "http://localhost:3000")
            .split(",")
            .map((s) => s.trim())
            .filter((s) => s.length > 0)[0] ?? "http://localhost:3000";
    return first.replace(/\/+$/, "");
}

// --- Rate limit (in-memory) -------------------------------------------------

// Best-effort guard against runaway invite spam from a single user.
// Process-local bucket — fine for a single Cloud Run instance and a
// soft limit; if we ever go multi-region we'd move this to Redis.
type Bucket = { count: number; resetAt: number };
const inviteBuckets = new Map<string, Bucket>();
const INVITE_WINDOW_MS = 60 * 60 * 1000; // 1h
const INVITE_LIMIT = 20;

function tryConsumeInvite(userId: string, n: number): boolean {
    const now = Date.now();
    const b = inviteBuckets.get(userId);
    if (!b || b.resetAt < now) {
        inviteBuckets.set(userId, { count: n, resetAt: now + INVITE_WINDOW_MS });
        return n <= INVITE_LIMIT;
    }
    if (b.count + n > INVITE_LIMIT) return false;
    b.count += n;
    return true;
}

// --- Helpers ----------------------------------------------------------------

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normalizeEmail(raw: unknown): string | null {
    if (typeof raw !== "string") return null;
    const e = raw.trim().toLowerCase();
    if (!EMAIL_RE.test(e) || e.length > 254) return null;
    return e;
}

function generateToken(): { token: string; hash: string } {
    const token = crypto.randomBytes(32).toString("base64url");
    const hash = crypto.createHash("sha256").update(token).digest("hex");
    return { token, hash };
}

function hashToken(token: string): string {
    return crypto.createHash("sha256").update(token).digest("hex");
}

// Public-preview limits — keep the unauthenticated teaser deliberately small.
const PREVIEW_QUESTION_CHARS = 500;
const PREVIEW_ANSWER_CHARS = 400;

/**
 * Flatten a chat_messages `content` field to plain text. User rows store a
 * string; assistant rows store an AssistantEvent[] where the visible answer
 * is the concatenation of `type: "content"` events. We deliberately ignore
 * every other event kind (tool calls, retrieved snippets) and the
 * annotations column so the PUBLIC preview can never leak them.
 */
function extractPlainText(content: unknown): string {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
        return content
            .map((e) =>
                e &&
                typeof e === "object" &&
                (e as { type?: string }).type === "content"
                    ? ((e as { text?: string }).text ?? "")
                    : "",
            )
            .join("");
    }
    return "";
}

/** Trim to `max` chars on a word boundary, adding an ellipsis when cut. */
function clampText(raw: string, max: number): string | null {
    const text = raw.trim();
    if (!text) return null;
    if (text.length <= max) return text;
    const slice = text.slice(0, max);
    const lastSpace = slice.lastIndexOf(" ");
    const cut = lastSpace > max * 0.6 ? slice.slice(0, lastSpace) : slice;
    return cut.trimEnd() + "…";
}

/**
 * Resolve a chat by id and check that the caller is allowed to share it.
 * The same "owner or project member" gate the rest of chat.ts uses.
 */
async function loadChatForShare(
    chatId: string,
    userId: string,
    userEmail: string | undefined,
): Promise<
    | {
          ok: true;
          chat: {
              id: string;
              user_id: string;
              project_id: string | null;
              title: string | null;
          };
      }
    | { ok: false; status: number; detail: string }
> {
    const db = createServerSupabase();
    const { data: chat } = await db
        .from("chats")
        .select("id, user_id, project_id, title")
        .eq("id", chatId)
        .single();
    if (!chat) return { ok: false, status: 404, detail: "Chat not found" };
    const c = chat as {
        id: string;
        user_id: string;
        project_id: string | null;
        title: string | null;
    };
    if (c.user_id === userId) return { ok: true, chat: c };
    if (c.project_id) {
        const access = await checkProjectAccess(c.project_id, userId, userEmail);
        if (access.ok) return { ok: true, chat: c };
    }
    return { ok: false, status: 404, detail: "Chat not found" };
}

type UserRow = {
    id: string;
    email: string | null;
    display_name: string | null;
};

async function loadUser(userId: string): Promise<UserRow | null> {
    const db = createServerSupabase();
    const { data } = await db
        .from("users")
        .select("id, email, display_name")
        .eq("id", userId)
        .single();
    return (data as UserRow | null) ?? null;
}

async function loadRecipientPreferredLanguage(
    email: string,
): Promise<"en" | "hr"> {
    const db = createServerSupabase();
    // If the recipient already has an account, honor their UI locale so
    // the invite arrives in the language they read every day. Falls
    // back to Croatian to match `frontend/src/i18n/request.ts`.
    const { data: user } = await db
        .from("users")
        .select("id")
        .eq("email", email)
        .maybeSingle();
    if (!user) return "hr";
    const { data: profile } = await db
        .from("user_profiles")
        .select("preferred_language")
        .eq("user_id", (user as { id: string }).id)
        .maybeSingle();
    const lang = (profile as { preferred_language?: string } | null)
        ?.preferred_language;
    return lang === "en" ? "en" : "hr";
}

// --- Routes -----------------------------------------------------------------

// POST /chat/:chatId/share
//
// Body: { emails: string[] }. For each valid email we (re)create an
// active invite and ship a magic link. If a previous active (non-revoked)
// invite exists for the same chat+email, we rotate its token instead of
// stacking duplicates — see migration 109 partial unique index.
chatSharesRouter.post(
    "/chat/:chatId/share",
    requireAuth,
    requireEntitlement("shareResearchLink"),
    async (req, res) => {
        const userId = res.locals.userId as string;
        const userEmail = res.locals.userEmail as string | undefined;
        const { chatId } = req.params;
        const raw = (req.body?.emails ?? []) as unknown[];

        // Normalise + dedupe, dropping bad inputs silently — the modal
        // already validates client-side, but never trust the client.
        const emails: string[] = [];
        const seen = new Set<string>();
        for (const r of raw) {
            const e = normalizeEmail(r);
            if (!e || seen.has(e)) continue;
            seen.add(e);
            emails.push(e);
        }
        if (emails.length === 0) {
            return void res
                .status(400)
                .json({ detail: "At least one valid email is required" });
        }

        const access = await loadChatForShare(chatId, userId, userEmail);
        if (!access.ok) {
            return void res.status(access.status).json({ detail: access.detail });
        }
        const chat = access.chat;

        // Don't let a user invite themselves — confusing UX and a self
        // share would already match the owner access check anyway.
        const owner = await loadUser(userId);
        const ownerEmail = (owner?.email ?? userEmail ?? "").toLowerCase();
        const filtered = emails.filter((e) => e !== ownerEmail);
        if (filtered.length === 0) {
            return void res
                .status(400)
                .json({ detail: "Cannot share a chat with yourself" });
        }

        if (!tryConsumeInvite(userId, filtered.length)) {
            return void res.status(429).json({
                detail: "Too many share invites in the last hour. Try again later.",
            });
        }

        const db = createServerSupabase();
        const provider = getEmailProvider();
        const baseUrl = frontendBaseUrl();
        const now = new Date();
        const expiresAt = new Date(
            now.getTime() + ttlDays() * 24 * 60 * 60 * 1000,
        );

        const ownerDisplayName =
            owner?.display_name?.trim() ||
            (ownerEmail ? ownerEmail.split("@")[0] : "Eulex Desk user");

        const successes: string[] = [];
        const failures: { email: string; reason: string }[] = [];

        for (const email of filtered) {
            const { token, hash } = generateToken();

            // Soft-revoke any previously-active invite for the same
            // (chat, email) pair so the partial unique index (see
            // migration 109) lets us insert a fresh row. We keep the
            // history rather than DELETE so audit/accepted rows survive.
            await db
                .from("chat_shares")
                .update({ revoked_at: now.toISOString() })
                .eq("chat_id", chatId)
                .eq("shared_with_email", email)
                .is("revoked_at", null)
                .is("accepted_at", null);

            const { data: inserted, error: insertErr } = await db
                .from("chat_shares")
                .insert({
                    chat_id: chatId,
                    shared_by_user_id: userId,
                    shared_with_email: email,
                    token_hash: hash,
                    snapshot_at: now.toISOString(),
                    expires_at: expiresAt.toISOString(),
                })
                .select("id")
                .single();
            if (insertErr || !inserted) {
                console.error(
                    "[chat-share] failed to insert chat_shares row:",
                    insertErr,
                );
                failures.push({
                    email,
                    reason: "Failed to create invite record",
                });
                continue;
            }

            const shareUrl = `${baseUrl}/share/${token}`;
            const lang = await loadRecipientPreferredLanguage(email);
            const rendered = renderChatShareEmail({
                ownerName: ownerDisplayName,
                ownerEmail: ownerEmail || "noreply@mike",
                chatTitle: chat.title,
                shareUrl,
                expiresAt,
                lang,
            });

            const sendResult = await provider.send({
                to: { email },
                subject: rendered.subject,
                html: rendered.html,
                text: rendered.text,
                replyTo: ownerEmail
                    ? { email: ownerEmail, name: ownerDisplayName }
                    : undefined,
                tags: ["chat-share"],
            });

            if (!sendResult.ok) {
                // Hard rollback so we don't leave dangling invites that
                // were never delivered — the user would otherwise see
                // a "people with access" entry for someone who can't
                // possibly know the link.
                await db
                    .from("chat_shares")
                    .update({ revoked_at: new Date().toISOString() })
                    .eq("id", (inserted as { id: string }).id);
                const reason =
                    "skipped" in sendResult
                        ? sendResult.reason
                        : sendResult.error;
                failures.push({ email, reason });
                continue;
            }

            successes.push(email);
        }

        if (successes.length === 0) {
            return void res.status(502).json({
                detail: "Failed to send any share invites",
                failures,
            });
        }

        const { data: shares } = await db
            .from("chat_shares")
            .select(
                "id, shared_with_email, created_at, expires_at, accepted_at, revoked_at",
            )
            .eq("chat_id", chatId)
            .order("created_at", { ascending: true });

        res.json({ sent: successes, failures, shares: shares ?? [] });
    },
);

// GET /chat/:chatId/shares
chatSharesRouter.get(
    "/chat/:chatId/shares",
    requireAuth,
    async (req, res) => {
        const userId = res.locals.userId as string;
        const userEmail = res.locals.userEmail as string | undefined;
        const { chatId } = req.params;

        const access = await loadChatForShare(chatId, userId, userEmail);
        if (!access.ok) {
            return void res
                .status(access.status)
                .json({ detail: access.detail });
        }

        const db = createServerSupabase();
        const { data: shares, error } = await db
            .from("chat_shares")
            .select(
                "id, shared_with_email, created_at, expires_at, accepted_at, revoked_at",
            )
            .eq("chat_id", chatId)
            .order("created_at", { ascending: true });
        if (error)
            return void res.status(500).json({ detail: error.message });
        res.json(shares ?? []);
    },
);

// DELETE /chat/:chatId/shares/:shareId
//
// Soft-revoke an unaccepted invite. Already-accepted recipients keep
// access through chats.shared_with — to actually evict them, edit that
// array via the chat edit flow (out of scope for this endpoint).
chatSharesRouter.delete(
    "/chat/:chatId/shares/:shareId",
    requireAuth,
    async (req, res) => {
        const userId = res.locals.userId as string;
        const userEmail = res.locals.userEmail as string | undefined;
        const { chatId, shareId } = req.params;

        const access = await loadChatForShare(chatId, userId, userEmail);
        if (!access.ok) {
            return void res
                .status(access.status)
                .json({ detail: access.detail });
        }

        const db = createServerSupabase();
        await db
            .from("chat_shares")
            .update({ revoked_at: new Date().toISOString() })
            .eq("id", shareId)
            .eq("chat_id", chatId)
            .is("revoked_at", null);
        res.status(204).send();
    },
);

// GET /share/:token/preview
//
// PUBLIC (no auth) teaser, shown BEFORE sign-in so an invited recipient
// can see what's being shared. Returns ONLY the first question and a
// truncated start of the first answer — never the full thread, never
// assistant events/annotations (retrieved snippets, citations), never the
// bound recipient email. Still validates the token so expired/revoked/
// unknown links don't render a teaser. The complete, email-bound snapshot
// stays behind the authenticated GET /share/:token below.
//
// NOTE: this relaxes the strict email-binding — anyone holding the link
// (links get forwarded) sees the teaser. Kept intentionally minimal for
// exactly that reason.
chatSharesRouter.get("/share/:token/preview", async (req, res) => {
    const { token } = req.params;
    if (!token)
        return void res.status(400).json({ detail: "Missing token" });

    const tokenHash = hashToken(token);
    const db = createServerSupabase();
    const { data: share } = await db
        .from("chat_shares")
        .select(
            "id, chat_id, shared_by_user_id, snapshot_at, expires_at, revoked_at",
        )
        .eq("token_hash", tokenHash)
        .single();
    if (!share) {
        return void res
            .status(404)
            .json({ detail: "Share not found", code: "not_found" });
    }
    const s = share as {
        id: string;
        chat_id: string;
        shared_by_user_id: string;
        snapshot_at: string;
        expires_at: string;
        revoked_at: string | null;
    };
    if (s.revoked_at) {
        return void res
            .status(410)
            .json({ detail: "Share was revoked", code: "revoked" });
    }
    if (new Date(s.expires_at).getTime() < Date.now()) {
        return void res
            .status(410)
            .json({ detail: "Share has expired", code: "expired" });
    }

    const { data: chat } = await db
        .from("chats")
        .select("id, title")
        .eq("id", s.chat_id)
        .single();
    if (!chat) {
        return void res
            .status(404)
            .json({ detail: "Chat not found", code: "chat_missing" });
    }

    // Same snapshot rule as the pre-accept full view: created_at <= snapshot_at.
    const { data: messages } = await db
        .from("chat_messages")
        .select("role, content, created_at")
        .eq("chat_id", s.chat_id)
        .lte("created_at", s.snapshot_at)
        .order("created_at", { ascending: true });
    const rows = (messages ?? []) as { role: string; content: unknown }[];

    const firstUser = rows.find((m) => m.role === "user");
    const firstAssistant = rows.find((m) => m.role === "assistant");
    const answerExcerpt = clampText(
        extractPlainText(firstAssistant?.content),
        PREVIEW_ANSWER_CHARS,
    );
    const owner = await loadUser(s.shared_by_user_id);

    res.json({
        mode: "preview",
        title: (chat as { title: string | null }).title,
        owner_name: owner?.display_name ?? null,
        question: clampText(
            extractPlainText(firstUser?.content),
            PREVIEW_QUESTION_CHARS,
        ),
        answer_excerpt: answerExcerpt,
        // Is there more to unlock? The first answer was cut, or there are
        // messages beyond the first question + answer.
        answer_truncated:
            (answerExcerpt?.endsWith("…") ?? false) || rows.length > 2,
        total_messages: rows.length,
        expires_at: s.expires_at,
    });
});

// GET /share/:token
//
// View the snapshot (or live thread, post-accept). Always requires
// auth: the email-bound model is the whole point of this feature.
// Errors are deliberately specific so the share page can render
// distinct UX for "wrong email" vs "expired" vs "not found".
chatSharesRouter.get(
    "/share/:token",
    requireAuth,
    async (req, res) => {
        const callerEmail = (
            (res.locals.userEmail as string | undefined) ?? ""
        ).toLowerCase();
        const { token } = req.params;
        if (!token)
            return void res.status(400).json({ detail: "Missing token" });

        const tokenHash = hashToken(token);
        const db = createServerSupabase();
        const { data: share } = await db
            .from("chat_shares")
            .select(
                "id, chat_id, shared_by_user_id, shared_with_email, snapshot_at, expires_at, accepted_at, revoked_at",
            )
            .eq("token_hash", tokenHash)
            .single();
        if (!share) {
            return void res
                .status(404)
                .json({ detail: "Share not found", code: "not_found" });
        }
        const s = share as {
            id: string;
            chat_id: string;
            shared_by_user_id: string;
            shared_with_email: string;
            snapshot_at: string;
            expires_at: string;
            accepted_at: string | null;
            revoked_at: string | null;
        };

        if (s.revoked_at) {
            return void res
                .status(410)
                .json({ detail: "Share was revoked", code: "revoked" });
        }
        if (new Date(s.expires_at).getTime() < Date.now()) {
            return void res
                .status(410)
                .json({ detail: "Share has expired", code: "expired" });
        }
        if (s.shared_with_email.toLowerCase() !== callerEmail) {
            return void res.status(403).json({
                detail: "This share is bound to a different email",
                code: "email_mismatch",
                expectedEmail: s.shared_with_email,
            });
        }

        const { data: chat } = await db
            .from("chats")
            .select("id, project_id, title, created_at")
            .eq("id", s.chat_id)
            .single();
        if (!chat) {
            return void res
                .status(404)
                .json({ detail: "Chat not found", code: "chat_missing" });
        }

        const isAccepted = !!s.accepted_at;
        // Pre-accept = virtual snapshot (filter by created_at). Post-accept
        // = live, the recipient already shows up in chats.shared_with and
        // will hit the regular GET /chat/:id route from now on.
        const messagesQuery = db
            .from("chat_messages")
            .select("*")
            .eq("chat_id", s.chat_id)
            .order("created_at", { ascending: true });
        const { data: messages } = isAccepted
            ? await messagesQuery
            : await messagesQuery.lte("created_at", s.snapshot_at);

        const owner = await loadUser(s.shared_by_user_id);
        res.json({
            mode: isAccepted ? "live" : "snapshot",
            chat,
            messages: messages ?? [],
            shared_at: s.snapshot_at,
            expires_at: s.expires_at,
            accepted_at: s.accepted_at,
            owner: {
                display_name: owner?.display_name ?? null,
                email: owner?.email ?? null,
            },
            // Where the frontend should send the user after they click
            // "Continue conversation". We deliberately route everyone
            // (including recipients of project-bound chats) to the
            // global `/assistant/chat/:id` viewer because the
            // per-project chat page calls POST /projects/:id/chat which
            // gates on project membership — and a share recipient is
            // a per-chat collaborator, not a project member. The global
            // POST /chat route honours chats.shared_with so they can
            // keep posting from there.
            redirect_to: `/assistant/chat/${s.chat_id}`,
        });
    },
);

// POST /share/:token/accept
chatSharesRouter.post(
    "/share/:token/accept",
    requireAuth,
    async (req, res) => {
        const userId = res.locals.userId as string;
        const callerEmail = (
            (res.locals.userEmail as string | undefined) ?? ""
        ).toLowerCase();
        const { token } = req.params;
        if (!token)
            return void res.status(400).json({ detail: "Missing token" });

        const tokenHash = hashToken(token);
        const db = createServerSupabase();
        const { data: share } = await db
            .from("chat_shares")
            .select(
                "id, chat_id, shared_with_email, accepted_at, expires_at, revoked_at",
            )
            .eq("token_hash", tokenHash)
            .single();
        if (!share)
            return void res
                .status(404)
                .json({ detail: "Share not found", code: "not_found" });
        const s = share as {
            id: string;
            chat_id: string;
            shared_with_email: string;
            accepted_at: string | null;
            expires_at: string;
            revoked_at: string | null;
        };

        if (s.revoked_at)
            return void res
                .status(410)
                .json({ detail: "Share was revoked", code: "revoked" });
        if (new Date(s.expires_at).getTime() < Date.now())
            return void res
                .status(410)
                .json({ detail: "Share has expired", code: "expired" });
        if (s.shared_with_email.toLowerCase() !== callerEmail)
            return void res
                .status(403)
                .json({
                    detail: "This share is bound to a different email",
                    code: "email_mismatch",
                });

        // Append the recipient's email to chats.shared_with (jsonb array).
        // Read-modify-write because the dbShim doesn't expose
        // jsonb_array_append directly, and the array is small (<=100s).
        const { data: chat } = await db
            .from("chats")
            .select("id, project_id, shared_with")
            .eq("id", s.chat_id)
            .single();
        if (!chat)
            return void res
                .status(404)
                .json({ detail: "Chat not found", code: "chat_missing" });

        const current = Array.isArray(
            (chat as { shared_with?: unknown }).shared_with,
        )
            ? ((chat as { shared_with: string[] }).shared_with.map((e) =>
                  (e ?? "").toLowerCase(),
              ) as string[])
            : [];
        if (!current.includes(callerEmail)) {
            current.push(callerEmail);
            await db
                .from("chats")
                .update({ shared_with: current })
                .eq("id", s.chat_id);
        }

        if (!s.accepted_at) {
            await db
                .from("chat_shares")
                .update({
                    accepted_at: new Date().toISOString(),
                    accepted_user_id: userId,
                })
                .eq("id", s.id);
        }

        const projectId = (chat as { project_id: string | null }).project_id;
        res.json({
            chat_id: s.chat_id,
            project_id: projectId,
            // Always land on the global chat page — see GET /share/:token
            // for the rationale (per-chat collaborator, not a project
            // member).
            redirect_to: `/assistant/chat/${s.chat_id}`,
        });
    },
);
