/**
 * Plan catalog — the single source of truth for the *marketing* shape of
 * each subscription plan (name, tagline, price string, feature bullets),
 * bilingual (hr/en), keyed by canonical tier.
 *
 * Layers (same pattern as lib/entitlements):
 *   1. CODE defaults (this file) — initial bilingual copy + order/popular.
 *   2. DB overrides — `public.tier_limits.marketing` (jsonb), editable in
 *      AdminMax. A DB value wins; absent → code default.
 *
 * Consumed by BOTH Eulex Desk's own PlanCards and the eulex.ai pricing page via
 * the public `GET /billing/plans` endpoint, so the two surfaces can never
 * drift. Prices shown here are display strings only — Stripe remains the
 * authority for what's actually charged.
 *
 * @module planCatalog
 */

import { query } from "./db";
import {
    getAllTierLimits,
    overwriteMarketing,
    seedMarketingIfEmpty,
} from "./tierLimitsStore";
import {
    getEntitlements,
    type Entitlements,
    type TierKey,
} from "./entitlements";
import {
    getEnterpriseTierLevelId,
    getEulexLegalTeamTierLevelId,
    getFreeTierLevelId,
    getLegalProTierLevelId,
    getPlusTierLevelId,
    getProTierLevelId,
    getTeamTierLevelId,
} from "./stripe";

export type Locale = "hr" | "en";

export interface PlanLocaleCopy {
    name: string;
    tagline: string;
    /** Display price string, e.g. "€24,00" (hr) / "€24.00" (en). */
    price: string;
    /** Billing period suffix, e.g. "/ mjesec", "/ per user per month". */
    period: string;
    /** "Everything in X, plus:" intro line (omitted for Free). */
    intro?: string;
    cta: string;
    features: string[];
}

export interface PlanMarketing {
    /** Display order, low → high. */
    order: number;
    /** Highlight badge (only Plus by default). */
    popular: boolean;
    locales: Record<Locale, PlanLocaleCopy>;
}

// ---------------------------------------------------------------------------
// CODE defaults — canonical initial copy (mirrors the account.plan i18n).
// ---------------------------------------------------------------------------

