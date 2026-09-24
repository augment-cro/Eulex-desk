import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
    boundToolOutput,
    buildLiveSessionConfig,
    createWebrtcLiveSession,
    functionName,
    liveTransportFor,
    lawName,
    progressHint,
    responsesDelegation,
    sourceLabels,
    toFunctionTool,
} from "./protocol";
import { liveBackendInstructions, liveInstructions } from "./livePrompt";
import {
    assertInstructionsFit, BUILT_IN_VOICES, frontendClientEvents, liveAlphaHeader, liveVoice,
} from "./protocol";

describe("GA session config", () => {
    it("maps voices: built-in string, custom voice object, unknown → marin", () => {
        assert.equal(liveVoice({ LIVE_VOICE: "cedar" }), "cedar");
        assert.equal(liveVoice({ REALTIME_VOICE: "quartz" }), "quartz");
        assert.deepEqual(liveVoice({ LIVE_VOICE: "voice_abc123" }), { id: "voice_abc123" });
        assert.equal(liveVoice({ LIVE_VOICE: "cove" }), "marin");
        assert.equal(liveVoice({}), "marin");
        assert.equal(BUILT_IN_VOICES.length, 22);
    });
    it("restricts the phone's data channel to what the app actually sends", () => {
        const client = frontendClientEvents("client");
        assert.ok(client.includes("session.commentary.append"));
        assert.ok(!client.includes("response.create"));
        assert.ok(!client.includes("session.update"));
        assert.ok(frontendClientEvents("responses").includes("response.create"));
        const session = buildLiveSessionConfig({ allowedClientEvents: client });
        assert.deepEqual(session.client, { data_channel: { allowed_client_events: client } });
        assert.deepEqual(Object.keys(session).sort(), ["client", "delegation", "model"]);
    });
    it("sends no alpha header unless explicitly configured", () => {
        assert.equal(liveAlphaHeader({}), null);
        assert.equal(liveAlphaHeader({ LIVE_ALPHA_HEADER: "quicksilver=v3" }), "quicksilver=v3");
    });
});

describe("liveTransportFor", () => {
    it("stays on realtime without an API key", () => {
        assert.equal(liveTransportFor("u1", { LIVE_ENABLED: "true" }), "realtime");
    });
    it("LIVE_ENABLED opens live for everyone", () => {
        assert.equal(liveTransportFor("u1", { OPENAI_API_KEY: "k", LIVE_ENABLED: "true" }), "live");
    });
    it("LIVE_USERS gates per user", () => {
        const env = { OPENAI_API_KEY: "k", LIVE_USERS: "a, b" };
        assert.equal(liveTransportFor("a", env), "live");
        assert.equal(liveTransportFor("b", env), "live");
        assert.equal(liveTransportFor("c", env), "realtime");
    });
    it("LIVE_USERS also matches the user's e-mail, case-insensitively", () => {
        const env = { OPENAI_API_KEY: "k", LIVE_USERS: "Someone@Example.com" };
        assert.equal(liveTransportFor("u1", env, "someone@example.com"), "live");
        assert.equal(liveTransportFor("u1", env, "other@example.com"), "realtime");
        assert.equal(liveTransportFor("u1", env, null), "realtime");
    });
});

describe("session config", () => {
    it("is a strict object: no undefined keys, no audio.format for WebRTC", () => {
        const session = buildLiveSessionConfig({
            model: "gpt-live-1",
            instructions: "Be concise.",
            voice: "marin",
            delegation: responsesDelegation({
                model: "gpt-5.6-terra",
                instructions: "backend",
                tools: [toFunctionTool({ name: "search", description: "d", inputSchema: { type: "object" } })],
                parallelToolCalls: true,
            }),
        });
        assert.deepEqual(Object.keys(session).sort(), ["audio", "delegation", "instructions", "model"]);
        assert.deepEqual(session.audio, { output: { voice: "marin" } });
        // GA: context_management je uklonjen; nepoznato polje ruši otvaranje sesije.
        assert.ok(!("context_management" in session));
        const json = JSON.stringify(session);
        assert.ok(!json.includes("undefined"));
        const d = session.delegation as { responses: Record<string, unknown> };
        assert.equal(d.responses.tool_choice, "auto");
        assert.equal(d.responses.parallel_tool_calls, true);
        assert.deepEqual(d.responses.reasoning, { effort: "low" });
        const none = responsesDelegation({ model: "m", reasoningEffort: "none" });
        assert.equal("reasoning" in none.responses, false);
        assert.deepEqual(responsesDelegation({ model: "m", reasoningEffort: "medium" }).responses.reasoning, { effort: "medium" });
    });
    it("omits instructions/audio when not given", () => {
        const session = buildLiveSessionConfig({});
        assert.equal("instructions" in session, false);
        assert.equal("audio" in session, false);
        assert.deepEqual(session.delegation, { type: "client" });
    });
});

