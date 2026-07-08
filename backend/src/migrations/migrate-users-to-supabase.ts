/**
 * One-shot user migration: Cloud SQL public.users → Supabase auth.users.
 *
 * Pre-creates every existing Eulex Desk user in Supabase Auth (no password —
 * they keep using the legacy WordPress login during the parallel-login
 * period, or set a password via reset / sign in with Google/LinkedIn,
 * which Supabase auto-links by verified e-mail) and records the mapping
 * in public.user_supabase_identity so the dual-token middleware resolves
 * them to their existing public.users row on first Supabase login.
 *
 * Idempotent & resumable:
 *   - users already in user_supabase_identity are skipped at the source
 *   - e-mails already registered in Supabase are linked, not re-created
 *   - the identity insert is ON CONFLICT DO NOTHING
 *
 * Usage (dry run by default — prints the plan, writes nothing):
 *
 *   cd backend
 *   export SUPABASE_SECRET_KEY=$(gcloud secrets versions access latest \
 *       --secret=SUPABASE_SECRET_KEY --project <GCP_PROJECT>)
 *   export DATABASE_URL=postgresql://...     # or Cloud SQL connector env
 *   npx tsx src/migrations/migrate-users-to-supabase.ts            # dry run
 *   npx tsx src/migrations/migrate-users-to-supabase.ts --execute  # do it
 *   npx tsx src/migrations/migrate-users-to-supabase.ts --execute --limit 5
 *
 * Optional `--csv <path>`: a WordPress / Ultimate Membership Pro member
 * export ("User ID",Email,Username,"First Name","Last Name",…). Before the
 * normal sweep, every CSV member is ensured to have a public.users row
 * (INSERT with wp_user_id; wp_user_id backfilled on e-mail match). The
 * regular sweep then migrates them to Supabase like any other local user.
 * This pulls in eulex.ai members who never logged into Eulex Desk.
 *
 *   npx tsx src/migrations/migrate-users-to-supabase.ts --csv export.csv --execute
 */

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { closePool, getPool } from "../lib/db";

const SUPABASE_URL = (process.env.SUPABASE_URL ?? "")
    .trim()
    .replace(/\/+$/, "");
if (!SUPABASE_URL) {
    console.error("SUPABASE_URL env var is required");
    process.exit(1);
}
const SUPABASE_SECRET_KEY = (process.env.SUPABASE_SECRET_KEY ?? "").trim();

const EXECUTE = process.argv.includes("--execute");
const limitArg = process.argv.indexOf("--limit");
const LIMIT =
    limitArg !== -1 ? parseInt(process.argv[limitArg + 1], 10) : Infinity;
const csvArg = process.argv.indexOf("--csv");
const CSV_PATH = csvArg !== -1 ? process.argv[csvArg + 1] : null;

/** Cheap sanity filter — skip rows that can never become Supabase users. */
function isPlausibleEmail(email: string): boolean {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/**
 * Minimal RFC-4180 CSV parser (quoted fields, "" escapes, newlines inside
 * quotes). Returns rows of raw string cells.
 */
function parseCsv(text: string): string[][] {
    const rows: string[][] = [];
    let row: string[] = [];
    let cell = "";
    let inQuotes = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (inQuotes) {
            if (c === '"') {
                if (text[i + 1] === '"') {
                    cell += '"';
                    i += 1;
                } else {
                    inQuotes = false;
                }
            } else {
                cell += c;
            }
        } else if (c === '"') {
            inQuotes = true;
        } else if (c === ",") {
            row.push(cell);
            cell = "";
        } else if (c === "\n" || c === "\r") {
            if (c === "\r" && text[i + 1] === "\n") i += 1;
            row.push(cell);
            cell = "";
            if (row.some((v) => v.length > 0)) rows.push(row);
            row = [];
        } else {
            cell += c;
        }
    }
    row.push(cell);
    if (row.some((v) => v.length > 0)) rows.push(row);
    return rows;
}

interface CsvMember {
    wpUserId: number;
    email: string;
    displayName: string;
}

