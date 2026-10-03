/**
 * Spreadsheet reading off the API's event loop.
 *
 * SheetJS parses synchronously. A 30 MB .xls held the event loop for ~10 s,
 * and during that time every other request on the instance stalled (Cloud
 * Run: 1 vCPU, concurrency 80). Each read therefore runs in its own worker
 * thread (lib/spreadsheetWorker.ts):
 *   - one job at a time per process, first in first out. A workbook can
 *     take hundreds of MB of heap, and the container has 2 GiB;
 *   - the thread's heap is capped, so a runaway workbook kills the thread,
 *     not the API;
 *   - a job that runs past the timeout is terminated.
 * Running out of heap or time surfaces as `SpreadsheetLimitError`, the
 * same "too large" the size and cell caps raise.
 *
 * `SPREADSHEET_WORKER=off` runs jobs inline, for debugging only.
 */

import path from "path";
import { Worker, type WorkerOptions } from "worker_threads";
import {
    CSV_SHEET_NAME,
    SpreadsheetLimitError,
    spreadsheetSheetNames,
    spreadsheetToText,
    spreadsheetToXlsx,
    type SpreadsheetInput,
    type SpreadsheetLimits,
} from "./spreadsheet";

export type SpreadsheetOp = "text" | "sheetNames" | "xlsx";

/** What crosses into the worker (`workerData`). */
export interface SpreadsheetJob {
    op: SpreadsheetOp;
    input:
        | { kind: "workbook"; bytes: Uint8Array }
        | { kind: "csv"; text: string };
    limits?: SpreadsheetLimits;
}

/** What the worker posts back: exactly one message per job. */
export type SpreadsheetJobReply =
    | { ok: true; op: "text"; text: string }
    | { ok: true; op: "sheetNames"; names: string[] }
    | { ok: true; op: "xlsx"; bytes: Uint8Array }
    | { ok: false; name: string; message: string };

type OkReply = Extract<SpreadsheetJobReply, { ok: true }>;

/** Longest a single read may run before its thread is terminated. */
export const SPREADSHEET_JOB_TIMEOUT_MS = 120_000;
/** Heap cap of a reading thread (old generation). */
const WORKER_HEAP_MB = 1024;

export interface SpreadsheetJobOptions {
    /** Overrides `SPREADSHEET_JOB_TIMEOUT_MS` (tests). */
    timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// One job at a time
// ---------------------------------------------------------------------------

let queueTail: Promise<unknown> = Promise.resolve();

/** Run `task` after every job queued before it has settled. */
function serialized<T>(task: () => Promise<T>): Promise<T> {
    const run = queueTail.then(task, task);
    queueTail = run.catch(() => undefined);
    return run;
}

// ---------------------------------------------------------------------------
// The thread
// ---------------------------------------------------------------------------

/**
 * A worker running lib/spreadsheetWorker. Compiled, that is
 * dist/lib/spreadsheetWorker.js. Under tsx (dev, tests) it is the .ts
 * source, and a worker thread does not inherit tsx's loader. A small
 * CommonJS bootstrap therefore registers tsx before it loads the source.
 */
function startWorker(options: WorkerOptions): Worker {
    const file = path.join(
        __dirname,
        `spreadsheetWorker${path.extname(__filename)}`,
    );
    if (!file.endsWith(".ts")) return new Worker(file, options);
    const tsx = require.resolve("tsx/cjs");
    return new Worker(
        `require(${JSON.stringify(tsx)}); require(${JSON.stringify(file)});`,
        { ...options, eval: true },
    );
}

function runInWorker(
    job: SpreadsheetJob,
    timeoutMs: number,
): Promise<SpreadsheetJobReply> {
    return new Promise((resolve, reject) => {
        const transferList =
            job.input.kind === "workbook"
                ? [job.input.bytes.buffer as ArrayBuffer]
                : [];
        const worker = startWorker({
            workerData: job,
            transferList,
            resourceLimits: { maxOldGenerationSizeMb: WORKER_HEAP_MB },
        });
        let settled = false;
        const settle = (fn: () => void) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            fn();
        };
        const timer = setTimeout(() => {
            settle(() =>
                reject(
                    new SpreadsheetLimitError(
                        "Spreadsheet too large: reading it took too long",
                    ),
                ),
            );
            void worker.terminate();
        }, timeoutMs);
        worker.once("message", (reply: SpreadsheetJobReply) =>
            settle(() => resolve(reply)),
        );
        worker.once("error", (err: Error & { code?: string }) =>
            settle(() =>
                reject(
                    err.code === "ERR_WORKER_OUT_OF_MEMORY"
                        ? new SpreadsheetLimitError(
                              "Spreadsheet too large: reading it ran out of memory",
                          )
                        : err,
                ),
            ),
        );
        worker.once("exit", (code) =>
            settle(() =>
                reject(new Error(`Spreadsheet worker exited with code ${code}`)),
            ),
        );
    });
}

