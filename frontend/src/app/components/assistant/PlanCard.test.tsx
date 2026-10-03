import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, it, expect } from "vitest";
import { NextIntlClientProvider } from "next-intl";
import hr from "../../../../messages/hr.json";
import en from "../../../../messages/en.json";
import { PlanCard } from "./PlanCard";
import { latestPlanSteps, parsePlanSteps } from "./planSteps";
import type { PlanStep } from "../shared/types";

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

const steps: PlanStep[] = [
    { title: "Pročitaj dokument", status: "done" },
    { title: "Provjeri AA-20 … AA-27", status: "in_progress" },
    { title: "Izradi izvještaj", status: "pending" },
    { title: "Potpis odgovorne osobe", status: "blocked", note: "nedostaje ovlaštenje" },
];

describe("PlanCard", () => {
    it("one line per step with a status mark, the note in muted text, done/total (hr)", () => {
        const c = renderIn("hr", <PlanCard steps={steps} />);
        const card = c.querySelector('[data-slot="plan-card"]');
        expect(card?.getAttribute("aria-label")).toBe("Plan");
        const items = [...c.querySelectorAll("li")];
        expect(items.map((li) => li.querySelector("[role=img]")?.getAttribute("aria-label"))).toEqual([
            "Gotovo",
            "U tijeku",
            "Na čekanju",
            "Blokirano",
        ]);
        expect(items[3].textContent).toBe("Potpis odgovorne osobenedostaje ovlaštenje");
        expect(items[3].querySelector(".text-muted-foreground")?.textContent).toBe(
            "nedostaje ovlaštenje",
        );
        expect(items[3].querySelector("[role=img]")?.getAttribute("class")).toContain("text-warning");
        expect(c.textContent).toContain("1/4");
        const bar = c.querySelector("[role=progressbar]");
        expect(bar?.getAttribute("aria-label")).toBe("Gotovo 1 od 4");
        expect(bar?.getAttribute("aria-valuenow")).toBe("1");
        expect((bar?.firstElementChild as HTMLElement).style.width).toBe("25%");
    });

    it("draws status tokens in step titles and notes as dots", () => {
        const c = renderIn(
            "hr",
            <PlanCard
                steps={[{ title: "AA-20 🔴 STOP", status: "blocked", note: "🟡 nedostaje dokaz" }]}
            />,
        );
        const dots = [...c.querySelectorAll('[data-slot="status-dot"]')];
        expect(dots.map((d) => d.getAttribute("aria-label"))).toEqual([
            "Materijalni problem",
            "Nedostatak",
        ]);
    });

    it("in English; nothing for an empty plan", () => {
        const c = renderIn("en", <PlanCard steps={steps} />);
        expect(c.querySelector("[role=progressbar]")?.getAttribute("aria-label")).toBe("1 of 4 done");
        expect(c.querySelector("li [role=img]")?.getAttribute("aria-label")).toBe("Done");
        const empty = renderIn("en", <PlanCard steps={[]} />);
        expect(empty.innerHTML).toBe("");
    });
});

describe("plan steps", () => {
    it("parses a streamed plan, dropping malformed steps", () => {
        expect(
            parsePlanSteps([
                { title: "a", status: "done", note: "" },
                { title: "b", status: "finished" },
                { status: "pending" },
                { title: "c", status: "blocked", note: "zašto" },
            ]),
        ).toEqual([
            { title: "a", status: "done" },
            { title: "c", status: "blocked", note: "zašto" },
        ]);
        expect(parsePlanSteps(null)).toEqual([]);
    });

    it("a message shows its latest plan", () => {
        expect(latestPlanSteps(undefined)).toBeNull();
        expect(latestPlanSteps([{ type: "content", text: "x" }])).toBeNull();
        expect(
            latestPlanSteps([
                { type: "plan_updated", steps: [{ title: "a", status: "pending" }] },
                { type: "content", text: "x" },
                { type: "plan_updated", steps: [{ title: "a", status: "done" }] },
            ]),
        ).toEqual([{ title: "a", status: "done" }]);
    });
});