describe("function tools", () => {
    it("sanitizes MCP names to the OpenAI function-name charset", () => {
        assert.equal(functionName("eulex.search v2"), "eulex_search_v2");
        assert.equal(functionName("get_article"), "get_article");
        assert.equal(functionName("x".repeat(80)).length, 64);
    });
    it("uses the Responses (flat) function shape", () => {
        const tool = toFunctionTool({ name: "search", description: " Search EUR-Lex ", inputSchema: undefined });
        assert.deepEqual(tool, {
            type: "function",
            name: "search",
            description: "Search EUR-Lex",
            parameters: { type: "object", properties: {} },
            strict: false,
        });
    });
});

describe("boundToolOutput", () => {
    it("returns short output unchanged", () => {
        assert.equal(boundToolOutput("abc", 10), "abc");
    });
    it("cuts on a boundary and says how much was dropped", () => {
        const text = `${"a".repeat(40)}. ${"b".repeat(40)}. ${"c".repeat(40)}`;
        const out = boundToolOutput(text, 90);
        assert.ok(out.startsWith("a".repeat(40) + ". " + "b".repeat(40) + "."));
        assert.match(out, /truncated: \d+ more characters/);
        assert.ok(out.length < text.length + 80);
    });
});

describe("sourceLabels", () => {
    it("labels with article, dedupes and caps", () => {
        const labels = sourceLabels([
            { title: "GDPR", articleLabel: "33", citation: "Uredba (EU) 2016/679", externalUrl: "https://x" },
            { title: "GDPR", articleLabel: "33" },
            { title: "", articleLabel: "1" },
            { title: "Zakon o radu" },
        ]);
        assert.deepEqual(labels.map((l) => l.label), ["GDPR, čl. 33", "Zakon o radu"]);
        assert.equal(labels[0].citation, "Uredba (EU) 2016/679");
        assert.equal(labels[0].url, "https://x");
        assert.equal(labels[1].citation, null);
        assert.equal(sourceLabels(Array.from({ length: 9 }, (_, i) => ({ title: `T${i}` })), 3).length, 3);
    });
    it("does not duplicate an article already in the EULEX title, drops the heading suffix", () => {
        const labels = sourceLabels([
            { title: "Zakon o provedbi Opće uredbe o zaštiti podataka, čl. 34 — Obveza", articleLabel: "Članak 34." },
            { title: "Zakon o kibernetičkoj sigurnosti, čl. 74 — Obveza izvještavanja", articleLabel: "74" },
            { title: "Zakon o radu — pročišćeni tekst", articleLabel: "Članak 7." },
        ]);
        assert.deepEqual(labels.map((l) => l.label), [
            "Zakon o provedbi Opće uredbe o zaštiti podataka, čl. 34",
            "Zakon o kibernetičkoj sigurnosti, čl. 74",
            "Zakon o radu, čl. 7",
        ]);
        assert.equal(labels[0].article, "34");
    });
});

