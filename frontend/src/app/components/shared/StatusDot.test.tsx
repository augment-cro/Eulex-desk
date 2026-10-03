import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, it, expect } from "vitest";
import { NextIntlClientProvider } from "next-intl";
import hr from "../../../../messages/hr.json";
import en from "../../../../messages/en.json";
import { StatusDot, renderStatusTokens } from "./StatusDot";
import { hasStatusToken, splitStatusTokens } from "./statusTokens";

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

describe("status tokens", () => {
    it("splits out exactly the five tokens, with a following variation selector, next to any text", () => {
        expect(splitStatusTokens("Razina upozorenja: 🔴 STOP")).toEqual([
            "Razina upozorenja: ",
            { status: "problem", token: "🔴" },
            " STOP",
        ]);
        expect(splitStatusTokens("⚪️nedovoljno|🟢🟡🔵")).toEqual([
            { status: "insufficient", token: "⚪️" },
            "nedovoljno|",
            { status: "clear", token: "🟢" },
            { status: "gap", token: "🟡" },
            { status: "assessment", token: "🔵" },
        ]);
        // Other circles and emoji stay text.
        expect(splitStatusTokens("🟠 ⚫ ✅ 🔴‍")).toEqual([
            "🟠 ⚫ ✅ ",
            { status: "problem", token: "🔴" },
            "‍",
        ]);
        expect(splitStatusTokens("bez oznake")).toEqual(["bez oznake"]);
        expect(hasStatusToken("a 🟡 b")).toBe(true);
        expect(hasStatusToken("a b")).toBe(false);
    });
});

describe("StatusDot", () => {
    it("is an image named after the status (hr, en), keeping the emoji only for copying", () => {
        const names = (locale: "hr" | "en") =>
            [...renderIn(
                locale,
                <>
                    {(["problem", "gap", "assessment", "insufficient", "clear"] as const).map((s) => (
                        <StatusDot key={s} status={s} token="🔴" />
                    ))}
                </>,
            ).querySelectorAll('[data-slot="status-dot"]')].map((d) => d.getAttribute("aria-label"));
        expect(names("hr")).toEqual([
            "Materijalni problem",
            "Nedostatak",
            "Potrebna pravna procjena",
            "Nedovoljno informacija",
            "Nema materijalnog nedostatka",
        ]);
        expect(names("en")).toEqual([
            "Material problem",
            "Gap",
            "Legal assessment needed",
            "Insufficient information",
            "No material gap",
        ]);
    });

    it("draws with the status tokens only: a pastel fill and a hairline edge; an empty ring for ⚪", () => {
        const c = renderIn(
            "hr",
            <>
                <StatusDot status="problem" token="🔴" />
                <StatusDot status="insufficient" token="⚪" />
            </>,
        );
        const [problem, empty] = c.querySelectorAll('[data-slot="status-dot"]');
        expect(problem.getAttribute("role")).toBe("img");
        expect(problem.className).toContain("bg-status-problem");
        expect(problem.className).toContain("border-status-problem-edge");
        expect(problem.className).toContain("rounded-full");
        expect(problem.querySelector(".sr-only")?.textContent).toBe("🔴");
        expect(empty.className).toContain("bg-transparent");
        expect(empty.className).toContain("border-status-insufficient-edge");
        expect(c.innerHTML).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(/i);
    });

    it("renderStatusTokens leaves plain text alone and draws the tokens in place", () => {
        const c = renderIn("en", <p>{renderStatusTokens("Status: 🟡 REVIEW, then 🟢")}</p>);
        expect([...c.querySelectorAll("[data-status]")].map((d) => d.getAttribute("data-status"))).toEqual([
            "gap",
            "clear",
        ]);
        expect(c.querySelector("p")?.textContent).toBe("Status: 🟡 REVIEW, then 🟢");
        expect(renderStatusTokens("plain")).toBe("plain");
    });
});
