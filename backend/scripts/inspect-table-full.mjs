#!/usr/bin/env node
import { Client } from "pg";

const [, , portArg, dbArg, userArg, tableArg] = process.argv;
const client = new Client({
    host: "127.0.0.1",
    port: Number(portArg),
    database: dbArg,
    user: userArg,
    password: process.env.PGPASSWORD,
    ssl: false,
});

(async () => {
    await client.connect();

    const cols = await client.query(
        `SELECT column_name, data_type, is_nullable, column_default
         FROM information_schema.columns
         WHERE table_schema='public' AND table_name=$1
         ORDER BY ordinal_position`,
        [tableArg],
    );
    console.log("COLUMNS:");
    for (const r of cols.rows) {
        console.log(`  ${r.column_name.padEnd(22)} ${r.data_type.padEnd(28)} null=${r.is_nullable.padEnd(3)} default=${r.column_default ?? "-"}`);
    }

    const cons = await client.query(
        `SELECT conname, pg_get_constraintdef(oid) AS def
         FROM pg_constraint
         WHERE conrelid = ('public.' || $1)::regclass
         ORDER BY conname`,
        [tableArg],
    );
    console.log("\nCONSTRAINTS:");
    for (const r of cons.rows) console.log(`  ${r.conname}\n    ${r.def}`);

    const idx = await client.query(
        `SELECT indexname, indexdef FROM pg_indexes
         WHERE schemaname='public' AND tablename=$1
         ORDER BY indexname`,
        [tableArg],
    );
    console.log("\nINDEXES:");
    for (const r of idx.rows) console.log(`  ${r.indexname}\n    ${r.indexdef}`);

    await client.end();
})().catch((e) => {
    console.error("ERR:", e.message);
    process.exit(1);
});
