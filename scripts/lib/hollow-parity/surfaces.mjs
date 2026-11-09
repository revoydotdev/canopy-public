/**
 * scripts/lib/hollow-parity/surfaces.mjs — item 3, surface-scoped
 * reachability (T5.2, 2026-08-23 remediation).
 *
 * A catalog kind existing and being MCP-dispatchable (`arbor_catalog_dispatch`
 * accepts any declared kind generically) proves nothing about whether any
 * real product surface (CLI, TUI, Web) actually produces it for an operator.
 * WA-35 (audit/2026-08-23-50-defects.md) is exactly this shape: a batch of
 * catalog kinds reachable only through the raw MCP tool, with no CLI
 * subcommand, TUI screen, or Web control ever naming them. This module
 * computes, for every catalog kind, which of five surfaces produce it, pure
 * over already-loaded source texts / documents so it is trivially
 * fixture-testable.
 */

import { findLiteralKindReferences } from "./catalog.mjs";

/**
 * @param {object} input
 * @param {readonly {kind:string, direction:"command"|"query", supported:boolean}[]} input.catalog
 * @param {string} input.cliSource - packages/arbor-mcp/src/cli.ts text
 * @param {string} input.webuiSource - packages/arbor-mcp/src/webui.ts text
 * @param {ReadonlySet<string>} input.tuiKinds - from loadTuiDispositionSurfaceKinds
 * @param {ReadonlySet<string>} input.livenessProbedQueryKinds - from parseLivenessProbedQueryKinds
 * @returns {Record<string, {cli:boolean, tui:boolean, web:boolean, liveness:boolean, mcp_generic:true}>}
 */
export function computeCatalogSurfaces(input) {
  const { catalog, cliSource, webuiSource, tuiKinds, livenessProbedQueryKinds } = input;
  const kinds = catalog.map((entry) => entry.kind);
  const cliKinds = findLiteralKindReferences(cliSource, kinds);
  const webKinds = findLiteralKindReferences(webuiSource, kinds);
  /** @type {Record<string, {cli:boolean, tui:boolean, web:boolean, liveness:boolean, mcp_generic:true}>} */
  const surfaces = {};
  for (const entry of catalog) {
    surfaces[entry.kind] = {
      cli: cliKinds.has(entry.kind),
      tui: tuiKinds.has(entry.kind),
      web: webKinds.has(entry.kind),
      liveness: entry.direction === "query" && livenessProbedQueryKinds.has(entry.kind),
      mcp_generic: true,
    };
  }
  return surfaces;
}

/** Every `supported: true` kind whose only surface is the generic MCP catalog tool. */
export function mcpGenericOnlyKinds(catalog, surfaces) {
  return catalog
    .filter((entry) => entry.supported)
    .map((entry) => entry.kind)
    .filter((kind) => {
      const s = surfaces[kind];
      return s !== undefined && !s.cli && !s.tui && !s.web && !s.liveness;
    });
}

/**
 * @param {readonly string[]} mcpOnlyKinds
 * @param {{entries?: readonly {kind:string, reason:string}[]}} apiOnlyDocument
 * @returns {{findings: string[], allowlisted: {kind:string, reason:string}[], staleAllowlistEntries: string[]}}
 */
export function evaluateApiOnlyAllowlist(mcpOnlyKinds, apiOnlyDocument) {
  const allowlist = new Map((apiOnlyDocument.entries ?? []).map((entry) => [entry.kind, entry.reason]));
  const findings = [];
  const allowlisted = [];
  for (const kind of mcpOnlyKinds) {
    const reason = allowlist.get(kind);
    if (reason && reason.trim().length > 0) allowlisted.push({ kind, reason });
    else findings.push(kind);
  }
  const mcpOnlySet = new Set(mcpOnlyKinds);
  const staleAllowlistEntries = [...allowlist.keys()].filter((kind) => !mcpOnlySet.has(kind));
  return { findings: findings.sort(), allowlisted: allowlisted.sort((a, b) => a.kind.localeCompare(b.kind)), staleAllowlistEntries: staleAllowlistEntries.sort() };
}
