# ADR-060: MCP Client Uses Bounded Version Negotiation

**Status:** Accepted
**Date:** 2026-08-12
**Authoring Revision:** 2bf8e373cfe642d249828bb603b710c72e989a72
**Content ID:** sha256:40dd92f66ed5a545c2ed652e6dd3fd5fe0bb3c7eaa974ba68441dd29623bf0c3

## Context

MCP `2026-07-28` removes the stateful initialize lifecycle used by the older
`2025-11-25` and `2025-06-18` revisions. A single pinned string cannot represent
both wire shapes and makes a current server fail on the first method.

## Decision

The client owns a bounded supported set, preferring `2026-07-28` and retaining
only `2025-11-25` and `2025-06-18` as legacy paths. It probes `server/discover`
first with current per-request metadata. Only method-not-found or an incompatible
discovery result shape falls back to legacy `initialize` and
`notifications/initialized`. An explicit offer containing no supported revision
fails closed and reports the offered versions; unknown future revisions are never
assumed compatible.

Protocol adapters negotiate compatibility but gain no ledger, gate, capability,
or execution authority. Adding another revision requires an implemented and
tested code path, not merely another string in the set.

## Consequences

Current and bounded legacy servers remain interoperable without conflating their
lifecycle rules. A server upgrade cannot silently select an unreviewed protocol
shape, and connector inspection records the path actually negotiated.

## Obligations

### O1 — Modern discovery and both legacy revisions are hermetically exercised

<!-- proof: symbol=McpClient file=packages/arbor-mcp/src/mcp-client/mcp-client.ts roundtrip=packages/arbor-mcp/tests/mcp-client/mcp-client.test.ts -->

### O2 — Unsupported future offers fail closed with a diagnosable version list

<!-- proof: symbol=MCP_SUPPORTED_PROTOCOL_VERSIONS file=packages/arbor-mcp/src/mcp-client/contracts.ts roundtrip=packages/arbor-mcp/tests/mcp-client/mcp-client.test.ts -->
