import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const renders = { docx: 0 };
vi.mock("@/app/components/shared/DocxViewer", () => ({
    DocxViewer: () => {
        renders.docx++;
        return null;
    },
}));
vi.mock("@/app/components/shared/DocView", () => ({ DocView: () => null }));

import { ProjectDocxPane } from "./ProjectDocPane";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;

const mounted: Root[] = [];
afterEach(() => {
    mounted.splice(0).forEach((root) => act(() => root.unmount()));
    document.body.innerHTML = "";
    renders.docx = 0;
});

const noop = () => {};
const quotes = [{ page: 1, quote: "u protivnom se ovaj Ugovor raskida" }];

describe("ProjectDocxPane", () => {
    it("does not re-render the viewer when only the chat around it changes", () => {
        let tick: () => void = noop;
        function Page() {
            // Stands in for the chat page re-rendering on every drip frame.
            const [, setFrame] = useState(0);
            tick = () => setFrame((n) => n + 1);
            return (
                <ProjectDocxPane
                    documentId="doc-1"
                    quotes={quotes}
                    onReadyFor={noop}
                    onWarningDismissFor={noop}
                    onScrollChangeFor={noop}
                    onSavedFor={noop}
                />
            );
        }
        const container = document.createElement("div");
        document.body.appendChild(container);
        const root = createRoot(container);
        mounted.push(root);
        act(() => root.render(<Page />));
        expect(renders.docx).toBe(1);
        for (let i = 0; i < 30; i++) act(() => tick());
        expect(renders.docx).toBe(1);
    });
});
