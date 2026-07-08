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
    const owner = await client.query(
        `SELECT schemaname, tablename, tableowner
         FROM pg_tables WHERE schemaname='public' AND tablename=$1`,
        [tableArg],
    );
    console.log("OWNER:", owner.rows);

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
    await client.end();
})().catch((e) => {
    console.error("ERR:", e.message);
    process.exit(1);
});
