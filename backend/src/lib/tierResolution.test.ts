import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import type { SupabaseClient } from "@supabase/supabase-js";
import { query } from "./db";
import {
    _resetTierResolutionForTesting,
    _setTierResolutionDepsForTesting,
    getFreshSupabaseTier,
    resolveSupabaseUserTier,
    resolveTierFromAppMetadata,
} from "./tierResolution";
import { getFreeTierLevelId } from "./stripe";

const FREE = getFreeTierLevelId();
const USER = "00000000-0000-0000-0000-000000000001";
const SB_USER = "11111111-1111-1111-1111-111111111111";

const FUTURE = new Date(Date.now() + 86_400_000).toISOString();
const PAST = new Date(Date.now() - 86_400_000).toISOString();

// ── stubs ───────────────────────────────────────────────────────────────

/** Counting stub for lib/db `query`, returning fixed user_tier_state rows. */
function queryStub(rows: unknown[] = [], fail = false) {
    const calls = { count: 0 };
    const fn = (async () => {
        calls.count += 1;
        if (fail) throw new Error("boom");
        return { rows, rowCount: rows.length };
    }) as unknown as typeof query;
    return { fn, calls };
}

/** Minimal fake of the admin client's `auth.admin.getUserById`. */
function adminStub(
    result: () => {
        data: { user: { app_metadata?: unknown } | null };
        error: { message: string } | null;
    },
) {
    const calls = { count: 0 };
    const client = {
        auth: {
            admin: {
                getUserById: async (_id: string) => {
                    calls.count += 1;
                    return result();
                },
            },
        },
    } as unknown as SupabaseClient;
    return { client, calls };
}

// ── resolveTierFromAppMetadata (pure ladder step 1) ─────────────────────

describe("resolveTierFromAppMetadata", () => {
    beforeEach(() => _resetTierResolutionForTesting());
    after(() => _resetTierResolutionForTesting());

    it("uses tier_level_id when present", () => {
        const r = resolveTierFromAppMetadata({
            tier_level_id: 2,
            tier_slug: "eulex_plus",
            tier_until: null,
        });
        assert.deepEqual(r, {
            kind: "tier",
            tierLevelId: 2,
            tierSlug: "eulex_plus",
        });
    });

    it("keeps the tier while tier_until is in the future", () => {
        const r = resolveTierFromAppMetadata({
            tier_level_id: 7,
            tier_until: FUTURE,
        });
        assert.equal(r.kind, "tier");
        assert.equal((r as { tierLevelId: number }).tierLevelId, 7);
    });

    it("resolves an expired tier_until to free", () => {
        const r = resolveTierFromAppMetadata({
            tier_level_id: 7,
            tier_until: PAST,
        });
        assert.deepEqual(r, { kind: "tier", tierLevelId: FREE, tierSlug: null });
    });

    it("treats an explicit null tier_level_id as authoritative free (write-side clear)", () => {
        const r = resolveTierFromAppMetadata({
            tier_level_id: null,
            tier_slug: null,
            tier_until: null,
        });
        assert.deepEqual(r, { kind: "tier", tierLevelId: FREE, tierSlug: null });
    });

    it("returns none when the tier field is absent (legacy user)", () => {
        assert.deepEqual(
            resolveTierFromAppMetadata({ provider: "email", providers: ["email"] }),
            { kind: "none" },
        );
    });

    it("returns none for missing / non-object app_metadata", () => {
        assert.deepEqual(resolveTierFromAppMetadata(undefined), { kind: "none" });
        assert.deepEqual(resolveTierFromAppMetadata(null), { kind: "none" });
        assert.deepEqual(resolveTierFromAppMetadata("junk"), { kind: "none" });
    });

    it("returns none for a malformed tier_level_id", () => {
        assert.deepEqual(resolveTierFromAppMetadata({ tier_level_id: "plus" }), {
            kind: "none",
        });
        assert.deepEqual(resolveTierFromAppMetadata({ tier_level_id: NaN }), {
            kind: "none",
        });
    });
});

// ── resolveSupabaseUserTier (auth-time ladder) ──────────────────────────

