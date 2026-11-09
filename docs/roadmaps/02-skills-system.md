# Roadmap 02 — Governed skills (reusable capability bundles for the native specialist)

Artifact kind: roadmap
Status: historical
Revision: 1
As-of commit: c373ea2b (2026-09-22)
Authority: Retained implementation brief for governed skills; informs local technical scope only. Release sequencing is owned by the canonical 1.0.0 roadmap.
Evidence scope: mixed — governed descriptor flow observed at 2348ddbb; multi-file/operator-authored bundles and unified catalog parity are target
Supersedes: none
Superseded by: sequencing and priority only: `docs/roadmap-1.0.0-and-documentation-governance.md`
Owner: Canopy/revoy2 maintainers
Review trigger: the brief is reopened, or its implementation is materially changed or superseded by an accepted ADR

> **Historical implementation brief — sequencing superseded.** The canonical 1.0.0 sequence is [docs/roadmap-1.0.0-and-documentation-governance.md](../roadmap-1.0.0-and-documentation-governance.md); this document's priority and ordering are subordinate to it. The design and evidence history below is retained. Any present-tense gap or future-work statements below describe the brief's authoring-time baseline, not a current status claim.
>
> **Implementation status at `2348ddbb6363f85ae3ddd3aeffec4b07156e5cd8`: partially implemented; original governed descriptor flow is present.** `packages/arbor-mcp/src/skills/`, `packages/arbor-mcp/tests/skills/`, and `docs/roadmaps/handoffs/skills-system.md` verify immutable JSON descriptors, role reduction, provenance, and tests. The canonical Phase 3 multi-file/operator-authored bundle and unified catalog parity remain proposed.

**Audience:** an implementing coding agent on a feature branch. This is your brief.
Read `docs/roadmaps/01-mcp-client.md` §1-§2 and §8 first — the invariants, the read-list,
and the repo gotchas there apply to you unchanged and are not repeated in full here.

**One-line goal:** a *skill* is a named, versioned, operator-governed bundle of
(instructions + allowed tools + optional input/output contract) that a specialist can be
composed with, so common workflows ("write an ADR", "add a test", "review a diff") are
reusable, inspectable, and bounded — the frontier-harness "skills/subagents" idea, expressed
inside revoy2's governance model.

**Frame it correctly:** revoy2 already has *role profiles*
(`packages/arbor-prompts/src/role-profiles.ts`: architect / documentation-writer /
specialist-executor / critic-reviewer). A skill is **a narrower, operator-authored
specialization _within_ a role** — it may only _reduce_ authority (fewer tools, tighter
paths, a specific instruction), never expand it. This is the key invariant. If you find
yourself letting a skill grant a tool the role does not already permit, you have the design
wrong.

---

## 0. What "done" means (acceptance)

1. An operator declares skills in a governed store (a directory of skill descriptor files, or
   config), each with: `skill_id`, `version`, a bounded instruction text, an `allowed_tools`
   subset, optional `write_path_patterns`, and an optional structured-output contract id.
2. A skill is selectable for a specialist dispatch (by the planner naming it, or by operator
   config). When selected, the composed native role's `allowed_tools`/write policy is the
   **intersection** of (role ∩ skill ∩ host) — strictly a reduction — and the skill's
   instruction is appended as a caller-owned, provenance-bearing governed instruction.
3. A skill descriptor is immutable per `(skill_id, version)`; a change requires a new version
   (SemVer discipline; see `AGENTS.md`/global conventions §3.1).
4. Skills are **projections/config, never authority**: a skill cannot self-approve, cannot see
   `critic_only` knowledge, cannot bypass a gate, cannot mint provenance.
5. A malformed, missing, or over-reaching skill fails closed (the dispatch proceeds with the
   plain role, and a diagnostic is recorded) — it never silently escalates authority.
6. Full suite green; hermetic tests cover composition, the intersection/reduction property, the
   immutability/versioning, and the fail-closed paths.

