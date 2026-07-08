import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildScopeSet, identifierInScope, stemOf,
  redactToolResult, precheckToolArgs, injectScopeParam,
  isLegalMcpServer,
} from "./scopeEnforcement.js";
// The REAL production harvester — regression tests must exercise the exact
// shapes it consumes (structuredContent OBJECTS with sources/results arrays),
// not a simplified stand-in.
import { harvestLegalSources } from "../chatTools.js";

/**
 * A provider's pre-minted allowlist for one legal ref, exactly as
 * contexts-service buildScopeAllowlist wires it: norm + stem, plus the
 * "@eu/celex/" minted forms for CELEX-shaped refs. The core consumes these
 * strings opaquely; this helper only exists so tests feed realistic wire
 * payloads.
 */
function allowlistFor(ref: string): string[] {
  const n = ref.trim().toLowerCase();
  const hash = n.indexOf("#");
  const stem = hash > 0 ? n.slice(0, hash) : n;
  const out = new Set([n, stem]);
  if (/^\d{5}[a-z]{1,2}\d{4}(?:#.*)?$/i.test(n)) {
    out.add(`@eu/celex/${n}`);
    out.add(`@eu/celex/${stem}`);
  }
  return [...out].sort();
}

/** Production EU `SearchResult` shape (harvest mints "@eu/celex/{celex}"). */
function euResult(celex: string, title = celex) {
  return { celex_id: celex, title, text: `${title} body…` };
}
/** Production HR/FR `EulexSource` shape (harvest keeps the source's own id). */
function hrSource(id: string, title = id) {
  return { id, scope: "@hr", title, document: { title } };
}

describe("buildScopeSet + membership", () => {
  it("unions allowlists lower-cased; membership checks the id and its #-stem", () => {
    const wl = buildScopeSet([allowlistFor("32016R0679#art_22")]);
    assert.equal(identifierInScope("32016R0679#art_22", wl), true);
    assert.equal(identifierInScope("32016R0679", wl), true);       // instrument stem in scope
    assert.equal(identifierInScope("32019R0881", wl), false);
    assert.equal(stemOf("32016R0679#ART_22"), "32016r0679");
  });
  it("matches the minted '@eu/celex/…' ids harvestLegalSources produces (provider pre-mints them)", () => {
    const wl = buildScopeSet([allowlistFor("32016R0679#art_22")]);
    assert.equal(identifierInScope("@eu/celex/32016R0679#Article 22", wl), true);
    assert.equal(identifierInScope("@eu/celex/32016R0679", wl), true);
    assert.equal(identifierInScope("@eu/celex/32019R0881#art_5", wl), false);
  });
  it("tolerates undefined allowlists and blank entries", () => {
    assert.equal(buildScopeSet([undefined, [" ", ""]]).size, 0);
  });
});

describe("redactToolResult — real MCP payload shapes", () => {
  const wl = buildScopeSet([allowlistFor("32016R0679")]);

  it("empty whitelist → unchanged, keptSources = full harvest", () => {
    const structured = { results: [euResult("32019R0881")] };
    const text = JSON.stringify(structured);
    const r = redactToolResult({ text, structured, whitelist: new Set<string>(), harvest: harvestLegalSources });
    assert.equal(r.text, text);
    assert.equal(r.structured, structured);
    assert.equal(r.suppressed, 0);
    assert.deepEqual(r.keptSources.map((s) => s.id), ["@eu/celex/32019R0881"]);
  });

  it("all-in-scope object payload passes through untouched", () => {
    const structured = { results: [euResult("32016R0679")] };
    const text = JSON.stringify(structured);
    const r = redactToolResult({ text, structured, whitelist: wl, harvest: harvestLegalSources });
    assert.equal(r.text, text);
    assert.equal(r.structured, structured);
    assert.equal(r.suppressed, 0);
    assert.deepEqual(r.keptSources.map((s) => s.id), ["@eu/celex/32016R0679"]);
  });

  it("mixed search (9 in / 1 out) keeps the 9 in structured and never leaks the out-of-scope id", () => {
    const inScope = Array.from({ length: 9 }, (_, i) => euResult("32016R0679", `GDPR hit ${i}`));
    const structured = { results: [...inScope, euResult("32019R0881", "Cybersecurity Act")] };
    const text = JSON.stringify(structured);
    const r = redactToolResult({ text, structured, whitelist: wl, harvest: harvestLegalSources });
    assert.equal(r.suppressed, 1);
    const kept = (r.structured as { results: unknown[] }).results;
    assert.equal(kept.length, 9);                                  // (iv) the 9 survive
    assert.deepEqual(kept, inScope);                               // (ii) in-scope items preserved
    assert.ok(!JSON.stringify(r.structured).includes("32019R0881")); // (i) out-of-scope removed
    // (iii) legal_sources feed can never carry the out-of-scope id
    assert.ok(r.keptSources.length > 0);
    assert.ok(r.keptSources.every((s) => !s.id.includes("32019R0881")));
    // text mirrored the JSON → tainted → replaced, stating in-scope withheld
    assert.doesNotMatch(r.text, /32019R0881/);
    assert.match(r.text, /suppressed/i);
    assert.match(r.text, /in-scope material .* withheld/i);
    assert.match(r.text, /9 in-scope result\(s\) retained/i);
  });

  it("filters HR-style {sources:[…]} payloads by the source's own id", () => {
    const hrRef = "0947a2b1-1111-2222-3333-444455556666";
    const wlHr = buildScopeSet([allowlistFor(hrRef)]);
    const keep = hrSource(hrRef, "Zakon o radu");
    const drop = hrSource("aaaaaaaa-bbbb-cccc-dddd-eeeeffff0000", "Zakon o PDV-u");
    const structured = { sources: [keep, drop] };
    const r = redactToolResult({ text: "prose summary", structured, whitelist: wlHr, harvest: harvestLegalSources });
    assert.equal(r.suppressed, 1);
    assert.deepEqual((r.structured as { sources: unknown[] }).sources, [keep]);
    assert.deepEqual(r.keptSources.map((s) => s.id), [hrRef]);
  });

  it("preserves prose text (marker appended) when only structured items were dropped", () => {
    const structured = { results: [euResult("32016R0679"), euResult("32019R0881")] };
    const text = "I found two instruments relevant to your question.";
    const r = redactToolResult({ text, structured, whitelist: wl, harvest: harvestLegalSources });
    assert.equal(r.suppressed, 1);
    assert.match(r.text, /I found two instruments/);               // original text kept
    assert.match(r.text, /suppressed/i);                           // marker appended
    assert.deepEqual((r.structured as { results: unknown[] }).results, [euResult("32016R0679")]);
    assert.deepEqual(r.keptSources.map((s) => s.id), ["@eu/celex/32016R0679"]);
  });

  it("text-only JSON payload (no structuredContent) → conservative whole-text replacement", () => {
    const text = JSON.stringify({ results: [euResult("32019R0881")] });
    const r = redactToolResult({ text, structured: undefined, whitelist: wl, harvest: harvestLegalSources });
    assert.equal(r.suppressed, 1);
    assert.doesNotMatch(r.text, /32019R0881/);
    assert.match(r.text, /suppressed/i);
    assert.deepEqual(r.keptSources, []);
  });

  it("out-of-scope top-level celex_id (single-article fetch) drops the whole structured payload", () => {
    const structured = { celex_id: "32019R0881", title: "CSA", section_name: "Article 5", text: "…" };
    const r = redactToolResult({ text: JSON.stringify(structured), structured, whitelist: wl, harvest: harvestLegalSources });
    assert.equal(r.suppressed, 1);
    assert.equal(r.structured, undefined);
    assert.doesNotMatch(r.text, /32019R0881/);
    assert.deepEqual(r.keptSources, []);
  });

  it("pure prose with no harvestable identifiers passes through even with a whitelist", () => {
    const r = redactToolResult({ text: "no legal ids here", structured: undefined, whitelist: wl, harvest: harvestLegalSources });
    assert.deepEqual(r, { text: "no legal ids here", structured: undefined, suppressed: 0, keptSources: [] });
  });
});

describe("precheckToolArgs", () => {
  const wl = buildScopeSet([allowlistFor("32016R0679")]);
  it("refuses an out-of-scope arg shaped like an allowlist entry, allows in-scope + free-text args", () => {
    // "32019R0881" shares its character-class shape with the allowlist's
    // "32016r0679" (shape learned from the opaque strings, no id scheme
    // known here) but is not in scope → refused.
    assert.deepEqual(precheckToolArgs({ celex: "32019R0881" }, wl), { ok: false, refusedId: "32019r0881" });
    assert.deepEqual(precheckToolArgs({ celex: "32016R0679", query: "risk assessment" }, wl), { ok: true });
    assert.deepEqual(precheckToolArgs({ nested: { ids: ["32016R0679#art_22"] } }, wl), { ok: true });
  });
  it("passes strings that share no allowlist shape (they cannot be provider ids)", () => {
    assert.deepEqual(precheckToolArgs({ article: "art_22", lang: "hr" }, wl), { ok: true });
  });
  it("no-op with an empty whitelist", () => {
    assert.deepEqual(precheckToolArgs({ celex: "32019R0881" }, new Set<string>()), { ok: true });
  });
});

describe("injectScopeParam", () => {
  it("injects the sorted whitelist under the configured name; no-op when unset", () => {
    const wl = new Set(["b", "a"]);
    assert.deepEqual(injectScopeParam({ q: "x" }, wl, "allowed_sources"),
      { q: "x", allowed_sources: ["a", "b"] });
    assert.deepEqual(injectScopeParam({ q: "x" }, wl, undefined), { q: "x" });
    assert.deepEqual(injectScopeParam({ q: "x" }, new Set(), "allowed_sources"), { q: "x" });
  });
});

describe("isLegalMcpServer", () => {
  it("classifies legal research servers by slug/name, mirroring deriveActiveJurisdictions", () => {
    assert.equal(isLegalMcpServer({ slug: "eulex", name: "EULEX AI" }), true);
    assert.equal(isLegalMcpServer({ slug: "zakon-ai", name: "zakon.ai" }), true);
    assert.equal(isLegalMcpServer({ slug: "x", name: "Narodne novine" }), true);
    assert.equal(isLegalMcpServer({ slug: "legifrance", name: "Légifrance" }), true);
  });
  it("keeps generic connectors (Drive/Notion/…) out of scope enforcement", () => {
    assert.equal(isLegalMcpServer({ slug: "gdrive", name: "Google Drive" }), false);
    assert.equal(isLegalMcpServer({ slug: "notion", name: "Notion" }), false);
    assert.equal(isLegalMcpServer(undefined), false);
  });
});
