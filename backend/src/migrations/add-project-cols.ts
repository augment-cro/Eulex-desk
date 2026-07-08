/**
 * One-off migration: add missing cm_number, visibility, shared_with columns
 * to the projects table. These were in the original Supabase schema (000)
 * but omitted from the Cloud SQL bootstrap (100).
 *
 * Run: npx tsx src/migrations/add-project-cols.ts
 */
import { query, closePool } from '../lib/db.js';

async function main() {
    console.log('[migration] Adding missing columns to projects...');
    await query(`ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS cm_number text;`);
    await query(`ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS visibility text NOT NULL DEFAULT 'private';`);
    await query(`ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS shared_with jsonb NOT NULL DEFAULT '[]'::jsonb;`);
    await query(`CREATE INDEX IF NOT EXISTS projects_shared_with_idx ON public.projects USING gin (shared_with);`);
    console.log('[migration] ✅ Done.');
    await closePool();
}

main().catch((err) => {
    console.error('[migration] ❌ Failed:', err);
    process.exit(1);
});
