/**
 * One-shot copy: seed the Supabase `tier_limits` table (created by
 * backend/supabase/tier_limits.sql) from the mike-DB rows.
 *
 * Tracker #15 Phase A — tier DEFINITIONS (quota / entitlements / marketing)
 * move to OUR Supabase Postgres; the backend reads them through
 * lib/tierLimitsStore.ts once `TIERS_FROM_SUPABASE=1` is set. This script
 * seeds the Supabase table so the flag can be flipped without a gap; the
 * mike table stays in place as the transition fallback.
 *
 * Idempotent: upserts on tier_level_id — re-running writes the same values.
 * Safe to re-run.
 *
 * Usage (dry run by default — prints the plan, writes nothing):
 *
 *   cd backend
 *   export SUPABASE_URL=https://<project-ref>.supabase.co
 *   export SUPABASE_SECRET_KEY=$(gcloud secrets versions access latest \
 *       --secret=SUPABASE_SECRET_KEY --project <gcp-project>)
 *   export DATABASE_URL=postgresql://...     # or Cloud SQL connector env
 *   npx tsx src/migrations/copy-tier-limits-to-supabase.ts            # dry run
 *   npx tsx src/migrations/copy-tier-limits-to-supabase.ts --execute  # do it
 */

import { closePool, getPool } from "../lib/db";
import {
    getSupabaseAdminClient,
    isSupabaseAdminConfigured,
} from "../lib/supabaseAdmin";

const EXECUTE = process.argv.includes("--execute");

interface Row {
    tier_level_id: string | number;
    tier_slug: string;
    display_label: string;
    daily_tokens: string | number;
    entitlements: Record<string, unknown> | null;
    marketing: Record<string, unknown> | null;
    updated_at: string | Date;
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
        `SELECT tier_level_id, tier_slug, display_label, daily_tokens,
                entitlements, marketing, updated_at
           FROM public.tier_limits
          ORDER BY tier_level_id ASC`,
    );

    console.log(
        `${rows.length} tier_limits rows found in the mike DB.${EXECUTE ? "" : "  (dry run — nothing written)"}`,
    );

    const payload = rows.map((r) => ({
        tier_level_id: Number(r.tier_level_id),
        tier_slug: r.tier_slug,
        display_label: r.display_label,
        daily_tokens: Number(r.daily_tokens),
        entitlements: r.entitlements ?? {},
        marketing: r.marketing ?? {},
        updated_at:
            r.updated_at instanceof Date
                ? r.updated_at.toISOString()
                : new Date(r.updated_at).toISOString(),
    }));

    for (const p of payload) {
        console.log(
            `  ${p.tier_level_id}  ${p.tier_slug} ("${p.display_label}") ` +
                `daily_tokens=${p.daily_tokens} ` +
                `entitlement_keys=${Object.keys(p.entitlements).length} ` +
                `marketing=${Object.keys(p.marketing).length > 0 ? "yes" : "empty"}`,
        );
    }

    let written = 0;
    const errors: string[] = [];

    if (EXECUTE && payload.length > 0) {
        const { error } = await getSupabaseAdminClient()
            .from("tier_limits")
            .upsert(payload, { onConflict: "tier_level_id" });
        if (error) {
            errors.push(`upsert failed: ${error.message}`);
            console.error(`ERROR  upsert failed — ${error.message}`);
        } else {
            written = payload.length;
        }
    }

    console.log("\n──── Report ─────────────────────────────");
    console.log(`rows read : ${rows.length}`);
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