/** Parse the UMP member export into normalized members. */
function readCsvMembers(path: string): CsvMember[] {
    const rows = parseCsv(readFileSync(path, "utf8"));
    if (rows.length < 2) return [];
    const header = rows[0].map((h) => h.trim().toLowerCase());
    const col = (name: string): number => header.indexOf(name.toLowerCase());
    const idIdx = col("User ID");
    const emailIdx = col("Email");
    const userIdx = col("Username");
    const firstIdx = col("First Name");
    const lastIdx = col("Last Name");
    if (idIdx === -1 || emailIdx === -1) {
        throw new Error(
            `CSV is missing "User ID"/"Email" columns (got: ${header.join(", ")})`,
        );
    }

    const members: CsvMember[] = [];
    for (const r of rows.slice(1)) {
        const wpUserId = parseInt((r[idIdx] ?? "").trim(), 10);
        const email = (r[emailIdx] ?? "").toLowerCase().trim();
        const clean = (v: string | undefined): string => {
            const t = (v ?? "").trim();
            return t === "-" ? "" : t;
        };
        const first = clean(firstIdx !== -1 ? r[firstIdx] : "");
        const last = clean(lastIdx !== -1 ? r[lastIdx] : "");
        const username = clean(userIdx !== -1 ? r[userIdx] : "");
        const displayName =
            [first, last].filter(Boolean).join(" ") ||
            username ||
            email.split("@")[0];
        if (!Number.isNaN(wpUserId) && email) {
            members.push({ wpUserId, email, displayName });
        }
    }
    return members;
}

/**
 * Ensure every CSV member has a public.users row, so the regular sweep
 * below migrates them to Supabase like any other local user. Match order:
 * wp_user_id → e-mail (backfilling wp_user_id when it was NULL) → INSERT.
 */
async function ensureLocalUsersFromCsv(
    pool: Awaited<ReturnType<typeof getPool>>,
    members: CsvMember[],
): Promise<{ inserted: number; matched: number; skipped: number }> {
    let inserted = 0;
    let matched = 0;
    let skipped = 0;
    const seen = new Set<string>();

    for (const m of members) {
        if (!isPlausibleEmail(m.email) || seen.has(m.email)) {
            skipped += 1;
            if (!isPlausibleEmail(m.email)) {
                console.warn(`CSV SKIP wp:${m.wpUserId} — implausible email "${m.email}"`);
            }
            continue;
        }
        seen.add(m.email);

        const byWp = await pool.query(
            "SELECT id FROM public.users WHERE wp_user_id = $1",
            [m.wpUserId],
        );
        if (byWp.rows.length > 0) {
            matched += 1;
            continue;
        }

        const byEmail = await pool.query<{ id: string; wp_user_id: number | null }>(
            "SELECT id, wp_user_id FROM public.users WHERE email = $1",
            [m.email],
        );
        if (byEmail.rows.length > 0) {
            matched += 1;
            const row = byEmail.rows[0];
            if (row.wp_user_id == null && EXECUTE) {
                await pool.query(
                    "UPDATE public.users SET wp_user_id = $1 WHERE id = $2",
                    [m.wpUserId, row.id],
                );
            } else if (row.wp_user_id != null && row.wp_user_id !== m.wpUserId) {
                console.warn(
                    `CSV WARN ${m.email} — existing row has wp_user_id ${row.wp_user_id}, CSV says ${m.wpUserId}; keeping existing`,
                );
            }
            continue;
        }

        inserted += 1;
        if (!EXECUTE) {
            console.log(`CSV NEW ${m.email} (wp:${m.wpUserId})`);
            continue;
        }
        await pool.query(
            `INSERT INTO public.users (wp_user_id, email, display_name)
             VALUES ($1, $2, $3)
             ON CONFLICT (wp_user_id) DO NOTHING`,
            [m.wpUserId, m.email, m.displayName],
        );
        console.log(`CSV NEW ${m.email} (wp:${m.wpUserId})`);
    }
    return { inserted, matched, skipped };
}

