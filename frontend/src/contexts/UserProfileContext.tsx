"use client";

import React, {
    createContext,
    useContext,
    useEffect,
    useState,
    ReactNode,
    useCallback,
} from "react";
import { useAuth } from "@/contexts/AuthContext";

interface UserProfile {
    displayName: string | null;
    organisation: string | null;
    /**
     * ISO-3166-1 alpha-2 country code (e.g. "HR", "DE"). Required for
     * Stripe automatic_tax on first checkout — without it the upgrade
     * modal silently falls back to no-VAT pricing. Pulled from UMP on
     * sign-in when the partner side knows it; user can also edit it
     * in the profile page.
     */
    country: string | null;
    /**
     * EU VAT registration number (e.g. "HR12345678901"). Sent to Stripe
     * as customer.tax_id so invoices can show it and zero-rate
     * reverse-charge B2B sales. Pulled from UMP when available; user
     * can also set / clear it in the profile page.
     */
    vatNumber: string | null;
    messageCreditsUsed: number;
    creditsResetDate: string;
    creditsRemaining: number;
    /** Internal users.id (UUID), surfaced by GET /user/profile. */
    id: string | null;
    /** Display tier string from the legacy profile column (e.g. "Free"). */
    tier: string;
    /**
     * Canonical tier key resolved from the authoritative tier_level_id
     * (free / plus / pro / team). Drives entitlement-aware UI such as the
     * Usage Plan cards. Prefer this over the `tier` display string.
     */
    tierKey:
        | "free"
        | "plus"
        | "pro"
        | "legal_pro"
        | "team"
        | "eulex_legal_team"
        | "enterprise";
    tabularModel: string;
    /**
     * User's reasoning-intensity preference for the main composer
     * (Brain icon picker). Persisted in `user_profiles.reasoning_effort`
     * (migration 113) so it survives reloads, sign-outs, and switching
     * devices. Maps 1:1 to provider-native effort/level params.
     */
    reasoningEffort: "low" | "medium" | "high";
    claudeApiKey: string | null;
    geminiApiKey: string | null;
    openaiApiKey: string | null;
    mistralApiKey: string | null;
    /**
     * Booleans (not values) indicating whether the operator has wired
     * up a server-level API key for each provider via env / Secret
     * Manager. When true, the user doesn't need to paste their own key
     * — the Settings UI shows a "shared key available" affordance.
     */
    serverKeys: {
        claude: boolean;
        gemini: boolean;
        openai: boolean;
        mistral: boolean;
    };
    /**
     * PII Shield user defaults (migration 120 + plan §1.5):
     *
     *  - piiDefaultMode: "off" disables the shield entirely; "standard"
     *    anonymizes silently; "strict_legal" requires user review on
     *    every new document; "strict" additionally hard-blocks
     *    hallucinated placeholders.
     *  - piiReviewRequired: force the review modal even in standard
     *    mode.
     *  - piiDisclosurePolicy: how the assistant resolves a placeholder
     *    that an external tool wants to use ("allow" / "deny" / "ask").
     */
    piiDefaultMode: "off" | "standard" | "strict_legal" | "strict";
    piiReviewRequired: boolean;
    piiDisclosurePolicy: "allow" | "deny" | "ask";
}

interface UserProfileContextType {
    profile: UserProfile | null;
    loading: boolean;
    updateDisplayName: (name: string) => Promise<boolean>;
    updateOrganisation: (organisation: string) => Promise<boolean>;
    /**
     * Persist the user's country (ISO-3166-1 alpha-2). Pass `null` (or
     * an empty string) to clear it. The backend validates the format
     * and uppercases the value, but we mirror that locally so optimistic
     * UI updates match what the server will store.
     */
    updateCountry: (country: string | null) => Promise<boolean>;
    /** Persist the user's VAT number. Pass null or "" to clear. */
    updateVatNumber: (vatNumber: string | null) => Promise<boolean>;
    updateModelPreference: (
        field: "tabularModel",
        value: string,
    ) => Promise<boolean>;
    /**
     * Persist the user's reasoning-effort pick to `user_profiles`.
     * Local state flips immediately; the PATCH is fire-and-forget so
     * the picker stays snappy. Returns true on success, false on
     * network error (UI doesn't block on this — the user's pick still
     * applies to the in-flight request via the message payload).
     */
    updateReasoningEffort: (
        value: "low" | "medium" | "high",
    ) => Promise<boolean>;
    /**
     * Persist the PII Shield defaults. Returns true on success.
     * Local state is updated optimistically; backend rejects unknown
     * values silently so a desync would only surface on next reload
     * (and only matters when the migration 120 column is missing).
     */
    updatePiiDefaults: (
        updates: Partial<{
            piiDefaultMode: UserProfile["piiDefaultMode"];
            piiReviewRequired: boolean;
            piiDisclosurePolicy: UserProfile["piiDisclosurePolicy"];
        }>,
    ) => Promise<boolean>;
    reloadProfile: () => Promise<void>;
    incrementMessageCredits: () => Promise<boolean>;
}

