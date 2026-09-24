#!/usr/bin/env node
/**
 * One-time backfill: legacy WordPress chat history (eulex-ai-20 plugin, MariaDB
 * `eulex_eulexweb`) -> assistant `chats` / `chat_messages` in mike-db.
 *
 * Each legacy conversation (`wp_eulex_chat_context`) becomes one `chats` row;
 * each legacy message (`wp_eulex_chat_history`, one row per turn) becomes one
 * `chat_messages` row, preserving the original `created_at` so the assistant's
 * chat list orders them by date.
 *
 * Source: three JSONL exports produced on the VM with `--raw -N -B` +
 * JSON_OBJECT (see the project plan). Default dir is the session scratchpad;
 * override with --data-dir=<path>. Expected files:
 *   eulex_context.jsonl  {id,user_id,title,status,created_at}
 *   eulex_history.jsonl  {id,case_id,message_type,content,created_at}
 *   eulex_users.jsonl    {ID,email}
 *
 * Identity bridge: wp user_id -> wp_users.email -> public.users.id (uuid),
 * matched case-insensitively on email. Users with no matching account are
 * skipped and reported.
 *
 * Content shape (must match what frontend getChat() expects):
 *   user      -> jsonb string literal   JSON.stringify(text)
 *   assistant -> jsonb array            [{ "type":"content", "text": text }]
 *
 * Connection: Cloud SQL Connector (PUBLIC IP) against
 * mikeoss-495610:europe-west1:mike-db, authType PASSWORD as `postgres`
 * (break-glass). The caller sets the password via gcloud and passes it in
 * PGPASSWORD, then rotates it afterwards (see memory `mike-db-ddl-access`).
 *
 * Usage:
 *   PGPASSWORD=... node scripts/migrate-wp-chat-history.mjs --dry-run
 *   PGPASSWORD=... node scripts/migrate-wp-chat-history.mjs --only-email=foo@bar.com
 *   PGPASSWORD=... node scripts/migrate-wp-chat-history.mjs            # full live run
 *
 * Flags:
 *   --dry-run            count only, no writes; also prints chat_messages schema
 *   --only-email=<addr>  restrict to a single user's email (test cohort)
 *   --data-dir=<path>    directory holding the three JSONL files
 *   --source-tz=<tz>     timezone the legacy naive timestamps are in
 *                        (default UTC; values are interpreted AT TIME ZONE this)
 */

import fs from "node:fs";
import path from "node:path";
import pg from "pg";
import {
    Connector,
    AuthTypes,
    IpAddressTypes,
} from "@google-cloud/cloud-sql-connector";

// ---- args -----------------------------------------------------------------
const argv = process.argv.slice(2);
const hasFlag = (n) => argv.includes(n);
const getOpt = (n, d) => {
    const hit = argv.find((a) => a.startsWith(`${n}=`));
    return hit ? hit.slice(n.length + 1) : d;
};
const DRY_RUN = hasFlag("--dry-run");
const ONLY_EMAIL = (getOpt("--only-email", "") || "").toLowerCase().trim();
const SOURCE_TZ = getOpt("--source-tz", "UTC");
const DATA_DIR = getOpt(
    "--data-dir",
    "/private/tmp/claude-501/-Users-bojanplese-Projekti-Max-mike-main/956e7722-dfb5-4d7f-9a99-eeff4ecd929a/scratchpad",
);
const INSTANCE = "mikeoss-495610:europe-west1:mike-db";

// ---- load JSONL -----------------------------------------------------------
function readJsonl(file) {
    const p = path.join(DATA_DIR, file);
    return fs
        .readFileSync(p, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l));
}

const context = readJsonl("eulex_context.jsonl");
const history = readJsonl("eulex_history.jsonl");
const wpUsers = readJsonl("eulex_users.jsonl");

// wp user id -> lowercased email
const wpEmailById = new Map(
    wpUsers
        .filter((u) => u.email)
        .map((u) => [String(u.ID), String(u.email).toLowerCase().trim()]),
);

// group messages by case, sorted by (created_at, id)
const msgsByCase = new Map();
for (const m of history) {
    const k = String(m.case_id);
    if (!msgsByCase.has(k)) msgsByCase.set(k, []);
    msgsByCase.get(k).push(m);
}
for (const arr of msgsByCase.values()) {
    arr.sort(
        (a, b) =>
            String(a.created_at).localeCompare(String(b.created_at)) ||
            Number(a.id) - Number(b.id),
    );
}

function titleFor(ctx, msgs) {
    const t = (ctx.title || "").trim();
    if (t) return t.slice(0, 255);
    const firstUser = msgs.find((m) => m.message_type === "user");
    return (firstUser?.content || "Razgovor").trim().slice(0, 120);
}

