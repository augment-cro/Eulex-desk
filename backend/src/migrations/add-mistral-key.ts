/**
 * One-off migration: add mistral_api_key column to user_profiles.
 * Run: npx tsx src/migrations/add-mistral-key.ts
 */
import { query, closePool } from '../lib/db.js';

async function main() {
    console.log('[migration] Adding mistral_api_key to user_profiles...');
    await query(`ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS mistral_api_key TEXT;`);
    console.log('[migration] ✅ Done.');
    await closePool();
}

main().catch((err) => {
    console.error('[migration] ❌ Failed:', err);
    process.exit(1);
});