const UserProfileContext = createContext<UserProfileContextType | undefined>(
    undefined,
);

const API_BASE =
    process.env.NEXT_PUBLIC_API_BASE_URL?.trim() || "http://localhost:3001";

const MONTHLY_CREDIT_LIMIT = 999999; // temporarily unlimited

import { getStoredTokens } from "@/lib/oauth";

function authHeaders(): Record<string, string> {
    const tokens = getStoredTokens();
    if (!tokens?.access_token) return {};
    return { Authorization: `Bearer ${tokens.access_token}` };
}

async function fetchProfile(): Promise<any> {
    const res = await fetch(`${API_BASE}/user/profile`, {
        headers: { Accept: "application/json", ...authHeaders() },
    });
    if (!res.ok) throw new Error(`Profile fetch failed: ${res.status}`);
    return res.json();
}

async function patchProfile(updates: Record<string, any>): Promise<void> {
    const res = await fetch(`${API_BASE}/user/profile`, {
        method: "PATCH",
        headers: {
            "Content-Type": "application/json",
            ...authHeaders(),
        },
        body: JSON.stringify(updates),
    });
    if (!res.ok) throw new Error(`Profile update failed: ${res.status}`);
}

function mapServerProfile(data: any): UserProfile {
    const creditsUsed = data.message_credits_used ?? 0;
    const rawEffort = data.reasoning_effort;
    const reasoningEffort: "low" | "medium" | "high" =
        rawEffort === "low" || rawEffort === "medium" || rawEffort === "high"
            ? rawEffort
            : "high";
    const rawCountry =
        typeof data.country === "string" ? data.country.trim() : "";
    const country = /^[A-Za-z]{2}$/.test(rawCountry)
        ? rawCountry.toUpperCase()
        : null;
    const rawVat =
        typeof data.vat_number === "string" ? data.vat_number.trim() : "";
    const vatNumber = rawVat.length > 0 ? rawVat : null;
    const PII_MODES: ReadonlyArray<UserProfile["piiDefaultMode"]> = [
        "off",
        "standard",
        "strict_legal",
        "strict",
    ];
    const PII_DISCLOSURE: ReadonlyArray<UserProfile["piiDisclosurePolicy"]> = [
        "allow",
        "deny",
        "ask",
    ];
    const piiDefaultMode: UserProfile["piiDefaultMode"] =
        typeof data.pii_default_mode === "string" &&
        (PII_MODES as readonly string[]).includes(data.pii_default_mode)
            ? (data.pii_default_mode as UserProfile["piiDefaultMode"])
            : "off";
    const piiDisclosurePolicy: UserProfile["piiDisclosurePolicy"] =
        typeof data.pii_disclosure_policy === "string" &&
        (PII_DISCLOSURE as readonly string[]).includes(data.pii_disclosure_policy)
            ? (data.pii_disclosure_policy as UserProfile["piiDisclosurePolicy"])
            : "ask";

    return {
        displayName: data.display_name ?? null,
        organisation: data.organisation ?? null,
        country,
        vatNumber,
        messageCreditsUsed: creditsUsed,
        creditsResetDate:
            data.credits_reset_date ??
            new Date(Date.now() + 30 * 86400000).toISOString(),
        creditsRemaining: MONTHLY_CREDIT_LIMIT - creditsUsed,
        id: (data.id as string | undefined) ?? null,
        tier: data.tier || "Free",
        tierKey: normalizeTierKey(data.tier_key, data.tier),
        tabularModel: data.tabular_model || "claude-sonnet-5",
        reasoningEffort,
        claudeApiKey: data.claude_api_key ?? null,
        geminiApiKey: data.gemini_api_key ?? null,
        openaiApiKey: data.openai_api_key ?? null,
        mistralApiKey: data.mistral_api_key ?? null,
        serverKeys: {
            claude: !!data.server_keys?.claude,
            gemini: !!data.server_keys?.gemini,
            openai: !!data.server_keys?.openai,
            mistral: !!data.server_keys?.mistral,
        },
        piiDefaultMode,
        piiReviewRequired: !!data.pii_review_required,
        piiDisclosurePolicy,
    };
}

