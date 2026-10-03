import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { describeTierGrant, expiryHistoryEntry, grantKind } from "./tierGrant";
import { grantReasonPrefix } from "./externalGrants";

const now = new Date("2026-10-02T14:00:00Z");

describe("grantKind", () => {
    it("tells an operator grant from a Stripe, offline-paid or partner one", () => {
        assert.equal(grantKind("admin", "Probni pristup 5 dana."), "manual");
        assert.equal(grantKind("admin", null), "manual");
        assert.equal(grantKind("admin", `${grantReasonPrefix("billing")} virman: ponuda 12`), "external");
        assert.equal(grantKind("stripe", null), "stripe");
        assert.equal(grantKind("ump_sync", "UMP status=active"), "ump");
        assert.equal(grantKind(null, null), "unknown");
    });
});

describe("describeTierGrant", () => {
    it("folds a grant past its until to free and flags it expired", () => {
        const v = describeTierGrant(
            { level: 9, until: "2026-09-16T08:50:00Z", source: "admin", reason: "Probni pristup 5 dana." },
            now,
        );
        assert.deepEqual(v, { effectiveLevelId: null, expired: true, kind: "manual" });
    });

    it("keeps a live grant, with or without an end date", () => {
        assert.deepEqual(
            describeTierGrant({ level: 9, until: "2026-10-14T21:50:00Z", source: "admin", reason: null }, now),
            { effectiveLevelId: 9, expired: false, kind: "manual" },
        );
        assert.deepEqual(
            describeTierGrant({ level: 7, until: null, source: "stripe", reason: null }, now),
            { effectiveLevelId: 7, expired: false, kind: "stripe" },
        );
    });

    it("has no grant kind for a user without a grant", () => {
        assert.deepEqual(
            describeTierGrant({ level: null, until: null, source: "admin", reason: "AdminMax manual clear" }, now),
            { effectiveLevelId: null, expired: false, kind: null },
        );
    });
});

describe("expiryHistoryEntry", () => {
    it("adds the missing → Free row, dated at the expiry", () => {
        const e = expiryHistoryEntry({ level: 9, until: "2026-09-16T08:50:00Z", label: "Legal Pro" }, now);
        assert.ok(e);
        assert.equal(e.created_at, "2026-09-16T08:50:00.000Z");
        assert.equal(e.old_tier_level_id, 9);
        assert.equal(e.old_label, "Legal Pro");
        assert.equal(e.new_tier_level_id, null);
        assert.equal(e.source, "expiry");
    });

    it("adds nothing while the grant still runs or has no end date", () => {
        assert.equal(expiryHistoryEntry({ level: 9, until: "2026-10-17T11:53:00Z", label: "Legal Pro" }, now), null);
        assert.equal(expiryHistoryEntry({ level: 9, until: null, label: "Legal Pro" }, now), null);
        assert.equal(expiryHistoryEntry({ level: null, until: null, label: null }, now), null);
    });
});
