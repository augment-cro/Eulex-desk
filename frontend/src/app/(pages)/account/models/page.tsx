"use client";

import { useState } from "react";
import {
    AlertCircle,
    Check,
    ChevronDown,
    ShieldCheck,
} from "lucide-react";
import { useTranslations } from "next-intl";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useUserProfile } from "@/contexts/UserProfileContext";
import { MODELS } from "@/app/components/assistant/ModelToggle";
import {
    isModelAvailable,
    modelGroupToProvider,
    providerLabel,
} from "@/app/lib/modelAvailability";

// All providers (Claude, OpenAI, Google, Mistral) now run exclusively
// through server-level API keys configured in Secret Manager. BYOK was
// removed 2026-05 so the tier-based rate limiter and cost forensics
// stay authoritative — see backend/src/lib/userSettings.ts:pickKey.
export default function ModelsAndApiKeysPage() {
    const { profile, updateModelPreference } = useUserProfile();
    const t = useTranslations("models");

    return (
        <div className="space-y-4">
            {/* Model Preferences */}
            <div className="pb-6">
                <div className="flex items-center gap-2 mb-4">
                    <h2 className="text-2xl font-medium font-serif">
                        {t("title")}
                    </h2>
                </div>
                <div className="space-y-4 max-w-md">
                    <div>
                        <label className="text-sm text-muted-foreground block mb-2">
                            {t("tabularModel")}
                        </label>
                        <TabularModelDropdown
                            value={profile?.tabularModel ?? "claude-sonnet-5"}
                            apiKeys={{
                                claudeApiKey: null,
                                geminiApiKey: null,
                                openaiApiKey: null,
                                mistralApiKey: null,
                                serverKeys: profile?.serverKeys,
                            }}
                            onChange={(id) =>
                                updateModelPreference("tabularModel", id)
                            }
                        />
                        <p className="text-xs text-muted-foreground mt-2">
                            {t("localLlmNote")}
                        </p>
                    </div>
                </div>
            </div>

            {/* Server-managed providers notice */}
            <div className="py-6">
                <div className="flex items-center gap-2 mb-3">
                    <h2 className="text-2xl font-medium font-serif">
                        {t("apiKeys.title")}
                    </h2>
                </div>
                <div className="max-w-xl rounded-lg border border-success/20 bg-success/10 p-4 flex items-start gap-3">
                    <ShieldCheck className="h-5 w-5 text-success mt-0.5 shrink-0" />
                    <div className="text-sm text-success space-y-1">
                        <p className="font-medium">
                            {t("apiKeys.serverManagedTitle")}
                        </p>
                        <p className="text-success/90">
                            {t("apiKeys.serverManagedDescription")}
                        </p>
                    </div>
                </div>
            </div>
        </div>
    );
}

function TabularModelDropdown({
    value,
    onChange,
    apiKeys,
}: {
    value: string;
    onChange: (id: string) => void;
    apiKeys: {
        claudeApiKey: string | null;
        geminiApiKey: string | null;
        openaiApiKey: string | null;
        mistralApiKey: string | null;
        serverKeys?: {
            claude?: boolean;
            gemini?: boolean;
            openai?: boolean;
            mistral?: boolean;
        };
    };
}) {
    const t = useTranslations("models");
    const [isOpen, setIsOpen] = useState(false);
    const selected = MODELS.find((m) => m.id === value);
    const selectedAvailable = isModelAvailable(value, apiKeys);
    const groups: ("LocalLLM" | "Anthropic" | "Google" | "OpenAI" | "Mistral")[] = ["LocalLLM", "Anthropic", "Google", "OpenAI", "Mistral"];

    return (
        <DropdownMenu onOpenChange={setIsOpen}>
            <DropdownMenuTrigger asChild>
                <button
                    type="button"
                    className="w-full h-9 rounded-md border border-input bg-surface-elevated px-3 text-sm flex items-center justify-between gap-2 hover:bg-accent focus:outline-none focus:ring-2 focus:ring-ring/10"
                >
                    <span className="flex items-center gap-2 min-w-0">
                        {!selectedAvailable && (
                            <AlertCircle className="h-3.5 w-3.5 shrink-0 text-destructive" />
                        )}
                        <span className="truncate text-foreground">
                            {selected?.label ?? t("selectModel")}
                        </span>
                    </span>
                    <ChevronDown
                        className={`h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform duration-200 ${isOpen ? "rotate-180" : ""}`}
                    />
                </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
                className="z-50"
                style={{ width: "var(--radix-dropdown-menu-trigger-width)" }}
                align="start"
            >
                {groups.map((group, gi) => {
                    const items = MODELS.filter((m) => m.group === group);
                    if (items.length === 0) return null;
                    return (
                        <div key={group}>
                            {gi > 0 && <DropdownMenuSeparator />}
                            <DropdownMenuLabel className="text-[10px] uppercase tracking-wider text-muted-foreground/70">
                                {group}
                            </DropdownMenuLabel>
                            {items.map((m) => {
                                const provider = modelGroupToProvider(m.group);
                                const available = isModelAvailable(
                                    m.id,
                                    apiKeys,
                                );
                                const tooltip = !available && m.group !== "LocalLLM"
                                    ? t("apiKeys.addKeyTooltip", { provider: providerLabel(provider) })
                                    : undefined;
                                return (
                                    <DropdownMenuItem
                                        key={m.id}
                                        className="cursor-pointer"
                                        onSelect={() => onChange(m.id)}
                                        title={tooltip}
                                    >
                                        <span
                                            className={`flex-1 ${available ? "" : m.group === "LocalLLM" ? "" : "text-muted-foreground/70"}`}
                                        >
                                            {m.label}
                                        </span>
                                        {!available && m.group !== "LocalLLM" && (
                                            <AlertCircle className="h-3.5 w-3.5 text-destructive ml-1" />
                                        )}
                                        {m.id === value && available && (
                                            <Check className="h-3.5 w-3.5 text-muted-foreground ml-1" />
                                        )}
                                    </DropdownMenuItem>
                                );
                            })}
                        </div>
                    );
                })}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