async function main(): Promise<void> {
    if (!SUPABASE_SECRET_KEY) {
        console.error(
            "SUPABASE_SECRET_KEY is not set. Fetch it with:\n" +
                "  export SUPABASE_SECRET_KEY=$(gcloud secrets versions access latest " +
                "--secret=SUPABASE_SECRET_KEY --project <GCP_PROJECT>)",
        );
        process.exit(1);
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, {
        auth: { autoRefreshToken: false, persistSession: false },
    });

    const pool = await getPool();

    // 0. Optional: seed public.users from a WP/UMP member export so
    //    site-only members (never opened Eulex Desk) get migrated too.
    if (CSV_PATH) {
        const members = readCsvMembers(CSV_PATH);
        console.log(`CSV members parsed: ${members.length}`);
        const r = await ensureLocalUsersFromCsv(pool, members);
        console.log(
            `CSV: ${r.inserted} new local users, ${r.matched} already present, ${r.skipped} skipped`,
        );
        if (!EXECUTE && r.inserted > 0) {
            console.log(
                "(dry run — the new CSV users below are NOT yet in public.users, " +
                    "so the sweep total excludes them until --execute)",
            );
        }
    }

    // 1. Local users that have no Supabase identity yet.
    const { rows: pending } = await pool.query<{
        id: string;
        email: string;
        display_name: string | null;
    }>(
        `SELECT u.id, u.email, u.display_name
           FROM public.users u
          WHERE NOT EXISTS (
                SELECT 1 FROM public.user_supabase_identity i
                 WHERE i.user_id = u.id)
          ORDER BY u.created_at ASC`,
    );
    console.log(`Local users without a Supabase identity: ${pending.length}`);

    // 2. All existing Supabase users → email → id map (handles reruns and
    //    users who signed up directly before the migration ran).
    const emailToSupabaseId = new Map<string, string>();
    let page = 1;
    for (;;) {
        const { data, error } = await supabase.auth.admin.listUsers({
            page,
            perPage: 1000,
        });
        if (error) {
            console.error(`listUsers page ${page} failed:`, error.message);
            process.exit(1);
        }
        for (const u of data.users) {
            if (u.email) emailToSupabaseId.set(u.email.toLowerCase(), u.id);
        }
        if (data.users.length < 1000) break;
        page += 1;
    }
    console.log(`Existing Supabase auth.users: ${emailToSupabaseId.size}`);
    console.log(EXECUTE ? "Mode: EXECUTE" : "Mode: dry run (use --execute to apply)");

    let created = 0;
    let linked = 0;
    let skipped = 0;
    const errors: string[] = [];
    const seenEmails = new Set<string>();

    for (const user of pending.slice(0, LIMIT)) {
        const email = (user.email ?? "").toLowerCase().trim();

        if (!isPlausibleEmail(email)) {
            skipped += 1;
            console.warn(`SKIP   ${user.id} — implausible email "${user.email}"`);
            continue;
        }
        if (seenEmails.has(email)) {
            skipped += 1;
            console.warn(`SKIP   ${user.id} — duplicate local email ${email}`);
            continue;
        }
        seenEmails.add(email);

        try {
            let supabaseId = emailToSupabaseId.get(email);

            if (!supabaseId) {
                if (!EXECUTE) {
                    created += 1;
                    console.log(`CREATE ${email}`);
                    continue;
                }
                const { data, error } = await supabase.auth.admin.createUser({
                    email,
                    email_confirm: true,
                    user_metadata: {
                        display_name:
                            user.display_name?.trim() || email.split("@")[0],
                    },
                });
                if (error || !data.user) {
                    errors.push(`${email}: ${error?.message ?? "no user returned"}`);
                    console.error(`ERROR  ${email} — ${error?.message}`);
                    continue;
                }
                supabaseId = data.user.id;
                emailToSupabaseId.set(email, supabaseId);
                created += 1;
                console.log(`CREATE ${email} → ${supabaseId}`);
            } else {
                linked += 1;
                console.log(`LINK   ${email} → ${supabaseId}`);
                if (!EXECUTE) continue;
            }

            await pool.query(
                `INSERT INTO public.user_supabase_identity
                     (supabase_user_id, user_id, email)
                 VALUES ($1, $2, $3)
                 ON CONFLICT (supabase_user_id) DO NOTHING`,
                [supabaseId, user.id, email],
            );
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            errors.push(`${email}: ${msg}`);
            console.error(`ERROR  ${email} — ${msg}`);
        }
    }

    console.log("\n──── Report ─────────────────────────────");
    console.log(`created : ${created}`);
    console.log(`linked  : ${linked}  (already existed in Supabase)`);
    console.log(`skipped : ${skipped}`);
    console.log(`errors  : ${errors.length}`);
    for (const e of errors) console.log(`  - ${e}`);

    await closePool();
    process.exit(errors.length > 0 ? 2 : 0);
}

main().catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
});
