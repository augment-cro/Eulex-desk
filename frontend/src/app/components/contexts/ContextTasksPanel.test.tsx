import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { NextIntlClientProvider } from "next-intl";
import hr from "../../../../messages/hr.json";
import en from "../../../../messages/en.json";
import type { MikeContextTask } from "@/app/lib/mikeApi";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

const contexts = {
    enabled: {} as Record<string, boolean>,
    toggle: vi.fn(async () => ({ ok: true })),
};
vi.mock("@/app/contexts/ContextsContext", () => ({ useContexts: () => contexts }));

const { ContextTasksPanel } = await import("./ContextTasksPanel");

// Plain react-dom rendering: @testing-library/react's `dom` peer is not
// installed (legacy-peer-deps).
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;

const mounted: Root[] = [];

beforeEach(() => {
    push.mockReset();
    contexts.toggle.mockReset();
    contexts.toggle.mockResolvedValue({ ok: true });
    contexts.enabled = {};
});

afterEach(() => {
    mounted.splice(0).forEach((root) => act(() => root.unmount()));
    document.body.innerHTML = "";
});

function renderIn(locale: "hr" | "en", ui: ReactElement): HTMLElement {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push(root);
    act(() =>
        root.render(
            <NextIntlClientProvider
                locale={locale}
                messages={locale === "hr" ? hr : en}
            >
                {ui}
            </NextIntlClientProvider>,
        ),
    );
    return container;
}

const CTX = "8f3c2a10-0000-4000-8000-000000000001";
const tasks: MikeContextTask[] = [
    {
        id: "RT-10",
        name: "Provjera usklađenosti dokumenta",
        name_i18n: { hr: "Provjera usklađenosti dokumenta", en: "Document compliance review" },
        summary: "Provjerava dokument prema zahtjevima.",
        summary_i18n: { hr: "Provjerava dokument prema zahtjevima.", en: "Reviews a document against the requirements." },
        when_i18n: { hr: "Kad imate gotov dokument." },
        inputs: { required: ["Dokument za provjeru"], optional: ["Sektor", "Rok"] },
        output: { kind: "docx", name: "Izvještaj o usklađenosti", name_i18n: { hr: "Izvještaj o usklađenosti", en: "Compliance report" } },
        status: "ready",
    },
    { id: "RT-01", name: "Inventar UI sustava", summary: "Popis sustava.", status: "draft" },
];

const startButtons = (c: HTMLElement) =>
    [...c.querySelectorAll("button")].filter((b) => /Pokreni|Start/.test(b.textContent ?? ""));

describe("ContextTasksPanel — the Zadaci tab", () => {
    it("lists each task with its summary, when, inputs, output and status (hr)", () => {
        const c = renderIn("hr", <ContextTasksPanel contextId={CTX} tasks={tasks} />);
        const items = c.querySelectorAll("li");
        expect(items).toHaveLength(2);
        const first = items[0].textContent ?? "";
        for (const text of [
            "RT-10",
            "Provjera usklađenosti dokumenta",
            "Spremno",
            "Provjerava dokument prema zahtjevima.",
            "KadaKad imate gotov dokument.",
            "PotrebnoDokument za provjeru",
            "NeobaveznoSektor · Rok",
            "RezultatWord dokument — Izvještaj o usklađenosti",
            "Pokreni",
        ]) {
            expect(first).toContain(text);
        }
        expect(items[1].textContent).toContain("U izradi");
        expect(items[1].querySelector("dl")?.textContent).toBe("");
        expect(startButtons(c)).toHaveLength(2);
    });

    it("in English, with the English names", () => {
        const c = renderIn("en", <ContextTasksPanel contextId={CTX} tasks={tasks} />);
        const first = c.querySelector("li")?.textContent ?? "";
        expect(first).toContain("Document compliance review");
        expect(first).toContain("Ready");
        expect(first).toContain("OutputWord document — Compliance report");
        expect(first).toContain("Kad imate gotov dokument."); // no en text → hr
    });

    it("Start switches the context on when it is off, then opens a new chat with the task selected", async () => {
        const c = renderIn("en", <ContextTasksPanel contextId={CTX} tasks={tasks} />);
        await act(async () => startButtons(c)[0].click());
        expect(contexts.toggle).toHaveBeenCalledWith(CTX, true);
        expect(push).toHaveBeenCalledWith(
            `/assistant?${new URLSearchParams({
                workflow: `ctx-${CTX}-RT-10`,
                workflowTitle: "RT-10 Document compliance review",
            }).toString()}`,
        );
    });

    it("an active context is not toggled; a failed switch-on shows an error and opens nothing", async () => {
        contexts.enabled = { [CTX]: true };
        const c = renderIn("hr", <ContextTasksPanel contextId={CTX} tasks={tasks} />);
        await act(async () => startButtons(c)[1].click());
        expect(contexts.toggle).not.toHaveBeenCalled();
        expect(push).toHaveBeenCalledTimes(1);

        push.mockReset();
        contexts.enabled = {};
        contexts.toggle.mockResolvedValue({ ok: false });
        const c2 = renderIn("hr", <ContextTasksPanel contextId={CTX} tasks={tasks} />);
        await act(async () => startButtons(c2)[0].click());
        expect(push).not.toHaveBeenCalled();
        expect(c2.textContent).toContain("Kontekst nije moguće uključiti.");
    });
});