Non-goals: executable skill code (a skill is declarative — instructions + tool allow-list +
contracts, NOT arbitrary code to run); a marketplace/registry download mechanism; recursive
skills that spawn skills; per-skill model selection (that is role/config's job).

---

## 1. Where this plugs in (integration points)

- `packages/arbor-prompts/src/role-profiles.ts` — `NativeRoleProfile`, `composeRolePrompt`,
  and the tool/capability policy shape. A skill composes **on top of** a role: read how
  `composeRolePrompt` assembles sections and how `RoleToolPolicy.allowed_tools` +
  `documentation_path_patterns` work. Your skill layer intersects these.
- `packages/arbor-mcp/src/native-role-composer.ts` — `composeNativeRole()` already intersects
  role policy with host tools (`available_tools`) and only ever _reduces_. **This is your
  model.** You add a skill intersection to the same reduction pipeline. Note it already
  distinguishes `permitted_extension_tools` (specialist-only) — respect that.
- `packages/arbor-mcp/src/native-agent-executor.ts` — `specialize()` takes an optional
  `execution_role`. You add an optional `skill_id`/`skill_version` alongside it, resolve the
  skill, and pass its reductions into `composeNativeRole`. The governed instruction goes into
  the `governed_instructions` the worker already forwards (provenance-bearing, excluded from
  events — see `NativeGovernedContext` in `native-worker.ts`).
- The task-plan contract (`packages/arbor-mcp/src/native-task-plan-contract.ts`) — an action may
  optionally name a `skill_id`. Add it to the schema (with a description) so the planner can
  select a skill; validate it against the known skill catalog at admission. Default: no skill.
- `packages/arbor-mcp/src/manager.ts` — the node action already carries `execution_role`,
  `high_risk_tool_scope`. A selected `skill_id` rides alongside as durable node context (it is
  admission-time authority-shaping data, so it belongs on the node, like `high_risk_tool_scope`).

---

## 2. The skill descriptor (closed, validated, immutable)

Store skills as descriptor files under a governed directory (suggest
`.arbor/skills/<skill_id>@<version>.json`, or a repo-committed `skills/` dir — pick one and
document it). Descriptor shape:
```jsonc
{
  "schema_version": 1,
  "skill_id": "write-adr",                 // [a-z0-9-], bounded, stable
  "version": "1.2.0",                       // SemVer; (skill_id,version) is immutable identity
  "role": "documentation-writer",           // the base role it specializes; must be a real NativeRoleProfileId
  "instruction": "Write one ADR …",         // bounded caller-owned instruction text
  "allowed_tools": ["file.read", "file.write"],   // MUST be a subset of the role's allowed_tools
  "write_path_patterns": ["decisions/**/*.md"],   // MUST be within the role's documentation paths
  "structured_output": null                 // optional contract id from a closed catalog, or null
}
```
Validation (fail closed on any violation):
- `skill_id` bounded/canonical; `version` a valid SemVer; `(skill_id, version)` unique.
- `role` ∈ the closed `NativeRoleProfileId` set.
- `allowed_tools` ⊆ the named role's `allowed_tools`. **Reject** any tool not in the role. This
  is the load-bearing check — a skill may not add tools.
- `write_path_patterns` ⊆ (are covered by) the role's `documentation_path_patterns` when the
  role is documentation-bound. Reject a broader path.
- `instruction` non-empty, bounded length, redaction-safe (run it through the same redaction as
  other caller context; a skill instruction is caller-owned, not secret, but must not carry a
  secret pattern into logs).
- `structured_output` is null or a member of a closed contract catalog you define — never an
  open string that could name an arbitrary schema.

Immutability: once a `(skill_id, version)` descriptor is loaded, it is frozen. A different bytes
for the same identity is a typed conflict (mirror commandment XI — idempotency conflicts loudly).

---

## 3. Composition (the reduction pipeline)

Add a `SkillCatalog` (in `packages/arbor-mcp/src/skills/`) that loads + validates descriptors
and answers `resolve(skill_id, version) -> ValidatedSkill | null`. Then, in the specialize path:
```
role policy (allowed_tools, write paths)
  ∩ skill.allowed_tools / skill.write_path_patterns     // reduction only
  ∩ host available_tools                                 // existing composeNativeRole step
  = effective policy
```
- Feed the skill's reductions into `composeNativeRole` (extend its input with optional
  `skill_allowed_tools?` / `skill_write_paths?` and intersect there, next to the existing host
  intersection). Keep the property test: the output `allowed_tools` is always a subset of every
  input set.
- Append `skill.instruction` as a `governed_instruction` with provenance
  `{ tag: "generated", generator: "skill:<id>@<version>", input_hash: <sha256 of descriptor> }`.
  It flows through the existing governed-context channel (bounded, excluded from events).
- If `skill.structured_output` is set and the role permits it, apply that contract; else leave
  the role's default.

**Fail-closed composition:** if `resolve` returns null (unknown/invalid skill), do NOT fail the
whole dispatch — compose the plain role and record a `skill_unavailable` diagnostic on the
session. An unavailable skill is a typed absence, never an escalation and never a hard crash.

---

## 4. Gotchas

- **Reduction, not expansion — prove it in a test.** The single most important test: a skill
  whose `allowed_tools` names a tool the role forbids is *rejected at load*, and even if
  injected, the composed policy never contains it. If this can ever fail, the feature is unsafe.
- **A skill instruction is prose; prose grants no authority.** The instruction can say
  "you may write anywhere" all it likes — the *policy* intersection is what the host enforces.
  Never let the instruction text influence the tool/path policy.
- **Versioning is identity, not decoration.** `(skill_id, version)` is immutable. Editing a
  skill in place is the same mistake as re-tagging a released version — forbidden. Bump the
  version. The node records the exact `(skill_id, version)` it used, so a replay is deterministic.
- **Catalog drift** (same as roadmap 01 §8): the `skill_id` field on the task-plan action must be
  added to the TS type, the JSON schema, and the validator together.
- **`npm run build` is the type gate; zero new deps; bun for installs; redaction is structural.**
  (See roadmap 01 §8 — all apply.)

---

## 5. Tests (hermetic)

- Load: a valid descriptor validates; each violation (tool not in role, path broader than role,
  duplicate identity with different bytes, bad SemVer, unknown role) is rejected with a typed
  error.
- Compose: role ∩ skill ∩ host = expected reduced set; the skill instruction appears as a
  provenance-bearing governed instruction; a null/invalid skill degrades to the plain role +
  diagnostic (no throw, no escalation).
- Property: for random subsets, `compose(role, skill, host).allowed_tools ⊆ role ∩ skill ∩ host`
  always holds.
- Plan integration: an action naming an unknown skill is admitted with the plain role + a
  diagnostic; an action naming a known skill composes it.
- `npm run build`, then `npx vitest run packages/arbor-mcp packages/arbor-prompts`, then full.

---

## 6. Feature-branch workflow

Same as roadmap 01 §10. Branch `feature/skills-system`. Handoff note at
`docs/roadmaps/handoffs/skills-system.md`. The integrator will add one real skill (e.g.
`write-adr`) and run a live campaign that selects it, then review the reduction-property test
specifically — that test is the safety case for the whole feature.
