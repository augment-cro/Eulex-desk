import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, it, expect } from "vitest";
import { NextIntlClientProvider } from "next-intl";
import hr from "../../../../messages/hr.json";
import en from "../../../../messages/en.json";
import { EuAiIcon } from "./EuAiIcon";

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

describe("EuAiIcon", () => {
    it("is an image with a localized label (hr, en)", () => {
        const svgHr = renderIn("hr", <EuAiIcon />).querySelector("svg");
        expect(svgHr?.getAttribute("role")).toBe("img");
        expect(svgHr?.getAttribute("aria-label")).toBe(
            "EU oznaka za umjetnu inteligenciju",
        );
        const svgEn = renderIn("en", <EuAiIcon />).querySelector("svg");
        expect(svgEn?.getAttribute("aria-label")).toBe(
            "EU label for artificial intelligence",
        );
    });

    it("takes a caller's label and size class", () => {
        const svg = renderIn(
            "hr",
            <EuAiIcon className="size-3" label="Sadržaj je izradila umjetna inteligencija (EU oznaka)" />,
        ).querySelector("svg");
        expect(svg?.getAttribute("aria-label")).toBe(
            "Sadržaj je izradila umjetna inteligencija (EU oznaka)",
        );
        expect(svg?.getAttribute("class")).toContain("size-3");
        expect(svg?.getAttribute("class")).not.toContain("size-3.5");
    });

    it("draws in currentColor with the letters knocked out, cropped to the circle, no literal colour", () => {
        const container = renderIn("hr", <EuAiIcon />);
        const svg = container.querySelector("svg");
        expect(svg?.getAttribute("fill")).toBe("currentColor");
        expect(svg?.getAttribute("viewBox")).toBe("89.28 100.72 365.49 365.49");
        const paths = container.querySelectorAll("path");
        expect(paths).toHaveLength(1);
        expect(paths[0].getAttribute("fill-rule")).toBe("evenodd");
        // circle + letter A (with its counter) + letter I
        expect(paths[0].getAttribute("d")?.match(/M/g)).toHaveLength(4);
        expect(container.innerHTML).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(/i);
    });
});