/**
 * Resolve the canonical tier key. Prefers the backend's `tier_key`
 * (derived from the authoritative tier_level_id); falls back to parsing
 * the legacy display string so older profile payloads still resolve.
 */
function normalizeTierKey(
    tierKey: unknown,
    tierStr: unknown,
):
    | "free"
    | "plus"
    | "pro"
    | "legal_pro"
    | "team"
    | "eulex_legal_team"
    | "enterprise" {
    const k = typeof tierKey === "string" ? tierKey.toLowerCase() : "";
    if (
        k === "free" ||
        k === "plus" ||
        k === "pro" ||
        k === "legal_pro" ||
        k === "team" ||
        k === "eulex_legal_team" ||
        k === "enterprise"
    )
        return k;
    const s = typeof tierStr === "string" ? tierStr.toLowerCase() : "";
    if (s.includes("enterprise")) return "enterprise";
    if (s.includes("legal") && s.includes("team")) return "eulex_legal_team";
    if (s.includes("legal")) return "legal_pro";
    if (s.includes("team")) return "team";
    if (s.includes("pro")) return "pro";
    if (s.includes("plus")) return "plus";
    return "free";
}

const DEFAULT_PROFILE: UserProfile = {
    displayName: null,
    organisation: null,
    country: null,
    vatNumber: null,
    messageCreditsUsed: 0,
    creditsResetDate: new Date(Date.now() + 30 * 86400000).toISOString(),
    creditsRemaining: MONTHLY_CREDIT_LIMIT,
    id: null,
    tier: "Free",
    tierKey: "free",
    tabularModel: "claude-sonnet-5",
    reasoningEffort: "high",
    claudeApiKey: null,
    geminiApiKey: null,
    openaiApiKey: null,
    mistralApiKey: null,
    serverKeys: {
        claude: false,
        gemini: false,
        openai: false,
        mistral: false,
    },
    piiDefaultMode: "off",
    piiReviewRequired: false,
    piiDisclosurePolicy: "ask",
};

