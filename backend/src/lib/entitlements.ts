/**
 * Tier entitlements — the single source of truth for "what each
 * subscription can do" (free / plus / pro / team).
 *
 * Two layers:
 *   1. CATALOG (this file) — the typed list of every entitlement key,
 *      its value type, default per canonical tier, and HR/EN labels.
 *      Adding a feature = add a row here (no migration).
 *   2. VALUES (DB) — `public.tier_limits.entitlements` (jsonb), editable
 *      at runtime via AdminMax. A DB value overrides the catalog default
 *      for that (tier, key); an absent key falls back to the default, so
 *      the DB column can stay `{}` and the system still behaves correctly.
 *
 * Canonical tier identity is the integer `tier_level_id` from the JWT /
 * Stripe webhook — NOT the legacy `'free'|'plus'` string (the WP issuer
 * only emits that for the two oldest tiers; pro/team come through as a
 * number with a 'plus'-ish status). Mapping (env-overridable):
 *   free = 3, plus = 2, pro = 7, team = 8
 *
 * Reads happen on the hot path (every gated route + the profile), so the
 * DB lookup is cached process-locally with a short TTL. AdminMax writes
 * bust the cache on the same instance; other Cloud Run instances pick the
 * change up within `ENTITLEMENTS_TTL_MS`.
 *
 * @module entitlements
 */

import type { RequestHandler } from "express";
import { getAllTierLimits, seedEntitlementsIfEmpty } from "./tierLimitsStore";
import {
    getEnterpriseTierLevelId,
    getEulexLegalTeamTierLevelId,
    getFoundationTierLevelId,
    getFreeTierLevelId,
    getLegalProTierLevelId,
    getPlusTierLevelId,
    getProTierLevelId,
    getTeamTierLevelId,
} from "./stripe";

// ---------------------------------------------------------------------------
// Tier identity
// ---------------------------------------------------------------------------

export type TierKey =
    | "free"
    | "plus"
    | "pro"
    | "legal_pro"
    | "team"
    | "eulex_legal_team"
    | "enterprise"
    | "foundation";

/** Ordered low → high so we can rank and pick "best" / "minimum" tiers. */
export const TIER_KEYS: readonly TierKey[] = [
    "free",
    "plus",
    "pro",
    "legal_pro",
    "team",
    "eulex_legal_team",
    "enterprise",
    "foundation",
];

export const TIER_RANK: Record<TierKey, number> = {
    free: 0,
    plus: 1,
    pro: 2,
    legal_pro: 3,
    team: 4,
    eulex_legal_team: 5,
    enterprise: 6,
    foundation: 7,
};

/**
 * Map a UMP `tier_level_id` to its canonical key. Unknown ids resolve to
 * `free` so a misconfigured tier never accidentally unlocks paid features.
 */
export function tierKeyForLevelId(tierLevelId: number): TierKey {
    if (tierLevelId === getPlusTierLevelId()) return "plus";
    if (tierLevelId === getProTierLevelId()) return "pro";
    if (tierLevelId === getLegalProTierLevelId()) return "legal_pro";
    if (tierLevelId === getTeamTierLevelId()) return "team";
    if (tierLevelId === getEulexLegalTeamTierLevelId()) return "eulex_legal_team";
    if (tierLevelId === getEnterpriseTierLevelId()) return "enterprise";
    if (tierLevelId === getFoundationTierLevelId()) return "foundation";
    // getFreeTierLevelId() and any unrecognised id → free.
    return "free";
}

export interface ResolvedTier {
    tierLevelId: number;
    key: TierKey;
    rank: number;
}

export function resolveTier(tierLevelId: number): ResolvedTier {
    const key = tierKeyForLevelId(tierLevelId);
    return { tierLevelId, key, rank: TIER_RANK[key] };
}

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

export type EntType = "bool" | "int";
export type EntitlementValue = boolean | number;
export type Entitlements = Record<string, EntitlementValue>;

export interface EntitlementDef {
    key: string;
    type: EntType;
    /** UI grouping in the AdminMax editor. */
    group: string;
    labelHr: string;
    labelEn: string;
    /** Default value per canonical tier. */
    defaults: Record<TierKey, EntitlementValue>;
    /** int only: render 0 as "unlimited" in the UI. */
    unlimitedWhenZero?: boolean;
}

const T = true;
const F = false;

