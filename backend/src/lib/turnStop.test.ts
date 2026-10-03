import { test } from "node:test";
import assert from "node:assert/strict";
import {
    activeTurnCount,
    pollTurnStops,
    registerTurn,
    requestTurnStop,
    setTurnStopQueryForTests,
} from "./turnStop";

// Tracker #96: behind Cloud Run a client disconnect never reaches the
// container, so Stop is an explicit request that may land on another
// instance than the one generating.

type Call = { sql: string; params?: unknown[] };

function fakeDb(rows: { chat_id: string; user_id: string; requested_at: Date }[] = []) {
    const calls: Call[] = [];
    setTurnStopQueryForTests((async (sql: string, params?: unknown[]) => {
        calls.push({ sql, params });
        if (/RETURNING chat_id/.test(sql)) return { rows: rows.splice(0) } as never;
        return { rows: [] } as never;
    }) as never);
    return calls;
}

test("a stop on the same instance aborts the turn without touching the DB", async () => {
    const calls = fakeDb();
    const ctrl = new AbortController();
    const unregister = registerTurn("11111111-1111-1111-1111-111111111111", "user-a", ctrl);
    const status = await requestTurnStop("11111111-1111-1111-1111-111111111111", "user-a");
    assert.equal(status, "stopped");
    assert.equal(ctrl.signal.aborted, true);
    assert.equal(calls.length, 0);
    unregister();
    assert.equal(activeTurnCount(), 0);
});

test("another user's stop is not applied locally — it is only recorded", async () => {
    const calls = fakeDb();
    const ctrl = new AbortController();
    const unregister = registerTurn("22222222-2222-2222-2222-222222222222", "user-a", ctrl);
    const status = await requestTurnStop("22222222-2222-2222-2222-222222222222", "user-b");
    assert.equal(status, "requested");
    assert.equal(ctrl.signal.aborted, false);
    assert.ok(calls.some((c) => /INSERT INTO public.turn_stop_requests/.test(c.sql)));
    unregister();
});

test("a stop recorded by another instance aborts the turn on the next poll", async () => {
    const chat = "33333333-3333-3333-3333-333333333333";
    const ctrl = new AbortController();
    const unregister = registerTurn(chat, "user-a", ctrl);
    const calls = fakeDb([{ chat_id: chat, user_id: "user-a", requested_at: new Date() }]);
    await pollTurnStops();
    assert.equal(ctrl.signal.aborted, true);
    assert.deepEqual(calls[0].params, [[chat]]);
    unregister();
});

test("a stale stop from an earlier turn, or another user's, does not abort", async () => {
    const chat = "44444444-4444-4444-4444-444444444444";
    const ctrl = new AbortController();
    const unregister = registerTurn(chat, "user-a", ctrl);
    fakeDb([
        { chat_id: chat, user_id: "user-a", requested_at: new Date(Date.now() - 60_000) },
        { chat_id: chat, user_id: "user-b", requested_at: new Date() },
    ]);
    await pollTurnStops();
    assert.equal(ctrl.signal.aborted, false);
    unregister();
});

test("no live turns → no poll query", async () => {
    const calls = fakeDb();
    await pollTurnStops();
    assert.equal(calls.length, 0);
});

test("a newer turn on the same chat survives the older turn's unregister", async () => {
    fakeDb();
    const chat = "55555555-5555-5555-5555-555555555555";
    const older = registerTurn(chat, "user-a", new AbortController());
    const newerCtrl = new AbortController();
    const newer = registerTurn(chat, "user-a", newerCtrl);
    older();
    assert.equal(await requestTurnStop(chat, "user-a"), "stopped");
    assert.equal(newerCtrl.signal.aborted, true);
    newer();
    assert.equal(activeTurnCount(), 0);
});
