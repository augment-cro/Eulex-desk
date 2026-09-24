#!/usr/bin/env node
import { Client } from "pg";

const [, , portArg = "5433", dbArg = "mike", userArg] = process.argv;
const client = new Client({
    host: "127.0.0.1",
    port: Number(portArg),
    database: dbArg,
    user: userArg,
    ssl: false,
});

await client.connect();

const TABLES = [
    "user_tier_state",
    "ump_membership_levels",
    "ump_user_level_assignments",
    "user_token_credits",
    "tier_limits",
    "users",
];

for (const t of TABLES) {
    const r = await client.query(
        `SELECT to_regclass('public.' || $1) AS reg`,
        [t],
    );
    console.log(t.padEnd(30), r.rows[0].reg ? "OK" : "MISSING");
}

const tier = await client.query(
    `SELECT column_name, data_type
       FROM information_schema.columns
      WHERE table_schema='public' AND table_name='user_tier_state'
      ORDER BY ordinal_position`,
);
console.log("\nuser_tier_state columns:");
for (const c of tier.rows)
    console.log("  ", c.column_name.padEnd(25), c.data_type);

const ump = await client.query(
    `SELECT column_name, data_type
       FROM information_schema.columns
      WHERE table_schema='public' AND table_name='ump_user_level_assignments'
      ORDER BY ordinal_position`,
);
console.log("\nump_user_level_assignments columns:");
for (const c of ump.rows)
    console.log("  ", c.column_name.padEnd(25), c.data_type);

await client.end();