const PLAN_MARKETING: Record<TierKey, PlanMarketing> = {
    free: {
        order: 0,
        popular: false,
        locales: {
            hr: {
                name: "Free",
                tagline: "Za prvo pitanje. Bez obveza.",
                price: "€0,00",
                period: "/ mjesec",
                cta: "Započni besplatno",
                features: [
                    "EU regulativa (EUR-Lex korpus)",
                    "Korpus europskog nacionalnog prava (osnovni)",
                    "Spremanje do 5 istraživačkih projekata",
                    "Analiza dokumenata",
                    "PDF izvoz (EULEX brendiran)",
                    "Dnevni limit korištenja",
                    "Probni pristup Eulex Desk pravnoj radnoj ploči",
                    "MCP pristup uz dnevni limit",
                ],
            },
            en: {
                name: "Free",
                tagline: "For the first question. No commitment.",
                price: "€0.00",
                period: "/ month",
                cta: "Start free",
                features: [
                    "EU regulation (EUR-Lex corpus)",
                    "European national law corpus (basic)",
                    "Save up to 5 research projects",
                    "Document analysis",
                    "PDF export (EULEX-branded)",
                    "Daily usage limit",
                    "Trial access to Eulex Desk legal workbench",
                    "MCP access with daily usage limit",
                ],
            },
        },
    },
    plus: {
        order: 1,
        popular: false,
        locales: {
            hr: {
                name: "Plus",
                tagline: "Za istraživača pod rokom.",
                price: "€24,00",
                period: "/ mjesec",
                intro: "Sve iz Free, plus:",
                cta: "Prijeđi na Plus",
                features: [
                    "5× veći dnevni limiti",
                    "Puni pristup Eulex Desk pravnoj radnoj ploči",
                    "Dijeljenje rezultata istraživanja putem poveznice",
                    "Word i Markdown izvoz istraživanja",
                    "Puni MCP pristup uz dnevni limit",
                ],
            },
            en: {
                name: "Plus",
                tagline: "For the deadline-driven researcher.",
                price: "€24.00",
                period: "/ month",
                intro: "Everything in Free, plus:",
                cta: "Upgrade to Plus",
                features: [
                    "5x daily usage limits",
                    "Full access to Eulex Desk legal workbench",
                    "Share research results via link",
                    "Word and Markdown export of research",
                    "Full MCP access with daily usage limit",
                ],
            },
        },
    },
    pro: {
        order: 2,
        popular: true,
        locales: {
            hr: {
                name: "Pro",
                tagline: "Za profesionalca kojem treba više.",
                price: "€99,00",
                period: "/ mjesec",
                intro: "Sve iz Plus, plus:",
                cta: "Prijeđi na Pro",
                features: [
                    "Uključuje jedan nacionalni paket dubinske pokrivenosti s vremenskom crtom i vremenskim snimkama*",
                    "20× dnevni limit za svakodnevno korištenje Eulex Deska",
                    "Anonimizacija upita i učitanih dokumenata",
                    "Word Plugin za usporedni pregled dokumenata",
                    "Izdavanje računa na tvrtku",
                ],
            },
            en: {
                name: "Pro",
                tagline: "For the professional who needs more.",
                price: "€99.00",
                period: "/ month",
                intro: "Everything in Plus, plus:",
                cta: "Upgrade to Pro",
                features: [
                    "Including one national deep coverage pack including timeline and temporal snapshots*",
                    "20x daily usage limit to support full day usage of Eulex Desk",
                    "Anonymization of query and uploaded documents",
                    "Word Plugin for side by side document review",
                    "Company billing",
                ],
            },
        },
    },
    legal_pro: {
        order: 3,
        popular: false,
        locales: {
            hr: {
                name: "Legal Pro",
                tagline: "Za svakodnevnu profesionalnu upotrebu.",
                price: "€399,00",
                period: "/ mjesec",
                intro: "Sve iz Pro, plus:",
                cta: "Prijeđi na Legal Pro",
                features: [
                    "80× dnevni limit za cjelodnevno korištenje Eulex Deska",
                    "Korištenje vlastitih API ključeva za proširenje AI kapaciteta po cijeni koštanja",
                    "Korisnička podrška za definiranje radnih procesa",
                ],
            },
            en: {
                name: "Legal Pro",
                tagline: "For daily professional use.",
                price: "€399.00",
                period: "/ month",
                intro: "Everything in Pro, plus:",
                cta: "Upgrade to Legal Pro",
                features: [
                    "80x daily usage limit to support full day usage of Eulex Desk",
                    "Use your own API-keys to extend AI capacity at cost",
                    "Customer support to define workflows",
                ],
            },
        },
    },
    team: {
        order: 4,
        popular: false,
        locales: {
            hr: {
                name: "Team",
                tagline: "Za sigurnu suradnju u timovima.",
                price: "€89,00",
                period: "/ po korisniku mjesečno",
                intro: "Sve iz Pro, plus:",
                cta: "Prijeđi na Team",
                features: [
                    "Dijeljenje Workbench projekata",
                    "Prijava putem računa tvrtke radi zaštite podataka",
                    "Dodavanje korisnika kako tvrtka raste",
                    "Limit korištenja dijeljen na razini cijelog tima",
                    "Minimalno 5 sjedala",
                ],
            },
            en: {
                name: "Team",
                tagline: "For safe collaboration in teams.",
                price: "€89.00",
                period: "/ per user per month",
                intro: "Everything in Pro, plus:",
                cta: "Upgrade to Teams",
                features: [
                    "Share Workbench projects",
                    "Login with your company account to protect your data",
                    "Add users as your company grows",
                    "Usage limit pooled across the whole team",
                    "Minimum 5 seats",
                ],
            },
        },
    },
    eulex_legal_team: {
        order: 5,
        popular: false,
        locales: {
            hr: {
                name: "Legal Team",
                tagline: "Za vrhunske pravne timove.",
                price: "€349,00",
                period: "/ po korisniku mjesečno",
                intro: "Sve iz Team, plus:",
                cta: "Prijeđi na Legal Team",
                features: [
                    "80× dnevni limit za cjelodnevno korištenje Eulex Deska",
                    "Korištenje vlastitih API ključeva za proširenje AI kapaciteta po cijeni koštanja",
                    "Korisnička podrška za definiranje radnih procesa",
                    "Minimalno 5 sjedala",
                ],
            },
            en: {
                name: "Legal Team",
                tagline: "For cutting edge legal teams.",
                price: "€349.00",
                period: "/ per user per month",
                intro: "Everything in Teams, plus:",
                cta: "Upgrade to Legal Team",
                features: [
                    "80x daily usage limit to support full day usage of Eulex Desk",
                    "Use your own API-keys to extend AI capacity at cost",
                    "Customer support to define workflows",
                    "Minimum 5 seats",
                ],
            },
        },
    },
    enterprise: {
        order: 6,
        popular: false,
        locales: {
            hr: {
                name: "Enterprise",
                tagline: "Za velike organizacije.",
                price: "Na upit",
                period: "",
                cta: "Kontaktirajte nas",
                features: [
                    "Prilagođena integracija s vašom bazom znanja",
                    "Privatni cloud i hibridna implementacija",
                    "Pružanje Eulex funkcionalnosti vašim klijentima bez Eulex računa",
                ],
            },
            en: {
                name: "Enterprise",
                tagline: "For large organisations.",
                price: "On demand",
                period: "",
                cta: "Contact us",
                features: [
                    "Custom integration with your knowledge base",
                    "Private cloud and hybrid deployment",
                    "Provide Eulex functionality to your customers without Eulex account",
                ],
            },
        },
    },
    // Internal tier — never listed on the public pricing catalog (excluded by
    // the `canonical` whitelist in getPlanCatalog). Copy exists only to satisfy
    // the Record<TierKey, …> type.
    foundation: {
        order: 7,
        popular: false,
        locales: {
            hr: {
                name: "Foundation",
                tagline: "Interni tim (neograničeno).",
                price: "—",
                period: "",
                cta: "—",
                features: ["Sva prava, praktički neograničeno"],
            },
            en: {
                name: "Foundation",
                tagline: "Internal team (unlimited).",
                price: "—",
                period: "",
                cta: "—",
                features: ["All rights, practically unlimited"],
            },
        },
    },
};

