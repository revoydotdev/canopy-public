# ADR-052: User Commands and Plugins Are Trust-Tiered Reduction-Only Authorities

**Status:** Accepted
**Date:** 2026-08-12

## Context

ADR-047 established a runtime hook bus that can observe or deny but cannot grant authority. The skills catalog similarly admits operator-authored instructions only after proving their tools are a subset of a role. User commands and packaged plugins combine those surfaces and can also introduce MCP server configuration, so treating them as prompt text or flat-trusted files would create a supply-chain authority bypass.

The four-tier G1–G4 shape independently converges with *Agent Skills for Large
Language Models* ([arXiv 2602.12430](https://arxiv.org/abs/2602.12430)). Its
reported vulnerability classes—prompt injection, data exfiltration, privilege
escalation, and supply chain—and the 2.12× higher reported risk for skills that
bundle executable scripts make T2's no-code boundary an empirical requirement.

## Decision

A user command is an immutable markdown descriptor identified by its filename. Project commands override same-named user commands. Typed frontmatter declares its role, tool subset, optional skill, description, and argument hint. Load rejects any tool outside the role. Invocation performs bounded parameter substitution, crosses ADR-047 lifecycle admission, and enters the existing task proposal/confirmation path; it does not dispatch a privileged action directly.

A plugin is a signed manifest whose components are commands, hooks, skills, or MCP servers. Ed25519 verification precedes admission. Its granted tier is constrained by verified gates and permissions:

- T1: G1; instruction-only commands, no tools.
- T2: G1–G2; read-only tools, no code, writes, network, or MCP servers.
- T3: G1–G3; declared tools and scoped writes, no code or network.
- T4: G1–G4; declared code/network effects and MCP servers after full review.

Admission and every tier transition append a `!verified` fact to a durable hash-chained tier ledger. Observed undeclared capabilities or a failed runtime check demote the plugin. Promotion requires explicit bounded evidence. A plugin MCP server can only construct the existing `McpConnector`; it cannot publish a tool port directly.

Descriptor prose, transition reasons, and evidence references are bounded and structurally redacted. Plugin sources are version-pinned local, GitHub, or git-subdirectory identities; a hosted marketplace and remote plugin execution remain non-goals.

## Consequences

Commands become discoverable in the CLI and TUI palette without becoming a second execution authority. Plugins are locally installable and restart-durable, while signature, tier, and runtime evidence remain independently inspectable. T4 is deliberately expensive because MCP configuration crosses supply-chain, host-orchestration, transport, and tool layers.

## Obligations

### O1 — Commands cannot expand role tools

<!-- proof: symbol=CommandCatalog file=packages/arbor-mcp/src/extensibility/command-catalog.ts roundtrip=packages/arbor-mcp/tests/extensibility/command-catalog.test.ts -->

Load fails with `command_escalation` when any declared tool is outside the execution role.

### O2 — Commands use governed invocation and are discoverable

<!-- proof: symbol=invokeUserCommand file=packages/arbor-mcp/src/extensibility/command-catalog.ts roundtrip=packages/arbor-mcp/tests/extensibility/command-catalog.test.ts -->

Invocation is bounded, lifecycle-admitted, submitted through task admission, and projected into the TUI palette.

### O3 — Signed tier admission limits effects

<!-- proof: symbol=validateTierAuthority file=packages/arbor-mcp/src/extensibility/plugin-manifest.ts roundtrip=packages/arbor-mcp/tests/extensibility/plugin-registry.test.ts -->

Signature and required G1–G4 evidence are verified before tier permissions are granted; T2 cannot execute code.

### O4 — Tier changes are durable provenance facts

<!-- proof: symbol=PluginTierLedger file=packages/arbor-mcp/src/extensibility/plugin-registry.ts roundtrip=packages/arbor-mcp/tests/extensibility/plugin-registry.test.ts -->

Admission, promotion, and demotion append `!verified`, hash-chained records, and runtime manifest violations demote.

### O5 — Plugin MCP servers cannot bypass the connector

<!-- proof: symbol=PluginRegistry file=packages/arbor-mcp/src/extensibility/plugin-registry.ts roundtrip=packages/arbor-mcp/tests/extensibility/plugin-registry.test.ts -->

Only T4 plugins may supply MCP servers, and they enter through the existing bounded, fail-closed connector.

### Acceptance note — remains Proposed

The T2 boundary has now been stress-tested against all four reported classes:
command tool-subset validation prevents prompt text from granting new authority;
network denial blocks an exfiltration channel; code/write denial blocks privilege
escalation; and signature verification plus the T4-only MCP rule addresses the
supply-chain path. Transient failures do not change caller tier or granted
capabilities (ADR-028's behavioral test repeats the denial).

This authoring branch does **not** move the record to Accepted. ADR-044 and
ADR-059 require acceptance authority to be separate from implementation/content
authority, and no independent acceptor participated in this change.
