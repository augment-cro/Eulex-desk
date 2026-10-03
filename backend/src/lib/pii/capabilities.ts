import { piiClient, type Result } from "./client";

/**
 * What the deployed shield can do, from `GET /version` → `capabilities`.
 *
 * The backend and the shield deploy separately and `mike-backend-staging`
 * shares the production shield, so backend code that relies on a shield
 * behavior must not assume it is there. The one that matters today:
 * `session_lock` — the shield resolves every /anonymize call's
 * placeholders in one transaction under a session-level lock, which is
 * what makes parallel history anonymization safe. Against an older shield
 * the history goes out sequentially, as before.
 *
 * Probe results are cached per process (5 min on success, 30 s on
 * failure) so this costs one small call per instance, not one per turn.
 */

type VersionProbe = () => Promise<Result<{ capabilities?: string[] }>>;

const OK_TTL_MS = 5 * 60_000;
const FAIL_TTL_MS = 30_000;

let cached: { until: number; caps: Set<string> } | null = null;
let inflight: Promise<Set<string>> | null = null;

export async function shieldCapabilities(
    probe: VersionProbe = () => piiClient.getVersion(),
): Promise<Set<string>> {
    if (cached && Date.now() < cached.until) return cached.caps;
    if (!inflight) {
        inflight = (async () => {
            try {
                const r = await probe();
                const caps = new Set<string>(r.ok ? (r.data.capabilities ?? []) : []);
                cached = { until: Date.now() + (r.ok ? OK_TTL_MS : FAIL_TTL_MS), caps };
                return caps;
            } catch {
                const caps = new Set<string>();
                cached = { until: Date.now() + FAIL_TTL_MS, caps };
                return caps;
            } finally {
                inflight = null;
            }
        })();
    }
    return inflight;
}

export async function shieldHasCapability(name: string, probe?: VersionProbe): Promise<boolean> {
    return (await shieldCapabilities(probe)).has(name);
}

export function _resetShieldCapabilitiesForTesting(): void {
    cached = null;
    inflight = null;
}
