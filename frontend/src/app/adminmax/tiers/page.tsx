"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
    AdminUnauthorizedError,
    clearAdminToken,
    createTier,
    getAdminToken,
    getEntitlementCatalog,
    listTiers,
    updateTier,
    type AdminTierLimit,
    type EntitlementDef,
    type PlanLocaleCopy,
    type PlanMarketing,
    type TierEntitlements,
} from "../lib/adminApi";

/** Fields the row's Save sends back up to the parent. */
type TierPatch = {
    display_label?: string;
    daily_tokens?: number;
    entitlements?: TierEntitlements;
    marketing?: PlanMarketing;
};

function fmtInt(n: number): string {
    return new Intl.NumberFormat("hr-HR").format(n);
}

function fmtDate(s: string | null): string {
    if (!s) return "—";
    try {
        return new Date(s).toLocaleString("hr-HR", {
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
        });
    } catch {
        return s;
    }
}

export default function AdminMaxTiersPage() {
    const router = useRouter();
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [tiers, setTiers] = useState<AdminTierLimit[]>([]);
    const [catalog, setCatalog] = useState<EntitlementDef[]>([]);
    const [savingId, setSavingId] = useState<number | null>(null);

    useEffect(() => {
        if (!getAdminToken()) {
            router.replace("/adminmax/login");
        }
    }, [router]);

    async function load() {
        setLoading(true);
        setError(null);
        try {
            const [tiersRes, catalogRes] = await Promise.all([
                listTiers(),
                getEntitlementCatalog(),
            ]);
            setTiers(tiersRes.tiers);
            setCatalog(catalogRes.catalog);
        } catch (err) {
            if (err instanceof AdminUnauthorizedError) {
                router.replace("/adminmax/login");
                return;
            }
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setLoading(false);
        }
    }

    useEffect(() => {
        if (!getAdminToken()) return;
        load();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    async function saveRow(t: AdminTierLimit, next: TierPatch) {
        setSavingId(t.tier_level_id);
        setError(null);
        try {
            const res = await updateTier(t.tier_level_id, {
                daily_tokens: next.daily_tokens ?? t.daily_tokens,
                display_label: next.display_label ?? t.display_label,
                entitlements: next.entitlements ?? t.entitlements,
                ...(next.marketing ? { marketing: next.marketing } : {}),
            });
            setTiers((rows) =>
                rows.map((r) =>
                    r.tier_level_id === t.tier_level_id ? res.tier : r,
                ),
            );
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setSavingId(null);
        }
    }

    function logout() {
        clearAdminToken();
        router.replace("/adminmax/login");
    }

    return (
        <div className="space-y-6">
            <div className="flex items-end justify-between gap-4 border-b border-border pb-4">
                <div>
                    <h1 className="font-serif text-2xl font-semibold tracking-tight">
                        AdminMax · Tier limiti
                    </h1>
                    <p className="text-sm text-muted-foreground">
                        Dnevni token limit po pretplati (rolling 24h prozor).
                        Promjena stupa na snagu pri sljedećem pozivu rate
                        limitera.
                    </p>
                </div>
                <div className="flex items-end gap-3">
                    <Link
                        href="/adminmax"
                        className="rounded-md border border-border px-3 py-1.5 text-sm font-medium text-foreground hover:bg-accent"
                    >
                        ← Potrošnja
                    </Link>
                    <button
                        onClick={load}
                        disabled={loading}
                        className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                    >
                        {loading ? "Učitavam…" : "Osvježi"}
                    </button>
                    <button
                        onClick={logout}
                        className="rounded-md border border-border px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground"
                    >
                        Odjava
                    </button>
                </div>
            </div>

            {error && (
                <div className="rounded-md border border-destructive/20 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                    {error}
                </div>
            )}

            <div className="overflow-hidden rounded-lg border border-border">
                <table className="w-full text-sm">
                    <thead className="bg-muted text-muted-foreground">
                        <tr>
                            <th className="px-4 py-2 text-left text-xs font-medium uppercase tracking-wide">
                                ID
                            </th>
                            <th className="px-4 py-2 text-left text-xs font-medium uppercase tracking-wide">
                                Slug
                            </th>
                            <th className="px-4 py-2 text-left text-xs font-medium uppercase tracking-wide">
                                Naziv
                            </th>
                            <th className="px-4 py-2 text-right text-xs font-medium uppercase tracking-wide">
                                Daily tokens
                            </th>
                            <th className="px-4 py-2 text-left text-xs font-medium uppercase tracking-wide">
                                Ažurirano
                            </th>
                            <th />
                        </tr>
                    </thead>
                    <tbody>
                        {tiers.length === 0 && !loading && (
                            <tr>
                                <td
                                    colSpan={6}
                                    className="px-4 py-6 text-center text-muted-foreground/70"
                                >
                                    Nema definiranih tierova.
                                </td>
                            </tr>
                        )}
                        {tiers.map((t) => (
                            <TierRow
                                key={t.tier_level_id}
                                tier={t}
                                catalog={catalog}
                                saving={savingId === t.tier_level_id}
                                onSave={(patch) => saveRow(t, patch)}
                            />
                        ))}
                    </tbody>
                </table>
            </div>

            <NewTierForm
                onCreated={async (t) => {
                    try {
                        await createTier(t);
                        await load();
                    } catch (err) {
                        setError(err instanceof Error ? err.message : String(err));
                    }
                }}
            />
        </div>
    );
}

const GROUP_LABELS: Record<string, string> = {
    workbench: "Workbench",
    sharing: "Dijeljenje",
    export: "Export",
    billing: "Naplata",
    coverage: "Coverage",
    pro: "Pro značajke",
    team: "Team (enforcement uskoro)",
};

/** Derive the canonical tier key from a slug so the editor can show the
 *  right catalog default for entitlement keys missing from the jsonb. */
function tierKeyFromSlug(slug: string): "free" | "plus" | "pro" | "team" {
    const s = slug.toLowerCase();
    if (s.includes("team")) return "team";
    if (s.includes("pro")) return "pro";
    if (s.includes("plus")) return "plus";
    return "free";
}

/** Materialise an editable entitlement map: stored jsonb value wins,
 *  catalog default for this tier backfills any absent key. */
function buildEnt(
    tier: AdminTierLimit,
    catalog: EntitlementDef[],
): TierEntitlements {
    const tk = tierKeyFromSlug(tier.tier_slug);
    const out: TierEntitlements = {};
    for (const def of catalog) {
        const cur = tier.entitlements?.[def.key];
        if (def.type === "bool") {
            out[def.key] =
                typeof cur === "boolean" ? cur : Boolean(def.defaults[tk]);
        } else {
            out[def.key] =
                typeof cur === "number" ? cur : Number(def.defaults[tk] ?? 0);
        }
    }
    return out;
}

function emptyLocaleCopy(): PlanLocaleCopy {
    return { name: "", tagline: "", price: "", period: "", intro: "", cta: "", features: [] };
}

/** Materialise an editable marketing object from the stored jsonb. */
function buildMkt(tier: AdminTierLimit): PlanMarketing {
    const m = tier.marketing as Partial<PlanMarketing> | undefined;
    const locales = (m as { locales?: { hr?: Partial<PlanLocaleCopy>; en?: Partial<PlanLocaleCopy> } })
        ?.locales;
    const mk = (l?: Partial<PlanLocaleCopy>): PlanLocaleCopy => ({
        name: l?.name ?? "",
        tagline: l?.tagline ?? "",
        price: l?.price ?? "",
        period: l?.period ?? "",
        intro: l?.intro ?? "",
        cta: l?.cta ?? "",
        features: Array.isArray(l?.features) ? (l!.features as string[]) : [],
    });
    return {
        order: typeof m?.order === "number" ? m.order : 0,
        popular: Boolean(m?.popular),
        locales: { hr: mk(locales?.hr), en: mk(locales?.en) },
    };
}

function TierRow({
    tier,
    catalog,
    saving,
    onSave,
}: {
    tier: AdminTierLimit;
    catalog: EntitlementDef[];
    saving: boolean;
    onSave: (patch: TierPatch) => void;
}) {
    const [label, setLabel] = useState(tier.display_label);
    const [tokens, setTokens] = useState(String(tier.daily_tokens));
    const [ent, setEnt] = useState<TierEntitlements>(() =>
        buildEnt(tier, catalog),
    );
    const [mkt, setMkt] = useState<PlanMarketing>(() => buildMkt(tier));
    const [expanded, setExpanded] = useState(false);
    const [mktExpanded, setMktExpanded] = useState(false);

    useEffect(() => {
        setLabel(tier.display_label);
        setTokens(String(tier.daily_tokens));
        setEnt(buildEnt(tier, catalog));
        setMkt(buildMkt(tier));
    }, [tier, catalog]);

    const entDirty =
        JSON.stringify(ent) !== JSON.stringify(buildEnt(tier, catalog));
    const mktDirty = JSON.stringify(mkt) !== JSON.stringify(buildMkt(tier));
    const dirty =
        label !== tier.display_label ||
        Number(tokens) !== tier.daily_tokens ||
        entDirty ||
        mktDirty;

    const groups: string[] = [];
    for (const def of catalog) {
        if (!groups.includes(def.group)) groups.push(def.group);
    }

    function save() {
        // Trim + drop empty feature lines before persisting.
        const cleanLoc = (l: PlanLocaleCopy): PlanLocaleCopy => ({
            ...l,
            features: l.features.map((s) => s.trim()).filter(Boolean),
        });
        const cleanMkt: PlanMarketing = {
            order: mkt.order,
            popular: mkt.popular,
            locales: { hr: cleanLoc(mkt.locales.hr), en: cleanLoc(mkt.locales.en) },
        };
        onSave({
            display_label: label,
            daily_tokens: Math.max(0, Number(tokens) || 0),
            entitlements: ent,
            marketing: cleanMkt,
        });
    }

    return (
        <>
            <tr className="border-t border-border hover:bg-accent">
                <td className="px-4 py-2 font-mono text-xs text-muted-foreground">
                    {tier.tier_level_id}
                </td>
                <td className="px-4 py-2 font-mono text-xs text-foreground">
                    {tier.tier_slug}
                </td>
                <td className="px-4 py-2">
                    <input
                        type="text"
                        value={label}
                        onChange={(e) => setLabel(e.target.value)}
                        className="w-full rounded-md border border-input bg-surface-elevated px-2 py-1 text-sm text-foreground"
                    />
                </td>
                <td className="px-4 py-2 text-right">
                    <input
                        type="number"
                        value={tokens}
                        onChange={(e) => setTokens(e.target.value)}
                        min={0}
                        step={100000}
                        className="w-36 rounded-md border border-input bg-surface-elevated px-2 py-1 text-right font-mono text-sm text-foreground"
                    />
                    <div className="mt-0.5 text-[10px] text-muted-foreground/70">
                        {fmtInt(Number(tokens) || 0)} tokena / 24h
                    </div>
                </td>
                <td className="px-4 py-2 text-xs text-muted-foreground/70">
                    {fmtDate(tier.updated_at)}
                </td>
                <td className="px-4 py-2 text-right">
                    <div className="flex items-center justify-end gap-2">
                        <button
                            type="button"
                            onClick={() => setExpanded((v) => !v)}
                            className="rounded-md border border-border px-2 py-1 text-xs text-foreground hover:bg-accent"
                        >
                            {expanded ? "Prava ▾" : "Prava ▸"}
                        </button>
                        <button
                            type="button"
                            onClick={() => setMktExpanded((v) => !v)}
                            className="rounded-md border border-border px-2 py-1 text-xs text-foreground hover:bg-accent"
                        >
                            {mktExpanded ? "Cjenik ▾" : "Cjenik ▸"}
                        </button>
                        <button
                            type="button"
                            disabled={!dirty || saving}
                            onClick={save}
                            className="rounded-md bg-success px-3 py-1 text-xs font-medium text-success-foreground hover:bg-success/90 disabled:cursor-not-allowed disabled:opacity-40"
                        >
                            {saving ? "Spremam…" : "Spremi"}
                        </button>
                    </div>
                </td>
            </tr>
            {expanded && (
                <tr className="border-t border-border bg-muted/50">
                    <td colSpan={6} className="px-4 py-3">
                        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                            {groups.map((g) => (
                                <div key={g} className="space-y-1.5">
                                    <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/70">
                                        {GROUP_LABELS[g] ?? g}
                                    </div>
                                    {catalog
                                        .filter((d) => d.group === g)
                                        .map((d) => (
                                            <EntitlementField
                                                key={d.key}
                                                def={d}
                                                value={ent[d.key]}
                                                onChange={(v) =>
                                                    setEnt((prev) => ({
                                                        ...prev,
                                                        [d.key]: v,
                                                    }))
                                                }
                                            />
                                        ))}
                                </div>
                            ))}
                        </div>
                        <div className="mt-2 text-[10px] text-muted-foreground/70">
                            Promjene se spremaju gumbom „Spremi“. Stupaju na
                            snagu unutar ~30 s (cache feature-gateova).
                        </div>
                    </td>
                </tr>
            )}
            {mktExpanded && (
                <tr className="border-t border-border bg-muted/50">
                    <td colSpan={6} className="px-4 py-3">
                        <MarketingEditor mkt={mkt} onChange={setMkt} />
                        <div className="mt-2 text-[10px] text-muted-foreground/70">
                            Marketinški tekst cjenika — povlači ga javni{" "}
                            <span className="font-mono">/billing/plans</span> (Eulex Desk
                            kartice + eulex.ai). Spremi gumbom „Spremi“.
                        </div>
                    </td>
                </tr>
            )}
        </>
    );
}

function MarketingEditor({
    mkt,
    onChange,
}: {
    mkt: PlanMarketing;
    onChange: (m: PlanMarketing) => void;
}) {
    const setLoc = (loc: "hr" | "en", patch: Partial<PlanLocaleCopy>) =>
        onChange({
            ...mkt,
            locales: { ...mkt.locales, [loc]: { ...mkt.locales[loc], ...patch } },
        });
    return (
        <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-4">
                <label className="flex cursor-pointer items-center gap-2 text-xs text-foreground">
                    <input
                        type="checkbox"
                        checked={mkt.popular}
                        onChange={(e) =>
                            onChange({ ...mkt, popular: e.target.checked })
                        }
                        className="h-3.5 w-3.5 rounded border-input bg-surface-elevated"
                    />
                    <span>Popularno (badge)</span>
                </label>
                <label className="flex items-center gap-2 text-xs text-foreground">
                    <span>Redoslijed</span>
                    <input
                        type="number"
                        value={String(mkt.order)}
                        onChange={(e) =>
                            onChange({ ...mkt, order: Number(e.target.value) || 0 })
                        }
                        className="w-16 rounded-md border border-input bg-surface-elevated px-2 py-0.5 text-right font-mono text-xs text-foreground"
                    />
                </label>
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                {(["hr", "en"] as const).map((loc) => (
                    <LocaleColumn
                        key={loc}
                        loc={loc}
                        copy={mkt.locales[loc]}
                        onChange={(patch) => setLoc(loc, patch)}
                    />
                ))}
            </div>
        </div>
    );
}

function LocaleColumn({
    loc,
    copy,
    onChange,
}: {
    loc: "hr" | "en";
    copy: PlanLocaleCopy;
    onChange: (patch: Partial<PlanLocaleCopy>) => void;
}) {
    const Field = ({
        label,
        value,
        onText,
    }: {
        label: string;
        value: string;
        onText: (v: string) => void;
    }) => (
        <label className="block">
            <span className="text-[10px] uppercase tracking-wide text-muted-foreground/70">
                {label}
            </span>
            <input
                type="text"
                value={value}
                onChange={(e) => onText(e.target.value)}
                className="mt-0.5 w-full rounded-md border border-input bg-surface-elevated px-2 py-1 text-xs text-foreground"
            />
        </label>
    );
    return (
        <div className="space-y-1.5 rounded-md border border-border p-3">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                {loc}
            </div>
            <Field label="Naziv" value={copy.name} onText={(v) => onChange({ name: v })} />
            <Field label="Tagline" value={copy.tagline} onText={(v) => onChange({ tagline: v })} />
            <Field label="Cijena" value={copy.price} onText={(v) => onChange({ price: v })} />
            <Field label="Period" value={copy.period} onText={(v) => onChange({ period: v })} />
            <Field label="Intro" value={copy.intro ?? ""} onText={(v) => onChange({ intro: v })} />
            <Field label="CTA" value={copy.cta} onText={(v) => onChange({ cta: v })} />
            <label className="block">
                <span className="text-[10px] uppercase tracking-wide text-muted-foreground/70">
                    Značajke (jedna po retku)
                </span>
                <textarea
                    rows={6}
                    value={copy.features.join("\n")}
                    onChange={(e) =>
                        onChange({ features: e.target.value.split("\n") })
                    }
                    className="mt-0.5 w-full rounded-md border border-input bg-surface-elevated px-2 py-1 text-xs text-foreground"
                />
            </label>
        </div>
    );
}

function EntitlementField({
    def,
    value,
    onChange,
}: {
    def: EntitlementDef;
    value: boolean | number | undefined;
    onChange: (v: boolean | number) => void;
}) {
    if (def.type === "bool") {
        return (
            <label className="flex cursor-pointer items-center gap-2 text-xs text-foreground">
                <input
                    type="checkbox"
                    checked={Boolean(value)}
                    onChange={(e) => onChange(e.target.checked)}
                    className="h-3.5 w-3.5 rounded border-input bg-surface-elevated"
                />
                <span>{def.labelHr}</span>
            </label>
        );
    }
    const num = typeof value === "number" ? value : 0;
    return (
        <label className="flex items-center justify-between gap-2 text-xs text-foreground">
            <span>{def.labelHr}</span>
            <span className="flex items-center gap-1">
                <input
                    type="number"
                    value={String(num)}
                    min={0}
                    onChange={(e) =>
                        onChange(Math.max(0, Number(e.target.value) || 0))
                    }
                    className="w-20 rounded-md border border-input bg-surface-elevated px-2 py-0.5 text-right font-mono text-xs text-foreground"
                />
                {def.unlimitedWhenZero && num === 0 && (
                    <span className="text-[10px] text-muted-foreground/70">∞</span>
                )}
            </span>
        </label>
    );
}

function NewTierForm({
    onCreated,
}: {
    onCreated: (t: {
        tier_level_id: number;
        tier_slug: string;
        display_label: string;
        daily_tokens: number;
    }) => Promise<void>;
}) {
    const [tierLevelId, setTierLevelId] = useState("");
    const [slug, setSlug] = useState("");
    const [label, setLabel] = useState("");
    const [tokens, setTokens] = useState("1000000");
    const [busy, setBusy] = useState(false);

    const valid =
        Number(tierLevelId) > 0 &&
        slug.trim().length > 0 &&
        label.trim().length > 0 &&
        Number(tokens) >= 0;

    return (
        <div className="rounded-lg border border-border bg-muted p-4">
            <div className="mb-3 text-sm font-medium text-foreground">
                Dodaj novi tier
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-5">
                <input
                    type="number"
                    placeholder="tier_level_id"
                    value={tierLevelId}
                    onChange={(e) => setTierLevelId(e.target.value)}
                    className="rounded-md border border-input bg-surface-elevated px-2 py-1.5 text-sm text-foreground"
                />
                <input
                    type="text"
                    placeholder="slug (npr. eulex_partner)"
                    value={slug}
                    onChange={(e) => setSlug(e.target.value)}
                    className="rounded-md border border-input bg-surface-elevated px-2 py-1.5 text-sm text-foreground"
                />
                <input
                    type="text"
                    placeholder="naziv"
                    value={label}
                    onChange={(e) => setLabel(e.target.value)}
                    className="rounded-md border border-input bg-surface-elevated px-2 py-1.5 text-sm text-foreground"
                />
                <input
                    type="number"
                    placeholder="daily_tokens"
                    value={tokens}
                    min={0}
                    step={100000}
                    onChange={(e) => setTokens(e.target.value)}
                    className="rounded-md border border-input bg-surface-elevated px-2 py-1.5 text-right font-mono text-sm text-foreground"
                />
                <button
                    type="button"
                    disabled={!valid || busy}
                    onClick={async () => {
                        setBusy(true);
                        try {
                            await onCreated({
                                tier_level_id: Number(tierLevelId),
                                tier_slug: slug.trim(),
                                display_label: label.trim(),
                                daily_tokens: Number(tokens) || 0,
                            });
                            setTierLevelId("");
                            setSlug("");
                            setLabel("");
                            setTokens("1000000");
                        } finally {
                            setBusy(false);
                        }
                    }}
                    className="rounded-md bg-success px-3 py-1.5 text-sm font-medium text-success-foreground hover:bg-success/90 disabled:cursor-not-allowed disabled:opacity-40"
                >
                    {busy ? "Spremam…" : "Dodaj"}
                </button>
            </div>
        </div>
    );
}
