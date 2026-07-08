import { describe, it, expect } from "vitest";
import {
    contextsReducer,
    activeCount,
    initialContextsState,
    MAX_ACTIVE,
} from "./contextsState";
import type { MikeContext, MikeContextListItem } from "./mikeApi";

const item = (id: string): MikeContextListItem => ({
    context: { id } as MikeContext,
    isOwner: true,
    allowEdit: true,
});

describe("contextsReducer", () => {
    it("loads items + toggles", () => {
        const s = contextsReducer(initialContextsState, {
            type: "loaded",
            items: [item("a")],
            toggles: [{ contextId: "a", enabled: true }],
        });
        expect(s.items.length).toBe(1);
        expect(s.enabled.a).toBe(true);
        expect(s.loading).toBe(false);
        expect(activeCount(s)).toBe(1);
    });

    it("setEnabled flips one context", () => {
        let s = contextsReducer(initialContextsState, {
            type: "loaded",
            items: [item("a")],
            toggles: [],
        });
        s = contextsReducer(s, { type: "setEnabled", id: "a", enabled: true });
        expect(s.enabled.a).toBe(true);
    });

    it("removed drops item + its enabled flag", () => {
        let s = contextsReducer(initialContextsState, {
            type: "loaded",
            items: [item("a")],
            toggles: [{ contextId: "a", enabled: true }],
        });
        s = contextsReducer(s, { type: "removed", id: "a" });
        expect(s.items.length).toBe(0);
        expect(s.enabled.a).toBeUndefined();
    });

    it("upserted replaces an existing item and prepends new ones", () => {
        let s = contextsReducer(initialContextsState, {
            type: "loaded",
            items: [item("a")],
            toggles: [],
        });
        s = contextsReducer(s, { type: "upserted", item: item("b") });
        expect(s.items.map((i) => i.context.id)).toEqual(["b", "a"]);
        s = contextsReducer(s, { type: "upserted", item: item("a") });
        expect(s.items.length).toBe(2);
    });

    it("MAX_ACTIVE is 5", () => {
        expect(MAX_ACTIVE).toBe(5);
    });
});
