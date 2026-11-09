# ADR-150: Skill Descriptors Admit Multi-File Bundles So Frontier-Harness Skills Install Natively

**Status:** Accepted
**Date:** 2026-08-30
**Authoring Revision:** c4aa582decd7e9844adee26be1350a380a2fe824
**Content ID:** sha256:5125e6609ef962571ead2e889344112ef80feb77c2b1987336585b281b5c0d13

Authored as Proposed. The implementing agent holds no acceptance authority
(ADR-059: acceptance is a separate status-only authority act), and this record
revises a stated non-goal of a roadmap the operator authored — which is exactly
the class of change that should not self-ratify.

## Context

`docs/roadmaps/02-skills-system.md` defines a skill as a declarative descriptor:
one JSON file per version under `.arbor/skills/<skill_id>@<version>.json`. The
implementation in `packages/arbor-mcp/src/skills/catalog.ts` enforces that shape
with a **closed key set** — `exactKeys(["schema_version", "skill_id", "version",
"role", "instruction", "allowed_tools", "write_path_patterns",
"structured_output"])` — and a hard ceiling, `SKILL_MAX_INSTRUCTION_BYTES = 16 *
1024`. The roadmap's non-goals name "executable skill code" and a
marketplace/download mechanism. A skill is one bounded instruction string.

Since that roadmap was written, three frontier harnesses converged independently
on a different format: **a directory containing `SKILL.md` plus arbitrary
supporting files.** Verified on this machine, 2026-08-29:

- **Claude Code** — `~/.claude/skills/<name>/SKILL.md` with sibling
  `references/`, `scripts/`, `templates/`.
- **Codex CLI 0.150.1** — `$CODEX_HOME/skills/<name>/SKILL.md`, same frontmatter
  convention, resolved by directory scan
  (`~/.codex/skills/.system/skill-installer/scripts/list-skills.py`).
- **opencode** (dev build `0.0.0-dev-202608282154`) — globs
  `skills/**/SKILL.md` and `{skill,skills}/**/SKILL.md` beneath both `.claude`
  and `.agents` roots. Recent: a backup on this box named
  `opencode.before-agents-md-only-20260828` dates the adoption to within days.

This is no longer one vendor's convention. It is the ecosystem's.

revoy2 already depends on it, through a door its own code does not govern.
`.claude/skills/` holds thirteen tracked skills, and nothing in revoy2 reads
them — `packages/arbor-governance/src/counts/documents.ts` merely counts the
directory. They are consumed by **Claude Code**, when a campaign delegates to
the `claude-code` connector. ADR-031 already found this shape of problem
intolerable for one skill and vendored it, on the reasoning that "a mechanism
available on one machine is not a mechanism." The same sentence applies here
with one word changed: a mechanism available through one connector is not a
property of the harness.

The concrete case that forces it. `paper` (Permissible Assimilation + Prior
Effort Research) is 47,523 bytes: a 15 KB router plus five reference files
totalling roughly 32 KB, loaded on demand — the router names which station's
reference to read, and only that one is paid for. Its `SKILL.md` alone *just*
fits under `SKILL_MAX_INSTRUCTION_BYTES`. Its references are twice the cap and
cannot be represented at all.

Collapsing it into one 16 KB instruction destroys two things at once: most of
the content, and the progressive-disclosure property that made a 47 KB skill
affordable in the first place. The result would not be a port. It would be a
summary of a skill, drifting silently from the upstream it was condensed from,
with nothing able to detect the drift.

**The crux.** The roadmap's central invariant is *reduction, not expansion*: a
skill may only narrow a role's authority, never widen it — `allowed_tools` must
be a subset of the role's own, and the roadmap calls the test proving it "the
single most important test." That invariant is about **authority**. It is not
about **content shape**. A multi-file bundle adds instruction text; it does not
add a tool, a path, a capability, or a model choice. The closed key set and the
16 KB cap were proxies for "declarative and bounded," and in serving that goal
they conflated bounding *authority* with bounding *bytes*. Only the first is
load-bearing.

The "no executable skill code" non-goal is untouched by this record and stays
intact. Reference files are prose read by a specialist. Nothing here proposes
running anything.

## Decision

**Extend the skill descriptor with an optional `bundle` key naming a
repository-relative directory, and treat a `SKILL.md` bundle as a first-class
descriptor body.**

- `bundle` names a directory inside the repository containing `SKILL.md`, and
  `bundle_files` is its complete sorted manifest of repository-relative file
  paths and `sha256:` digests. Bundle descriptors omit `instruction`; inline
  descriptors omit both bundle keys. The two shapes are mutually exclusive.
  The composed governed instruction is the body of `SKILL.md` after optional
  frontmatter is removed and the ordinary native-context redactor runs.
- **Supporting files are readable, not injected.** The specialist may read them
  through its existing, already-reduced `file.read` authority. They are never
  auto-appended to the prompt. This is what preserves progressive disclosure and
  keeps the context economy (ADR-015) intact — a 47 KB bundle costs 15 KB unless
  a station is actually entered.
- **Every existing invariant holds unchanged.** `allowed_tools` remains a subset
  of the role's tools; `write_path_patterns` is unchanged; redaction applies to
  every byte loaded from the bundle exactly as it does to `instruction` today;
  bundle files are read-only inputs and never a write target.
