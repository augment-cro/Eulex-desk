import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import type { SupabaseClient } from "@supabase/supabase-js";
import { query } from "./db";
import {
    _resetTierLimitsStoreForTesting,
    _setTierLimitsDepsForTesting,
    getAllTierLimits,
    getTierLimitsRow,
    tiersFromSupabase,
    updateTierDefinition,
} from "./tierLimitsStore";

// ── fixtures ────────────────────────────────────────────────────────────

/** A row as the mike DB (pg) returns it: bigints as strings, Date objects. */
const PG_ROW = {
    tier_level_id: "3",
    tier_slug: "eulex_free",
    display_label: "Eulex FREE",
    daily_tokens: "1000000",
    entitlements: { fullWorkbench: false },
    marketing: {},
    updated_at: new Date("2026-01-01T00:00:00.000Z"),
};

/** The same row as Supabase PostgREST returns it: JSON numbers + ISO. */
const SB_ROW = {
    tier_level_id: 3,
    tier_slug: "eulex_free",
    display_label: "Eulex FREE",
    daily_tokens: 1000000,
    entitlements: { fullWorkbench: false },
    marketing: {},
    updated_at: "2026-01-01T00:00:00.000Z",
};

const NORMALIZED = {
    tier_level_id: 3,
    tier_slug: "eulex_free",
    display_label: "Eulex FREE",
    daily_tokens: 1000000,
    entitlements: { fullWorkbench: false },
    marketing: {},
    updated_at: "2026-01-01T00:00:00.000Z",
};

// ── stubs ───────────────────────────────────────────────────────────────

/** Counting stub for lib/db `query` — dispatches on the SQL verb. */
function queryStub(rows: unknown[] = [PG_ROW]) {
    const calls = { select: 0, update: 0 };
    const fn = (async (text: string) => {
        if (/^\s*UPDATE/i.test(text)) {
            calls.update += 1;
            return { rows: [PG_ROW], rowCount: 1 };
        }
        calls.select += 1;
        return { rows, rowCount: rows.length };
    }) as unknown as typeof query;
    return { fn, calls };
}

/** Minimal fake of the supabase service-role client's `.from().select()`. */
function supabaseStub(
    result: () => { data: unknown; error: { message: string } | null },
) {
    const calls = { select: 0 };
    const client = {
        from: (_table: string) => ({
            select: (_cols: string) => {
                calls.select += 1;
                return Promise.resolve(result());
            },
        }),
    } as unknown as SupabaseClient;
    return { client, calls };
}

const neverSupabase = () =>
    ({
        from: () => {
            throw new Error("supabase client must not be used in legacy mode");
        },
    }) as unknown as SupabaseClient;

// ── tests ───────────────────────────────────────────────────────────────