/** The same job, on the calling thread (`SPREADSHEET_WORKER=off`). */
async function runInline(
    op: SpreadsheetOp,
    input: SpreadsheetInput,
    limits: SpreadsheetLimits | undefined,
): Promise<OkReply> {
    switch (op) {
        case "text":
            return { ok: true, op, text: await spreadsheetToText(input, limits) };
        case "sheetNames":
            return {
                ok: true,
                op,
                names: await spreadsheetSheetNames(input, limits),
            };
        case "xlsx":
            return { ok: true, op, bytes: await spreadsheetToXlsx(input, limits) };
    }
}

async function runJob(
    op: SpreadsheetOp,
    input: SpreadsheetInput,
    limits: SpreadsheetLimits | undefined,
    opts: SpreadsheetJobOptions,
): Promise<OkReply> {
    if (process.env.SPREADSHEET_WORKER === "off")
        return runInline(op, input, limits);
    return serialized(async () => {
        const job: SpreadsheetJob = {
            op,
            // A private copy of the bytes, transferred rather than cloned. The
            // caller's Buffer may be a view into a larger pooled ArrayBuffer,
            // which must never be detached.
            input:
                input.kind === "csv"
                    ? input
                    : { kind: "workbook", bytes: new Uint8Array(input.bytes) },
            limits,
        };
        const reply = await runInWorker(
            job,
            opts.timeoutMs ?? SPREADSHEET_JOB_TIMEOUT_MS,
        );
        if (!reply.ok) {
            throw reply.name === "SpreadsheetLimitError"
                ? new SpreadsheetLimitError(reply.message)
                : new Error(reply.message);
        }
        if (reply.op !== op)
            throw new Error(`Spreadsheet worker answered "${reply.op}" to "${op}"`);
        return reply;
    });
}

// ---------------------------------------------------------------------------
// Public API: the lib/spreadsheet.ts readers, off the event loop
// ---------------------------------------------------------------------------

/** `spreadsheetToText` in a worker thread. */
export async function spreadsheetTextOffThread(
    input: SpreadsheetInput,
    limits?: SpreadsheetLimits,
    opts: SpreadsheetJobOptions = {},
): Promise<string> {
    const reply = await runJob("text", input, limits, opts);
    if (reply.op !== "text") throw new Error("unreachable");
    return reply.text;
}

/** `spreadsheetSheetNames` in a worker thread. A CSV needs no parse. */
export async function spreadsheetSheetNamesOffThread(
    input: SpreadsheetInput,
    limits?: SpreadsheetLimits,
    opts: SpreadsheetJobOptions = {},
): Promise<string[]> {
    if (input.kind === "csv") return [CSV_SHEET_NAME];
    const reply = await runJob("sheetNames", input, limits, opts);
    if (reply.op !== "sheetNames") throw new Error("unreachable");
    return reply.names;
}

/** `spreadsheetToXlsx` in a worker thread. */
export async function spreadsheetXlsxOffThread(
    input: SpreadsheetInput,
    limits?: SpreadsheetLimits,
    opts: SpreadsheetJobOptions = {},
): Promise<Buffer> {
    const reply = await runJob("xlsx", input, limits, opts);
    if (reply.op !== "xlsx") throw new Error("unreachable");
    return Buffer.from(
        reply.bytes.buffer,
        reply.bytes.byteOffset,
        reply.bytes.byteLength,
    );
}