/**
 * The product matrix. Mirrors the pricing page; the user-confirmed gates:
 *   • Word + Markdown export → Plus and up
 *   • PII anonymization + Word Plugin → Pro and up
 *   • adding users to projects/cases + the rest of collaboration → Team
 *
 * Team-only flags are DEFINED here now but their enforcement/features land
 * with the separate Team subsystem (seats, shared projects, company login,
 * pooled usage, BYO keys). They exist so the data model is complete.
 */
export const ENTITLEMENT_CATALOG: readonly EntitlementDef[] = [
    {
        key: "fullWorkbench",
        type: "bool",
        group: "workbench",
        labelHr: "Puni Eulex Desk workbench (Free = trial)",
        labelEn: "Full Eulex Desk workbench (Free = trial)",
        defaults: { free: F, plus: T, pro: T, legal_pro: T, team: T, eulex_legal_team: T, enterprise: T, foundation: T },
    },
    {
        key: "maxSavedProjects",
        type: "int",
        group: "workbench",
        labelHr: "Maks. spremljenih projekata",
        labelEn: "Eulex Desk saved projects",
        defaults: { free: 5, plus: 0, pro: 0, legal_pro: 0, team: 0, eulex_legal_team: 0, enterprise: 0, foundation: 0 },
        unlimitedWhenZero: true,
    },
    {
        key: "mcpAccess",
        type: "bool",
        group: "workbench",
        labelHr: "MCP pristup (uz dnevni limit)",
        labelEn: "MCP access (with daily limit)",
        defaults: { free: T, plus: T, pro: T, legal_pro: T, team: T, eulex_legal_team: T, enterprise: T, foundation: T },
    },
    {
        key: "shareResearchLink",
        type: "bool",
        group: "sharing",
        labelHr: "Dijeljenje rezultata linkom",
        labelEn: "Share research via link",
        defaults: { free: F, plus: T, pro: T, legal_pro: T, team: T, eulex_legal_team: T, enterprise: T, foundation: T },
    },
    {
        key: "exportWordMarkdown",
        type: "bool",
        group: "export",
        labelHr: "Word + Markdown export",
        labelEn: "Word + Markdown export",
        defaults: { free: F, plus: T, pro: T, legal_pro: T, team: T, eulex_legal_team: T, enterprise: T, foundation: T },
    },
    {
        key: "buyTokenPacks",
        type: "bool",
        group: "billing",
        labelHr: "Kupnja token paketa (nadoplata)",
        labelEn: "Buy token packs (top-up)",
        defaults: { free: F, plus: T, pro: T, legal_pro: T, team: T, eulex_legal_team: T, enterprise: T, foundation: T },
    },
    {
        key: "deepCoveragePack",
        type: "bool",
        group: "coverage",
        labelHr: "Deep coverage pack (1 nacionalni)",
        labelEn: "Deep coverage pack (1 national)",
        defaults: { free: F, plus: F, pro: T, legal_pro: T, team: T, eulex_legal_team: T, enterprise: T, foundation: T },
    },
    {
        key: "piiAnonymization",
        type: "bool",
        group: "pro",
        labelHr: "PII anonimizacija (upiti + dokumenti)",
        labelEn: "PII anonymization (queries + documents)",
        defaults: { free: F, plus: F, pro: T, legal_pro: T, team: T, eulex_legal_team: T, enterprise: T, foundation: T },
    },
    {
        key: "wordPlugin",
        type: "bool",
        group: "pro",
        labelHr: "Word Plugin (side-by-side)",
        labelEn: "Word Plugin (side-by-side review)",
        defaults: { free: F, plus: F, pro: T, legal_pro: T, team: T, eulex_legal_team: T, enterprise: T, foundation: T },
    },
    {
        key: "companyBilling",
        type: "bool",
        group: "billing",
        labelHr: "Company billing",
        labelEn: "Company billing",
        defaults: { free: F, plus: F, pro: T, legal_pro: T, team: T, eulex_legal_team: T, enterprise: T, foundation: T },
    },
    // ── Team subsystem (enforcement deferred to the Team phase) ──────────
    {
        key: "shareWorkbenchProjects",
        type: "bool",
        group: "team",
        labelHr: "Dijeljenje Workbench projekata",
        labelEn: "Share Workbench projects",
        defaults: { free: F, plus: F, pro: F, legal_pro: F, team: T, eulex_legal_team: T, enterprise: T, foundation: T },
    },
    {
        key: "addUsersToProjects",
        type: "bool",
        group: "team",
        labelHr: "Dodavanje korisnika na predmete",
        labelEn: "Add users to projects/cases",
        defaults: { free: F, plus: F, pro: F, legal_pro: F, team: T, eulex_legal_team: T, enterprise: T, foundation: T },
    },
    {
        key: "companyAccountLogin",
        type: "bool",
        group: "team",
        labelHr: "Login s company računom",
        labelEn: "Company-account login",
        defaults: { free: F, plus: F, pro: F, legal_pro: F, team: T, eulex_legal_team: T, enterprise: T, foundation: T },
    },
    {
        key: "pooledUsage",
        type: "bool",
        group: "team",
        labelHr: "Dijeljena (pooled) kvota tima",
        labelEn: "Pooled team usage limit",
        defaults: { free: F, plus: F, pro: F, legal_pro: F, team: T, eulex_legal_team: T, enterprise: T, foundation: T },
    },
    {
        key: "byoApiKeys",
        type: "bool",
        group: "team",
        labelHr: "Vlastiti API ključevi (at-cost)",
        labelEn: "Bring-your-own API keys (at cost)",
        // Legal Pro is the one individual tier that grants BYO keys.
        defaults: { free: F, plus: F, pro: F, legal_pro: T, team: T, eulex_legal_team: T, enterprise: T, foundation: T },
    },
];

