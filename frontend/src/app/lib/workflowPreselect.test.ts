import { describe, expect, it } from "vitest";
import {
    contextTaskWorkflow,
    readWorkflowPreselect,
    workflowPreselectHref,
} from "./workflowPreselect";

const CTX = "8f3c2a10-0000-4000-8000-000000000001";
const task = {
    id: "RT-10",
    name: "Provjera usklađenosti dokumenta",
    name_i18n: { hr: "Provjera usklađenosti dokumenta", en: "Document compliance review" },
};

describe("workflow preselect", () => {
    it("a context task is the workflow ctx-<context>-<task>, titled in the UI locale", () => {
        expect(contextTaskWorkflow(CTX, task, "hr")).toEqual({
            id: `ctx-${CTX}-RT-10`,
            title: "RT-10 Provjera usklađenosti dokumenta",
            type: "assistant",
        });
        expect(contextTaskWorkflow(CTX, task, "en").title).toBe("RT-10 Document compliance review");
        expect(contextTaskWorkflow(CTX, { id: "RT-02", name: "Klasifikacija" }, "en").title).toBe(
            "RT-02 Klasifikacija",
        );
    });

    it("the new-chat link carries it and reads back the same", () => {
        const wf = contextTaskWorkflow(CTX, task, "hr");
        const href = workflowPreselectHref(wf);
        expect(href.startsWith("/assistant?workflow=ctx-")).toBe(true);
        const params = new URLSearchParams(href.split("?")[1]);
        expect(readWorkflowPreselect(params)).toEqual(wf);
    });

    it("nothing without both parameters, or with over-long ones", () => {
        expect(readWorkflowPreselect(null)).toBeNull();
        expect(readWorkflowPreselect(new URLSearchParams("workflow=x"))).toBeNull();
        expect(readWorkflowPreselect(new URLSearchParams("workflowTitle=x"))).toBeNull();
        expect(
            readWorkflowPreselect(new URLSearchParams({ workflow: "x".repeat(201), workflowTitle: "t" })),
        ).toBeNull();
    });
});
