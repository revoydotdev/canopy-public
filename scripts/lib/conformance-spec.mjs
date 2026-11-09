/**
 * scripts/lib/conformance-spec.mjs — the single, machine-readable list of
 * structural elements a revoy2-family project's "standard form" declares
 * (ADR-073). `scripts/project-conform.mjs` (the checker) and any future
 * scaffolder both consume `CONFORMANCE_SPEC` directly; neither may keep a
 * second copy of the element list.
 *
 * Each element is `{ id, kind, target, requirement, remedy }`:
 *   - `kind`: "dir" | "file" | "script" | "marker" — what shape of thing to
 *     check for. "script" means "package.json declares this npm/bun script
 *     name". "marker" means "this file's text contains a literal marker
 *     string" (the `marker` field on the element carries it).
 *   - `target`: either a literal repo-relative path/script-name string, or
 *     `{ profilePath: "dotted.path" }` naming a field inside the loaded
 *     `arbor.profile.jsonc` (see `project-profile.mjs`) to resolve at
 *     evaluation time. `resolveElementTargets` below is the ONE place that
 *     interprets this — the checker and a future scaffolder both call it
 *     rather than re-deriving the path themselves.
 *   - `requirement`: "required" (this repo genuinely has it, and any
 *     revoy2-family repo is expected to), "required_via_profile" (varies by
 *     profile — layout and command wiring), or "optional" (revoy2/Claude
 *     Code-specific extras a sibling project need not have; never blocks
 *     the gate).
 *
 * Classification is deliberately honest rather than aspirational: an
 * over-strict spec that forces a sibling project to cargo-cult empty
 * directories it will never use is a failure of this design, not a
 * strength of it.
 */

