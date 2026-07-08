#!/usr/bin/env node
/**
 * Apply a SQL migration to a local Cloud SQL Proxy connection as a given user.
 *
 * Usage:
 *   PGPASSWORD=... node backend/scripts/run-migration.mjs <port> <db> <user> <sql-file>
 *
 * The script runs the entire file as one transaction so partial failures roll
 * back cleanly.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Client } from "pg";

const [, , portArg, dbArg, userArg, fileArg] = process.argv;
if (!portArg || !dbArg || !userArg || !fileArg) {
    console.error("usage: run-migration.mjs <port> <db> <user> <sql-file>");
    process.exit(2);
}

const port = Number(portArg);
const sqlPath = resolve(fileArg);
const sql = readFileSync(sqlPath, "utf8");

const client = new Client({
    host: "127.0.0.1",
    port,
    database: dbArg,
    user: userArg,
    password: process.env.PGPASSWORD,
    ssl: false,
});

(async () => {
    try {
        await client.connect();
        console.log(`[migration] connected as ${userArg} to ${dbArg} on :${port}`);
        await client.query("BEGIN");
        await client.query(sql);
        await client.query("COMMIT");
        console.log(`[migration] applied ${sqlPath}`);
    } catch (err) {
        try {
            await client.query("ROLLBACK");
        } catch {
            /* ignore */
        }
        console.error(`[migration] FAILED: ${err.message}`);
        if (err.position) console.error(`  position: ${err.position}`);
        if (err.detail) console.error(`  detail:   ${err.detail}`);
        if (err.hint) console.error(`  hint:     ${err.hint}`);
        process.exit(1);
    } finally {
        await client.end();
    }
})();