// Legacy citation tokens from the old plugin look like
//   [[DIRECTIVE:<CELEX>:<display name>]]
// (the "DIRECTIVE:" prefix is generic — it wraps regulations, directives and
// CJEU cases alike; the first field is always a EUR-Lex CELEX id).
//
// We convert each token two ways at once:
//   1. In the prose, replace the token with its clean display name, so old
//      answers read naturally (no raw "[[...]]", no fragile inline markers).
//   2. Collect a deduped (by CELEX) list of EU legal sources for the message,
//      shaped exactly like the native `legal_source_data` annotation the
//      frontend renders in the "Izvori" list under the answer. Each is
//      clickable and opens the FULL document in-app via the `/legal-docs`
//      proxy (fetchPath `/api/v1/documents/<CELEX>`), matching how native
//      answers harvest EU sources (see backend lsFromEu / legalSourcesForList).
const TOKEN_RE = /\[\[DIRECTIVE:([^:\]]+):([^\]]*)\]\]/g;

// LegalSource built deterministically from a CELEX id (no lookup needed).
// externalUrl is intentionally null: migrated sources open the full document
// in-app (via fetchPath) but must NOT show the "Otvori na EUR-Lexu" button —
// that button is gated on source.externalUrl in LegalSourcePanel.tsx. Native
// MCP answers keep their externalUrl and button untouched.
function legalSourceFromCelex(celex, name) {
    const title = (name || celex).replace(/[[\]]/g, "").trim() || celex;
    return {
        id: `@eu/celex/${celex}`,
        scope: "@eu",
        title,
        citation: title,
        snippet: null,
        externalUrl: null,
        articleLabel: null,
        fetchPath: `/api/v1/documents/${celex}`,
        celex,
        inForce: null,
    };
}

// Returns { text, annotations } for an assistant message body.
function transformAssistant(raw) {
    const text = String(raw ?? "");
    const byId = new Map(); // source.id -> LegalSource (dedupe)
    let m;
    TOKEN_RE.lastIndex = 0;
    while ((m = TOKEN_RE.exec(text)) !== null) {
        const celex = m[1].trim();
        const src = legalSourceFromCelex(celex, m[2]);
        if (!byId.has(src.id)) byId.set(src.id, src);
    }
    const clean = text.replace(TOKEN_RE, (_m, celex, name) =>
        (name || celex).replace(/[[\]]/g, "").trim() || celex.trim(),
    );
    const annotations = [...byId.values()].map((source, i) => ({
        type: "legal_source_data",
        ref: i + 1,
        source,
        quote: "",
    }));
    return { text: clean, annotations };
}

// User questions: just strip tokens to clean text (rare, but be safe).
const cleanUserText = (raw) =>
    String(raw ?? "").replace(TOKEN_RE, (_m, celex, name) =>
        (name || celex).replace(/[[\]]/g, "").trim() || celex.trim(),
    );

// jsonb payload for a user message (matches getChat() expectations)
const userContent = (text) => JSON.stringify(cleanUserText(text));

