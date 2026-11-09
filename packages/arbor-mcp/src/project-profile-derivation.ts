/**
 * packages/arbor-mcp/src/project-profile-derivation.ts — closes the "split
 * brain" named in docs/roadmaps/23-multi-project-enrollment.md §2.5: the
 * enrollment surface (`project-lifecycle.ts`) never wrote an
 * `arbor.profile.jsonc`, so an enrolled project always failed
 * `scripts/project-conform.mjs` (ADR-073).
 *
 * Two derivation strategies, deliberately kept apart:
 *
 *   `deriveProfileFromInspection(root)` — for an EXISTING target (`enroll`
 *   without `--new`, or `--backfill`). Reads only what is actually on disk:
 *   `.git`, supported ecosystem manifests, `tsconfig.json`, conventional source-root
 *   directories. A field it cannot prove is OMITTED, never guessed — a
 *   wrong value would silently mis-scope every gate that reads the profile,
 *   which is worse than an honest gap. Refusals are returned alongside the
 *   (possibly null, possibly partial) profile so the caller can report
 *   exactly what was skipped and why. This mirrors
 *   `scripts/project-conform.mjs`'s `attemptFix`, which refuses to
 *   fabricate file content it would otherwise have to invent.
 *
 *   `deriveProfileForNewProject(root)` — for `enroll --new` against a
 *   target with no existing `package.json`. This is authorship of an
 *   initial state, not a guess about an existing repo's history: a
 *   brand-new project truthfully has no source yet, so its scaffolded
 *   commands are honest no-ops that say so, rather than invented claims
 *   about functionality that does not exist.
 */

import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

export interface DerivedProfile {
  readonly schema_version: 1;
  readonly project_id: string;
  readonly language: string | null;
  readonly source_roots: readonly string[];
  readonly governance: {
    readonly decisions_dir: string;
    readonly evidence_stores: readonly string[];
    readonly arbor_dir: string;
  };
  readonly commands: Readonly<Record<string, string>>;
}

export interface ProfileDerivationRefusal {
  readonly field: string;
  readonly reason: string;
}

export interface ProfileDerivationResult {
  readonly profile: DerivedProfile | null;
  readonly refusals: readonly ProfileDerivationRefusal[];
}

/** Matches `arbor.profile.jsonc`'s own governance defaults (project-profile.mjs's DEFAULT_PROFILE). */
const GOVERNANCE_DEFAULTS = Object.freeze({
  decisions_dir: "decisions",
  evidence_stores: Object.freeze([".claim-ledger", ".completion-depth", ".determinism-baseline", ".visual-intelligence"]),
  arbor_dir: ".arbor",
});

const SOURCE_ROOTS_BY_ECOSYSTEM = Object.freeze({
  javascript: Object.freeze(["packages", "src", "lib"]),
  python: Object.freeze(["src"]),
  rust: Object.freeze(["src", "crates"]),
  go: Object.freeze(["cmd", "internal", "pkg"]),
});
const COMMAND_SCRIPT_CANDIDATES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  typecheck: Object.freeze(["typecheck"]),
  test: Object.freeze(["test"]),
  reachability: Object.freeze(["gate:reachability", "reachability"]),
});

interface RawPackageJson {
  readonly name?: unknown;
  readonly scripts?: Record<string, unknown>;
  readonly devDependencies?: Record<string, unknown>;
  readonly dependencies?: Record<string, unknown>;
}

type Ecosystem = keyof typeof SOURCE_ROOTS_BY_ECOSYSTEM;

