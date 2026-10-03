import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { NextIntlClientProvider } from "next-intl";
import hr from "../../../../messages/hr.json";
import { TextDocView } from "./TextDocView";
import { isMarkdownFilename } from "./rehypeMarkRanges";

// Plain react-dom rendering: @testing-library/react's `dom` peer is not
// installed (legacy-peer-deps).
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// jsdom has no element scrolling; the view centres the first highlight.
Element.prototype.scrollTo ??= () => {};

const mounted: Root[] = [];
afterEach(() => {
    mounted.splice(0).forEach((root) => act(() => root.unmount()));
    document.body.innerHTML = "";
});

function render(ui: React.ReactElement): HTMLElement {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push(root);
    act(() => root.render(<NextIntlClientProvider locale="hr" messages={hr}>{ui}</NextIntlClientProvider>));
    return container;
}

// A Compliance Checker part as the context ingests it.
const CHECKER = [
    "# EU AI Act Compliance Checker — dio 4 (str. 18–27)",
    "",
    "[str. 27]",
    "#### QAIS 6.5.1 Profiling of natural persons",
    "",
    "**Točno pitanje**",
    "",
    "Is your AI system perform profiling of natural persons?",
    "",
    "| Odgovor | Sljedeće |",
    "|---|---|",
    "| **[0]** Yes | exception refused |",
].join("\n");

describe("TextDocView — Markdown documents", () => {
    it("renders headings, bold, tables and the [str. N] label as a page divider — no raw ####, ** or pipes", () => {
        const c = render(<TextDocView text={CHECKER} markdown />);
        const doc = c.querySelector('[data-slot="markdown-doc"]')!;
        expect(doc.querySelector("h1")?.textContent).toContain("dio 4");
        expect(doc.querySelector("h4")?.textContent).toBe("QAIS 6.5.1 Profiling of natural persons");
        expect(doc.querySelector("strong")?.textContent).toBe("Točno pitanje");
        expect(doc.querySelectorAll("table td")).toHaveLength(2);
        expect(doc.querySelector("[data-page-marker]")?.textContent).toBe("str. 27");
        expect(doc.textContent).not.toMatch(/####|\*\*|\|---/);
    });

    it("highlights the cited passage inside the rendered text", () => {
        const c = render(
            <TextDocView text={CHECKER} markdown quotes={["Is your AI system perform profiling of natural persons?"]} />,
        );
        const marks = [...c.querySelectorAll("mark[data-quote-mark]")];
        expect(marks.map((m) => m.textContent).join("")).toBe("Is your AI system perform profiling of natural persons?");
    });

    it("a quote across formatting is still marked, piece by piece", () => {
        const c = render(<TextDocView text={"Prvi **važan** dio teksta."} markdown quotes={["Prvi važan dio"]} />);
        // The quote is found in the raw text only when the markup is part of
        // it; without a match nothing is marked and nothing breaks.
        expect(c.querySelector('[data-slot="markdown-doc"] p')?.textContent).toBe("Prvi važan dio teksta.");
    });

    it("without markdown the raw text stays as it was", () => {
        const c = render(<TextDocView text={"# Naslov\n**x**"} quotes={["Naslov"]} />);
        expect(c.querySelector('[data-slot="markdown-doc"]')).toBeNull();
        expect(c.textContent).toContain("# Naslov");
        expect(c.querySelector("mark")?.textContent).toBe("Naslov");
    });

    it("a .md file name turns Markdown on", () => {
        expect(isMarkdownFilename("EULEX — Compliance Checker, karta pitanja.md")).toBe(true);
        expect(isMarkdownFilename("Preporuka.txt")).toBe(false);
        expect(isMarkdownFilename(undefined)).toBe(false);
    });
});