export const CONFORMANCE_SPEC = Object.freeze([
  // --- required: structural facts this repo genuinely has, that any
  //     revoy2-family repo is expected to carry regardless of profile ---
  {
    id: "decisions-dir",
    kind: "dir",
    target: "decisions",
    requirement: "required",
    remedy: "create the decisions/ directory (the governance corpus root)",
  },
  {
    id: "decisions-registry",
    kind: "file",
    target: "decisions/registry.json",
    requirement: "required",
    remedy: "author decisions/registry.json (see scripts/lib/adr-registry.mjs's schema)",
  },
  {
    id: "decisions-readme",
    kind: "file",
    target: "decisions/README.md",
    requirement: "required",
    remedy: "author decisions/README.md as the ADR index",
  },
  {
    id: "evidence-claim-ledger",
    kind: "dir",
    target: ".claim-ledger",
    requirement: "required",
    remedy: "run the claim-ledger refresh (`bun run claims:refresh`) to create .claim-ledger/",
  },
  {
    id: "evidence-completion-depth",
    kind: "dir",
    target: ".completion-depth",
    requirement: "required",
    remedy: "run the completion-depth refresh (`bun run completion-depth:refresh`) to create .completion-depth/",
  },
  {
    id: "evidence-determinism-baseline",
    kind: "dir",
    target: ".determinism-baseline",
    requirement: "required",
    remedy: "run the determinism-baseline refresh (`bun run determinism:refresh`) to create .determinism-baseline/",
  },
  {
    id: "evidence-visual-intelligence",
    kind: "dir",
    target: ".visual-intelligence",
    requirement: "required",
    remedy: "run `bun run vi:refresh` to create .visual-intelligence/",
  },
  {
    id: "arbor-dir",
    kind: "dir",
    target: ".arbor",
    requirement: "required",
    remedy: "initialize arbor state under .arbor/",
  },
  {
    id: "agents-md-governance-marker",
    kind: "marker",
    target: "AGENTS.md",
    marker: "<!-- governance:adr_total -->",
    requirement: "required",
    remedy: "add a <!-- governance:adr_total -->N ADRs<!-- /governance:adr_total --> marker to AGENTS.md and run `bun run governance:render`",
  },
  {
    id: "gate-adr-registry",
    kind: "script",
    target: "gate:adr-registry",
    requirement: "required",
    remedy: 'wire "gate:adr-registry" into package.json scripts',
  },
  {
    id: "gate-reachability",
    kind: "script",
    target: "gate:reachability",
    requirement: "required",
    remedy: 'wire "gate:reachability" into package.json scripts',
  },
  {
    id: "gate-project-conform",
    kind: "script",
    target: "gate:project-conform",
    requirement: "required",
    remedy: 'wire "gate:project-conform" into package.json scripts',
  },
  {
    id: "profile-file",
    kind: "file",
    target: "arbor.profile.jsonc",
    requirement: "required",
    remedy: "author arbor.profile.jsonc describing this repo's source_roots, citation_roots, governance paths, and commands",
  },

  // --- required_via_profile: layout and command wiring that legitimately
  //     vary by profile (a Rust sibling's source_roots and commands look
  //     nothing like this repo's) ---
  {
    id: "source-roots",
    kind: "dir",
    target: { profilePath: "source_roots" },
    requirement: "required_via_profile",
    remedy: "create the source root(s) declared in arbor.profile.jsonc's source_roots",
  },
  {
    // citation_roots is OPTIONAL in the profile: unset means "same as
    // source_roots" (see project-profile.mjs's DEFAULT_PROFILE and
    // arbor.profile.jsonc's own comment on the key), and that fallback must
    // keep working — an unprofiled or citation_roots-silent repo must not
    // start failing this gate. `fallbackProfilePath` below is what makes
    // that true: resolveElementTargets only falls back to source_roots when
    // citation_roots is null/absent, so this element checks the *effective*
    // citation roots (declared or defaulted) rather than the literal key.
    // A citation_roots that IS declared, including a typo'd/nonexistent
    // root, is checked for real and fails closed — that is the whole point:
    // without this element a bad citation root silently scans nothing and
    // every ADR is misreported as an orphan (ADR-080).
    id: "citation-roots",
    kind: "dir",
    target: { profilePath: "citation_roots", fallbackProfilePath: "source_roots" },
    requirement: "required_via_profile",
    remedy:
      "create the citation root(s) declared in arbor.profile.jsonc's citation_roots (if citation_roots is unset, this falls back to checking source_roots instead)",
  },
  {
    id: "command-typecheck",
    kind: "script",
    target: { profilePath: "commands.typecheck" },
    requirement: "required_via_profile",
    remedy: "declare commands.typecheck in arbor.profile.jsonc and wire the referenced script",
  },
  {
    id: "command-test",
    kind: "script",
    target: { profilePath: "commands.test" },
    requirement: "required_via_profile",
    remedy: "declare commands.test in arbor.profile.jsonc and wire the referenced script",
  },
  {
    id: "command-reachability",
    kind: "script",
    target: { profilePath: "commands.reachability" },
    requirement: "required_via_profile",
    remedy: "declare commands.reachability in arbor.profile.jsonc and wire the referenced script",
  },

  // --- optional: revoy2/Claude-Code-specific extras a sibling project
  //     plausibly would not have; never blocks the gate ---
  {
    id: "claude-dir",
    kind: "dir",
    target: ".claude",
    requirement: "optional",
    remedy: "n/a — Claude Code project scaffolding, not part of the portable standard form",
  },
  {
    id: "roadmap-md",
    kind: "file",
    target: "ROADMAP.md",
    requirement: "optional",
    remedy: "n/a — revoy2's own planning document",
  },
  {
    id: "changelog-md",
    kind: "file",
    target: "CHANGELOG.md",
    requirement: "optional",
    remedy: "n/a — recommended but not structurally required",
  },
  {
    id: "audit-dir",
    kind: "dir",
    target: "audit",
    requirement: "optional",
    remedy: "n/a — populated by the implementation-audit skill when run",
  },
  {
    id: "hook-liveness-dir",
    kind: "dir",
    target: ".hook-liveness",
    requirement: "optional",
    remedy: "n/a — populated by the git-hooks liveness wrapper when installed",
  },
]);

function readProfilePath(profile, path) {
  const parts = path.split(".");
  let value = profile;
  for (const part of parts) value = value?.[part];
  return value;
}

/**
 * Resolves one spec element's `target` against a loaded profile into zero or
 * more concrete repo-relative path/script-name strings. The single place
 * that interprets `{ profilePath }` — the checker and a future scaffolder
 * both call this rather than re-deriving the path themselves, which is what
 * keeps `CONFORMANCE_SPEC` a genuinely single source of truth.
 *
 * `{ profilePath, fallbackProfilePath }` is for keys that are genuinely
 * optional at the profile level with a defined fallback meaning (currently
 * only `citation_roots`, which DEFAULT_PROFILE and arbor.profile.jsonc both
 * document as "unset means same as source_roots"). When `profilePath`
 * resolves to `null`/`undefined` — i.e. the key was never declared, not
 * merely declared empty — `fallbackProfilePath` is resolved instead, so an
 * element built this way checks the *effective* value rather than failing
 * closed on an intentionally-absent optional key.
 */
export function resolveElementTargets(element, profile) {
  if (typeof element.target === "string") return [element.target];
  const { profilePath, fallbackProfilePath } = element.target;
  let value = readProfilePath(profile, profilePath);
  if (value === undefined || value === null) {
    if (fallbackProfilePath) value = readProfilePath(profile, fallbackProfilePath);
  }
  if (Array.isArray(value)) return value.filter((v) => typeof v === "string" && v.length > 0);
  if (typeof value === "string" && value.length > 0) return [value];
  return [];
}
