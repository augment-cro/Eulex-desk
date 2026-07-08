"use client";

import { useEffect, useState } from "react";
import { Check, Eye, ShieldCheck } from "lucide-react";
import { useTranslations } from "next-intl";
import { useUserProfile } from "@/contexts/UserProfileContext";
import { piiVersion, type PiiPreviewResult } from "@/app/lib/mikeApi";
import DocumentAnonymizationPreviewModal from "@/app/components/assistant/DocumentAnonymizationPreviewModal";
import { ProFeatureLock } from "@/app/components/account/ProFeatureLock";
import { hasProFeatures } from "@/lib/tiers";

type Mode = "off" | "standard" | "strict_legal" | "strict";
type Disclosure = "allow" | "deny" | "ask";

const MODE_OPTIONS: Array<{ id: Mode; labelKey: string; descKey: string }> = [
    { id: "off", labelKey: "modeOff", descKey: "modeOffDesc" },
    { id: "standard", labelKey: "modeStandard", descKey: "modeStandardDesc" },
    { id: "strict_legal", labelKey: "modeStrictLegal", descKey: "modeStrictLegalDesc" },
    { id: "strict", labelKey: "modeStrict", descKey: "modeStrictDesc" },
];

const DISCLOSURE_OPTIONS: Array<{ id: Disclosure; labelKey: string }> = [
    { id: "ask", labelKey: "disclosureAsk" },
    { id: "allow", labelKey: "disclosureAllow" },
    { id: "deny", labelKey: "disclosureDeny" },
];