- **The bundle must live inside the repository.** No `$HOME` resolution. This is
  ADR-031's reproducibility property, restated: a skill that resolves outside
  the repo cannot be run by CI or by a fresh clone.
- **Bounds move, they do not disappear.** For bundle-mode skills, replace the
  single-instruction cap with a 256 KiB total-bundle byte ceiling and a 64-file
  ceiling, both enforced in `SkillCatalog`. `SKILL_MAX_INSTRUCTION_BYTES`
  continues to govern inline-instruction skills.
- **The descriptor governs the files it names.** The bundle's contents are
  content-hashed into the descriptor, so "this skill is governed" does not decay
  into "this skill is a pointer to ungoverned files." This reuses the mechanism
  ADR-031 already established for vendored skills.

Consequently a frontier-harness skill installs into revoy2 by vendoring the
directory and writing a descriptor that wraps it — no rewrite, no condensation,
no drift.

## Consequences

Easier:

- Frontier skills install natively and losslessly, in the format three
  harnesses already publish.
- ADR-031's vendoring path gains a native consumer. Today a vendored skill is
  reachable only when a campaign happens to delegate to Claude Code; after this
  it is reachable by an arbor specialist directly.
- Skills revoy2 wants to *govern* stop arriving through an ungoverned connector
  side door.
- The authority model stays where it belongs: the JSON descriptor keeps the
  `allowed_tools ⊆ role` guarantee that `SKILL.md` frontmatter has no field for.

Harder, and these are real costs:

- `SkillCatalog` must validate a **directory**, not just a JSON blob. New
  failure modes have explicit diagnostics: `bundle_missing`,
  `bundle_identity`, `bundle_traversal`, `bundle_symlink`, `bundle_bound`, and
  `bundle_integrity`.
- Redaction now spans many files rather than one string, so the redaction test
  surface grows with it.
- Without the new ceilings, a bundle can blow a context budget that the 16 KB
  cap used to make impossible. The ceilings are not optional.
- Content-hashing bundle files means editing a vendored skill in place breaks
  its descriptor — the same friction ADR-031 accepted deliberately, now applying
  to a second class of artifact.
- Two descriptor shapes (inline and bundle) exist where one existed before.
  Mitigated by making `bundle` and `instruction` mutually exclusive rather than
  overlapping, so no descriptor is ambiguous.

## Alternatives / Roads not taken

**Hand-condense each skill into the 16 KB cap.** Rejected: lossy by
construction. `paper`'s references are twice the cap, so condensation is not
tightening but deletion, and the result is an unversioned fork of an upstream
that will move. It also fails this repository's own standard — the condensed
skill would be a claim about the upstream doctrine that nothing can check.

**Keep relying on the `claude-code` connector to carry skills.** Rejected on
ADR-031's own reasoning, which this record only restates: the mechanism must be
a property of the harness, not of one connector's presence. It also leaves the
skills ungoverned by arbor's authority model entirely.

**Keep single-file descriptors; point at the bundle from inside the instruction
text.** Rejected. It works in practice, which makes it tempting, but the pointer
is unvalidated prose — nothing checks the referenced files exist, nothing hashes
them, and a moved file yields a skill that silently instructs a specialist to
read nothing. That is precisely the claim-without-evidence pattern this
repository has spent Phase 6 eliminating.

**Adopt `SKILL.md` as the only format and drop JSON descriptors.** Rejected:
`SKILL.md` frontmatter has no field for `allowed_tools`, `write_path_patterns`,
or `role`. Dropping the descriptor would discard the reduction guarantee that is
the skills system's reason for existing. The descriptor should **wrap** the
bundle, not be replaced by it.

## Obligations

### O1 — A bundle-mode skill cannot widen authority

A skill that supplies a `bundle` is subject to the identical reduction check as
an inline-instruction skill: its `allowed_tools` intersect to a subset of the
base role's, its `write_path_patterns` cannot escape the role's, and no file
inside the bundle can introduce a tool, path, or capability. Bundle mode changes
what a specialist may *read*, never what it may *do*.

<!-- proof: symbol=SkillCatalog file=packages/arbor-mcp/src/skills/catalog.ts roundtrip=packages/arbor-mcp/tests/skills/bundle.test.ts -->

### O2 — A bundle is bounded, contained, and content-governed

Bundle resolution enforces a total byte ceiling and a file-count ceiling, refuses
any path escaping the bundle root by traversal or symlink, refuses a bundle
lacking `SKILL.md` or whose directory name mismatches `skill_id`, and records a
content hash per bundle file so a descriptor cannot name files it does not
govern.

<!-- proof: symbol=SkillCatalog file=packages/arbor-mcp/src/skills/catalog.ts roundtrip=packages/arbor-mcp/tests/skills/bundle.test.ts -->

### O3 — Supporting files are read on demand, never auto-injected

Composing a bundle-mode skill contributes only `SKILL.md` to the governed
instruction. Reference files reach the specialist solely through its own reduced
read authority, so a large bundle costs its router and nothing more until a
station is entered.

<!-- proof: symbol=SkillCatalog file=packages/arbor-mcp/src/skills/catalog.ts roundtrip=packages/arbor-mcp/tests/skills/bundle.test.ts -->
