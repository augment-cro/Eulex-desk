import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
    _resetBrevoContactsCacheForTesting,
    buildAttributes,
    getBrevoContactsConfig,
    listsFor,
    normalizeLanguage,
    syncSignupContact,
} from "./brevoContacts";

type Call = { url: string; init: RequestInit };
let calls: Call[] = [];
let responses: Array<{ status: number; body: unknown }> = [];
const realFetch = globalThis.fetch;

beforeEach(() => {
    _resetBrevoContactsCacheForTesting();
    calls = [];
    responses = [];
    process.env.BREVO_API_KEY = "k";
    process.env.BREVO_SIGNUP_LIST_ID = "50";
    process.env.BREVO_SIGNUP_LIST_ID_EN = "51";
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), init: init ?? {} });
        const next = responses.shift() ?? { status: 500, body: { message: "no mock" } };
        return new Response(next.status === 204 ? null : JSON.stringify(next.body), { status: next.status });
    }) as typeof fetch;
});

afterEach(() => {
    globalThis.fetch = realFetch;
    delete process.env.BREVO_API_KEY;
    delete process.env.BREVO_SIGNUP_LIST_ID;
    delete process.env.BREVO_SIGNUP_LIST_ID_EN;
});

test("listsFor routes hr → default list, en → en list, and unlinks the other", () => {
    const cfg = getBrevoContactsConfig()!;
    assert.deepEqual(listsFor(cfg, "hr"), { target: 50, unlink: [51] });
    assert.deepEqual(listsFor(cfg, "EN"), { target: 51, unlink: [50] });
    assert.deepEqual(listsFor(cfg, null), { target: 50, unlink: [51] });
    assert.deepEqual(listsFor(cfg, "de"), { target: 50, unlink: [51] });
    assert.equal(normalizeLanguage(undefined), "hr");
    // No EN list configured → everyone in the default list, nothing to unlink.
    delete process.env.BREVO_SIGNUP_LIST_ID_EN;
    _resetBrevoContactsCacheForTesting();
    assert.deepEqual(listsFor(getBrevoContactsConfig()!, "en"), { target: 50, unlink: [] });
});

test("config is off without a list id or key", () => {
    delete process.env.BREVO_SIGNUP_LIST_ID;
    assert.equal(getBrevoContactsConfig(), null);
    process.env.BREVO_SIGNUP_LIST_ID = "abc";
    assert.equal(getBrevoContactsConfig(), null);
    process.env.BREVO_SIGNUP_LIST_ID = "50";
    delete process.env.BREVO_API_KEY;
    assert.equal(getBrevoContactsConfig(), null);
});

test("buildAttributes only emits attributes the account has", () => {
    const both = new Set(["FIRSTNAME", "LASTNAME"]);
    assert.deepEqual(buildAttributes("Ivana  Horvat Kos", both), {
        FIRSTNAME: "Ivana",
        LASTNAME: "Horvat Kos",
    });
    assert.deepEqual(buildAttributes("ivana", both), { FIRSTNAME: "ivana" });
    assert.deepEqual(buildAttributes("Ivana Horvat", new Set(["FIRSTNAME"])), {
        FIRSTNAME: "Ivana",
    });
    assert.deepEqual(buildAttributes("Ivana Horvat", new Set()), {});
    assert.deepEqual(buildAttributes("   ", both), {});
});

test("syncSignupContact upserts into the list with updateEnabled", async () => {
    responses.push({ status: 200, body: { attributes: [{ name: "FIRSTNAME", category: "normal" }, { name: "LASTNAME", category: "normal" }] } });
    responses.push({ status: 201, body: { id: 1 } });
    const r = await syncSignupContact({ email: " Ana@Example.com ", displayName: "Ana Anić" });
    assert.deepEqual(r, { ok: true, created: true });
    assert.equal(calls.length, 2);
    assert.match(calls[0].url, /\/contacts\/attributes$/);
    assert.match(calls[1].url, /\/contacts$/);
    const body = JSON.parse(String(calls[1].init.body));
    assert.deepEqual(body, {
        email: "ana@example.com",
        attributes: { FIRSTNAME: "Ana", LASTNAME: "Anić" },
        listIds: [50],
        unlinkListIds: [51],
        updateEnabled: true,
    });
    assert.equal((calls[1].init.headers as Record<string, string>)["api-key"], "k");
});

test("syncSignupContact reports 204 as updated, moves en users, caches attributes", async () => {
    responses.push({ status: 200, body: { attributes: [] } });
    responses.push({ status: 204, body: {} });
    responses.push({ status: 204, body: {} });
    assert.deepEqual(await syncSignupContact({ email: "a@b.co" }), { ok: true, created: false });
    assert.deepEqual(await syncSignupContact({ email: "c@d.co", language: "en" }), { ok: true, created: false });
    const enBody = JSON.parse(String(calls[2].init.body));
    assert.deepEqual(enBody.listIds, [51]);
    assert.deepEqual(enBody.unlinkListIds, [50]);
    // Attribute lookup happened once for both syncs.
    assert.equal(calls.filter((c) => c.url.endsWith("/attributes")).length, 1);
});

test("syncSignupContact never throws", async () => {
    responses.push({ status: 200, body: { attributes: [] } });
    responses.push({ status: 401, body: { code: "unauthorized", message: "bad key" } });
    const r = await syncSignupContact({ email: "a@b.co" });
    assert.deepEqual(r, { ok: false, error: "Brevo 401: bad key" });

    globalThis.fetch = (async () => { throw new Error("boom"); }) as typeof fetch;
    _resetBrevoContactsCacheForTesting();
    process.env.BREVO_API_KEY = "k";
    process.env.BREVO_SIGNUP_LIST_ID = "50";
    const r2 = await syncSignupContact({ email: "a@b.co" });
    assert.equal(r2.ok, false);

    assert.deepEqual(await syncSignupContact({ email: "not-an-email" }), {
        ok: false, skipped: true, reason: "invalid email",
    });
});
