/**
 * Worker-thread entry for spreadsheet reading (see lib/spreadsheetThread.ts).
 *
 * Each worker runs one job. The job arrives in `workerData`, the reply goes
 * back on `parentPort`, and the thread exits. SheetJS is synchronous, so
 * this thread absorbs the parse and the API's event loop does not.
 */

import { parentPort, workerData } from "worker_threads";
import {
    spreadsheetSheetNames,
    spreadsheetToText,
    spreadsheetToXlsx,
    type SpreadsheetInput,
} from "./spreadsheet";
import type { SpreadsheetJob, SpreadsheetJobReply } from "./spreadsheetThread";

async function run(job: SpreadsheetJob): Promise<SpreadsheetJobReply> {
    const input: SpreadsheetInput =
        job.input.kind === "csv"
            ? job.input
            : {
                  kind: "workbook",
                  bytes: Buffer.from(
                      job.input.bytes.buffer,
                      job.input.bytes.byteOffset,
                      job.input.bytes.byteLength,
                  ),
              };
    switch (job.op) {
        case "text":
            return {
                ok: true,
                op: "text",
                text: await spreadsheetToText(input, job.limits),
            };
        case "sheetNames":
            return {
                ok: true,
                op: "sheetNames",
                names: await spreadsheetSheetNames(input, job.limits),
            };
        case "xlsx": {
            const out = await spreadsheetToXlsx(input, job.limits);
            // A compact copy, so exactly these bytes are transferred.
            return { ok: true, op: "xlsx", bytes: new Uint8Array(out) };
        }
    }
}

run(workerData as SpreadsheetJob).then(
    (reply) => {
        const transfer =
            reply.ok && reply.op === "xlsx"
                ? [reply.bytes.buffer as ArrayBuffer]
                : [];
        parentPort!.postMessage(reply, transfer);
    },
    (err: unknown) => {
        const reply: SpreadsheetJobReply = {
            ok: false,
            name: err instanceof Error ? err.name : "Error",
            message: err instanceof Error ? err.message : String(err),
        };
        parentPort!.postMessage(reply);
    },
);