export function defaultPlanMarketing(tierKey: TierKey): PlanMarketing {
    const m = PLAN_MARKETING[tierKey];
    // Deep-ish clone so callers can't mutate the module constant.
    return {
        order: m.order,
        popular: m.popular,
        locales: {
            hr: { ...m.locales.hr, features: [...m.locales.hr.features] },
            en: { ...m.locales.en, features: [...m.locales.en.features] },
        },
    };
}

// ---------------------------------------------------------------------------
// Catalog assembly (DB row ⊕ code defaults)
// ---------------------------------------------------------------------------

export interface PlanCatalogEntry {
    tierLevelId: number;
    tierKey: TierKey;
    slug: string;
    label: string;
    dailyTokens: number;
    entitlements: Entitlements;
    marketing: PlanMarketing;
}

const CATALOG_TTL_MS = 60_000;
let _catalogCache: { at: number; entries: PlanCatalogEntry[] } | null = null;

/** Merge a DB marketing jsonb over the code default for a tier. */
function mergeMarketing(
    tierKey: TierKey,
    db: Record<string, unknown> | null | undefined,
): PlanMarketing {
    const base = defaultPlanMarketing(tierKey);
    if (!db || typeof db !== "object") return base;
    const d = db as Partial<PlanMarketing>;
    const out: PlanMarketing = {
        order: typeof d.order === "number" ? d.order : base.order,
        popular: typeof d.popular === "boolean" ? d.popular : base.popular,
        locales: base.locales,
    };
    const dl = (d as { locales?: Record<string, unknown> }).locales;
    if (dl && typeof dl === "object") {
        for (const loc of ["hr", "en"] as Locale[]) {
            const lv = dl[loc] as Partial<PlanLocaleCopy> | undefined;
            if (lv && typeof lv === "object") {
                out.locales[loc] = {
                    name: typeof lv.name === "string" ? lv.name : base.locales[loc].name,
                    tagline:
                        typeof lv.tagline === "string"
                            ? lv.tagline
                            : base.locales[loc].tagline,
                    price:
                        typeof lv.price === "string" ? lv.price : base.locales[loc].price,
                    period:
                        typeof lv.period === "string"
                            ? lv.period
                            : base.locales[loc].period,
                    intro:
                        typeof lv.intro === "string" ? lv.intro : base.locales[loc].intro,
                    cta: typeof lv.cta === "string" ? lv.cta : base.locales[loc].cta,
                    features: Array.isArray(lv.features)
                        ? (lv.features as unknown[]).filter(
                              (f): f is string => typeof f === "string",
                          )
                        : base.locales[loc].features,
                };
            }
        }
    }
    return out;
}

