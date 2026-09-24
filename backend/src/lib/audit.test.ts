import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { recordAuditEvent } from "./audit.js";

// Contract coverage for the workspace-audit recorder (#27): it is called
// un-awaited on request paths (`void recordAuditEvent(...)`), so it must
// NEVER throw synchronously and NEVER reject — a failed insert must never
// take a chat stream or an upload down with it. In this test environment
// there is no reachable database (or no audit_events table), so the insert
// path genuinely fails — exactly the failure mode the contract is about.

const USER = "00000000-0000-0000-0000-000000000000";

describe("recordAuditEvent (#27)", () => {
    it("resolves (never rejects) when the DB insert fails", async () => {
        await assert.doesNotReject(
            recordAuditEvent({
                userId: USER,
                eventType: "test.event",
                chatId: "11111111-1111-1111-1111-111111111111",
                metadata: { model: "claude-sonnet-4-6", cancelled: false },
            }),
        );
    });

    it("never throws synchronously and never rejects on unserializable metadata", async () => {
        const circular: Record<string, unknown> = {};
        circular.self = circular;
        let pending: Promise<void> | undefined;
        assert.doesNotThrow(() => {
            pending = recordAuditEvent({
                userId: USER,
                eventType: "test.event",
                metadata: circular,
            });
        });
        await assert.doesNotReject(pending!);
    });

    it("never rejects even on a malformed input object", async () => {
        await assert.doesNotReject(
            recordAuditEvent(null as unknown as Parameters<typeof recordAuditEvent>[0]),
        );
    });
});