function readPackageJson(root: string): RawPackageJson | null {
  const path = join(root, "package.json");
  if (!existsSync(path)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  return parsed as RawPackageJson;
}

/**
 * Derives a profile for an EXISTING target purely by inspection. Never
 * writes anything. A target that is not a git repository, or has no
 * recognized ecosystem manifest refuses the whole profile rather than
 * emitting a silently partial one built on no evidence at all. Commands are
 * derived only from explicit package.json scripts; ecosystem conventions
 * such as `cargo test` or `go test ./...` are not proof that the corresponding
 * tool exists in the enrolled environment.
 */
export function deriveProfileFromInspection(root: string): ProfileDerivationResult {
  const refusals: ProfileDerivationRefusal[] = [];

  if (!existsSync(join(root, ".git"))) {
    refusals.push({
      field: "*",
      reason: "target is not a git repository (no .git directory); cannot safely derive project shape without version-controlled history to inspect",
    });
    return { profile: null, refusals: Object.freeze(refusals) };
  }

  const pkg = readPackageJson(root);
  const ecosystems: Ecosystem[] = [];
  if (pkg !== null) ecosystems.push("javascript");
  if (existsSync(join(root, "pyproject.toml"))) ecosystems.push("python");
  if (existsSync(join(root, "Cargo.toml"))) ecosystems.push("rust");
  if (existsSync(join(root, "go.mod"))) ecosystems.push("go");
  if (ecosystems.length === 0) {
    refusals.push({
      field: "*",
      reason: "no readable supported manifest at target root (package.json, pyproject.toml, Cargo.toml, or go.mod); a manifest-less or unsupported project cannot be profiled by inspection",
    });
    return { profile: null, refusals: Object.freeze(refusals) };
  }

  const projectId = typeof pkg?.name === "string" && pkg.name.trim().length > 0 ? pkg.name.trim() : basename(root) || "project";
  const hasTypescript = pkg !== null && (existsSync(join(root, "tsconfig.json")) || Boolean(pkg.devDependencies?.typescript) || Boolean(pkg.dependencies?.typescript));
  const language = ecosystems.length > 1 ? "polyglot" : hasTypescript ? "typescript" : ecosystems[0]!;

  const sourceRootCandidates = [...new Set(ecosystems.flatMap((ecosystem) => SOURCE_ROOTS_BY_ECOSYSTEM[ecosystem]))];
  const sourceRoots = sourceRootCandidates.filter((candidate) => existsSync(join(root, candidate)));
  if (sourceRoots.length === 0) {
    refusals.push({
      field: "source_roots",
      reason: `none of the manifest-matched conventional source-root directories (${sourceRootCandidates.join(", ")}) exist at the target root`,
    });
  }

  const scripts = pkg?.scripts && typeof pkg.scripts === "object" ? pkg.scripts : {};
  const commands: Record<string, string> = {};
  for (const [field, candidates] of Object.entries(COMMAND_SCRIPT_CANDIDATES)) {
    const match = candidates.find((name) => typeof scripts[name] === "string" && (scripts[name] as string).length > 0);
    if (match !== undefined) commands[field] = match;
    else if (pkg !== null) refusals.push({ field: `commands.${field}`, reason: `package.json declares no script named ${candidates.map((c) => `"${c}"`).join(" or ")}` });
    else refusals.push({
      field: `commands.${field}`,
      reason: `${ecosystems.join("+")} manifest presence does not explicitly declare an Arbor ${field} command; refusing to guess from ecosystem convention`,
    });
  }

  const profile: DerivedProfile = Object.freeze({
    schema_version: 1,
    project_id: projectId,
    language,
    source_roots: Object.freeze(sourceRoots),
    governance: GOVERNANCE_DEFAULTS,
    commands: Object.freeze(commands),
  });
  return { profile, refusals: Object.freeze(refusals) };
}

/**
 * Scaffolds a profile plus the package.json script wiring it needs, for a
 * genuinely NEW project (`enroll --new` against a target with no existing
 * `package.json`). The conformance spec's `script`-kind elements only check
 * that a package.json script KEY exists — not that it does anything real
 * yet — so an honest no-op that says "no source yet" satisfies the check
 * without lying about capability the project does not have.
 */
export function deriveProfileForNewProject(root: string): { readonly profile: DerivedProfile; readonly packageJsonScripts: Readonly<Record<string, string>> } {
  // Scaffolded scripts run inside a shell (`bun run <name>`), so the message
  // they print must be safe as a single-quoted shell/JS string literal —
  // strip anything that could break out of that quoting rather than trying
  // to escape it.
  const projectId = (basename(root) || "project").replace(/[^A-Za-z0-9._-]/g, "-");
  const note = (label: string) => `node -e "console.log('${label}: ${projectId} has no source yet')"`;
  const packageJsonScripts = Object.freeze({
    typecheck: note("typecheck"),
    test: note("test"),
    "gate:reachability": note("reachability"),
    "gate:adr-registry": `node -e "console.log('adr-registry: ${projectId} has no decisions yet')"`,
    "gate:project-conform": `node -e "console.log('project-conform: run the arbor toolchain project-conform.mjs against this root')"`,
  });
  const profile: DerivedProfile = Object.freeze({
    schema_version: 1,
    project_id: projectId,
    language: null,
    source_roots: Object.freeze(["src"]),
    governance: GOVERNANCE_DEFAULTS,
    commands: Object.freeze({ typecheck: "typecheck", test: "test", reachability: "gate:reachability" }),
  });
  return { profile, packageJsonScripts };
}

export function renderProfileJsonc(profile: DerivedProfile): string {
  const header = "// arbor.profile.jsonc — scaffolded by `arbor project enroll`. Review and\n// edit as this project grows real source, tests, and decisions.\n";
  // `language: null` (unknown, not derivable for a brand-new project) is
  // deliberately omitted rather than written as a literal `null` —
  // validateProfile (project-profile.mjs) treats a present-but-null field as
  // invalid ("must be a non-empty string when present"); omitting the key
  // entirely is what "not derived" is supposed to mean to the loader.
  const body = JSON.stringify(profile, (_key, value) => (value === null ? undefined : value), 2);
  return `${header}${body}\n`;
}
