import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    _resetShieldCapabilitiesForTesting,
    shieldCapabilities,
    shieldHasCapability,
} from "./capabilities";

describe("shieldCapabilities", () => {
    beforeEach(() => _resetShieldCapabilitiesForTesting());

    it("reports the shield's capabilities and caches the probe", async () => {
        let calls = 0;
        const probe = async () => {
            calls++;
            return { ok: true as const, data: { capabilities: ["session_lock", "analysis_cache"] } };
        };
        assert.equal(await shieldHasCapability("session_lock", probe), true);
        assert.equal(await shieldHasCapability("analysis_cache", probe), true);
        assert.equal(await shieldHasCapability("teleport", probe), false);
        assert.equal(calls, 1);
    });

    it("an older shield without the field has no capabilities", async () => {
        const probe = async () => ({ ok: true as const, data: {} });
        assert.equal(await shieldHasCapability("session_lock", probe), false);
    });

    it("a failed probe means no capabilities, and is retried later", async () => {
        const probe = async () => ({ ok: false as const, error: "HTTP 503" });
        assert.deepEqual([...(await shieldCapabilities(probe))], []);
        _resetShieldCapabilitiesForTesting();
        const probe2 = async () => {
            throw new Error("network");
        };
        assert.equal(await shieldHasCapability("session_lock", probe2), false);
    });

    it("collapses concurrent probes into one call", async () => {
        let calls = 0;
        const probe = async () => {
            calls++;
            await new Promise<void>((r) => setImmediate(r));
            return { ok: true as const, data: { capabilities: ["session_lock"] } };
        };
        const [a, b] = await Promise.all([
            shieldHasCapability("session_lock", probe),
            shieldHasCapability("session_lock", probe),
        ]);
        assert.deepEqual([a, b], [true, true]);
        assert.equal(calls, 1);
    });
});
