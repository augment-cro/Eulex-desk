import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { addContextDocuments, contextDocumentIds, SYSTEM_CONTEXT_OWNER } from "./contextDocuments.js";
import type { DocIndex, DocStore } from "../chatTools.js";
import type { ResolvedContext, UnavailableContextItem } from "./contextsRuntime.js";

const ctx: ResolvedContext = {
  id: "sys",
  instructions_md: "",
  level: "system",
  sources: [
    { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1", kind: "document", label: "AZOP smjernice" },
    { id: "32024R1689", kind: "legal_instrument" },
    { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2", kind: "document" },
  ],
};

/** Fake Supabase-ish client: documents filtered by id/user/status; versions by id. */
function fakeDb(docs: Record<string, unknown>[], versions: Record<string, unknown>[]) {
  const seen: { user?: string } = {};
  return {
    seen,
    from(table: string) {
      return {
        select() {
          return {
            in(_c: string, ids: string[]) {
              if (table === "document_versions") {
                return Promise.resolve({ data: versions.filter((v) => ids.includes(v.id as string)) });
              }
              return {
                eq(_c1: string, user: string) {
                  seen.user = user;
                  return {
                    eq: async () => ({
                      data: docs.filter((d) => ids.includes(d.id as string) && d.user_id === user && d.status === "ready"),
                    }),
                  };
                },
              };
            },
          };
        },
      };
    },
  };
}

describe("context documents", () => {
  it("lists only document-kind source ids", () => {
    assert.deepEqual(contextDocumentIds([ctx]), ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2"]);
    assert.deepEqual(contextDocumentIds(undefined), []);
  });

  it("adds the system-owned documents after the turn's own, never other users' files", async () => {
    const docIndex: DocIndex = { "doc-0": { document_id: "mine", filename: "ugovor.pdf" } };
    const docStore: DocStore = new Map([["doc-0", { storage_path: "p0", file_type: "pdf", filename: "ugovor.pdf" }]]);
    const db = fakeDb(
      [
        { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1", filename: "AZOP smjernice.pdf", file_type: "pdf", current_version_id: "v1", status: "ready", user_id: SYSTEM_CONTEXT_OWNER },
        { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2", filename: "tuđi.pdf", file_type: "pdf", current_version_id: "v2", status: "ready", user_id: "someone" },
      ],
      [{ id: "v1", storage_path: "sys/v1.pdf", pdf_storage_path: "sys/v1.pdf", version_number: 1 }],
    );
    await addContextDocuments({ docIndex, docStore, active: [ctx], db });
    assert.equal(db.seen.user, SYSTEM_CONTEXT_OWNER);
    assert.deepEqual(Object.keys(docIndex), ["doc-0", "doc-1"]);
    assert.equal(docIndex["doc-1"].document_id, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1");
    assert.equal(docStore.get("doc-1")?.storage_path, "sys/v1.pdf");
  });

  it("ignores documents of personal contexts and malformed ids; marks context docs read-only", async () => {
    const personal: ResolvedContext = { id: "p", instructions_md: "", sources: [{ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1", kind: "document" }] };
    assert.deepEqual(contextDocumentIds([personal]), []);
    const sys: ResolvedContext = {
      id: "s", instructions_md: "", level: "system",
      sources: [{ id: "not-a-uuid", kind: "document" }, { id: "11111111-1111-4111-8111-111111111111", kind: "document" }],
    };
    assert.deepEqual(contextDocumentIds([sys]), ["11111111-1111-4111-8111-111111111111"]);
    const docIndex: DocIndex = {};
    const db = fakeDb(
      [{ id: "11111111-1111-4111-8111-111111111111", filename: "a.pdf", file_type: "pdf", current_version_id: "v1", status: "ready", user_id: SYSTEM_CONTEXT_OWNER }],
      [{ id: "v1", storage_path: "sys/a.pdf", pdf_storage_path: "sys/a.pdf", version_number: 1 }],
    );
    await addContextDocuments({ docIndex, docStore: new Map(), active: [sys], db });
    assert.equal(docIndex["doc-0"].read_only, true);
  });

  it("follows the pack, not UUID order: contexts in prompt order, sources as listed, first occurrence wins", async () => {
    const map = "ffffffff-ffff-4fff-8fff-fffffffffff1"; // the chapter map, listed first
    const form = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
    const other = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa9";
    const first: ResolvedContext = {
      id: "ctx-a", instructions_md: "", level: "system",
      sources: [{ id: map, kind: "document" }, { id: form, kind: "document" }],
    };
    const second: ResolvedContext = {
      id: "ctx-b", instructions_md: "", level: "system",
      sources: [{ id: other, kind: "document" }, { id: map, kind: "document" }],
    };
    const personal: ResolvedContext = { id: "0-personal", instructions_md: "", sources: [] };
    // Passed out of order: prompt order puts system contexts first, by id.
    assert.deepEqual(contextDocumentIds([personal, second, first]), [map, form, other]);

    const docIndex: DocIndex = {};
    const db = fakeDb(
      [other, form, map].map((id, i) => ({
        id, filename: `${i}.pdf`, file_type: "pdf", current_version_id: `v-${id}`, status: "ready", user_id: SYSTEM_CONTEXT_OWNER,
      })),
      [other, form, map].map((id) => ({ id: `v-${id}`, storage_path: `sys/${id}.pdf`, version_number: 1 })),
    );
    await addContextDocuments({ docIndex, docStore: new Map(), active: [second, first], db });
    assert.deepEqual(
      Object.entries(docIndex).map(([label, d]) => [label, d.document_id]),
      [["doc-0", map], ["doc-1", form], ["doc-2", other]],
    );
  });

  it("fails soft on a lookup error", async (t) => {
    t.mock.method(console, "warn", () => {});
    const docIndex: DocIndex = {};
    await addContextDocuments({ docIndex, docStore: new Map(), active: [ctx], db: { from() { throw new Error("db down"); } } });
    assert.deepEqual(docIndex, {});
  });

  it("reports each listed document that did not join, under its source label (else file name, else id)", async (t) => {
    t.mock.method(console, "warn", () => {});
    const ok = "11111111-1111-4111-8111-111111111111";
    const noFile = "22222222-2222-4222-8222-222222222222";
    const notReady = "33333333-3333-4333-8333-333333333333";
    const gone = "44444444-4444-4444-8444-444444444444";
    const sys: ResolvedContext = {
      id: "s", instructions_md: "", level: "system",
      sources: [
        { id: gone, kind: "document", label: "Poglavlja (karta)" },
        { id: ok, kind: "document", label: "AZOP smjernice" },
        { id: noFile, kind: "document" },
        { id: notReady, kind: "document", label: "  " },
      ],
    };
    const db = fakeDb(
      [
        { id: ok, filename: "smjernice.pdf", file_type: "pdf", current_version_id: "v1", status: "ready", user_id: SYSTEM_CONTEXT_OWNER },
        { id: noFile, filename: "obrazac.docx", file_type: "docx", current_version_id: "v-missing", status: "ready", user_id: SYSTEM_CONTEXT_OWNER },
        { id: notReady, filename: "u-obradi.pdf", file_type: "pdf", current_version_id: "v3", status: "processing", user_id: SYSTEM_CONTEXT_OWNER },
      ],
      [
        { id: "v1", storage_path: "sys/v1.pdf", version_number: 1 },
        { id: "v3", storage_path: "sys/v3.pdf", version_number: 1 },
      ],
    );
    const docIndex: DocIndex = {};
    const unavailable: UnavailableContextItem[] = [];
    await addContextDocuments({ docIndex, docStore: new Map(), active: [sys], db, unavailable });
    assert.deepEqual(Object.values(docIndex).map((d) => d.document_id), [ok]);
    assert.deepEqual(unavailable, [
      { kind: "document", name: "Poglavlja (karta)" },
      { kind: "document", name: "obrazac.docx" },
      { kind: "document", name: notReady },
    ]);
  });

  it("a lookup error makes every listed document unavailable; a document already in the turn is not reported", async (t) => {
    t.mock.method(console, "warn", () => {});
    const docIndex: DocIndex = { "doc-0": { document_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2", filename: "već.pdf" } };
    const unavailable: UnavailableContextItem[] = [];
    await addContextDocuments({
      docIndex, docStore: new Map(), active: [ctx], unavailable,
      db: { from() { throw new Error("db down"); } },
    });
    assert.deepEqual(unavailable, [{ kind: "document", name: "AZOP smjernice" }]);
    // Nothing listed, nothing reported — and the collector is optional.
    const none: UnavailableContextItem[] = [];
    await addContextDocuments({ docIndex: {}, docStore: new Map(), active: [], db: {}, unavailable: none });
    assert.deepEqual(none, []);
  });
});
