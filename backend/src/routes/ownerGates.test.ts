import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { folderDeleteAllowed } from "./projects.js";
import { removedDocumentIds } from "./tabular.js";

// Unit coverage for the #26 authz gates: folder deletion is owner-only,
// and a tabular-review PATCH may only REMOVE documents when the caller is
// the owner (collaborators may still add). These pin the gate decisions
// without needing a DB — the route handlers call exactly these helpers.

describe("folderDeleteAllowed (#26)", () => {
    const project = { id: "p1", user_id: "u1", shared_with: ["b@x.hr"] };

    it("allows the project owner", () => {
        assert.equal(
            folderDeleteAllowed({ ok: true, isOwner: true, project }),
            true,
        );
    });

    it("denies a shared (non-owner) member", () => {
        assert.equal(
            folderDeleteAllowed({ ok: true, isOwner: false, project }),
            false,
        );
    });

    it("denies when there is no access at all", () => {
        assert.equal(folderDeleteAllowed({ ok: false }), false);
    });
});

describe("removedDocumentIds (#26)", () => {
    it("pure addition removes nothing", () => {
        assert.deepEqual(
            removedDocumentIds(["d1", "d2"], ["d1", "d2", "d3"]),
            [],
        );
    });

    it("detects an omitted (removed) document", () => {
        assert.deepEqual(removedDocumentIds(["d1", "d2"], ["d2"]), ["d1"]);
    });

    it("an empty request removes every attached document", () => {
        assert.deepEqual(removedDocumentIds(["d1", "d2"], []), ["d1", "d2"]);
    });

    it("non-string entries cannot 'keep' a document", () => {
        // Junk ids in the request must still count the real docs as removed.
        assert.deepEqual(removedDocumentIds(["d1"], [123, null, {}]), ["d1"]);
    });

    it("non-array request body removes nothing", () => {
        assert.deepEqual(removedDocumentIds(["d1"], undefined), []);
        assert.deepEqual(removedDocumentIds(["d1"], "d1"), []);
    });

    it("deduplicates the attached list", () => {
        assert.deepEqual(removedDocumentIds(["d1", "d1", "d2"], ["d2"]), [
            "d1",
        ]);
    });

    it("nothing attached → nothing to remove", () => {
        assert.deepEqual(removedDocumentIds([], ["d1"]), []);
    });
});
