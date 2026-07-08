"use client";

import { useCallback, useEffect, useState } from "react";
import {
    ALLOWED_MODEL_IDS,
    DEFAULT_MODEL_ID,
    DEFAULT_REASONING_EFFORT,
    REASONING_EFFORT_VALUES,
    modelSupportsReasoningEffort,
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
 *  - **effort** is per-user (DB-persisted via user_profiles.reasoning_effort,
 *    migration 113). Falls through to localStorage during initial profile
 *    load, then to the canonical default ("high"). Optimistic write through
 *    `updateReasoningEffort` so the picker stays snappy.
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
    const { profile, updateReasoningEffort } = useUserProfile();
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

    const profileEffort = profile?.reasoningEffort;
    const validEffort: ReasoningEffort =
        profileEffort &&
        (REASONING_EFFORT_VALUES as readonly string[]).includes(profileEffort)
            ? (profileEffort as ReasoningEffort)
            : DEFAULT_REASONING_EFFORT;

    const setEffort = useCallback(
        (next: ReasoningEffort) => {
            // Fire-and-forget — the context applies the change optimistically
            // and persists it. Errors are swallowed there; the in-flight
            // chat request still picks up the new value via the message
            // payload because the picker re-renders on `profile` change.
            void updateReasoningEffort(next);
        },
        [updateReasoningEffort],
    );

    // Don't ship an effort to the backend for models that ignore it —
    // keeps the request body minimal and avoids any accidental
    // provider-side validation surprises.
    const effectiveEffort = modelSupportsReasoningEffort(model)
        ? validEffort
        : DEFAULT_REASONING_EFFORT;

    return [model, setModel, effectiveEffort, setEffort];
}
