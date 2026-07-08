"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { LogOut, Check, CreditCard } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { useUserProfile } from "@/contexts/UserProfileContext";
import { PlanCards } from "@/app/components/account/PlanCards";
import { TeamSection } from "@/app/components/account/TeamSection";
import { createBillingPortalSession, deleteAccount } from "@/app/lib/mikeApi";
import { COUNTRIES } from "@/lib/countries";

export default function AccountPage() {
    const router = useRouter();
    const { user, signOut } = useAuth();
    const { profile, updateDisplayName, updateOrganisation, updateCountry, updateVatNumber } =
        useUserProfile();
    const t = useTranslations("account");
    const tc = useTranslations("common");
    const tCountries = useTranslations("countries");
    const [displayName, setDisplayName] = useState("");
    const [isSavingName, setIsSavingName] = useState(false);
    const [saved, setSaved] = useState(false);
    const [organisation, setOrganisation] = useState("");
    const [isSavingOrg, setIsSavingOrg] = useState(false);
    const [orgSaved, setOrgSaved] = useState(false);
    const [country, setCountry] = useState("");
    const [isSavingCountry, setIsSavingCountry] = useState(false);
    const [countrySaved, setCountrySaved] = useState(false);
    const [vatNumber, setVatNumber] = useState("");
    const [isSavingVat, setIsSavingVat] = useState(false);
    const [vatSaved, setVatSaved] = useState(false);
    const [deleteConfirm, setDeleteConfirm] = useState(false);
    const [isDeleting, setIsDeleting] = useState(false);
    const [isOpeningPortal, setIsOpeningPortal] = useState(false);

    useEffect(() => {
        if (profile?.displayName) {
            setDisplayName(profile.displayName);
        }
        if (profile?.organisation) {
            setOrganisation(profile.organisation);
        }
        // Country is stored upper-case; reflect that in the dropdown so
        // the option matches even if a stale lower-case value snuck in
        // from an older client. Empty string → "no country selected".
        setCountry(profile?.country?.toUpperCase() ?? "");
        setVatNumber(profile?.vatNumber ?? "");
    }, [profile]);

    const handleCountryChange = async (next: string) => {
        const previous = country;
        setCountry(next);
        if (next === (profile?.country ?? "")) return;
        setIsSavingCountry(true);
        const success = await updateCountry(next || null);
        setIsSavingCountry(false);
        if (success) {
            setCountrySaved(true);
            setTimeout(() => setCountrySaved(false), 1500);
        } else {
            setCountry(previous);
            alert(t("alerts.failedUpdateCountry"));
        }
    };

    const handleVatChange = async (value: string) => {
        setVatNumber(value);
    };

    const handleVatBlur = async () => {
        const trimmed = vatNumber.trim();
        if (trimmed === (profile?.vatNumber ?? "")) return;
        const previous = profile?.vatNumber ?? "";
        setIsSavingVat(true);
        const success = await updateVatNumber(trimmed || null);
        setIsSavingVat(false);
        if (success) {
            setVatSaved(true);
            setTimeout(() => setVatSaved(false), 1500);
        } else {
            setVatNumber(previous);
            alert(t("alerts.failedUpdateVat"));
        }
    };

    const localizedCountryLabel = (code: string, fallback: string): string => {
        // Localised name lives in messages/<locale>.json under
        // "countries.<CODE>"; if a translator hasn't filled it in yet
        // we fall back to the English label shipped in lib/countries.ts
        // so the UI never shows raw "DE" / "FR".
        const key = `${code}` as Parameters<typeof tCountries>[0];
        try {
            const localized = tCountries(key);
            return localized && localized !== key ? localized : fallback;
        } catch {
            return fallback;
        }
    };

    const handleLogout = async () => {
        await signOut();
        router.push("/");
    };

    const handleOpenBillingPortal = async () => {
        setIsOpeningPortal(true);
        try {
            const { url } = await createBillingPortalSession();
            window.location.href = url;
        } catch {
            setIsOpeningPortal(false);
            alert(t("alerts.failedOpenBillingPortal"));
        }
    };

    const handleDeleteAccount = async () => {
        setIsDeleting(true);
        try {
            await deleteAccount();
            await signOut();
            router.push("/");
        } catch {
            setIsDeleting(false);
            setDeleteConfirm(false);
            alert(t("alerts.failedDeleteAccount"));
        }
    };

    const handleSaveDisplayName = async () => {
        setIsSavingName(true);
        const success = await updateDisplayName(displayName.trim());
        setIsSavingName(false);

        if (success) {
            setSaved(true);
            setTimeout(() => setSaved(false), 2000);
        } else {
            alert(t("alerts.failedUpdateName"));
        }
    };

    const handleSaveOrganisation = async () => {
        setIsSavingOrg(true);
        const success = await updateOrganisation(organisation.trim());
        setIsSavingOrg(false);

        if (success) {
            setOrgSaved(true);
            setTimeout(() => setOrgSaved(false), 2000);
        } else {
            alert(t("alerts.failedUpdateOrg"));
        }
    };

    if (!user) return null;

    return (
        <div className="space-y-4">
            {/* Profile Settings */}
            <div className="pb-6">
                <div className="flex items-center gap-2 mb-4">
                    <h2 className="text-2xl font-medium font-serif">{t("profile.title")}</h2>
                </div>
                <div className="space-y-4">
                    <div>
                        <label className="text-sm text-muted-foreground block mb-2">
                            {t("profile.displayName")}
                        </label>
                        <div className="flex gap-2">
                            <Input
                                type="text"
                                value={displayName}
                                onChange={(e) => setDisplayName(e.target.value)}
                                placeholder={t("profile.displayNamePlaceholder")}
                                className="flex-1"
                            />
                            <Button
                                onClick={handleSaveDisplayName}
                                disabled={
                                    isSavingName || !displayName.trim() || saved
                                }
                                className="min-w-[80px] transition-all bg-primary hover:bg-primary/90 text-primary-foreground"
                            >
                                {isSavingName ? (
                                    tc("saving")
                                ) : saved ? (
                                    <>
                                        <Check className="h-4 w-3" />
                                        {tc("saved")}
                                    </>
                                ) : (
                                    tc("save")
                                )}
                            </Button>
                        </div>
                    </div>
                    <div>
                        <label className="text-sm text-muted-foreground block mb-2">
                            {t("profile.organisation")}
                        </label>
                        <div className="flex gap-2">
                            <Input
                                type="text"
                                value={organisation}
                                onChange={(e) =>
                                    setOrganisation(e.target.value)
                                }
                                placeholder={t("profile.organisationPlaceholder")}
                                className="flex-1"
                            />
                            <Button
                                onClick={handleSaveOrganisation}
                                disabled={
                                    isSavingOrg ||
                                    organisation.trim() ===
                                        (profile?.organisation ?? "") ||
                                    orgSaved
                                }
                                className="min-w-[80px] transition-all bg-primary hover:bg-primary/90 text-primary-foreground"
                            >
                                {isSavingOrg ? (
                                    tc("saving")
                                ) : orgSaved ? (
                                    <>
                                        <Check className="h-4 w-3" />
                                        {tc("saved")}
                                    </>
                                ) : (
                                    tc("save")
                                )}
                            </Button>
                        </div>
                    </div>
                    <div>
                        <label
                            htmlFor="profile-country"
                            className="text-sm text-muted-foreground block mb-2"
                        >
                            {t("profile.country")}
                        </label>
                        <div className="flex items-center gap-2">
                            <select
                                id="profile-country"
                                value={country}
                                onChange={(e) =>
                                    handleCountryChange(e.target.value)
                                }
                                disabled={isSavingCountry}
                                className="flex-1 h-10 rounded-md border border-input bg-surface-elevated px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring/10 disabled:opacity-60"
                            >
                                <option value="">
                                    {t("profile.countryPlaceholder")}
                                </option>
                                {COUNTRIES.map((c) => (
                                    <option key={c.code} value={c.code}>
                                        {localizedCountryLabel(c.code, c.label)}
                                    </option>
                                ))}
                            </select>
                            {countrySaved ? (
                                <span className="text-xs text-success inline-flex items-center gap-1">
                                    <Check className="h-3.5 w-3.5" />
                                    {tc("saved")}
                                </span>
                            ) : isSavingCountry ? (
                                <span className="text-xs text-muted-foreground">
                                    {tc("saving")}
                                </span>
                            ) : null}
                        </div>
                        <p className="text-xs text-muted-foreground mt-1.5">
                            {t("profile.countryHint")}
                        </p>
                    </div>
                    <div>
                        <label
                            htmlFor="profile-vat"
                            className="text-sm text-muted-foreground block mb-2"
                        >
                            {t("profile.vatNumber")}
                        </label>
                        <div className="flex items-center gap-2">
                            <Input
                                id="profile-vat"
                                value={vatNumber}
                                onChange={(e) => handleVatChange(e.target.value)}
                                onBlur={handleVatBlur}
                                disabled={isSavingVat}
                                placeholder={t("profile.vatNumberPlaceholder")}
                                className="flex-1"
                            />
                            {vatSaved ? (
                                <span className="text-xs text-success inline-flex items-center gap-1">
                                    <Check className="h-3.5 w-3.5" />
                                    {tc("saved")}
                                </span>
                            ) : isSavingVat ? (
                                <span className="text-xs text-muted-foreground">
                                    {tc("saving")}
                                </span>
                            ) : null}
                        </div>
                        <p className="text-xs text-muted-foreground mt-1.5">
                            {t("profile.vatNumberHint")}
                        </p>
                    </div>
                    <div>
                        <label className="text-sm text-muted-foreground block mb-2">
                            {t("profile.email")}
                        </label>
                        <p className="text-base">{user?.email}</p>
                    </div>
                </div>
            </div>

            {/* Plan */}
            <div className="py-6">
                <div className="flex items-center gap-2 mb-4">
                    <h2 className="text-2xl font-medium font-serif">
                        {t("plan.title")}
                    </h2>
                </div>
                <PlanCards currentTier={profile?.tierKey} />
                {profile?.tierKey && profile.tierKey !== "free" && (
                    <div className="mt-4">
                        <Button
                            variant="outline"
                            onClick={handleOpenBillingPortal}
                            disabled={isOpeningPortal}
                            className="w-full sm:w-auto"
                        >
                            <CreditCard className="h-4 w-4 mr-2" />
                            {isOpeningPortal
                                ? t("plan.openingBillingPortal")
                                : t("plan.manageBilling")}
                        </Button>
                        <p className="text-xs text-gray-500 mt-1.5">
                            {t("plan.manageBillingHint")}
                        </p>
                    </div>
                )}
            </div>

            {/* Team (self-hides unless the user belongs to a team) */}
            <TeamSection />

            {/* Actions */}
            <div className="py-6">
                <h2 className="text-2xl font-medium font-serif mb-4">
                    {t("actions.title")}
                </h2>
                <Button
                    variant="outline"
                    onClick={handleLogout}
                    className="w-full sm:w-auto"
                >
                    <LogOut className="h-4 w-4 mr-2" />
                    {t("actions.signOut")}
                </Button>
            </div>

            {/* Danger Zone */}
            <div className="py-6">
                <h2 className="text-2xl font-medium font-serif mb-1 text-destructive">
                    {t("danger.title")}
                </h2>
                <p className="text-sm text-muted-foreground mb-4">
                    {t("danger.description")}
                </p>
                {deleteConfirm ? (
                    <div className="rounded-lg border border-destructive/20 bg-destructive/10 p-4 space-y-3 max-w-sm">
                        <p className="text-sm font-medium text-destructive">
                            {t("danger.confirmMessage")}
                        </p>
                        <div className="flex gap-2">
                            <Button
                                variant="outline"
                                onClick={() => setDeleteConfirm(false)}
                                disabled={isDeleting}
                                className="text-sm"
                            >
                                {tc("cancel")}
                            </Button>
                            <Button
                                onClick={handleDeleteAccount}
                                disabled={isDeleting}
                                className="text-sm bg-destructive hover:bg-destructive/90 text-destructive-foreground"
                            >
                                {isDeleting ? t("danger.deleting") : t("danger.deleteAccount")}
                            </Button>
                        </div>
                    </div>
                ) : (
                    <Button
                        variant="outline"
                        onClick={() => setDeleteConfirm(true)}
                        className="w-full sm:w-auto border-destructive/20 text-destructive hover:bg-destructive/10 hover:text-destructive"
                    >
                        {t("danger.deleteAccount")}
                    </Button>
                )}
            </div>
        </div>
    );
}
