/**
 * One-off migration: add missing tabular_model and organisation columns
 * to the user_profiles table. These were in the original Supabase schema (000)
 * but omitted from the Cloud SQL bootstrap (100).
 *
 * Missing tabular_model was causing a 500 error on /chat/:id/generate-title
 * because getUserModelSettings() would crash and fallback to default Gemini 
 * without checking keys properly.
 *
 * Run: npx tsx src/migrations/add-user-cols.ts
 */
import { query, closePool } from '../lib/db.js';

async function main() {
    console.log('[migration] Adding missing columns to user_profiles...');
    await query(`ALTER TABLE public.user_profiles ADD COLUMN IF NOT EXISTS tabular_model text NOT NULL DEFAULT 'gemini-3-flash-preview';`);
    await query(`ALTER TABLE public.user_profiles ADD COLUMN IF NOT EXISTS organisation text;`);
    console.log('[migration] ✅ Done.');
    await closePool();
}

main().catch((err) => {
    console.error('[migration] ❌ Failed:', err);
    process.exit(1);
});