describe("resolveSupabaseUserTier", () => {
    beforeEach(() => _resetTierResolutionForTesting());
    after(() => _resetTierResolutionForTesting());

    it("app_metadata present → uses it, no user_tier_state query", async () => {
        const q = queryStub([]);
        _setTierResolutionDepsForTesting({ query: q.fn });
        const tier = await resolveSupabaseUserTier({
            userId: USER,
            supabaseUserId: SB_USER,
            appMetadata: { tier_level_id: 2, tier_slug: "eulex_plus" },
        });
        assert.equal(tier, 2);
        assert.equal(q.calls.count, 0);
    });

    it("app_metadata absent → falls back to an active user_tier_state row", async () => {
        const q = queryStub([
            { active_tier_level_id: 7, active_tier_until: FUTURE },
        ]);
        _setTierResolutionDepsForTesting({ query: q.fn });
        const tier = await resolveSupabaseUserTier({
            userId: USER,
            supabaseUserId: SB_USER,
            appMetadata: { provider: "email" },
        });
        assert.equal(tier, 7);
        assert.equal(q.calls.count, 1);
    });

    it("fallback row expired → free", async () => {
        const q = queryStub([
            { active_tier_level_id: 7, active_tier_until: PAST },
        ]);
        _setTierResolutionDepsForTesting({ query: q.fn });
        const tier = await resolveSupabaseUserTier({
            userId: USER,
            supabaseUserId: SB_USER,
            appMetadata: undefined,
        });
        assert.equal(tier, FREE);
    });

    it("neither source yields a tier → free (fail closed)", async () => {
        const q = queryStub([]);
        _setTierResolutionDepsForTesting({ query: q.fn });
        const tier = await resolveSupabaseUserTier({
            userId: USER,
            supabaseUserId: SB_USER,
            appMetadata: undefined,
        });
        assert.equal(tier, FREE);
        assert.equal(q.calls.count, 1);
    });

    it("fallback query failure → free, never throws", async () => {
        const q = queryStub([], true);
        _setTierResolutionDepsForTesting({ query: q.fn });
        const tier = await resolveSupabaseUserTier({
            userId: USER,
            supabaseUserId: SB_USER,
            appMetadata: undefined,
        });
        assert.equal(tier, FREE);
    });
});

// ── getFreshSupabaseTier (stale-quota fresh-lookup path) ────────────────

describe("getFreshSupabaseTier", () => {
    beforeEach(() => _resetTierResolutionForTesting());
    after(() => _resetTierResolutionForTesting());

    it("returns error when Supabase admin is not configured", async () => {
        _setTierResolutionDepsForTesting({ isSupabaseConfigured: () => false });
        assert.deepEqual(await getFreshSupabaseTier(SB_USER), { kind: "error" });
    });

    it("reads the tier via admin getUserById and caches it for the TTL", async () => {
        const admin = adminStub(() => ({
            data: { user: { app_metadata: { tier_level_id: 2, tier_slug: "eulex_plus" } } },
            error: null,
        }));
        let now = 1_000_000;
        _setTierResolutionDepsForTesting({
            isSupabaseConfigured: () => true,
            getSupabaseClient: () => admin.client,
            ttlMs: 60_000,
            now: () => now,
        });

        const first = await getFreshSupabaseTier(SB_USER);
        assert.deepEqual(first, {
            kind: "tier",
            tierLevelId: 2,
            tierSlug: "eulex_plus",
        });
        assert.equal(admin.calls.count, 1);

        // Within the TTL — served from cache, no second admin call.
        now += 30_000;
        await getFreshSupabaseTier(SB_USER);
        assert.equal(admin.calls.count, 1);

        // Past the TTL — re-fetched.
        now += 60_001;
        await getFreshSupabaseTier(SB_USER);
        assert.equal(admin.calls.count, 2);
    });

    it("returns none when the auth user no longer exists", async () => {
        const admin = adminStub(() => ({
            data: { user: null },
            error: { message: "User not found" },
        }));
        _setTierResolutionDepsForTesting({
            isSupabaseConfigured: () => true,
            getSupabaseClient: () => admin.client,
        });
        assert.deepEqual(await getFreshSupabaseTier(SB_USER), { kind: "none" });
    });

    it("returns error on admin failure and caches it (no hammering during an outage)", async () => {
        const admin = adminStub(() => ({
            data: { user: null },
            error: { message: "service unavailable" },
        }));
        let now = 2_000_000;
        _setTierResolutionDepsForTesting({
            isSupabaseConfigured: () => true,
            getSupabaseClient: () => admin.client,
            ttlMs: 60_000,
            now: () => now,
        });
        assert.deepEqual(await getFreshSupabaseTier(SB_USER), { kind: "error" });
        now += 1_000;
        assert.deepEqual(await getFreshSupabaseTier(SB_USER), { kind: "error" });
        assert.equal(admin.calls.count, 1);
    });

    it("returns error (keep auth-time tier) when the client throws", async () => {
        _setTierResolutionDepsForTesting({
            isSupabaseConfigured: () => true,
            getSupabaseClient: () => {
                throw new Error("no client");
            },
        });
        assert.deepEqual(await getFreshSupabaseTier(SB_USER), { kind: "error" });
    });
});
