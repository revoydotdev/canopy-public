# Roadmap 11 — User commands & governed plugin registry (parity gaps 7 + 8)

Artifact kind: roadmap
Status: historical
Revision: 1
As-of commit: 3498984f (2026-09-22)
Authority: Retained implementation brief for user commands and plugin registry; informs local technical scope only. Release sequencing is owned by the canonical 1.0.0 roadmap.
Evidence scope: mixed — command catalogs and plugin admission observed at 2348ddbb; hosted marketplace is an explicit non-goal
Supersedes: none
Superseded by: sequencing and priority only: `docs/roadmap-1.0.0-and-documentation-governance.md`
Owner: Canopy/revoy2 maintainers
Review trigger: the brief is reopened, or its implementation is materially changed or superseded by an accepted ADR

> **Sequencing superseded (2026-09-22).** The [1.0.0 roadmap](../roadmap-1.0.0-and-documentation-governance.md) governs release order and priority; this file is a retained implementation brief, not an active queue. Its handoff is [here](handoffs/user-commands-and-plugin-registry.md).
>
> **Status checked at `2348ddbb` (2026-09-22): implementation present.** Command catalogs, plugin admission/tiering, CLI wiring, and focused tests are tracked. The described hosted marketplace is explicitly a non-goal; this status does not claim external marketplace operation.

**Audience:** an implementing coding agent on a feature branch. Read roadmap 01 §1-§2 and §8 first,
then **roadmap 06 (governed hook & lifecycle bus) in full** — commands and plugins are the two
follow-ons roadmap 06 §6 explicitly names, and they are built *on* its bus, not beside it.

**Gaps closed (parity matrix):** category **7 (custom slash/user commands, 🟡)** and **8
(plugin/extension marketplace, ❌)**. These are one roadmap because a plugin is the packaging of the
same governed artifacts commands are made of; both reuse the skills catalog reduction pattern and
the hook bus.

**Why this waits on roadmap 06.** A command is a named, governed action = a `lifecycle` handler on
the hook bus + a palette entry; a plugin is a bundle of {commands, hooks, skills, MCP servers} with
one manifest and one reduction check. Build the bus first (roadmap 06), then this is the thin,
high-leverage layer that turns it into an operator-facing extensibility surface.

---

## 0. What "done" means (acceptance)

1. **User-defined commands** load from a declared location (`.arbor/commands/*.md` project,
   `~/.arbor/commands/*.md` user; project > user precedence), filename = command name, with typed
   frontmatter (`description`, `allowed_tools`, `execution_role`, `argument_hint`, `skill_id`) and
   parameter substitution (`$ARGUMENTS`, `$1..$n`). A command is a governed prompt/lifecycle action;
   its `allowed_tools` **intersect** (never expand) its role policy — the same reduce-only rule as
   skills (`skills/catalog.ts`).
2. A command is **invocable** from the CLI and appears in the palette; invoking it composes with the
   hook bus (roadmap 06) and the existing gate/approval seams — it is not a privileged side channel.
3. A **plugin** is a signed manifest bundling any of {commands, hooks, skills, MCP servers} with
   declared capabilities, admitted through a **trust-tiered verification pipeline** (§7.1): a plugin
   never gains authority beyond its granted tier, and its granted tier is a durable, ledger-witnessed
   fact.
4. **A plugin-supplied MCP server enters through the tier pipeline, never directly** — it is vetted
   at the host-orchestration and transport layers, not only by tool schema (§7.2). revoy2's MCP
   connector (roadmap 01) already fail-closes and leases credentials; the plugin layer sits above it.
5. **Trust evolves from runtime evidence:** a plugin/command deployed at a tier can be promoted or
   demoted based on ledger-witnessed runtime behavior (a manifest violation demotes it).
6. Wired + reachable: a command is invocable; a plugin is installable, its commands appear, its
   hooks fire (through roadmap 06), its skills load (through roadmap 02). Dead registry code is
   incomplete (CLAUDE.md wiring requirement).
7. Tests: a command's `allowed_tools` exceeding its role is rejected at load (mirror the skills
   escalation test); a plugin admitted at T2 cannot execute code; a plugin's tier is a durable
   ledger fact; demotion on a failed runtime check works; a command is invocable end-to-end;
   full suite green.

Non-goals (v1): a hosted marketplace *service* (local + git-source registry only — path/github/
git-subdir, like Claude Code's `source` field); RL-learned tier promotion (manual/rule assignment;
design the seam); remote plugin execution (roadmap 10).

---

## 1. The invariant that dominates this design

**A command or plugin is an authority, not a persona string** — identical to skills and to roadmap
06's hooks. It can only ever *reduce or gate* the authority the role/session already grants, never
silently expand it. The worst outcome is operator-authored text becoming privilege escalation.
Every command/plugin runs inside the existing provenance/gate spine; its authority is bounded by its
trust tier; and its admission and every tier change are ledger-witnessed facts.

## 2. Where it plugs in
- `packages/arbor-mcp/src/skills/catalog.ts` — the **direct template**: immutable descriptor
  catalog, load-time reduction check, composition-time intersection, one property test. The command
  catalog and the plugin registry copy this shape wholesale; do not reinvent the reduction test.
- **Roadmap 06's hook bus** — commands register as `lifecycle` handlers; plugin-supplied hooks
  register through the same bus. This roadmap consumes the bus; it does not add a parallel one.
- `packages/arbor-mcp/src/cli.ts` — composition: construct the command catalog + plugin registry
  alongside `skill_catalog`/`mcp_connector`/the hook bus (near `toolPortsForSession`, ~:720).
- `packages/arbor-mcp/src/mcp-client/*` (roadmap 01) — a plugin's MCP server is admitted through the
  tier pipeline into the existing connector, never bypassing it.
