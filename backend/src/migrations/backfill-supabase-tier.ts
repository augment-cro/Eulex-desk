/**
 * One-shot backfill: push each linked user's current tier into the Supabase
 * user's `app_metadata` (tier_level_id / tier_slug / tier_until).
 *
 * The runtime mirror (lib/membership.ts → mirrorTierToSupabase, fed by
 * setLocalTierActive / clearLocalTierOverride) only fires on FUTURE tier
 * changes. This script seeds the existing population so app_metadata matches
 * `public.user_tier_state` from day one — same convenience denormalization;
 * `user_tier_state` stays authoritative and enforced server-side.
 *
 * For every row in public.user_supabase_identity we read the EFFECTIVE tier:
 *   - active override (level set and not expired) → that level + slug + until
 *   - no override / expired                       → nulls (cleared)
 *
 * Idempotent: re-running writes the same values. Safe to re-run.
 *
 * Usage (dry run by default — prints the plan, writes nothing):
 *
 *   cd backend
 *   export SUPABASE_URL=https://<project-ref>.supabase.co
 *   export SUPABASE_SECRET_KEY=$(gcloud secrets versions access latest \
 *       --secret=SUPABASE_SECRET_KEY --project <gcp-project>)
 *   export DATABASE_URL=postgresql://...     # or Cloud SQL connector env
 *   npx tsx src/migrations/backfill-supabase-tier.ts            # dry run
 *   npx tsx src/migrations/backfill-supabase-tier.ts --execute  # do it
 *   npx tsx src/migrations/backfill-supabase-tier.ts --execute --limit 5
 */

import { closePool, getPool } from "../lib/db";
import {
    isSupabaseAdminConfigured,
    updateSupabaseUserTier,
} from "../lib/supabaseAdmin";

const EXECUTE = process.argv.includes("--execute");
const limitArg = process.argv.indexOf("--limit");
const LIMIT =
    limitArg !== -1 ? parseInt(process.argv[limitArg + 1], 10) : Infinity;

interface Row {
    supabase_user_id: string;
    user_id: string;
    email: string | null;
    active_tier_level_id: number | null;
    active_tier_until: string | null;
    tier_slug: string | null;
}

async function main(): Promise<void> {
    if (!isSupabaseAdminConfigured()) {
        console.error(
            "Supabase admin not configured — set SUPABASE_URL and SUPABASE_SECRET_KEY.",
        );
        process.exit(1);
    }

    const pool = await getPool();
    const { rows } = await pool.query<Row>(
        `SELECT i.supabase_user_id,
                i.user_id,
                u.email,
                s.active_tier_level_id,
                s.active_tier_until,
                tl.tier_slug
           FROM public.user_supabase_identity i
           JOIN public.users u            ON u.id = i.user_id
           LEFT JOIN public.user_tier_state s ON s.user_id = i.user_id
           LEFT JOIN public.tier_limits tl    ON tl.tier_level_id = s.active_tier_level_id
          ORDER BY u.email`,
    );

    console.log(
        `${rows.length} linked Supabase identities found.${EXECUTE ? "" : "  (dry run — nothing written)"}`,
    );

    const now = Date.now();
    let written = 0;
    let paid = 0;
    let cleared = 0;
    const errors: string[] = [];

    let processed = 0;
    for (const r of rows) {
        if (processed >= LIMIT) break;
        processed += 1;

        const expired =
            r.active_tier_until != null &&
            new Date(r.active_tier_until).getTime() < now;
        const active = r.active_tier_level_id != null && !expired;

        const tier = active
            ? {
                  tier_level_id: r.active_tier_level_id,
                  tier_slug: r.tier_slug,
                  tier_until: r.active_tier_until
                      ? new Date(r.active_tier_until).toISOString()
                      : null,
              }
            : { tier_level_id: null, tier_slug: null, tier_until: null };

        const label = active
            ? `${r.tier_slug ?? r.active_tier_level_id}`
            : "free/cleared";
        console.log(`  ${r.email ?? r.user_id} → ${label}`);

        if (active) paid += 1;
        else cleared += 1;

        if (!EXECUTE) continue;
        try {
            await updateSupabaseUserTier(r.supabase_user_id, tier);
            written += 1;
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            errors.push(`${r.email ?? r.user_id}: ${msg}`);
            console.error(`ERROR  ${r.email ?? r.user_id} — ${msg}`);
        }
    }

    console.log("\n──── Report ─────────────────────────────");
    console.log(`processed : ${processed}`);
    console.log(`paid tier : ${paid}`);
    console.log(`free/clear: ${cleared}`);
    console.log(`written   : ${written}${EXECUTE ? "" : "  (dry run)"}`);
    console.log(`errors    : ${errors.length}`);
    for (const e of errors) console.log(`  - ${e}`);

    await closePool();
    process.exit(errors.length > 0 ? 2 : 0);
}

main().catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
});