const CATALOG_BY_KEY = new Map<string, EntitlementDef>(
    ENTITLEMENT_CATALOG.map((d) => [d.key, d]),
);

/** Deep-ish copy of the catalog for the AdminMax UI to render the editor. */
export function entitlementCatalog(): EntitlementDef[] {
    return ENTITLEMENT_CATALOG.map((d) => ({ ...d, defaults: { ...d.defaults } }));
}

// ---------------------------------------------------------------------------
// Resolution (catalog default ⊕ DB override)
// ---------------------------------------------------------------------------

function catalogDefault(def: EntitlementDef, key: TierKey): EntitlementValue {
    const v = def.defaults[key];
    return def.type === "bool" ? Boolean(v) : Number(v ?? 0);
}

function mergeEntitlements(
    tierKey: TierKey,
    db: Record<string, unknown>,
): Entitlements {
    const out: Entitlements = {};
    for (const def of ENTITLEMENT_CATALOG) {
        const dbVal = db[def.key];
        if (def.type === "bool") {
            out[def.key] =
                typeof dbVal === "boolean"
                    ? dbVal
                    : (catalogDefault(def, tierKey) as boolean);
        } else {
            out[def.key] =
                typeof dbVal === "number" && Number.isFinite(dbVal)
                    ? dbVal
                    : (catalogDefault(def, tierKey) as number);
        }
    }
    return out;
}

/** Catalog-only defaults for a tier (no DB read) — used by the seeder. */
export function defaultEntitlements(tierKey: TierKey): Entitlements {
    return mergeEntitlements(tierKey, {});
}

// ---------------------------------------------------------------------------
// Cache + DB load
// ---------------------------------------------------------------------------

const ENTITLEMENTS_TTL_MS = 30_000;
let _entCache: {
    at: number;
    byLevel: Map<number, Record<string, unknown>>;
} | null = null;

async function loadDbEntitlements(): Promise<Map<number, Record<string, unknown>>> {
    if (_entCache && Date.now() - _entCache.at < ENTITLEMENTS_TTL_MS) {
        return _entCache.byLevel;
    }
    const byLevel = new Map<number, Record<string, unknown>>();
    try {
        // Definition rows come from tierLimitsStore (Supabase or the legacy
        // mike table, per TIERS_FROM_SUPABASE) with its own 60s row cache.
        const rows = await getAllTierLimits();
        for (const r of rows) {
            byLevel.set(r.tier_level_id, r.entitlements);
        }
    } catch (err) {
        // Never break a request on a metering-table hiccup — fall back to
        // catalog defaults (empty map → mergeEntitlements uses defaults).
        console.warn(
            "[entitlements] DB load failed; using catalog defaults:",
            err instanceof Error ? err.message : err,
        );
    }
    _entCache = { at: Date.now(), byLevel };
    return byLevel;
}

/** Drop the cache so the next read re-queries (AdminMax write path). */
export function bustEntitlementsCache(): void {
    _entCache = null;
}

/** Resolve the full entitlement set for a tier_level_id. */
export async function getEntitlements(tierLevelId: number): Promise<Entitlements> {
    const tierKey = tierKeyForLevelId(tierLevelId);
    const db = (await loadDbEntitlements()).get(tierLevelId) ?? {};
    return mergeEntitlements(tierKey, db);
}

