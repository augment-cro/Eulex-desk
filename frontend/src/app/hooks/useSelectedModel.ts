"use client";

import { useCallback, useEffect, useState } from "react";
import {
    ALLOWED_MODEL_IDS,
    DEFAULT_MODEL_ID,
    DEFAULT_REASONING_EFFORT,
    type ReasoningEffort,
} from "../components/assistant/ModelToggle";
import { useUserProfile } from "@/contexts/UserProfileContext";

const STORAGE_KEY = "mike.selectedModel";

const LEGACY_MODEL_ALIASES: Record<string, string> = {
    "claude-opus-4-7": "claude-opus-4-8",
};

function readStoredModel(): string {
    if (typeof window === "undefined") return DEFAULT_MODEL_ID;
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const resolved = raw ? (LEGACY_MODEL_ALIASES[raw] ?? raw) : null;
    if (resolved && ALLOWED_MODEL_IDS.has(resolved)) return resolved;
    return DEFAULT_MODEL_ID;
}

/**
 * Single source of truth for the chat composer's model + reasoning-effort
 * pick.
 *
 *  - **model** is per-browser (localStorage). Per-device makes sense for
 *    the picker since the relevant API keys / available providers can
 *    vary by environment.
 *  - **effort** is fixed at DEFAULT_REASONING_EFFORT ("high") for the main
 *    composer. The composer has had no effort picker since 2026-06-04, so the
 *    stored user_profiles.reasoning_effort is invisible to the user and must
 *    not silently steer answers (a stale 'medium'/'low' row would otherwise
 *    downgrade every turn). `setEffort` still persists the profile value for
 *    surfaces that expose a dial.
 *
 * The returned `effective` effort is automatically clamped to the default
 * for models that don't expose a reasoning dial — that way nothing is sent
 * over the wire when it would be silently ignored anyway.
 */
export function useSelectedModel(): [
    string,
    (id: string) => void,
    ReasoningEffort,
    (effort: ReasoningEffort) => void,
] {
    const { updateReasoningEffort } = useUserProfile();
    const [model, setModelState] = useState<string>(DEFAULT_MODEL_ID);

    useEffect(() => {
        setModelState(readStoredModel());
    }, []);

    const setModel = useCallback((id: string) => {
        const next = ALLOWED_MODEL_IDS.has(id) ? id : DEFAULT_MODEL_ID;
        setModelState(next);
        if (typeof window !== "undefined") {
            window.localStorage.setItem(STORAGE_KEY, next);
        }
    }, []);

    const setEffort = useCallback(
        (next: ReasoningEffort) => {
            // Fire-and-forget — the context applies the change optimistically
            // and persists it. Errors are swallowed there. The main composer
            // does not read it back (effort is fixed, see above).
            void updateReasoningEffort(next);
        },
        [updateReasoningEffort],
    );

    // No picker in the composer → always the product default (see above).
    const effectiveEffort = DEFAULT_REASONING_EFFORT;

    return [model, setModel, effectiveEffort, setEffort];
}
