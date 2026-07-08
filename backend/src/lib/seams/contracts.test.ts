import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

// Tests run from backend/ (npm test cwd) — contracts/ sits at the repo root.
const CONTRACTS_DIR = path.resolve(process.cwd(), "..", "contracts");

const DOCS: Array<{ file: string; paths: string[] }> = [
    {
        file: "context-provider.openapi.json",
        paths: ["/contexts", "/contexts/{id}/resolve", "/notifications"],
    },
    { file: "pre-inference-hook.openapi.json", paths: ["/pre-inference"] },
    { file: "audit-sink.openapi.json", paths: ["/audit"] },
];

describe("open interface contracts", () => {
    for (const doc of DOCS) {
        it(`${doc.file} parses and declares its paths`, () => {
            const raw = readFileSync(path.join(CONTRACTS_DIR, doc.file), "utf8");
            const parsed = JSON.parse(raw) as {
                openapi?: string;
                paths?: Record<string, unknown>;
            };
            assert.match(parsed.openapi ?? "", /^3\./);
            for (const p of doc.paths) {
                assert.ok(parsed.paths?.[p], `missing path ${p}`);
            }
        });
    }
});