- `packages/arbor-audit/*` — a plugin's admitted tier and every promotion/demotion are ledger facts.

## 3. Suggested structure
```
packages/arbor-mcp/src/extensibility/
  command-catalog.ts  # .arbor/commands loader (mirrors skills/catalog.ts): frontmatter, param subst
  plugin-manifest.ts  # signed manifest schema; declared capabilities per component kind
  plugin-registry.ts  # G1-G4 verification pipeline; T1-T4 tier assignment; promote/demote lifecycle
```

## 4. Gotchas
- **Reuse the skills reduction test verbatim in shape** — a command/plugin whose declared tools
  exceed its role is rejected at load. This is the whole safety case; do not weaken it.
- **A plugin's tier is provenance, and provenance is a type** (`handoff.md` §2) — a T2 plugin cannot
  produce a T4-tier effect; make the tier→permission mapping type-level where possible.
- **Redaction** (roadmap 01 §8): command/plugin descriptor fields (`why`, reasons) are redacted in
  the audit ledger.
- **Zero new runtime deps**; markdown frontmatter parsing is a small bounded parser; **bun** installs;
  **`npm run build`** is the type gate.

## 5. Tests
- Command `allowed_tools` exceeding its role → rejected at load (`command_escalation`), mirroring
  the skills escalation test.
- Command invocable end-to-end (integration through the CLI + hook bus), not only parsed.
- Plugin admitted at T2 cannot execute code (tier + G-gate enforcement); T4 requires all gates.
- Plugin tier is a durable ledger fact; a runtime manifest violation demotes it.
- Plugin-supplied MCP server enters via the connector's fail-closed path, not directly.
- Full suite green.

## 6. Feature-branch workflow
Same as roadmap 01 §10. Branch `feature/commands-and-plugins`. **Write an ADR** (relate it to the
skills ADR and roadmap 06's hook-bus ADR) — this extends the operator-authored authority surface to
commands and packaged plugins. Land the command catalog first (thin, on the hook bus), then the
plugin registry — two reviewable, independently-green commits.

---

## 7. Prior art & grounded design (arXiv 2025–2026 + competitive RE)

Source: `../research/frontier-gap-literature-2026.md` (Gaps 5-cluster, 8-cluster). The governance
paper below was **read in full**; the retrieval and MCP-defense papers are abstract-verified.

### 7.1 Trust tiers, not flat trust — Agent Skills Governance (arXiv:2602.12430, read in full)
26.1% of community-contributed skills contain vulnerabilities; the paper's **Skill Trust &
Lifecycle Governance Framework** is the direct design for the plugin/command registry and maps onto
revoy2's gates + provenance:
- **Verification gates G1→G4:** G1 static analysis (pattern + dependency scan) → G2 semantic
  classification (intent) → G3 behavioral sandbox (execution monitoring + side-effect audit — this
  is where roadmap 05's OS sandbox is the enforcement substrate) → G4 permission-manifest validation
  (**declared vs. observed capability match** — the overprovision check from roadmap 05 §7.4). A
  failed gate → reject/quarantine.
- **Trust tiers T1→T4 bound to permissions:** T1 unvetted = instructions only, no tools, isolated
  (G1 auto-triage); T2 community = read-only tools, no code exec, user-confirm (G1+G2+audit); T3
  org-vetted = declared tools, scoped fs, no network (G1+G2+G3+admin approval); T4 vendor-certified
  = full access + code + network (all gates + review). **Attack surface is graded by layer:** L1
  metadata (name spoofing) at T1; L2 instructions (prompt injection) at T2+; L3 executable scripts
  require T3/T4. A plugin's tier *is* its provenance; revoy2's provenance union + waiver store
  already models exactly this.
- **Lifecycle = author→submit(+manifest)→verify(G1-G4)→deploy(at tier)→monitor(runtime audit)→
  promote/demote.** Runtime monitoring that catches a manifest violation demotes the tier — a
  natural fit for revoy2's ledger-witnessed runtime evidence (§0.5).

### 7.2 Retrieve at scale; vet MCP at the right layer (abstract-verified)
- **Graph-of-Skills (arXiv:2604.05333):** past a few hundred commands/skills, naive full-context
  loading saturates the context window; dependency-aware bounded retrieval (an offline skill graph +
  reverse-aware Personalized PageRank) delivers **+25.55% reward, −56.72% tokens**. Design the
  catalog's lookup seam for retrieval now, even if v1 loads all.
- **MCP defense-placement taxonomy (arXiv:2604.07551):** existing MCP defenses are tool-centric,
  leaving **host-orchestration, transport, and supply-chain layers under-defended** — exactly where
  a plugin-supplied MCP server is most dangerous. Vet plugin MCP servers at those layers (§0.4), not
  only by tool schema.

### 7.3 Concrete mechanisms to reimplement (competitive RE — clean-room)
From the companion RE brief (idea, not code):
- **Commands** — all four harnesses converge on *markdown + frontmatter + filename-as-name +
  project>global precedence*. Steal **OpenCode's `!\`cmd\`` inline-shell and `@file` reference**
  syntax inside command bodies, and **Claude Code's `allowed-tools` frontmatter** (keeps a command
  governed — its tools intersect the role, never expand it).
- **Plugins** — **Claude Code's `plugin.json` manifest + `marketplace.json` with a `source` field
  (path/github/git-subdir/archive) and version pinning** is the most complete portable spec to
  reimplement from; pair it with the T1–T4 tiers so a plugin's provenance and granted authority are
  auditable facts in the hash-chained ledger. **Codex's managed-vs-user `source` trust** (system/
  MDM/cloud plugins non-disableable by the user) is the governance counterpart — a managed plugin's
  authority is fixed by the deployment, not by the model or a user override.
