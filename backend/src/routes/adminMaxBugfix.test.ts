import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { bugfixIssueStatus } from "./adminMax";

// Per-PR promotion (issue #130): a merged PR is "waiting for LIVE" only
// when ITS merge commit is still among the commits main has ahead of
// stable — other merged issues must not regress when someone merges an
// unrelated PR to main.

const PR = (over: Partial<{
    mergedAt: string | null;
    state: "open" | "closed";
    mergeCommitSha: string | null;
}> = {}) => ({
    mergedAt: "2026-07-10T12:00:00Z",
    state: "closed" as const,
    mergeCommitSha: "aaa111",
    ...over,
});

describe("bugfixIssueStatus", () => {
    it("merged PR whose commit is NOT in the ahead list → closed issue stays closed", () => {
        const deploy = { mainAheadOfStable: 2, unpromotedShas: new Set(["fff999"]) };
        assert.equal(bugfixIssueStatus("closed", PR(), deploy), "closed");
    });

    it("merged PR whose commit IS in the ahead list → merged (waiting for LIVE)", () => {
        const deploy = { mainAheadOfStable: 2, unpromotedShas: new Set(["aaa111", "fff999"]) };
        assert.equal(bugfixIssueStatus("closed", PR(), deploy), "merged");
        assert.equal(bugfixIssueStatus("open", PR(), deploy), "merged");
    });

    it("promoted fix with a still-open issue → live (deployed, awaiting closure)", () => {
        const deploy = { mainAheadOfStable: 2, unpromotedShas: new Set(["fff999"]) };
        assert.equal(bugfixIssueStatus("open", PR(), deploy), "live");
    });

    it("falls back to the global gate when the ahead list is unavailable", () => {
        // Unknown list + stable lags → conservative "merged", even if closed.
        const lagging = { mainAheadOfStable: 2, unpromotedShas: null };
        assert.equal(bugfixIssueStatus("closed", PR(), lagging), "merged");
        // Unknown list + main == stable → promoted.
        const promoted = { mainAheadOfStable: 0, unpromotedShas: null };
        assert.equal(bugfixIssueStatus("closed", PR(), promoted), "closed");
        assert.equal(bugfixIssueStatus("open", PR(), promoted), "live");
    });

    it("falls back to the global gate when the PR has no merge_commit_sha", () => {
        const deploy = { mainAheadOfStable: 1, unpromotedShas: new Set(["fff999"]) };
        assert.equal(
            bugfixIssueStatus("closed", PR({ mergeCommitSha: null }), deploy),
            "merged",
        );
    });

    it("non-merged PRs and bare issues keep the existing ladder", () => {
        const deploy = { mainAheadOfStable: 0, unpromotedShas: new Set<string>() };
        assert.equal(
            bugfixIssueStatus("open", PR({ mergedAt: null, state: "open" }), deploy),
            "pr_open",
        );
        assert.equal(
            bugfixIssueStatus("open", PR({ mergedAt: null, state: "closed" }), deploy),
            "open",
        );
        assert.equal(bugfixIssueStatus("open", null, deploy), "open");
        assert.equal(bugfixIssueStatus("closed", null, deploy), "closed");
    });
});