describe("tierLimitsStore", () => {
    beforeEach(() => {
        _resetTierLimitsStoreForTesting();
        delete process.env.TIERS_FROM_SUPABASE;
    });
    after(() => {
        _resetTierLimitsStoreForTesting();
        delete process.env.TIERS_FROM_SUPABASE;
    });

    it("flag off → legacy mike-DB path, supabase never touched", async () => {
        const q = queryStub();
        _setTierLimitsDepsForTesting({
            query: q.fn,
            getSupabaseClient: neverSupabase,
            isSupabaseConfigured: () => true,
        });
        assert.equal(tiersFromSupabase(), false);
        const rows = await getAllTierLimits();
        assert.deepEqual(rows, [NORMALIZED]);
        assert.equal(q.calls.select, 1);
        assert.deepEqual(await getTierLimitsRow(3), NORMALIZED);
        assert.equal(await getTierLimitsRow(99), null);
    });

    it("flag on but supabase unconfigured → still legacy", async () => {
        process.env.TIERS_FROM_SUPABASE = "1";
        const q = queryStub();
        _setTierLimitsDepsForTesting({
            query: q.fn,
            getSupabaseClient: neverSupabase,
            isSupabaseConfigured: () => false,
        });
        assert.equal(tiersFromSupabase(), false);
        assert.deepEqual(await getAllTierLimits(), [NORMALIZED]);
        assert.equal(q.calls.select, 1);
    });

    it("flag on → supabase path, mike DB never queried", async () => {
        process.env.TIERS_FROM_SUPABASE = "1";
        const q = queryStub();
        const sb = supabaseStub(() => ({ data: [SB_ROW], error: null }));
        _setTierLimitsDepsForTesting({
            query: q.fn,
            getSupabaseClient: () => sb.client,
            isSupabaseConfigured: () => true,
        });
        assert.equal(tiersFromSupabase(), true);
        assert.deepEqual(await getAllTierLimits(), [NORMALIZED]);
        assert.equal(sb.calls.select, 1);
        assert.equal(q.calls.select, 0);
    });

    it("cache TTL: repeat reads inside the TTL hit the cache, after it re-fetch", async () => {
        let nowMs = 1_000_000;
        const q = queryStub();
        _setTierLimitsDepsForTesting({
            query: q.fn,
            getSupabaseClient: neverSupabase,
            isSupabaseConfigured: () => false,
            ttlMs: 60_000,
            now: () => nowMs,
        });
        await getAllTierLimits();
        await getAllTierLimits();
        nowMs += 59_999; // still inside the TTL
        await getAllTierLimits();
        assert.equal(q.calls.select, 1);
        nowMs += 2; // past the TTL
        await getAllTierLimits();
        assert.equal(q.calls.select, 2);
    });

    it("supabase failure → serves last-known cached rows (no throw, no mike-DB read)", async () => {
        process.env.TIERS_FROM_SUPABASE = "1";
        let nowMs = 1_000_000;
        let fail = false;
        const q = queryStub();
        const sb = supabaseStub(() =>
            fail
                ? { data: null, error: { message: "postgrest down" } }
                : { data: [SB_ROW], error: null },
        );
        _setTierLimitsDepsForTesting({
            query: q.fn,
            getSupabaseClient: () => sb.client,
            isSupabaseConfigured: () => true,
            ttlMs: 60_000,
            now: () => nowMs,
        });
        assert.deepEqual(await getAllTierLimits(), [NORMALIZED]); // warm cache
        fail = true;
        nowMs += 120_000; // cache stale → re-fetch attempted, fails
        assert.deepEqual(await getAllTierLimits(), [NORMALIZED]); // stale served
        assert.equal(sb.calls.select, 2);
        assert.equal(q.calls.select, 0); // fallback DB untouched while cached
    });

    it("supabase failure with empty cache → falls back to the mike-DB read", async () => {
        process.env.TIERS_FROM_SUPABASE = "1";
        const q = queryStub();
        const sb = supabaseStub(() => ({
            data: null,
            error: { message: "postgrest down" },
        }));
        _setTierLimitsDepsForTesting({
            query: q.fn,
            getSupabaseClient: () => sb.client,
            isSupabaseConfigured: () => true,
        });
        assert.deepEqual(await getAllTierLimits(), [NORMALIZED]);
        assert.equal(sb.calls.select, 1);
        assert.equal(q.calls.select, 1);
    });

    it("a write invalidates the cache so the next read re-fetches", async () => {
        const q = queryStub();
        _setTierLimitsDepsForTesting({
            query: q.fn,
            getSupabaseClient: neverSupabase,
            isSupabaseConfigured: () => false,
            ttlMs: 60_000,
            now: () => 1_000_000, // frozen clock — TTL alone never expires
        });
        await getAllTierLimits();
        await getAllTierLimits();
        assert.equal(q.calls.select, 1);
        const updated = await updateTierDefinition(3, { daily_tokens: 2_000_000 });
        assert.equal(q.calls.update, 1);
        assert.deepEqual(updated, NORMALIZED); // stub returns the fixture row
        await getAllTierLimits();
        assert.equal(q.calls.select, 2); // cache was dropped by the write
    });
});