export function UserProfileProvider({ children }: { children: ReactNode }) {
    const { user, isAuthenticated } = useAuth();
    const [profile, setProfile] = useState<UserProfile | null>(null);
    const [loading, setLoading] = useState(true);

    const loadProfile = useCallback(async () => {
        try {
            const data = await fetchProfile();
            const mapped = mapServerProfile(data);

            // Auto-reset credits if past the reset date
            if (
                mapped.creditsResetDate &&
                new Date() > new Date(mapped.creditsResetDate)
            ) {
                const newResetDate = new Date(
                    Date.now() + 30 * 86400000,
                ).toISOString();
                setProfile({
                    ...mapped,
                    messageCreditsUsed: 0,
                    creditsResetDate: newResetDate,
                    creditsRemaining: MONTHLY_CREDIT_LIMIT,
                });
                // Background DB update
                patchProfile({
                    message_credits_used: 0,
                    credits_reset_date: newResetDate,
                }).catch((err) =>
                    console.error("Failed to auto-reset credits", err),
                );
            } else {
                setProfile(mapped);
            }
        } catch {
            setProfile(DEFAULT_PROFILE);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        if (isAuthenticated && user) {
            setLoading(true);
            loadProfile();
        } else {
            setProfile(null);
            setLoading(false);
        }
    }, [isAuthenticated, user, loadProfile]);

    const updateDisplayName = useCallback(
        async (displayName: string): Promise<boolean> => {
            if (!user) return false;
            try {
                await patchProfile({ display_name: displayName });
                setProfile((prev) => (prev ? { ...prev, displayName } : null));
                return true;
            } catch {
                return false;
            }
        },
        [user],
    );

    const updateOrganisation = useCallback(
        async (organisation: string): Promise<boolean> => {
            if (!user) return false;
            try {
                await patchProfile({ organisation });
                setProfile((prev) =>
                    prev ? { ...prev, organisation } : null,
                );
                return true;
            } catch {
                return false;
            }
        },
        [user],
    );

    const updateCountry = useCallback(
        async (country: string | null): Promise<boolean> => {
            if (!user) return false;
            // Empty string and null both map to "clear it" so the user
            // can reset the field. Anything else is normalised the
            // same way the backend does it (uppercase ISO-2) — that
            // keeps the in-memory snapshot identical to what GET will
            // return on the next reload.
            const raw = (country ?? "").trim();
            const normalised = /^[A-Za-z]{2}$/.test(raw)
                ? raw.toUpperCase()
                : null;
            try {
                await patchProfile({ country: normalised ?? "" });
                setProfile((prev) =>
                    prev ? { ...prev, country: normalised } : null,
                );
                return true;
            } catch {
                return false;
            }
        },
        [user],
    );

    const updateVatNumber = useCallback(
        async (vatNumber: string | null): Promise<boolean> => {
            if (!user) return false;
            const normalised =
                typeof vatNumber === "string" && vatNumber.trim().length > 0
                    ? vatNumber.trim()
                    : null;
            try {
                await patchProfile({ vat_number: normalised ?? "" });
                setProfile((prev) =>
                    prev ? { ...prev, vatNumber: normalised } : null,
                );
                return true;
            } catch {
                return false;
            }
        },
        [user],
    );

    const updateModelPreference = useCallback(
        async (
            field: "tabularModel",
            value: string,
        ): Promise<boolean> => {
            if (!user) return false;
            const dbField = field === "tabularModel" ? "tabular_model" : "";
            if (!dbField) return false;
            try {
                await patchProfile({ [dbField]: value });
                setProfile((prev) =>
                    prev ? { ...prev, [field]: value } : null,
                );
                return true;
            } catch {
                return false;
            }
        },
        [user],
    );

    const updateReasoningEffort = useCallback(
        async (value: "low" | "medium" | "high"): Promise<boolean> => {
            if (!user) return false;
            // Optimistic local update so the picker doesn't lag on the
            // network round-trip — backend validates the value too
            // (CHECK constraint + route guard) so we won't desync.
            setProfile((prev) =>
                prev ? { ...prev, reasoningEffort: value } : null,
            );
            try {
                await patchProfile({ reasoning_effort: value });
                return true;
            } catch {
                return false;
            }
        },
        [user],
    );

    const updatePiiDefaults = useCallback(
        async (updates: {
            piiDefaultMode?: UserProfile["piiDefaultMode"];
            piiReviewRequired?: boolean;
            piiDisclosurePolicy?: UserProfile["piiDisclosurePolicy"];
        }): Promise<boolean> => {
            if (!user) return false;
            const payload: Record<string, unknown> = {};
            if (updates.piiDefaultMode !== undefined)
                payload.pii_default_mode = updates.piiDefaultMode;
            if (updates.piiReviewRequired !== undefined)
                payload.pii_review_required = updates.piiReviewRequired;
            if (updates.piiDisclosurePolicy !== undefined)
                payload.pii_disclosure_policy = updates.piiDisclosurePolicy;
            if (Object.keys(payload).length === 0) return true;
            try {
                await patchProfile(payload);
                setProfile((prev) =>
                    prev
                        ? {
                              ...prev,
                              ...(updates.piiDefaultMode !== undefined && {
                                  piiDefaultMode: updates.piiDefaultMode,
                              }),
                              ...(updates.piiReviewRequired !== undefined && {
                                  piiReviewRequired: updates.piiReviewRequired,
                              }),
                              ...(updates.piiDisclosurePolicy !== undefined && {
                                  piiDisclosurePolicy:
                                      updates.piiDisclosurePolicy,
                              }),
                          }
                        : null,
                );
                return true;
            } catch {
                return false;
            }
        },
        [user],
    );

    const reloadProfile = useCallback(async () => {
        if (user) {
            await loadProfile();
        }
    }, [user, loadProfile]);

    const incrementMessageCredits = useCallback(async (): Promise<boolean> => {
        if (!user || !profile) return false;
        if (profile.creditsRemaining <= 0) return false;

        try {
            const newCreditsUsed = profile.messageCreditsUsed + 1;
            await patchProfile({ message_credits_used: newCreditsUsed });
            setProfile((prev) =>
                prev
                    ? {
                          ...prev,
                          messageCreditsUsed: newCreditsUsed,
                          creditsRemaining: MONTHLY_CREDIT_LIMIT - newCreditsUsed,
                      }
                    : null,
            );
            return true;
        } catch {
            return false;
        }
    }, [user, profile]);

    return (
        <UserProfileContext.Provider
            value={{
                profile,
                loading,
                updateDisplayName,
                updateOrganisation,
                updateCountry,
                updateVatNumber,
                updateModelPreference,
                updateReasoningEffort,
                updatePiiDefaults,
                reloadProfile,
                incrementMessageCredits,
            }}
        >
            {children}
        </UserProfileContext.Provider>
    );
}

export function useUserProfile() {
    const context = useContext(UserProfileContext);
    if (context === undefined) {
        throw new Error(
            "useUserProfile must be used within a UserProfileProvider",
        );
    }
    return context;
}
