import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import type { PreselectedWorkflow } from "@/app/lib/workflowPreselect";

let search = "";
const replace = vi.fn();
vi.mock("next/navigation", () => ({
    useSearchParams: () => new URLSearchParams(search),
    useRouter: () => ({ replace }),
}));

const { WithWorkflowPreselect } = await import("./InitialView");

// Plain react-dom rendering: @testing-library/react's `dom` peer is not
// installed (legacy-peer-deps).
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;

const mounted: Root[] = [];

beforeEach(() => replace.mockReset());
afterEach(() => {
    mounted.splice(0).forEach((root) => act(() => root.unmount()));
    document.body.innerHTML = "";
});

function render(): (PreselectedWorkflow | null)[] {
    const seen: (PreselectedWorkflow | null)[] = [];
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push(root);
    act(() =>
        root.render(
            <WithWorkflowPreselect>
                {(wf) => {
                    seen.push(wf);
                    return null;
                }}
            </WithWorkflowPreselect>,
        ),
    );
    return seen;
}

describe("new chat — a workflow preselected by the link", () => {
    it("hands the workflow to the composer and drops the parameters from the address", () => {
        search = new URLSearchParams({
            workflow: "ctx-8f3c2a10-0000-4000-8000-000000000001-RT-10",
            workflowTitle: "RT-10 Provjera usklađenosti dokumenta",
        }).toString();
        const seen = render();
        expect(seen[0]).toEqual({
            id: "ctx-8f3c2a10-0000-4000-8000-000000000001-RT-10",
            title: "RT-10 Provjera usklađenosti dokumenta",
            type: "assistant",
        });
        expect(replace).toHaveBeenCalledWith("/assistant", { scroll: false });
    });

    it("an ordinary new chat: no workflow, the address is left alone", () => {
        search = "";
        expect(render()).toEqual([null]);
        expect(replace).not.toHaveBeenCalled();
    });
});
