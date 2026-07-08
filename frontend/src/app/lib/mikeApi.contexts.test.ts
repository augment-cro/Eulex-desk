import { describe, it, expect, beforeEach, vi } from "vitest";
import {
    contextsServiceEnabled,
    createContext,
    setContextToggle,
    addContextSource,
    updateContextSource,
    attachContextToWorkflow,
    detachContextFromProject,
    listContexts,
    listContextLinks,
    createContextFromChat,
} from "./mikeApi";

const SERVICE_URL = "https://contexts.example";

function mockFetch(body: unknown, status = 200) {
    const fn = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
        // The core-side service-token mint the contexts client performs
        // before its first service call.
        if (String(input).includes("/service-token/contexts")) {
            return new Response(
                JSON.stringify({ token: "svc-tok", expires_in: 3600 }),
                { status: 200, headers: { "Content-Type": "application/json" } },
            );
        }
        return new Response(JSON.stringify(body), {
            status,
            headers: { "Content-Type": "application/json" },
        });
    });
    vi.stubGlobal("fetch", fn);
    return fn;
}

/** The last non-token call (management functions mint a token first). */
function serviceCall(
    fn: ReturnType<typeof mockFetch>,
): [RequestInfo | URL, RequestInit] {
    const calls = fn.mock.calls.filter(
        ([input]) => !String(input).includes("/service-token/"),
    );
    return calls[calls.length - 1] as [RequestInfo | URL, RequestInit];
}

beforeEach(() => {
    window.localStorage.setItem(
        "mike_oauth_tokens",
        JSON.stringify({ access_token: "tok" }),
    );
    vi.unstubAllGlobals();
    vi.stubEnv("NEXT_PUBLIC_CONTEXTS_URL", SERVICE_URL);
});

describe("mikeApi contexts (management → contexts service)", () => {
    it("createContext POSTs to the service's /manage/contexts with the service token", async () => {
        const fn = mockFetch({ id: "c1", name: "GDPR" });
        const out = await createContext({ name: "GDPR" });
        expect(out.id).toBe("c1");
        const [url, init] = serviceCall(fn);
        expect(String(url)).toBe(`${SERVICE_URL}/manage/contexts`);
        expect(init.method).toBe("POST");
        expect(JSON.parse(String(init.body))).toEqual({ name: "GDPR" });
        expect(
            (init.headers as Record<string, string>).Authorization,
        ).toBe("Bearer svc-tok");
    });

    it("addContextSource POSTs the service's /manage/contexts/:id/sources", async () => {
        const fn = mockFetch({ id: "s1" });
        await addContextSource("c1", {
            kind: "legal_article",
            ref: "32016R0679#art_22",
            mode: "pinned",
        });
        const [url, init] = serviceCall(fn);
        expect(String(url)).toBe(`${SERVICE_URL}/manage/contexts/c1/sources`);
        expect(JSON.parse(String(init.body)).mode).toBe("pinned");
    });

    it("updateContextSource PATCHes the service's /manage/contexts/:id/sources/:sourceId", async () => {
        const fn = mockFetch({ id: "s1", retrieval_note: "n" });
        await updateContextSource("c1", "s1", { retrieval_note: "n" });
        const [url, init] = serviceCall(fn);
        expect(String(url)).toBe(
            `${SERVICE_URL}/manage/contexts/c1/sources/s1`,
        );
        expect(init.method).toBe("PATCH");
        expect(JSON.parse(String(init.body))).toEqual({ retrieval_note: "n" });
    });

    it("createContextFromChat POSTs the transcript + sources to the service", async () => {
        const fn = mockFetch({ context: { id: "c1" }, sources: [] });
        await createContextFromChat({
            name: "From chat",
            transcript: "USER: art 22?",
            sources: [
                { kind: "legal_instrument", ref: "32016R0679", mode: "retrieved" },
            ],
        });
        const [url, init] = serviceCall(fn);
        expect(String(url)).toBe(`${SERVICE_URL}/manage/contexts/from-chat`);
        expect(init.method).toBe("POST");
        expect(JSON.parse(String(init.body)).sources).toHaveLength(1);
    });

    it("without NEXT_PUBLIC_CONTEXTS_URL the feature is dormant: listContexts resolves [] with no fetch", async () => {
        vi.stubEnv("NEXT_PUBLIC_CONTEXTS_URL", "");
        const fn = mockFetch([]);
        expect(contextsServiceEnabled()).toBe(false);
        await expect(listContexts()).resolves.toEqual([]);
        expect(fn).not.toHaveBeenCalled();
    });
});

describe("mikeApi contexts (runtime → core)", () => {
    it("setContextToggle PUTs the core's /contexts/toggles/:id with the user token", async () => {
        const fn = mockFetch({ ok: true });
        await setContextToggle("c1", true);
        const [url, init] = fn.mock.calls[0] as [RequestInfo | URL, RequestInit];
        expect(String(url)).toMatch(/\/contexts\/toggles\/c1$/);
        expect(String(url)).not.toContain(SERVICE_URL);
        expect(init.method).toBe("PUT");
        expect(JSON.parse(String(init.body))).toEqual({ enabled: true });
        expect(
            (init.headers as Record<string, string>).Authorization,
        ).toBe("Bearer tok");
    });

    it("attachContextToWorkflow POSTs the core's /contexts/:id/workflows/:workflowId", async () => {
        const fn = mockFetch({ ok: true });
        await attachContextToWorkflow("c1", "wf1");
        const [url, init] = fn.mock.calls[0] as [RequestInfo | URL, RequestInit];
        expect(String(url)).toMatch(/\/contexts\/c1\/workflows\/wf1$/);
        expect(String(url)).not.toContain(SERVICE_URL);
        expect(init.method).toBe("POST");
    });

    it("detachContextFromProject DELETEs the core's /contexts/:id/projects/:projectId", async () => {
        const fn = mockFetch({});
        await detachContextFromProject("c1", "pr1");
        const [url, init] = fn.mock.calls[0] as [RequestInfo | URL, RequestInit];
        expect(String(url)).toMatch(/\/contexts\/c1\/projects\/pr1$/);
        expect(init.method).toBe("DELETE");
    });

    it("listContextLinks GETs the core's /contexts/:id/links", async () => {
        const fn = mockFetch({ workflows: ["wf1"], projects: [] });
        const out = await listContextLinks("c1");
        expect(out.workflows).toEqual(["wf1"]);
        const [url] = fn.mock.calls[0] as [RequestInfo | URL, RequestInit];
        expect(String(url)).toMatch(/\/contexts\/c1\/links$/);
    });
});
