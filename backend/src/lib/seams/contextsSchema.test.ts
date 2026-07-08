import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// __dirname (CJS) instead of import.meta.url — the backend compiles as CommonJS.
const migration = (name: string) =>
  readFileSync(resolve(__dirname, `../../../migrations/${name}`), "utf8");

describe("contexts runtime schema", () => {
  it("201 creates the core-owned toggle prefs table", () => {
    assert.match(
      migration("201_custom_contexts.sql"),
      /CREATE TABLE IF NOT EXISTS public\.user_context_prefs\b/,
    );
  });

  it("203 creates the core-owned attach-link tables with their lookup indexes", () => {
    const sql = migration("203_context_links.sql");
    for (const t of ["context_workflow_links", "context_project_links"]) {
      assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS public\\.${t}\\b`));
    }
    assert.match(sql, /CREATE INDEX IF NOT EXISTS idx_context_workflow_links_wf\b/);
    assert.match(sql, /CREATE INDEX IF NOT EXISTS idx_context_project_links_proj\b/);
  });

  describe("205 deprecates the content tables without touching data", () => {
    const sql = migration("205_deprecate_context_content_tables.sql");

    it("marks every content table deprecated", () => {
      assert.match(sql, /DEPRECATED/);
      for (const t of [
        "custom_contexts", "context_sources", "context_shares",
        "source_change_events", "context_alert_events",
      ]) {
        assert.match(sql, new RegExp(`'${t}'`));
      }
    });

    it("drops the runtime tables' FKs into the deprecated content table (opaque provider ids)", () => {
      for (const fk of [
        "user_context_prefs_context_id_fkey",
        "context_workflow_links_context_id_fkey",
        "context_project_links_context_id_fkey",
      ]) {
        assert.match(sql, new RegExp(`DROP CONSTRAINT IF EXISTS ${fk}\\b`));
      }
    });

    it("contains no table drops and no DML", () => {
      assert.doesNotMatch(sql, /DROP TABLE/i);
      assert.doesNotMatch(sql, /\b(DELETE FROM|UPDATE |INSERT INTO|TRUNCATE)\b/i);
    });
  });
});