/**
 * Full public plan catalog — one entry per configured tier, sorted by
 * marketing order. Process-cached for `CATALOG_TTL_MS` (the public
 * pricing page can be hit often). Entitlements are resolved per tier.
 */
export async function getPlanCatalog(): Promise<PlanCatalogEntry[]> {
    if (_catalogCache && Date.now() - _catalogCache.at < CATALOG_TTL_MS) {
        return _catalogCache.entries;
    }
    // Load all tier_limits rows into a map by level_id (marketing + quota).
    const byLevel = new Map<
        number,
        {
            slug: string;
            label: string;
            dailyTokens: number;
            marketing: Record<string, unknown> | null;
        }
    >();
    try {
        // Definition rows come from tierLimitsStore (Supabase or the legacy
        // mike table, per TIERS_FROM_SUPABASE) with its own 60s row cache.
        const rows = await getAllTierLimits();
        for (const r of rows) {
            byLevel.set(r.tier_level_id, {
                slug: r.tier_slug,
                label: r.display_label,
                dailyTokens: r.daily_tokens,
                marketing: r.marketing,
            });
        }
    } catch (err) {
        console.warn(
            "[planCatalog] DB load failed; using code defaults:",
            err instanceof Error ? err.message : err,
        );
    }
    // Build EXACTLY the four canonical plans by their known level id. Extra
    // lazy-upserted tier_limits rows (unknown tiers: first-login defaults for
    // ids like 1/4/5/6, partner/foundation, …) are deliberately excluded —
    // the public pricing catalog is only the four marketing tiers.
    const canonical: Array<{ key: TierKey; levelId: number; defaultSlug: string }> = [
        { key: "free", levelId: getFreeTierLevelId(), defaultSlug: "eulex_free" },
        { key: "plus", levelId: getPlusTierLevelId(), defaultSlug: "eulex_plus" },
        { key: "pro", levelId: getProTierLevelId(), defaultSlug: "pro" },
        { key: "legal_pro", levelId: getLegalProTierLevelId(), defaultSlug: "legal_pro" },
        { key: "team", levelId: getTeamTierLevelId(), defaultSlug: "team" },
        { key: "eulex_legal_team", levelId: getEulexLegalTeamTierLevelId(), defaultSlug: "eulex_legal_team" },
        { key: "enterprise", levelId: getEnterpriseTierLevelId(), defaultSlug: "enterprise" },
    ];
    const entries: PlanCatalogEntry[] = [];
    for (const { key, levelId, defaultSlug } of canonical) {
        const row = byLevel.get(levelId);
        entries.push({
            tierLevelId: levelId,
            tierKey: key,
            slug: row?.slug ?? defaultSlug,
            label: row?.label ?? PLAN_MARKETING[key].locales.en.name,
            dailyTokens: row?.dailyTokens ?? 0,
            entitlements: await getEntitlements(levelId),
            marketing: mergeMarketing(key, row?.marketing ?? null),
        });
    }
    entries.sort((a, b) => a.marketing.order - b.marketing.order);
    _catalogCache = { at: Date.now(), entries };
    return entries;
}

export function bustPlanCatalogCache(): void {
    _catalogCache = null;
}

// ---------------------------------------------------------------------------
// Write-path + seed helpers (AdminMax / boot)
// ---------------------------------------------------------------------------

