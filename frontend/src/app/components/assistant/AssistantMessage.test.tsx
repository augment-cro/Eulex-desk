import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, it, expect, vi } from "vitest";
import { NextIntlClientProvider } from "next-intl";
import hr from "../../../../messages/hr.json";
import { AssistantMessage } from "./AssistantMessage";

// Plain react-dom rendering: @testing-library/react's `dom` peer is not
// installed (legacy-peer-deps).
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;

const mounted: Root[] = [];

afterEach(() => {
    mounted.splice(0).forEach((root) => act(() => root.unmount()));
    document.body.innerHTML = "";
});

function render(ui: ReactElement): HTMLElement {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push(root);
    act(() =>
        root.render(
            <NextIntlClientProvider locale="hr" messages={hr}>
                {ui}
            </NextIntlClientProvider>,
        ),
    );
    return container;
}

const euIcon = (c: HTMLElement) => c.querySelector('[data-slot="eu-ai-icon"]');

describe("AssistantMessage — EU icon for AI-generated content", () => {
    it("labels a finished answer in its toolbar", () => {
        const c = render(
            <AssistantMessage
                content="Odgovor."
                events={[{ type: "content", text: "Odgovor." }]}
            />,
        );
        expect(euIcon(c)?.getAttribute("aria-label")).toBe(
            "Sadržaj je izradila umjetna inteligencija (EU oznaka)",
        );
    });

    it("not while streaming, and not on a bare error notice", () => {
        const streaming = render(
            <AssistantMessage
                content="Odg"
                events={[{ type: "content", text: "Odg", isStreaming: true }]}
                isStreaming
            />,
        );
        expect(euIcon(streaming)).toBeNull();
        const error = render(<AssistantMessage content="" events={[]} isError />);
        expect(euIcon(error)).toBeNull();
    });
});

describe("AssistantMessage — the PLAN card", () => {
    it("shows the latest plan above the answer, live while streaming", () => {
        const c = render(
            <AssistantMessage
                content="Radim."
                isStreaming
                events={[
                    { type: "plan_updated", steps: [{ title: "Pročitaj dokument", status: "in_progress" }] },
                    { type: "content", text: "Radim." },
                    {
                        type: "plan_updated",
                        steps: [
                            { title: "Pročitaj dokument", status: "done" },
                            { title: "Izradi izvještaj", status: "in_progress" },
                        ],
                    },
                ]}
            />,
        );
        const cards = c.querySelectorAll('[data-slot="plan-card"]');
        expect(cards).toHaveLength(1);
        expect(cards[0].textContent).toContain("1/2");
        expect(cards[0].textContent).toContain("Izradi izvještaj");
        // Above the answer text.
        const answer = [...c.querySelectorAll("p")].find((p) => p.textContent === "Radim.");
        expect(answer).toBeTruthy();
        expect(
            cards[0].compareDocumentPosition(answer!) & Node.DOCUMENT_POSITION_FOLLOWING,
        ).toBeTruthy();
    });

    it("no card without a plan", () => {
        const c = render(
            <AssistantMessage content="Odgovor." events={[{ type: "content", text: "Odgovor." }]} />,
        );
        expect(c.querySelector('[data-slot="plan-card"]')).toBeNull();
    });
});

describe("AssistantMessage — status tokens as soft dots", () => {
    const answer = [
        "## Razina upozorenja: 🔴 STOP",
        "",
        "Zaključak: 🟡️ REVIEW — vidi `🔴 u kodu`.",
        "",
        "- 🔵 potrebna pravna procjena",
        "- ⚪ nedovoljno informacija",
        "",
        "| 🟢 | Kontrola |",
        "| --- | --- |",
        "| 🟡 | AA-20 |",
        "",
        "```",
        "🔴 blok koda",
        "```",
    ].join("\n");

    it("in headings, paragraphs, list items and table cells — never in code", () => {
        const c = render(<AssistantMessage content={answer} events={[{ type: "content", text: answer }]} />);
        const dots = [...c.querySelectorAll('[data-slot="status-dot"]')];
        expect(dots.map((d) => d.getAttribute("data-status"))).toEqual([
            "problem",
            "gap",
            "assessment",
            "insufficient",
            "clear",
            "gap",
        ]);
        expect(dots[0].closest("h2")).toBeTruthy();
        expect(dots[2].closest("li")).toBeTruthy();
        expect(dots[4].closest("th")).toBeTruthy();
        expect(dots[5].closest("td")).toBeTruthy();
        expect(dots[0].getAttribute("aria-label")).toBe("Materijalni problem");
        // Code keeps the emoji as text.
        const codes = [...c.querySelectorAll("code")].map((e) => e.textContent);
        expect(codes).toContain("🔴 u kodu");
        expect(codes.some((t) => t?.includes("🔴 blok koda"))).toBe(true);
        // The heading still reads as text around the dot.
        expect(c.querySelector("h2")?.textContent).toBe("Razina upozorenja: 🔴 STOP");
    });
});

describe("AssistantMessage — the REZULTAT card", () => {
    const assessment = (version: number) => ({
        assessment_id: "PROC-1A2B",
        version,
        recorded_at: "2026-10-03T10:00:00Z",
        title: "Provjera",
        task_id: "RT-10",
        facts_as_of: null,
        sources_checked_at: null,
        context: null,
        workflow: { id: "ctx-c1-RT-10", title: "RT-10 Provjera usklađenosti dokumenta" },
        facts: [],
        decisions: [],
        findings: [],
        unread_documents: [],
        source_conflicts: [],
        warning: null,
        superseded: [],
        counts: { material: 0, gap: 0, legal: 0, insufficient: 0, ok: 0 },
        total: 0,
    });

    it("shows the latest version under the plan, above the answer; continue goes to the composer", () => {
        const onContinue = vi.fn();
        const c = render(
            <AssistantMessage
                content="Gotovo."
                onContinueAssessment={onContinue}
                events={[
                    { type: "plan_updated", steps: [{ title: "Pročitaj dokument", status: "done" }] },
                    { type: "assessment_recorded", assessment: assessment(1) },
                    { type: "assessment_recorded", assessment: assessment(2) },
                    { type: "content", text: "Gotovo." },
                ]}
            />,
        );
        const cards = c.querySelectorAll('[data-slot="assessment-card"]');
        expect(cards).toHaveLength(1);
        expect(cards[0].getAttribute("aria-label")).toBe("Rezultat · v2");
        const plan = c.querySelector('[data-slot="plan-card"]')!;
        expect(plan.compareDocumentPosition(cards[0]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        const answer = [...c.querySelectorAll("p")].find((p) => p.textContent === "Gotovo.")!;
        expect(cards[0].compareDocumentPosition(answer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        const btn = [...cards[0].querySelectorAll("button")].find((b) => b.textContent === "Nastavi procjenu")!;
        act(() => btn.click());
        expect(onContinue).toHaveBeenCalledWith({
            workflow: { id: "ctx-c1-RT-10", title: "RT-10 Provjera usklađenosti dokumenta", type: "assistant" },
            text: "Nastavi procjenu PROC-1A2B: ",
        });
    });

    it("no continue button while the answer streams", () => {
        const c = render(
            <AssistantMessage
                content=""
                isStreaming
                onContinueAssessment={() => {}}
                events={[{ type: "assessment_recorded", assessment: assessment(1) }]}
            />,
        );
        expect(c.querySelector('[data-slot="assessment-card"]')).toBeTruthy();
        expect(c.textContent).not.toContain("Nastavi procjenu");
    });
});
