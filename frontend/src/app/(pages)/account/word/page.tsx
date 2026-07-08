"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { AlertCircle, Copy, Download, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { startPairingCode, type PairingCode } from "@/app/lib/mikeApi";
import { useUserProfile } from "@/contexts/UserProfileContext";
import { ProFeatureLock } from "@/app/components/account/ProFeatureLock";
import { hasProFeatures } from "@/lib/tiers";

function formatRemaining(seconds: number): string {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${s.toString().padStart(2, "0")}`;
}

export default function WordAddinPage() {
    const t = useTranslations("wordAddin");
    const tc = useTranslations("common");
    const { profile } = useUserProfile();

    const [code, setCode] = useState<PairingCode | null>(null);
    const [remaining, setRemaining] = useState(0);
    const [generating, setGenerating] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [copied, setCopied] = useState(false);
    const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);

    const stopTimer = useCallback(() => {
        if (tickRef.current) {
            clearInterval(tickRef.current);
            tickRef.current = null;
        }
    }, []);

    useEffect(() => () => stopTimer(), [stopTimer]);

    const startTimer = useCallback(
        (expiresAt: string) => {
            stopTimer();
            const tick = () => {
                const left = Math.max(
                    0,
                    Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000),
                );
                setRemaining(left);
                if (left <= 0) {
                    stopTimer();
                    setCode(null);
                }
            };
            tick();
            tickRef.current = setInterval(tick, 1000);
        },
        [stopTimer],
    );

    const handleGenerate = useCallback(async () => {
        setGenerating(true);
        setError(null);
        setCopied(false);
        try {
            const c = await startPairingCode();
            setCode(c);
            startTimer(c.expires_at);
        } catch (err) {
            setError(err instanceof Error ? err.message : t("errors.generic"));
        } finally {
            setGenerating(false);
        }
    }, [startTimer, t]);

    const handleCopy = useCallback(() => {
        if (!code) return;
        navigator.clipboard.writeText(code.code).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
        });
    }, [code]);

    // The Word add-in is a Pro entitlement (pairing is the only way the add-in
    // gets a token, and that route is entitlement-gated). Free/plus see the
    // upsell instead of a generator that would 403.
    if (!hasProFeatures(profile?.tierKey)) {
        return <ProFeatureLock kind="word" />;
    }

    return (
        <div className="space-y-8">
            <div className="pb-2">
                <h2 className="text-2xl font-medium font-serif mb-2">
                    {t("title")}
                </h2>
                <p className="text-sm text-muted-foreground max-w-2xl">
                    {t("description")}
                </p>
            </div>

            {/* Step 1: Pairing code */}
            <section className="space-y-3">
                <h3 className="text-lg font-medium">{t("steps.pair.title")}</h3>
                <p className="text-sm text-muted-foreground">
                    {t("steps.pair.description")}
                </p>

                {!code ? (
                    <Button
                        onClick={handleGenerate}
                        disabled={generating}
                        className="bg-primary hover:bg-primary/90 text-primary-foreground"
                    >
                        {generating ? (
                            <>
                                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                                {tc("loading")}
                            </>
                        ) : (
                            t("steps.pair.generate")
                        )}
                    </Button>
                ) : (
                    <div className="rounded-lg border border-border bg-muted p-4 max-w-md space-y-3">
                        <div className="flex items-center justify-between">
                            <span className="text-xs uppercase tracking-wider text-muted-foreground">
                                {t("steps.pair.codeLabel")}
                            </span>
                            <span className="text-xs text-muted-foreground">
                                {t("steps.pair.expiresIn", {
                                    time: formatRemaining(remaining),
                                })}
                            </span>
                        </div>
                        <div className="flex items-center gap-3">
                            <code className="text-3xl font-mono font-medium tracking-widest flex-1">
                                {code.code}
                            </code>
                            <Button
                                variant="outline"
                                size="sm"
                                onClick={handleCopy}
                                className="shrink-0"
                            >
                                <Copy className="h-4 w-4 mr-1" />
                                {copied ? tc("copied") : tc("copy")}
                            </Button>
                        </div>
                        <Button
                            variant="ghost"
                            size="sm"
                            onClick={handleGenerate}
                            disabled={generating}
                            className="text-xs"
                        >
                            <RefreshCw
                                className={`h-3 w-3 mr-1 ${generating ? "animate-spin" : ""}`}
                            />
                            {t("steps.pair.regenerate")}
                        </Button>
                    </div>
                )}

                {error ? (
                    <div className="flex items-start gap-2 text-sm text-destructive">
                        <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
                        <span>{error}</span>
                    </div>
                ) : null}
            </section>

            {/* Step 2: Install in Word */}
            <section className="space-y-3">
                <h3 className="text-lg font-medium">
                    {t("steps.install.title")}
                </h3>
                <ol className="text-sm text-foreground space-y-2 list-decimal pl-5 max-w-2xl">
                    <li>{t("steps.install.step1")}</li>
                    <li>{t("steps.install.step2")}</li>
                    <li>{t("steps.install.step3")}</li>
                    <li>{t("steps.install.step4")}</li>
                </ol>
                <a
                    href="/word-addin/manifest.xml"
                    download="mike-manifest.xml"
                    className="inline-flex items-center gap-2 text-sm text-foreground underline underline-offset-3 font-medium"
                >
                    <Download className="h-4 w-4" />
                    {t("steps.install.downloadManifest")}
                </a>
            </section>

            {/* Step 3: Use in Word */}
            <section className="space-y-3">
                <h3 className="text-lg font-medium">{t("steps.use.title")}</h3>
                <p className="text-sm text-muted-foreground max-w-2xl">
                    {t("steps.use.description")}
                </p>
            </section>
        </div>
    );
}