/** Keep only known marketing fields with valid types (AdminMax write path). */
export function sanitizeMarketingInput(input: unknown): PlanMarketing | null {
    if (!input || typeof input !== "object") return null;
    const d = input as Record<string, unknown>;
    const cleanLocale = (lv: unknown): PlanLocaleCopy | null => {
        if (!lv || typeof lv !== "object") return null;
        const o = lv as Record<string, unknown>;
        const str = (v: unknown) => (typeof v === "string" ? v : "");
        return {
            name: str(o.name),
            tagline: str(o.tagline),
            price: str(o.price),
            period: str(o.period),
            intro: typeof o.intro === "string" ? o.intro : undefined,
            cta: str(o.cta),
            features: Array.isArray(o.features)
                ? (o.features as unknown[]).filter(
                      (f): f is string => typeof f === "string",
                  )
                : [],
        };
    };
    const locales = d.locales as Record<string, unknown> | undefined;
    const hr = cleanLocale(locales?.hr);
    const en = cleanLocale(locales?.en);
    if (!hr || !en) return null;
    return {
        order: typeof d.order === "number" ? Math.floor(d.order) : 0,
        popular: !!d.popular,
        locales: { hr, en },
    };
}

/**
 * Seed code-default marketing into `tier_limits.marketing` for the four
 * canonical tiers, only where empty (`{}` / NULL) so admin edits stand.
 * Runs at boot after ensureSchema, like seedEntitlementDefaults.
 */
export async function seedPlanMarketingDefaults(): Promise<void> {
    const pairs: Array<{ levelId: number; key: TierKey }> = [
        { levelId: getFreeTierLevelId(), key: "free" },
        { levelId: getPlusTierLevelId(), key: "plus" },
        { levelId: getProTierLevelId(), key: "pro" },
        { levelId: getLegalProTierLevelId(), key: "legal_pro" },
        { levelId: getTeamTierLevelId(), key: "team" },
        { levelId: getEulexLegalTeamTierLevelId(), key: "eulex_legal_team" },
        { levelId: getEnterpriseTierLevelId(), key: "enterprise" },
    ];
    for (const { levelId, key } of pairs) {
        try {
            await seedMarketingIfEmpty(
                levelId,
                defaultPlanMarketing(key) as unknown as Record<string, unknown>,
            );
        } catch (err) {
            console.warn(
                `[planCatalog] marketing seed for level ${levelId} failed:`,
                err instanceof Error ? err.message : err,
            );
        }
    }
    bustPlanCatalogCache();
    console.log("[planCatalog] marketing defaults seeded");
}

/**
 * One-time pricing relaunch. The canonical tiers already have DB
 * `marketing` seeded from the OLD code defaults (the fill-if-empty seeder
 * above), so editing PLAN_MARKETING alone would NOT change what
 * GET /billing/plans serves for free/plus/pro/team. This overwrites those
 * four tiers' marketing with the current code defaults exactly once —
 * guarded by `public.app_migrations` — so the relaunch (Pro €99 + popular,
 * Team €89, refreshed bullets) takes effect without clobbering any future
 * AdminMax edits. The new tiers (legal_pro, eulex_legal_team, enterprise)
 * are filled by seedPlanMarketingDefaults() since their rows start empty.
 */
const MARKETING_RELAUNCH_MARKER = "tier_marketing_relaunch_2026_06";

export async function applyMarketingRelaunchOnce(): Promise<void> {
    try {
        const seen = await query<{ name: string }>(
            `SELECT name FROM public.app_migrations WHERE name = $1`,
            [MARKETING_RELAUNCH_MARKER],
        );
        if (seen.rows.length > 0) return;
        const canonical: Array<{ levelId: number; key: TierKey }> = [
            { levelId: getFreeTierLevelId(), key: "free" },
            { levelId: getPlusTierLevelId(), key: "plus" },
            { levelId: getProTierLevelId(), key: "pro" },
            { levelId: getTeamTierLevelId(), key: "team" },
        ];
        for (const { levelId, key } of canonical) {
            await overwriteMarketing(
                levelId,
                defaultPlanMarketing(key) as unknown as Record<string, unknown>,
            );
        }
        await query(
            `INSERT INTO public.app_migrations (name) VALUES ($1)
             ON CONFLICT (name) DO NOTHING`,
            [MARKETING_RELAUNCH_MARKER],
        );
        bustPlanCatalogCache();
        console.log("[planCatalog] pricing relaunch marketing applied");
    } catch (err) {
        console.warn(
            "[planCatalog] pricing relaunch failed:",
            err instanceof Error ? err.message : err,
        );
    }
}
