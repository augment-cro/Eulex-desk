import { Router } from "express";
import type { Request, Response } from "express";
import { query } from "../lib/db";

export const statsRouter = Router();

const TOTAL_TOKEN_GIFT = 200_000_000;

/**
 * GET /stats/tokens
 * Public endpoint — no auth required.
 *
 * Vraća total potrošenih tokena ikad i gift cap.
 *
 * "used" sada uključuje SVE 4 dimenzije Anthropic usage-a:
 *   • input_tokens                 — non-cached uncached prompt
 *   • output_tokens                — model generation
 *   • cache_creation_input_tokens  — cache WRITE (5 min)
 *   • cache_read_input_tokens      — cache READ (hit-ovi na već keširani prompt)
 *
 * Razlog: 200M token gift mora odražavati STVARNI trošak prema providerima.
 * Cache read tokeni naplaćuju se ($0.30 / 1M na Claude Sonnet 4.6), a cache
 * write tokeni još više ($3.75 / 1M) — pa ih moramo uračunati u quota,
 * inače banner pokazuje 31,9 M iskorišteno a u stvarnosti je ~90 M.
 *
 * Admin dashboard već radi pravu sumu (vidi adminMax.ts /platform/usage)
 * pa se ova ruta s njim slaže.
 */
statsRouter.get("/tokens", async (_req: Request, res: Response) => {
    try {
        const result = await query<{
            input_total: string;
            output_total: string;
            cache_write_total: string;
            cache_read_total: string;
        }>(
            `SELECT
                COALESCE(SUM(input_tokens), 0)                  AS input_total,
                COALESCE(SUM(output_tokens), 0)                 AS output_total,
                COALESCE(SUM(cache_creation_input_tokens), 0)   AS cache_write_total,
                COALESCE(SUM(cache_read_input_tokens), 0)       AS cache_read_total
            FROM public.llm_usage`,
            [],
        );

        const row = result.rows[0];
        const input = Number(row?.input_total ?? 0);
        const output = Number(row?.output_total ?? 0);
        const cacheWrite = Number(row?.cache_write_total ?? 0);
        const cacheRead = Number(row?.cache_read_total ?? 0);
        const used = input + output + cacheWrite + cacheRead;

        res.setHeader("Cache-Control", "public, max-age=60");
        res.json({
            used,
            cap: TOTAL_TOKEN_GIFT,
            input,
            output,
            cache_write: cacheWrite,
            cache_read: cacheRead,
        });
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[stats/tokens] failed:", msg);
        res.status(500).json({ detail: "Failed to load token stats" });
    }
});
