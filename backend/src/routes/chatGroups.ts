import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { createServerSupabase } from "../lib/supabase";

// Sidebar conversation groups (migration 132, ISSUE-TRACKER #13).
//
// Groups are strictly per-user — no project/share visibility — so every
// query filters on user_id. Status model mirrors chats: 'active' |
// 'archived' | 'deleted'; 'deleted' rows are soft-deleted and never
// returned. Archive/delete CASCADE to the group's chats (the sidebar
// confirm dialogs warn about this).
//
// Mounted at /chat/groups in index.ts — MUST be registered before
// chatRouter, whose GET /chat/:chatId would otherwise shadow these routes.

export const chatGroupsRouter = Router();

const GROUP_NAME_MAX = 100;

// 404 non-uuid ids up front so they never reach Postgres as invalid uuids.
const UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
chatGroupsRouter.param("groupId", (req, res, next, groupId) => {
    if (!UUID_RE.test(String(groupId)))
        return void res.status(404).json({ detail: "Group not found" });
    next();
});

function parseGroupName(raw: unknown): string | null {
    if (typeof raw !== "string") return null;
    const name = raw.trim();
    if (!name || name.length > GROUP_NAME_MAX) return null;
    return name;
}

// GET /chat/groups — the user's groups (active + archived, never deleted).
chatGroupsRouter.get("/", requireAuth, async (_req, res) => {
    const userId = res.locals.userId as string;
    const db = createServerSupabase();
    const { data, error } = await db
        .from("chat_groups")
        .select("id, name, status, created_at")
        .eq("user_id", userId)
        .neq("status", "deleted")
        .order("name", { ascending: true });
    if (error) return void res.status(500).json({ detail: error.message });
    res.json(data ?? []);
});

// POST /chat/groups — create a group. Body: { name }.
chatGroupsRouter.post("/", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const name = parseGroupName(req.body?.name);
    if (!name)
        return void res
            .status(400)
            .json({ detail: "name is required (max 100 chars)" });

    const db = createServerSupabase();
    const { data, error } = await db
        .from("chat_groups")
        .insert({ user_id: userId, name })
        .select("id, name, status, created_at")
        .single();
    if (error || !data)
        return void res
            .status(500)
            .json({ detail: error?.message ?? "insert failed" });
    res.json(data);
});

// PATCH /chat/groups/:groupId — rename and/or set status.
// Body: { name?, status? ('active' | 'archived') }.
// status='archived' cascades: the group's active chats become archived.
// status='active' (unarchive) restores the group only — member chats are
// individually restorable from the archived view (spec §8.3).
chatGroupsRouter.patch("/:groupId", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const { groupId } = req.params;

    const patch: Record<string, unknown> = {};
    if (req.body?.name !== undefined) {
        const name = parseGroupName(req.body.name);
        if (!name)
            return void res
                .status(400)
                .json({ detail: "name must be a non-empty string (max 100 chars)" });
        patch.name = name;
    }
    let nextStatus: "active" | "archived" | null = null;
    if (req.body?.status !== undefined) {
        if (req.body.status !== "active" && req.body.status !== "archived")
            return void res
                .status(400)
                .json({ detail: "status must be 'active' or 'archived'" });
        nextStatus = req.body.status;
        patch.status = nextStatus;
    }
    if (Object.keys(patch).length === 0)
        return void res.status(400).json({ detail: "no valid fields" });
    patch.updated_at = new Date().toISOString();

    const db = createServerSupabase();

    // Ownership check up front so the cascade can't touch foreign rows.
    const { data: existing } = await db
        .from("chat_groups")
        .select("id")
        .eq("id", groupId)
        .eq("user_id", userId)
        .neq("status", "deleted")
        .single();
    if (!existing)
        return void res.status(404).json({ detail: "Group not found" });

    // No transaction support in the shim, so cascade the member chats
    // FIRST and flip the group row last: a mid-way failure leaves the
    // group visible (active) and the request retryable, never a hidden
    // group with live chats.
    if (nextStatus === "archived") {
        const { error: cascadeErr } = await db
            .from("chats")
            .update({ status: "archived" })
            .eq("group_id", groupId)
            .eq("user_id", userId)
            .eq("status", "active");
        if (cascadeErr)
            return void res
                .status(500)
                .json({ detail: cascadeErr.message });
    }

    const { data, error } = await db
        .from("chat_groups")
        .update(patch)
        .eq("id", groupId)
        .eq("user_id", userId)
        .neq("status", "deleted")
        .select("id, name, status, created_at")
        .single();
    if (error || !data)
        return void res.status(404).json({ detail: "Group not found" });
    res.json(data);
});

// DELETE /chat/groups/:groupId — soft-delete the group AND all its chats
// (any status). Pins are cleared so a later restore-by-support can't
// resurrect a chat into the Pinned section unexpectedly.
chatGroupsRouter.delete("/:groupId", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const { groupId } = req.params;
    const db = createServerSupabase();

    const { data: existing } = await db
        .from("chat_groups")
        .select("id")
        .eq("id", groupId)
        .eq("user_id", userId)
        .neq("status", "deleted")
        .single();
    if (!existing)
        return void res.status(404).json({ detail: "Group not found" });

    // Cascade the chats before the group row (see PATCH above): a mid-way
    // failure leaves the group intact and the DELETE retryable, never
    // orphaned live chats behind a deleted group.
    const { error: cascadeErr } = await db
        .from("chats")
        .update({ status: "deleted", pinned: false })
        .eq("group_id", groupId)
        .eq("user_id", userId);
    if (cascadeErr)
        return void res.status(500).json({ detail: cascadeErr.message });

    const { error } = await db
        .from("chat_groups")
        .update({ status: "deleted", updated_at: new Date().toISOString() })
        .eq("id", groupId)
        .eq("user_id", userId);
    if (error) return void res.status(500).json({ detail: error.message });

    res.status(204).send();
});
