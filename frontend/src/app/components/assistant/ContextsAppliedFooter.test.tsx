import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, it, expect } from "vitest";
import { NextIntlClientProvider } from "next-intl";
import hr from "../../../../messages/hr.json";
import en from "../../../../messages/en.json";
import { ContextsAppliedFooter } from "./ContextsAppliedFooter";

// Plain react-dom rendering: @testing-library/react's `dom` peer is not
// installed (legacy-peer-deps).
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;

const mounted: Root[] = [];

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

describe("ContextsAppliedFooter — what the answer ran without", () => {
    it("names each one in a warning line under the contexts (hr)", () => {
        const container = renderIn(
            "hr",
            <ContextsAppliedFooter
                event={{
                    type: "contexts_applied",
                    contexts: [{ id: "p", name: "Moj kontekst", level: "personal" }],
                    unavailable: [
                        { kind: "context", name: "", id: "unknown" },
                        { kind: "document", name: "AZOP smjernice" },
                    ],
                }}
            />,
        );
        const warning = container.querySelector("p.text-warning");
        expect(warning?.textContent).toBe(
            "Nije učitano: aktivni kontekst, AZOP smjernice",
        );
        expect(container.textContent).toContain("Moj kontekst");
    });

    it("shows the warning alone when the only context failed (en); nothing when all loaded and none active", () => {
        const container = renderIn(
            "en",
            <ContextsAppliedFooter
                event={{
                    type: "contexts_applied",
                    contexts: [],
                    unavailable: [{ kind: "context", name: "", id: "c1" }],
                }}
            />,
        );
        expect(container.textContent).toBe("Not loaded: an active context");
        const empty = renderIn(
            "en",
            <ContextsAppliedFooter event={{ type: "contexts_applied", contexts: [] }} />,
        );
        expect(empty.innerHTML).toBe("");
    });

    it("no warning line when everything loaded", () => {
        const container = renderIn(
            "hr",
            <ContextsAppliedFooter
                event={{
                    type: "contexts_applied",
                    contexts: [{ id: "p", name: "Moj kontekst", level: "personal" }],
                }}
            />,
        );
        expect(container.querySelector(".text-warning")).toBeNull();
    });
});