export default function PrivacyPage() {
    const t = useTranslations("privacy");
    const { profile, updatePiiDefaults } = useUserProfile();
    const [savedMode, setSavedMode] = useState(false);
    const [savedReview, setSavedReview] = useState(false);
    const [savedDisclosure, setSavedDisclosure] = useState(false);
    const [engineInfo, setEngineInfo] = useState<{
        configured: boolean;
        engine_version?: string;
        ok?: boolean;
    } | null>(null);
    // Demo modal — opens DocumentAnonymizationPreviewModal with a fixed
    // sample so users can see exactly what the review screen looks like
    // before they ever upload a strict-legal document. The "Confirm"
    // path is a no-op in the demo (no real session exists) — closing
    // the modal is the expected end state.
    const [demoPreview, setDemoPreview] = useState<PiiPreviewResult | null>(null);

    useEffect(() => {
        piiVersion()
            .then(setEngineInfo)
            .catch(() => setEngineInfo({ configured: false }));
    }, []);

    if (!profile) {
        return (
            <div className="text-sm text-muted-foreground">
                {t("loading", { default: "Učitavanje…" })}
            </div>
        );
    }

    // PII anonymization is a Pro entitlement — free/plus see the upsell
    // (default mode stays "off"), matching the backend route guard.
    if (!hasProFeatures(profile.tierKey)) {
        return <ProFeatureLock kind="pii" />;
    }

    const handleModeChange = async (mode: Mode) => {
        if (mode === profile.piiDefaultMode) return;
        const ok = await updatePiiDefaults({ piiDefaultMode: mode });
        if (ok) {
            setSavedMode(true);
            setTimeout(() => setSavedMode(false), 1500);
        }
    };

    const handleReviewToggle = async (val: boolean) => {
        const ok = await updatePiiDefaults({ piiReviewRequired: val });
        if (ok) {
            setSavedReview(true);
            setTimeout(() => setSavedReview(false), 1500);
        }
    };

    const handleDisclosureChange = async (policy: Disclosure) => {
        if (policy === profile.piiDisclosurePolicy) return;
        const ok = await updatePiiDefaults({ piiDisclosurePolicy: policy });
        if (ok) {
            setSavedDisclosure(true);
            setTimeout(() => setSavedDisclosure(false), 1500);
        }
    };

    return (
        <div className="space-y-8">
            <header>
                <div className="flex items-center gap-2 mb-2">
                    <ShieldCheck className="h-5 w-5 text-foreground" />
                    <h2 className="text-2xl font-medium font-serif">
                        {t("title", { default: "Privatnost i PII" })}
                    </h2>
                </div>
                <p className="text-sm text-muted-foreground">
                    {t("subtitle", {
                        default:
                            "Postavke privacy proxy-ja koje se primjenjuju na sve chatove dok ne odaberete drugačije po pojedinom razgovoru.",
                    })}
                </p>
                {engineInfo && !engineInfo.configured && (
                    <p className="mt-3 rounded border border-warning/20 bg-warning/10 px-3 py-2 text-sm text-warning">
                        {t("notConfigured", {
                            default:
                                "PII Shield sidecar nije konfiguriran u ovom okruženju — postavke su pohranjene, ali se za sada ne primjenjuju.",
                        })}
                    </p>
                )}
                {engineInfo?.configured && engineInfo.engine_version && (
                    <p className="mt-2 text-xs text-muted-foreground">
                        {t("engineVersion", {
                            default: "Engine verzija",
                            version: engineInfo.engine_version,
                        })}
                        : <code>{engineInfo.engine_version}</code>
                    </p>
                )}
            </header>

            {/* Default mode */}
            <section>
                <h3 className="text-sm font-semibold text-foreground mb-3">
                    {t("modeLabel", { default: "Zadani način rada" })}
                    {savedMode && (
                        <span className="ml-2 inline-flex items-center gap-1 text-success">
                            <Check className="h-3 w-3" /> {t("saved", { default: "Spremljeno" })}
                        </span>
                    )}
                </h3>
                <div className="grid gap-2 max-w-2xl">
                    {MODE_OPTIONS.map((opt) => (
                        <label
                            key={opt.id}
                            className={`flex items-start gap-3 rounded border px-3 py-2 cursor-pointer transition-colors ${
                                profile.piiDefaultMode === opt.id
                                    ? "border-ring bg-accent"
                                    : "border-border hover:bg-accent"
                            }`}
                        >
                            <input
                                type="radio"
                                name="pii-mode"
                                value={opt.id}
                                checked={profile.piiDefaultMode === opt.id}
                                onChange={() => handleModeChange(opt.id)}
                                className="mt-1"
                            />
                            <div>
                                <div className="text-sm font-medium text-foreground">
                                    {t(opt.labelKey, { default: opt.id })}
                                </div>
                                <div className="text-xs text-muted-foreground mt-0.5">
                                    {t(opt.descKey, { default: "" })}
                                </div>
                            </div>
                        </label>
                    ))}
                </div>
            </section>

            {/* Review-required toggle */}
            <section className="max-w-2xl">
                <label className="flex items-center justify-between gap-3 rounded border px-3 py-2">
                    <span>
                        <span className="block text-sm font-medium">
                            {t("reviewRequired", {
                                default: "Uvijek tražiti pregled prije slanja AI-u",
                            })}
                        </span>
                        <span className="block text-xs text-muted-foreground mt-0.5">
                            {t("reviewRequiredDesc", {
                                default:
                                    "I u standardnom načinu otvori modal s pregledom prepoznatih podataka prije prvog AI poziva po dokumentu.",
                            })}
                        </span>
                    </span>
                    <input
                        type="checkbox"
                        checked={profile.piiReviewRequired}
                        onChange={(e) => handleReviewToggle(e.target.checked)}
                    />
                </label>
                {savedReview && (
                    <span className="mt-1 inline-flex items-center gap-1 text-xs text-success">
                        <Check className="h-3 w-3" /> {t("saved", { default: "Spremljeno" })}
                    </span>
                )}
            </section>

            {/* Disclosure policy */}
            <section className="max-w-2xl">
                <h3 className="text-sm font-semibold text-foreground mb-3">
                    {t("disclosureLabel", { default: "Otkrivanje podataka alatima" })}
                </h3>
                <div className="grid gap-2">
                    {DISCLOSURE_OPTIONS.map((opt) => (
                        <label
                            key={opt.id}
                            className={`flex items-center gap-2 rounded border px-3 py-2 cursor-pointer ${
                                profile.piiDisclosurePolicy === opt.id
                                    ? "border-ring bg-accent"
                                    : "border-border hover:bg-accent"
                            }`}
                        >
                            <input
                                type="radio"
                                name="pii-disclosure"
                                checked={profile.piiDisclosurePolicy === opt.id}
                                onChange={() => handleDisclosureChange(opt.id)}
                            />
                            <span className="text-sm">
                                {t(opt.labelKey, { default: opt.id })}
                            </span>
                        </label>
                    ))}
                </div>
                {savedDisclosure && (
                    <span className="mt-1 inline-flex items-center gap-1 text-xs text-success">
                        <Check className="h-3 w-3" /> {t("saved", { default: "Spremljeno" })}
                    </span>
                )}
            </section>

            {/* Review modal demo. The modal itself is identical to the
                production one — same component, same UX. We feed it a
                fixed sample so users can browse the screen and the
                per-row toggles without uploading a real strict-legal
                document. The Confirm click is intentionally a no-op
                in demo mode (no live pii_sessions row to apply
                overrides on). */}
            <section className="max-w-2xl">
                <h3 className="text-sm font-semibold text-foreground mb-3">
                    {t("demoTitle", {
                        default: "Kako izgleda pregled prije slanja AI-u",
                    })}
                </h3>
                <p className="text-xs text-muted-foreground mb-3">
                    {t("demoSubtitle", {
                        default:
                            "U strict modovima i kad je 'uvijek tražiti pregled' uključen, prije svakog AI poziva otvori se modal s prepoznatim podacima. Kliknite niže da vidite kako izgleda na uzorku ugovora.",
                    })}
                </p>
                <button
                    type="button"
                    onClick={() =>
                        setDemoPreview({
                            session_id: "demo-session",
                            preview_text:
                                "UGOVOR O AUTORSKOM DJELU sklopljen između ⟦PII:ORGANIZATION_1⟧, ⟦PII:LOCATION_1⟧, ⟦PII:LOCATION_2⟧, OIB ⟦PII:HR_OIB_1⟧, zastupanog po direktoru ⟦PII:PERSON_1⟧, i dr. ⟦PII:PERSON_2⟧, ⟦PII:LOCATION_3⟧, ⟦PII:LOCATION_4⟧, dana ⟦PII:DATE_TIME_1⟧.",
                            entities: [
                                {
                                    placeholder: "⟦PII:PERSON_1⟧",
                                    entity_type: "PERSON",
                                    start: 0,
                                    end: 0,
                                    score: 0.95,
                                    original_text: "Ivana Primjer",
                                },
                                {
                                    placeholder: "⟦PII:PERSON_2⟧",
                                    entity_type: "PERSON",
                                    start: 0,
                                    end: 0,
                                    score: 0.94,
                                    original_text: "dr. Marko Primjerić",
                                },
                                {
                                    placeholder: "⟦PII:ORGANIZATION_1⟧",
                                    entity_type: "ORGANIZATION",
                                    start: 0,
                                    end: 0,
                                    score: 0.92,
                                    original_text: "Primjer d.o.o.",
                                },
                                {
                                    placeholder: "⟦PII:HR_OIB_1⟧",
                                    entity_type: "HR_OIB",
                                    start: 0,
                                    end: 0,
                                    score: 1.0,
                                    original_text: "00000000001",
                                },
                                {
                                    placeholder: "⟦PII:LOCATION_1⟧",
                                    entity_type: "LOCATION",
                                    start: 0,
                                    end: 0,
                                    score: 0.91,
                                    original_text: "Zagreb",
                                },
                                {
                                    placeholder: "⟦PII:LOCATION_2⟧",
                                    entity_type: "LOCATION",
                                    start: 0,
                                    end: 0,
                                    score: 0.9,
                                    original_text:
                                        "Roberta Frangeša Mihanovića 6",
                                },
                                {
                                    placeholder: "⟦PII:LOCATION_3⟧",
                                    entity_type: "LOCATION",
                                    start: 0,
                                    end: 0,
                                    score: 0.93,
                                    original_text: "Beograd",
                                },
                                {
                                    placeholder: "⟦PII:LOCATION_4⟧",
                                    entity_type: "LOCATION",
                                    start: 0,
                                    end: 0,
                                    score: 0.92,
                                    original_text: "Srbija",
                                },
                                {
                                    placeholder: "⟦PII:DATE_TIME_1⟧",
                                    entity_type: "DATE_TIME",
                                    start: 0,
                                    end: 0,
                                    score: 0.88,
                                    original_text: "15. svibnja 2025.",
                                },
                            ],
                            entity_summary: {
                                PERSON: 2,
                                ORGANIZATION: 1,
                                HR_OIB: 1,
                                LOCATION: 4,
                                DATE_TIME: 1,
                            },
                        })
                    }
                    className="inline-flex items-center gap-2 rounded border border-border bg-accent px-3 py-2 text-sm text-foreground hover:bg-accent"
                >
                    <Eye className="h-4 w-4" />
                    {t("demoButton", { default: "Otvori demo pregled" })}
                </button>
            </section>

            <DocumentAnonymizationPreviewModal
                open={demoPreview !== null}
                preview={demoPreview}
                filename="ugovor o autorskom djelu (demo)"
                demo
                onClose={() => setDemoPreview(null)}
                onConfirm={() => setDemoPreview(null)}
            />
        </div>
    );
}