// ---- db -------------------------------------------------------------------
async function main() {
    if (!process.env.PGPASSWORD) {
        console.error("PGPASSWORD not set (break-glass postgres password)");
        process.exit(2);
    }
    const connector = new Connector();
    const opts = await connector.getOptions({
        instanceConnectionName: INSTANCE,
        authType: AuthTypes.PASSWORD,
        ipType: IpAddressTypes.PUBLIC,
    });
    const pool = new pg.Pool({
        ...opts,
        user: "postgres",
        password: process.env.PGPASSWORD,
        database: "mike",
        max: 4,
    });

    const stats = {
        cases: context.length,
        empty: 0, // no qualifying user+assistant pair
        noWpEmail: 0, // wp user row had no email
        noAccount: 0, // email not present in new users
        alreadyMigrated: 0,
        skippedByFilter: 0,
        chatsInserted: 0,
        messagesInserted: 0,
    };
    const noAccountEmails = new Set();

    try {
        console.log(
            `[migrate] connected as ${(await pool.query("select current_user")).rows[0].current_user} | dry-run=${DRY_RUN} | tz=${SOURCE_TZ}` +
                (ONLY_EMAIL ? ` | only=${ONLY_EMAIL}` : ""),
        );

        // safety: legacy column must exist (migration 130). In dry-run we only
        // warn (so the read-only preview works before 130 is applied); a live
        // run hard-fails because idempotency depends on the column.
        const col = await pool.query(
            `select 1 from information_schema.columns
             where table_schema='public' and table_name='chats'
               and column_name='legacy_wp_case_id'`,
        );
        const hasLegacyCol = col.rowCount > 0;
        if (!hasLegacyCol) {
            if (!DRY_RUN)
                throw new Error(
                    "chats.legacy_wp_case_id missing — apply migration 130 first",
                );
            console.log(
                "[migrate] NOTE: legacy_wp_case_id not present yet (migration 130 not applied) — dry-run assumes 0 already-migrated",
            );
        }

        if (DRY_RUN) {
            const cm = await pool.query(
                `select column_name, data_type, is_nullable, column_default
                 from information_schema.columns
                 where table_schema='public' and table_name='chat_messages'
                 order by ordinal_position`,
            );
            console.log("[migrate] chat_messages columns:");
            for (const c of cm.rows)
                console.log(
                    `   ${c.column_name} ${c.data_type} null=${c.is_nullable} default=${c.column_default ?? "-"}`,
                );
        }

        // resolve all candidate emails -> uuid in one query
        const emails = [
            ...new Set(
                context
                    .map((c) => wpEmailById.get(String(c.user_id)))
                    .filter(Boolean),
            ),
        ];
        const u = await pool.query(
            `select id, lower(email) as email from users where lower(email) = any($1::text[])`,
            [emails],
        );
        const uuidByEmail = new Map(u.rows.map((r) => [r.email, r.id]));

        // already-migrated case ids (skip query if column not yet present)
        const allCaseIds = context.map((c) => Number(c.id));
        const migrated = new Set();
        if (hasLegacyCol) {
            const mig = await pool.query(
                `select legacy_wp_case_id from chats where legacy_wp_case_id = any($1::bigint[])`,
                [allCaseIds],
            );
            for (const r of mig.rows) migrated.add(Number(r.legacy_wp_case_id));
        }

        // process cases in stable id order
        const ordered = [...context].sort((a, b) => Number(a.id) - Number(b.id));
        for (const ctx of ordered) {
            const msgs = msgsByCase.get(String(ctx.id)) || [];
            const hasUser = msgs.some((m) => m.message_type === "user");
            const hasAsst = msgs.some((m) => m.message_type === "assistant");
            if (!hasUser || !hasAsst) {
                stats.empty++;
                continue;
            }
            const email = wpEmailById.get(String(ctx.user_id));
            if (!email) {
                stats.noWpEmail++;
                continue;
            }
            if (ONLY_EMAIL && email !== ONLY_EMAIL) {
                stats.skippedByFilter++;
                continue;
            }
            const uuid = uuidByEmail.get(email);
            if (!uuid) {
                stats.noAccount++;
                noAccountEmails.add(email);
                continue;
            }
            if (migrated.has(Number(ctx.id))) {
                stats.alreadyMigrated++;
                continue;
            }

            if (DRY_RUN) {
                stats.chatsInserted++;
                stats.messagesInserted += msgs.length;
                continue;
            }

            // one transaction per case
            const client = await pool.connect();
            try {
                await client.query("BEGIN");
                const chat = await client.query(
                    `insert into chats (user_id, project_id, title, created_at, updated_at, legacy_wp_case_id)
                     values ($1, null, $2, ($3::timestamp at time zone $4), ($3::timestamp at time zone $4), $5)
                     returning id`,
                    [uuid, titleFor(ctx, msgs), String(ctx.created_at), SOURCE_TZ, Number(ctx.id)],
                );
                const chatId = chat.rows[0].id;
                for (const m of msgs) {
                    const isUser = m.message_type === "user";
                    let payload, annotations;
                    if (isUser) {
                        payload = userContent(m.content);
                        annotations = null;
                    } else {
                        const t = transformAssistant(m.content);
                        payload = JSON.stringify([
                            { type: "content", text: t.text },
                        ]);
                        annotations = t.annotations.length
                            ? JSON.stringify(t.annotations)
                            : null;
                    }
                    await client.query(
                        `insert into chat_messages (chat_id, role, content, annotations, created_at)
                         values ($1, $2, $3::jsonb, $4::jsonb, ($5::timestamp at time zone $6))`,
                        [
                            chatId,
                            isUser ? "user" : "assistant",
                            payload,
                            annotations,
                            String(m.created_at),
                            SOURCE_TZ,
                        ],
                    );
                }
                await client.query("COMMIT");
                stats.chatsInserted++;
                stats.messagesInserted += msgs.length;
            } catch (e) {
                await client.query("ROLLBACK");
                console.error(`[migrate] case ${ctx.id} FAILED: ${e.message}`);
            } finally {
                client.release();
            }
        }

        console.log("\n=== REPORT ===");
        console.log(`legacy cases (context rows):   ${stats.cases}`);
        console.log(`skipped — empty/no Q&A pair:   ${stats.empty}`);
        console.log(`skipped — wp user no email:    ${stats.noWpEmail}`);
        console.log(`skipped — no new account:      ${stats.noAccount} (distinct emails: ${noAccountEmails.size})`);
        if (ONLY_EMAIL)
            console.log(`skipped — --only-email filter: ${stats.skippedByFilter}`);
        console.log(`already migrated (idempotent): ${stats.alreadyMigrated}`);
        console.log(
            `${DRY_RUN ? "WOULD insert" : "INSERTED"} chats:        ${stats.chatsInserted}`,
        );
        console.log(
            `${DRY_RUN ? "WOULD insert" : "INSERTED"} messages:     ${stats.messagesInserted}`,
        );
        if (noAccountEmails.size && noAccountEmails.size <= 60) {
            console.log("\nemails with no new account:");
            console.log([...noAccountEmails].sort().join("\n"));
        }
    } finally {
        await pool.end();
        connector.close();
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