// ---------------------------------------------------------------------------
// Accessors
// ---------------------------------------------------------------------------

export function can(ent: Entitlements | null | undefined, key: string): boolean {
    return Boolean(ent?.[key]);
}

export function intEntitlement(
    ent: Entitlements | null | undefined,
    key: string,
): number {
    const v = ent?.[key];
    return typeof v === "number" ? v : 0;
}

/** Lowest tier whose catalog default grants `key` — for upgrade hints. */
export function minTierForEntitlement(key: string): TierKey | null {
    const def = CATALOG_BY_KEY.get(key);
    if (!def) return null;
    for (const tk of TIER_KEYS) {
        const grants =
            def.type === "bool"
                ? Boolean(def.defaults[tk])
                : Number(def.defaults[tk]) > 0;
        if (grants) return tk;
    }
    return null;
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

/**
 * Express middleware factory: 403 unless the caller's tier grants the
 * boolean entitlement `key`. Reads `res.locals.tierLevelId` (set by
 * `requireAuth`). Numeric limits (e.g. maxSavedProjects) are enforced
 * inline in their routes, not here. Fails closed on a lookup error.
 */
export function requireEntitlement(key: string): RequestHandler {
    return async (_req, res, next) => {
        const tierLevelId = res.locals.tierLevelId as number | undefined;
        if (typeof tierLevelId !== "number") {
            res.status(401).json({ detail: "Not authenticated" });
            return;
        }
        try {
            const ent = await getEntitlements(tierLevelId);
            if (can(ent, key)) {
                next();
                return;
            }
        } catch (err) {
            console.error(
                "[entitlements] gate check failed:",
                err instanceof Error ? err.message : err,
            );
            // fall through to 403 (fail closed)
        }
        res.status(403).json({
            detail: "Ova značajka zahtijeva višu razinu pretplate.",
            code: "TIER_REQUIRED",
            feature: key,
            required: minTierForEntitlement(key),
        });
    };
}

// ---------------------------------------------------------------------------
// Write-path helpers (AdminMax)
// ---------------------------------------------------------------------------

/**
 * Keep only known entitlement keys with the right value type so the jsonb
 * never accumulates junk. ints are floored and clamped to >= 0.
 */
export function sanitizeEntitlementsInput(input: unknown): Entitlements {
    const out: Entitlements = {};
    if (!input || typeof input !== "object") return out;
    const obj = input as Record<string, unknown>;
    for (const def of ENTITLEMENT_CATALOG) {
        if (!(def.key in obj)) continue;
        const v = obj[def.key];
        if (def.type === "bool" && typeof v === "boolean") {
            out[def.key] = v;
        } else if (
            def.type === "int" &&
            typeof v === "number" &&
            Number.isFinite(v) &&
            v >= 0
        ) {
            out[def.key] = Math.floor(v);
        }
    }
    return out;
}

// ---------------------------------------------------------------------------
// Seeder
// ---------------------------------------------------------------------------

/**
 * Write catalog defaults into `tier_limits.entitlements` for the four
 * canonical tiers, but ONLY where the column is still empty (`{}` / NULL)
 * so an admin's later edits are never clobbered. Values come from the code
 * catalog, so SQL and code can't drift. Safe to run on every boot; called
 * right after `ensureSchema()`.
 */
export async function seedEntitlementDefaults(): Promise<void> {
    const pairs: Array<{ levelId: number; key: TierKey }> = [
        { levelId: getFreeTierLevelId(), key: "free" },
        { levelId: getPlusTierLevelId(), key: "plus" },
        { levelId: getProTierLevelId(), key: "pro" },
        { levelId: getLegalProTierLevelId(), key: "legal_pro" },
        { levelId: getTeamTierLevelId(), key: "team" },
        { levelId: getEulexLegalTeamTierLevelId(), key: "eulex_legal_team" },
        { levelId: getEnterpriseTierLevelId(), key: "enterprise" },
        { levelId: getFoundationTierLevelId(), key: "foundation" },
    ];
    for (const { levelId, key } of pairs) {
        try {
            await seedEntitlementsIfEmpty(
                levelId,
                defaultEntitlements(key) as Record<string, unknown>,
            );
        } catch (err) {
            console.warn(
                `[entitlements] seed for level ${levelId} failed:`,
                err instanceof Error ? err.message : err,
            );
        }
    }
    bustEntitlementsCache();
    console.log("[entitlements] defaults seeded");
}
