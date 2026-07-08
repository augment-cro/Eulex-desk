"use client";

import { useState } from "react";
import { Brain, Check, AlertCircle } from "lucide-react";
import { useTranslations } from "next-intl";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { isModelAvailable } from "@/app/lib/modelAvailability";
import { cn } from "@/lib/utils";

export type ReasoningEffort = "low" | "medium" | "high";

export const REASONING_EFFORT_VALUES: readonly ReasoningEffort[] = [
    "low",
    "medium",
    "high",
] as const;

export const DEFAULT_REASONING_EFFORT: ReasoningEffort = "high";

export interface ModelOption {
    id: string;
    label: string;
    group: "Anthropic" | "Google" | "OpenAI" | "LocalLLM" | "Mistral";
    /**
     * Coarse capability tier reported to analytics as `model_tier` (never
     * the raw model id). Required so a newly added model can't silently
     * ship as "unknown" in metrics.
     */
    tier: "pro" | "standard" | "lite";
    /**
     * Whether this model accepts a reasoning-effort knob. Mirrors the
     * server-side mapping in backend/src/lib/llm/{claude,openai,gemini}.ts:
     *   - Claude 4.x: `output_config.effort`
     *   - GPT-5 family: `reasoning_effort`
     *   - Gemini 3.x: `thinkingConfig.thinkingLevel`
     * LocalLLM and lite/nano tiers don't expose one and silently ignore
     * the value, so we hide the picker for them.
     */
    supportsReasoningEffort?: boolean;
    /**
     * Shape of the reasoning-effort control. "standard" (default) is the
     * Low/Medium/High dial. "binary" is Mistral's none|high switch, shown
     * as "Nema" / "Visoka" — Mistral Small/Medium expose only those two
     * (see the SDK's ReasoningEffort enum), mapped onto the shared
     * low/high effort values.
     */
    reasoningVariant?: "standard" | "binary";
}

export const MODELS: ModelOption[] = [
    {
        id: "claude-sonnet-5",
        label: "Claude Sonnet 5",
        group: "Anthropic",
        tier: "standard",
        supportsReasoningEffort: true,
    },
];

// Primary model for the web composer. Backend deploy ships with ANTHROPIC_API_KEY
// wired from Secret Manager (see cloudbuild.yaml), so every signed-in user
// gets Claude Sonnet 5 by default without pasting their own key.
export const DEFAULT_MODEL_ID = "claude-sonnet-5";

export const ALLOWED_MODEL_IDS = new Set(MODELS.map((m) => m.id));

const REASONING_MODEL_IDS = new Set(
    MODELS.filter((m) => m.supportsReasoningEffort).map((m) => m.id),
);

export function modelSupportsReasoningEffort(modelId: string): boolean {
    return REASONING_MODEL_IDS.has(modelId);
}

const MODEL_TIER_BY_ID = new Map(MODELS.map((m) => [m.id, m.tier]));

/**
 * Coarse `model_tier` analytics label for a model id, straight from the
 * MODELS registry (single source of truth). "unknown" only for ids that
 * aren't in the registry at all.
 */
export function modelTierOf(modelId: string | undefined): string {
    return (modelId && MODEL_TIER_BY_ID.get(modelId)) || "unknown";
}

const GROUP_ORDER: ModelOption["group"][] = [
    "Anthropic",
    "Google",
    "OpenAI",
    "Mistral",
    // LocalLLM is shown last and rendered disabled (greyed out) in the
    // picker — see the `disabled` branch in the item map below.
    "LocalLLM",
];