describe("prompts", () => {
    it("fit the startup cap and carry the language", () => {
        for (const lang of ["hr", "en"]) {
            const live = liveInstructions(lang);
            assert.ok(assertInstructionsFit(live) < 2_000);
            assert.match(live, /Delegate to the backend when:/);
            assert.match(live, /Do not delegate to the backend when:/);
            assert.match(liveBackendInstructions(lang), /## Return the result/);
        }
        assert.match(liveInstructions("hr"), /Croatian/);
        assert.match(liveInstructions("en"), /Speak English/);
        // client (zadano): backend streama STATUS/spoken/SILENT; živi model samo nastavlja
        assert.match(liveBackendInstructions("en"), /plain text in English/);
        assert.match(liveBackendInstructions("hr"), /STATUS: answered \| partial \| nothing \| needs_detail/);
        assert.match(liveInstructions("hr"), /A second mind works alongside you/);
        assert.match(liveInstructions("hr"), /never restart/);
        // responses: stariji put, živi model sam izgovara backend stream
        assert.match(liveBackendInstructions("en", "responses"), /Write in English/);
        assert.match(liveInstructions("hr", "responses"), /Keep talking about the topic/);
        assert.ok(assertInstructionsFit(liveInstructions("hr", "responses")) < 2_000);
    });
});

describe("createWebrtcLiveSession", () => {
    const sdp = "v=0\r\n" + "o=- 1 1 IN IP4 127.0.0.1\r\n".repeat(2);
    const session = buildLiveSessionConfig({ model: "gpt-live-1" });

    it("posts the GA body without an alpha header and reads the opaque id + answer", async () => {
        let seen: { url: string; init: RequestInit } | null = null;
        const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
            seen = { url: String(url), init: init ?? {} };
            return new Response(
                JSON.stringify({ session: { id: "rtc_abc" }, transport: { type: "webrtc", sdp: "v=0 answer" } }),
                { status: 201, headers: { "x-request-id": "req_1" } },
            );
        }) as typeof fetch;
        const created = await createWebrtcLiveSession({ session, sdp, apiKey: "k", fetchImpl });
        assert.deepEqual(created, { sessionId: "rtc_abc", answerSdp: "v=0 answer", requestId: "req_1" });
        const headers = seen!.init.headers as Record<string, string>;
        assert.equal(headers["OpenAI-Alpha"], undefined);
        assert.equal(headers.Authorization, "Bearer k");
        assert.equal(headers["Content-Type"], "application/json");
        const body = JSON.parse(String(seen!.init.body));
        assert.deepEqual(body.transport, { type: "webrtc", sdp });
        assert.equal(body.session.model, "gpt-live-1");
    });

    it("surfaces an HTTP failure with its status (not as session.started)", async () => {
        const fetchImpl = (async () => new Response("nope", { status: 403 })) as typeof fetch;
        await assert.rejects(
            createWebrtcLiveSession({ session, sdp, apiKey: "k", fetchImpl }),
            (e: Error & { status?: number }) => e.status === 403 && /live sessions 403/.test(e.message),
        );
    });

    it("rejects a bogus offer before calling upstream", async () => {
        await assert.rejects(
            createWebrtcLiveSession({ session, sdp: "short", apiKey: "k" }),
            (e: Error & { status?: number }) => e.status === 400,
        );
    });
});

describe("progressHint", () => {
    it("names the laws found by a search and the query, without legal content", () => {
        const hint = progressHint({
            tool: "search",
            args: { query: "rok za prijavu povrede osobnih podataka" },
            sources: [
                { label: "Zakon o provedbi Opće uredbe o zaštiti podataka, čl. 34" },
                { label: "Zakon o provedbi Opće uredbe o zaštiti podataka, čl. 40" },
                { label: "Zakon o kibernetičkoj sigurnosti, čl. 74" },
            ],
        });
        assert.ok(hint);
        assert.match(hint!.text, /Zakon o provedbi Opće uredbe o zaštiti podataka; Zakon o kibernetičkoj sigurnosti/);
        assert.match(hint!.text, /"rok za prijavu povrede osobnih podataka"/);
        assert.match(hint!.text, /Do not state any deadline, article number/);
        assert.equal(hint!.key, "Zakon o provedbi Opće uredbe o zaštiti podataka|Zakon o kibernetičkoj sigurnosti");
        assert.ok(!hint!.text.includes("čl. 34"));
    });
    it("search with no hits still narrates the databases; a read with no sources is silent", () => {
        assert.match(progressHint({ tool: "search", args: {}, sources: [] })!.text, /EU and Croatian legal databases/);
        assert.equal(progressHint({ tool: "get_article", args: {}, sources: [] }), null);
        assert.match(progressHint({ tool: "get_article", args: {}, sources: [{ label: "Zakon o radu, čl. 7" }] })!.text, /now reading Zakon o radu/);
    });
    it("lawName strips article and heading", () => {
        assert.equal(lawName("Zakon o radu, čl. 7"), "Zakon o radu");
        assert.equal(lawName("Uredba (EU) 2016/679 — Opća uredba"), "Uredba (EU) 2016/679");
    });
});
