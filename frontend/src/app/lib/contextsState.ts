import type { MikeContextListItem, MikeContextToggle } from "./mikeApi";

/** Max simultaneously active personal contexts (mirrors the backend toggle
 *  cap; EULEX system contexts are exempt). */
export const MAX_ACTIVE = 5;

export interface ContextsState {
    items: MikeContextListItem[];
    enabled: Record<string, boolean>;
    loading: boolean;
}

export const initialContextsState: ContextsState = {
    items: [],
    enabled: {},
    loading: true,
};

export type ContextsAction =
    | {
          type: "loaded";
          items: MikeContextListItem[];
          toggles: MikeContextToggle[];
      }
    | { type: "setEnabled"; id: string; enabled: boolean }
    | { type: "removed"; id: string }
    | { type: "upserted"; item: MikeContextListItem };

export function contextsReducer(
    state: ContextsState,
    action: ContextsAction,
): ContextsState {
    switch (action.type) {
        case "loaded": {
            const enabled: Record<string, boolean> = {};
            for (const t of action.toggles) enabled[t.contextId] = t.enabled;
            return { items: action.items, enabled, loading: false };
        }
        case "setEnabled":
            return {
                ...state,
                enabled: { ...state.enabled, [action.id]: action.enabled },
            };
        case "removed": {
            const enabled = { ...state.enabled };
            delete enabled[action.id];
            return {
                ...state,
                items: state.items.filter((i) => i.context.id !== action.id),
                enabled,
            };
        }
        case "upserted": {
            const rest = state.items.filter(
                (i) => i.context.id !== action.item.context.id,
            );
            return { ...state, items: [action.item, ...rest] };
        }
    }
}

export function activeCount(state: ContextsState): number {
    return Object.values(state.enabled).filter(Boolean).length;
}

/** Active contexts that count toward MAX_ACTIVE — system contexts do not. */
export function cappedActiveCount(state: ContextsState): number {
    const system = new Set(
        state.items
            .filter((i) => i.context.level === "system")
            .map((i) => i.context.id),
    );
    return Object.entries(state.enabled).filter(
        ([id, on]) => on && !system.has(id),
    ).length;
}
