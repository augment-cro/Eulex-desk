import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, it, expect, vi } from "vitest";
import { NextIntlClientProvider } from "next-intl";
import hr from "../../../../messages/hr.json";
import en from "../../../../messages/en.json";
import type { UploadFailure } from "@/app/lib/bulkUpload";
import { UploadFailuresAlert } from "./UploadFailuresAlert";
import { TextDocView } from "./TextDocView";

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

const failures: UploadFailure[] = [
    { name: "tablica.xlsx", reason: "unsupported", fileType: "xlsx" },
    { name: "sken.pdf", reason: "too_large" },
    { name: "ugovor.docx", reason: "error" },
];

describe("UploadFailuresAlert", () => {
    it("names each file and why it failed (hr)", () => {
        const onDismiss = vi.fn();
        const container = renderIn(
            "hr",
            <UploadFailuresAlert failures={failures} onDismiss={onDismiss} />,
        );
        const text = container.textContent ?? "";
        expect(text).toContain("3 datoteke nisu učitane");
        expect(text).toContain("tablica.xlsx· nepodržani format (XLSX)");
        expect(text).toContain("sken.pdf· prevelika datoteka (najviše 100 MB)");
        expect(text).toContain("ugovor.docx· učitavanje nije uspjelo");
        expect(text).toContain("Podržani formati: PDF, DOCX, DOC, TXT.");
        const close = container.querySelector<HTMLButtonElement>(
            'button[aria-label="Zatvori"]',
        );
        act(() => close?.click());
        expect(onDismiss).toHaveBeenCalledOnce();
    });

    it("pluralizes in English and renders nothing without failures", () => {
        const one = renderIn(
            "en",
            <UploadFailuresAlert
                failures={failures.slice(0, 1)}
                onDismiss={() => {}}
            />,
        );
        expect(one.textContent).toContain("1 file wasn't uploaded");
        const none = renderIn(
            "en",
            <UploadFailuresAlert failures={[]} onDismiss={() => {}} />,
        );
        expect(none).toBeEmptyDOMElement();
    });
});

describe("TextDocView", () => {
    it("shows the raw text, highlights the cited quote and scrolls to it", () => {
        // jsdom has no Element.scrollTo.
        const scrollTo = vi.fn();
        HTMLElement.prototype.scrollTo = scrollTo;
        const container = renderIn(
            "hr",
            <TextDocView
                text={"Članak 1.\nUgovor se sklapa\nna određeno vrijeme."}
                quotes={["ugovor se sklapa na određeno vrijeme"]}
            />,
        );
        expect(container.querySelector("mark")?.textContent).toBe(
            "Ugovor se sklapa\nna određeno vrijeme",
        );
        expect(container.textContent).toContain("Članak 1.");
        expect(scrollTo).toHaveBeenCalledOnce();
    });

    it("says so when the document has no text", () => {
        const container = renderIn("en", <TextDocView text={"  \n"} />);
        expect(container.textContent).toContain(
            "This document contains no text.",
        );
    });
});
