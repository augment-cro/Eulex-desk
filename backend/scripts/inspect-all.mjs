#!/usr/bin/env node
import { Client } from "pg";

const TABLES = [
    "users",
    "user_profiles",
    "projects",
    "project_subfolders",
    "documents",
    "document_versions",
    "document_edits",
    "chats",
    "chat_messages",
    "workflows",
    "workflow_shares",
    "hidden_workflows",
    "user_mcp_servers",
    "tabular_reviews",
    "tabular_cells",
    "tabular_review_chats",
    "tabular_review_chat_messages",
];

const [, , portArg, dbArg, userArg] = process.argv;
const client = new Client({
    host: "127.0.0.1",
    port: Number(portArg),
    database: dbArg,
    user: userArg,
    password: process.env.PGPASSWORD,
    ssl: false,
});

await client.connect();

for (const t of TABLES) {
    const exists = await client.query(
        `SELECT to_regclass('public.' || $1) AS reg`,
        [t],
    );
    if (!exists.rows[0].reg) {
        console.log(`\n=== ${t} === MISSING`);
        continue;
    }
    const cols = await client.query(
        `SELECT column_name, data_type, is_nullable, column_default
         FROM information_schema.columns
         WHERE table_schema='public' AND table_name=$1
         ORDER BY ordinal_position`,
        [t],
    );
    console.log(`\n=== ${t} ===`);
    for (const r of cols.rows) {
        const def = r.column_default
            ? r.column_default.length > 40
                ? r.column_default.slice(0, 40) + "…"
                : r.column_default
            : "-";
        console.log(`  ${r.column_name.padEnd(24)} ${r.data_type.padEnd(28)} null=${r.is_nullable.padEnd(3)} default=${def}`);
    }
    const cons = await client.query(
        `SELECT conname, pg_get_constraintdef(oid) AS def
         FROM pg_constraint
         WHERE conrelid = ('public.' || $1)::regclass
           AND contype IN ('f','c','u')
         ORDER BY conname`,
        [t],
    );
    if (cons.rows.length > 0) {
        console.log("  -- constraints --");
        for (const r of cons.rows) {
            const def = r.def.length > 90 ? r.def.slice(0, 90) + "…" : r.def;
            console.log(`  ${r.conname.padEnd(50)} ${def}`);
        }
    }
}

await client.end();