interface Props {
    value: string;
    onChange: (id: string) => void;
    effort: ReasoningEffort;
    onEffortChange: (effort: ReasoningEffort) => void;
    apiKeys?: {
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
}

export function ModelToggle({
    value,
    onChange,
    effort,
    onEffortChange,
    apiKeys,
}: Props) {
    const t = useTranslations("assistant.modelToggle");
    const [isOpen, setIsOpen] = useState(false);
    const selected = MODELS.find((m) => m.id === value);
    const selectedAvailable = apiKeys
        ? isModelAvailable(value, apiKeys)
        : true;

    const triggerTitle = !selectedAvailable
        ? t("apiKeyMissingTitle")
        : `${t("trigger", { model: selected?.label ?? "Model" })}`;

    return (
        <DropdownMenu onOpenChange={setIsOpen}>
            <DropdownMenuTrigger asChild>
                <button
                    type="button"
                    aria-label={t("triggerAria", {
                        model: selected?.label ?? "Model",
                    })}
                    className={`relative flex items-center justify-center rounded-lg h-8 w-8 transition-colors cursor-pointer text-muted-foreground/70 hover:bg-accent hover:text-foreground ${isOpen ? "bg-secondary text-foreground" : ""}`}
                    title={triggerTitle}
                >
                    <Brain className="h-4 w-4" />
                    {!selectedAvailable && (
                        <AlertCircle className="absolute -top-0.5 -right-0.5 h-3 w-3 text-destructive" />
                    )}
                </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
                className="w-72 z-50"
                side="top"
                align="end"
            >
                {GROUP_ORDER.map((group, gi) => {
                    const items = MODELS.filter((m) => m.group === group);
                    if (items.length === 0) return null;
                    return (
                        <div key={group}>
                            {gi > 0 && <DropdownMenuSeparator />}
                            <DropdownMenuLabel className="text-[10px] uppercase tracking-wider text-muted-foreground/70">
                                {group}
                            </DropdownMenuLabel>
                            {items.map((m) => {
                                // LocalLLM is intentionally shown but not
                                // selectable — greyed out at the bottom of
                                // the list (server-side self-hosted tier).
                                const disabled = m.group === "LocalLLM";
                                const available = apiKeys
                                    ? isModelAvailable(m.id, apiKeys)
                                    : true;
                                const isSelected = m.id === value;
                                const showsEffort =
                                    !!m.supportsReasoningEffort &&
                                    available &&
                                    !disabled;
                                return (
                                    <DropdownMenuItem
                                        key={m.id}
                                        disabled={disabled}
                                        className={cn(
                                            "flex flex-col items-stretch gap-1.5 py-1.5",
                                            disabled
                                                ? "cursor-not-allowed"
                                                : "cursor-pointer",
                                        )}
                                        onSelect={(e) => {
                                            e.preventDefault();
                                            if (disabled) return;
                                            onChange(m.id);
                                        }}
                                    >
                                        <div className="flex items-center w-full">
                                            <span
                                                className={cn(
                                                    "flex-1",
                                                    (!available || disabled) &&
                                                        "text-muted-foreground/70",
                                                )}
                                            >
                                                {m.label}
                                            </span>
                                            {!available && (
                                                <AlertCircle
                                                    className="h-3.5 w-3.5 text-destructive ml-1"
                                                    aria-label={t(
                                                        "apiKeyMissingTitle",
                                                    )}
                                                />
                                            )}
                                            {isSelected && available && !disabled && (
                                                <Check className="h-3.5 w-3.5 text-muted-foreground ml-1" />
                                            )}
                                        </div>
                                        {showsEffort && (
                                            <EffortPicker
                                                variant={m.reasoningVariant}
                                                value={
                                                    isSelected
                                                        ? effort
                                                        : DEFAULT_REASONING_EFFORT
                                                }
                                                onChange={(next) => {
                                                    if (!isSelected)
                                                        onChange(m.id);
                                                    onEffortChange(next);
                                                }}
                                            />
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

interface EffortPickerProps {
    value: ReasoningEffort;
    onChange: (effort: ReasoningEffort) => void;
    variant?: "standard" | "binary";
}

function EffortPicker({ value, onChange, variant = "standard" }: EffortPickerProps) {
    const t = useTranslations("assistant.modelToggle.effort");
    // Mistral exposes only a binary reasoning switch (off | high — see the
    // SDK's ReasoningEffort enum), surfaced as "Nema" / "Visoka". We map it
    // onto the shared low/high effort values so the rest of the effort
    // plumbing needs no separate "none" state; mistral.ts treats anything
    // other than "high" as reasoning off.
    const options: { value: ReasoningEffort; key: string; active: boolean }[] =
        variant === "binary"
            ? [
                  { value: "low", key: "off", active: value !== "high" },
                  { value: "high", key: "high", active: value === "high" },
              ]
            : REASONING_EFFORT_VALUES.map((o) => ({
                  value: o,
                  key: o,
                  active: o === value,
              }));
    return (
        <div
            className="flex items-center gap-1 rounded-md border border-border bg-muted p-0.5"
            role="radiogroup"
            aria-label={t("label")}
        >
            {options.map((opt) => (
                <button
                    key={opt.key}
                    type="button"
                    role="radio"
                    aria-checked={opt.active}
                    title={t(`${opt.key}Title`)}
                    onClick={(e) => {
                        e.stopPropagation();
                        onChange(opt.value);
                    }}
                    className={cn(
                        "flex-1 px-1.5 py-0.5 rounded text-[10px] font-medium transition-colors",
                        opt.active
                            ? "bg-surface-elevated text-foreground border border-border"
                            : "text-muted-foreground hover:text-foreground",
                    )}
                >
                    {t(opt.key)}
                </button>
            ))}
        </div>
    );
}
