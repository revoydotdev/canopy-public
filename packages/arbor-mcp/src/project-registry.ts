/**
 * packages/arbor-mcp/src/project-registry.ts — Roadmap 23 W2, ADR-076.
 *
 * ADR-076's central move: a project registry entry is a CLAIM, not a fact.
 * It records what was true at the moment it was written — `project_id`,
 * `path`, the `profile_hash` observed then, the `verified_at_revision` of
 * the governed project, and `verified_at` — and never stores "conformant"
 * as a standing property. Discharge (does the claim still hold?) is always
 * recomputed by re-running conformance against the live path, never by
 * editing the entry. This module is the read/write store plus the discharge
 * function; `scripts/project-registry-gate.mjs` is the gate that calls
 * `evaluateProjectRegistry` and fails the battery on an undischarged entry.
 *
 * Boundary note: conformance evaluation lives in `scripts/project-conform.mjs`
 * (`evaluateConformance`), outside this package. `packages/arbor-mcp`
 * importing `scripts/lib` would invert the package boundary — the same
 * reasoning `docs/roadmaps/23-multi-project-enrollment.md` §W4 gives for why
 * enrollment doesn't import `CONFORMANCE_SPEC` directly. So discharge here
 * shells out to `bun scripts/project-conform.mjs --root <path> --json`,
 * the same process boundary `scripts/gate-all.mjs` already uses between
 * gates, rather than reaching across the boundary in-process.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PROJECT_REGISTRY_SCHEMA_VERSION = 1;
export const PROJECT_REGISTRY_FILENAME = "project-registry.json";
/** Shelf-life default for a freshly-registered entry, in days. Mirrors the
 * allowlist/disposition precedent (`scripts/reachability/allowlist.json`):
 * a claim has an expiry, not an indefinite lifetime. */
export const DEFAULT_REGISTRY_ENTRY_TTL_DAYS = 30;

export interface ProjectRegistryEntry {
  readonly project_id: string;
  /** Absolute, canonical filesystem path to the governed project. */
  readonly path: string;
  /** sha256 hex digest of `arbor.profile.jsonc`'s raw bytes, observed at
   * the moment discharge was established. */
  readonly profile_hash: string;
  /** `git rev-parse HEAD` of the governed project at that same moment. */
  readonly verified_at_revision: string;
  /** ISO-8601 timestamp of that moment. */
  readonly verified_at: string;
  /** YYYY-MM-DD. An entry past this date fails the gate regardless of
   * whether the underlying project is still conformant. */
  readonly expires: string;
}

export interface ProjectRegistry {
  readonly schema_version: 1;
  readonly entries: readonly ProjectRegistryEntry[];
}

const EMPTY_REGISTRY: ProjectRegistry = Object.freeze({ schema_version: 1, entries: Object.freeze([]) });

function registryPath(persistenceDir: string): string {
  return join(persistenceDir, PROJECT_REGISTRY_FILENAME);
}

/** Never throws on "file absent" — an ungoverned repo has no registry yet,
 * and that is the same as an empty one (ADR-076 requirement 6). Any other
 * read/parse failure DOES throw: a corrupt registry must not silently
 * behave as if it governed nothing. */
export function loadProjectRegistry(persistenceDir: string): ProjectRegistry {
  const path = registryPath(persistenceDir);
  if (!existsSync(path)) return EMPTY_REGISTRY;
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${path} is not a JSON object.`);
  }
  const value = parsed as Record<string, unknown>;
  if (value.schema_version !== PROJECT_REGISTRY_SCHEMA_VERSION || !Array.isArray(value.entries)) {
    throw new Error(`${path} does not satisfy project-registry schema version ${PROJECT_REGISTRY_SCHEMA_VERSION}.`);
  }
  for (const entry of value.entries) validateEntryShape(entry, path);
  return Object.freeze({ schema_version: 1, entries: Object.freeze(value.entries as ProjectRegistryEntry[]) });
}

function validateEntryShape(entry: unknown, path: string): asserts entry is ProjectRegistryEntry {
  if (typeof entry !== "object" || entry === null) throw new Error(`${path}: entry is not an object.`);
  const item = entry as Record<string, unknown>;
  for (const field of ["project_id", "path", "profile_hash", "verified_at_revision", "verified_at", "expires"]) {
    if (typeof item[field] !== "string" || (item[field] as string).length === 0) {
      throw new Error(`${path}: entry missing required string field "${field}".`);
    }
  }
}

export function saveProjectRegistry(persistenceDir: string, registry: ProjectRegistry): void {
  mkdirSync(persistenceDir, { recursive: true });
  writeFileSync(registryPath(persistenceDir), `${JSON.stringify(registry, null, 2)}\n`, { encoding: "utf8", mode: 0o644 });
}

/** sha256 hex of `arbor.profile.jsonc`'s raw bytes at `root`, or `null` if
 * the file does not exist. Deliberately a raw-byte hash, not a parsed/
 * normalized one: ADR-076 requirement 4 treats ANY change to what was
 * observed as drift, including formatting-only edits — the claim was about
 * the file that was actually read, not its semantic content. */
export function computeProfileHash(root: string): string | null {
  const path = join(root, "arbor.profile.jsonc");
  if (!existsSync(path)) return null;
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** `git rev-parse HEAD` of `root`, or `null` if `root` is not a git
 * repository or has no commits yet. Never synthesized — an unattributable
 * revision must fail registration rather than record a placeholder, the
 * same posture `ledger-command.ts`'s `resolveGitHead` takes. */
export function resolveProjectRevision(root: string): string | null {
  try {
    const out = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

/**
 * `git init` + a single initial commit at `root`, for a target the caller
 * has already verified has no `.git` yet (Roadmap 23 §6 L2 —
 * `project-lifecycle.ts`'s `ensureNewProjectGitRepo` is the only caller,
 * and it makes that existence check before calling this). Lives here,
 * alongside `resolveProjectRevision`, rather than in `project-lifecycle.ts`
 * itself so the `node:child_process` dependency this needs stays confined
 * to the one module that already carries it and already has an accepted
 * `anti-stub` rule4_weak triage for its own unrelated `JSON.parse`
 * (`loadProjectRegistry`) — adding a second `child_process`-importing file
 * would raise a second, untriaged instance of that same well-understood
 * false positive for no functional benefit.
 *
 * Returns `{ ok: true }` on success or `{ ok: false, error }` on any git
 * failure (missing binary, permissions, etc.) — never throws, so a failed
 * git init cannot turn an otherwise-successful profile scaffold into a
 * thrown error.
 */
export function initializeGitRepositoryForScaffold(root: string): { readonly ok: true } | { readonly ok: false; readonly error: string } {
  try {
    execFileSync("git", ["init", "--quiet", root], { stdio: ["ignore", "pipe", "pipe"] });
    execFileSync("git", ["-C", root, "add", "-A"], { stdio: ["ignore", "pipe", "pipe"] });
    execFileSync(
      "git",
      ["-C", root, "-c", "user.email=arbor-scaffold@localhost", "-c", "user.name=arbor project enroll", "commit", "--quiet", "-m", "Initial scaffold (arbor project enroll --new)"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function repoRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // packages/arbor-mcp/src -> repo root
  return resolve(here, "..", "..", "..");
}

export interface ConformanceCheckResult {
  readonly ok: boolean;
  /** Human-readable ids of unmet required/required_via_profile elements, or
   * a single diagnostic if the checker itself could not run. Empty when ok. */
  readonly reasons: readonly string[];
}

/**
 * Runs `scripts/project-conform.mjs --root <root> --json` and reduces it to
 * a pass/fail plus the unmet element ids. This is THE discharge mechanism
 * ADR-076 requirement 2 names: "the discharge is a conformance run against
 * that path... re-established by re-running, never by editing the entry."
 */
export function runConformanceCheck(root: string): ConformanceCheckResult {
  const script = join(repoRoot(), "scripts", "project-conform.mjs");
  type ConformResults = { ok?: boolean; results?: readonly { id: string; ok: boolean; requirement: string }[] };
  const reduce = (stdout: string): ConformanceCheckResult => {
    let parsed: ConformResults;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      return { ok: false, reasons: [`project-conform.mjs produced unparseable output: ${stdout.slice(0, 500)}`] };
    }
    if (parsed.ok === true) return { ok: true, reasons: [] };
    const unmet = (parsed.results ?? []).filter((r) => !r.ok && r.requirement !== "optional").map((r) => r.id);
    return { ok: false, reasons: unmet.length > 0 ? unmet : ["project-conform.mjs reported failure with no unmet elements listed"] };
  };
  try {
    const stdout = execFileSync("bun", [script, "--root", root, "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return reduce(stdout);
  } catch (error) {
    // project-conform.mjs exits non-zero when required elements are unmet —
    // that is the expected, informative case, not a spawn failure. Its JSON
    // is still on stdout, captured by Node in `error.stdout` on ENOENT-free
    // non-zero exits.
    const stdout = error instanceof Error && "stdout" in error ? String((error as { stdout?: unknown }).stdout ?? "") : "";
    if (stdout.length > 0) return reduce(stdout);
    return { ok: false, reasons: [`project-conform.mjs could not be run against ${root}: ${error instanceof Error ? error.message : String(error)}`] };
  }
}

/**
 * Why registration did not happen. The distinction is load-bearing for
 * callers deciding an exit code: `conformance_failed` means there WAS a claim
 * to make and its discharge failed, which is a real problem. `no_revision`
 * and `no_profile` mean there was nothing to claim yet — an enrollment that
 * otherwise succeeded must not be reported as failed because of them.
 */
export type RegisterRefusalCode = "no_profile" | "conformance_failed" | "no_revision";

export interface RegisterProjectOutcome {
  readonly registered: boolean;
  readonly entry: ProjectRegistryEntry | null;
  /** Non-empty exactly when `registered` is false — why discharge could not
   * be established at registration time. */
  readonly reasons: readonly string[];
  /** Set exactly when `registered` is false. */
  readonly refusal?: RegisterRefusalCode;
}

/**
 * Registers (or re-registers) `root` under `project_id` in the registry at
 * `persistenceDir`. ADR-076 requirement 1+2: registration establishes
 * discharge AT THIS MOMENT by actually running conformance — it never
 * records an entry for a project that does not currently pass. Upserts by
 * `project_id`: re-enrollment is the explicit act ADR-076 requires for
 * updating a drifted claim (requirement 4), and this is that act.
 */
export function registerProject(
  persistenceDir: string,
  root: string,
  projectId: string,
  options: { readonly now?: string; readonly ttlDays?: number } = {},
): RegisterProjectOutcome {
  const canonicalRoot = resolve(root);
  const profileHash = computeProfileHash(canonicalRoot);
  if (profileHash === null) {
    return { registered: false, entry: null, refusal: "no_profile", reasons: [`no arbor.profile.jsonc found at ${canonicalRoot}; nothing to hash or register`] };
  }
  const conformance = runConformanceCheck(canonicalRoot);
  if (!conformance.ok) {
    return { registered: false, entry: null, refusal: "conformance_failed", reasons: conformance.reasons };
  }
  const revision = resolveProjectRevision(canonicalRoot);
  if (revision === null) {
    return { registered: false, entry: null, refusal: "no_revision", reasons: [`${canonicalRoot} has no resolvable git revision (not a git repository, or no commits yet); a registry entry cannot claim provenance it does not have`] };
  }
  const now = options.now ?? new Date().toISOString();
  const ttlDays = options.ttlDays ?? DEFAULT_REGISTRY_ENTRY_TTL_DAYS;
  const expires = new Date(Date.parse(now) + ttlDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const entry: ProjectRegistryEntry = Object.freeze({
    project_id: projectId,
    path: canonicalRoot,
    profile_hash: profileHash,
    verified_at_revision: revision,
    verified_at: now,
    expires,
  });
  const registry = loadProjectRegistry(persistenceDir);
  const nextEntries = registry.entries.filter((existing) => existing.project_id !== projectId);
  nextEntries.push(entry);
  saveProjectRegistry(persistenceDir, { schema_version: 1, entries: Object.freeze(nextEntries) });
  return { registered: true, entry, reasons: [] };
}

export type RegistryEntryFailureCode = "expired" | "path_unreachable" | "profile_drifted" | "conformance_failed";

export interface RegistryEntryVerification {
  readonly project_id: string;
  readonly path: string;
  readonly ok: boolean;
  readonly failures: readonly { readonly code: RegistryEntryFailureCode; readonly detail: string }[];
}

/**
 * Re-establishes (or refutes) discharge for a single entry. This is the
 * function both the gate and `arbor project registry verify` call — the one
 * evaluation path, matching `evaluateConformance`'s own "single evaluation
 * path" discipline. Checks run in a fixed order but ALL run regardless of
 * earlier failures (except path-unreachable, which makes hash/conformance
 * checks meaningless and short-circuits them) so a single verify call
 * reports every real problem, not just the first.
 */
export function verifyRegistryEntry(entry: ProjectRegistryEntry, options: { readonly now?: string } = {}): RegistryEntryVerification {
  const failures: { code: RegistryEntryFailureCode; detail: string }[] = [];
  const now = options.now ?? new Date().toISOString();
  const today = now.slice(0, 10);
  if (today > entry.expires) {
    failures.push({ code: "expired", detail: `entry expired ${entry.expires} (checked ${today}); the claim is stale regardless of the project's current state — re-register to renew it` });
  }
  if (!existsSync(entry.path)) {
    failures.push({ code: "path_unreachable", detail: `registered path does not exist: ${entry.path}` });
    // Nothing further can be honestly checked against a path that is not there.
    return { project_id: entry.project_id, path: entry.path, ok: false, failures: Object.freeze(failures) };
  }
  const currentHash = computeProfileHash(entry.path);
  if (currentHash === null) {
    failures.push({ code: "profile_drifted", detail: `arbor.profile.jsonc no longer exists at ${entry.path}; the profile this entry claims to have verified is gone` });
  } else if (currentHash !== entry.profile_hash) {
    failures.push({ code: "profile_drifted", detail: `arbor.profile.jsonc content hash changed since registration (was ${entry.profile_hash.slice(0, 12)}…, is ${currentHash.slice(0, 12)}…); re-enroll to record the new hash, this gate does not auto-update it` });
  }
  const conformance = runConformanceCheck(entry.path);
  if (!conformance.ok) {
    failures.push({ code: "conformance_failed", detail: `project-conform failed at ${entry.path}: ${conformance.reasons.join(", ")}` });
  }
  return { project_id: entry.project_id, path: entry.path, ok: failures.length === 0, failures: Object.freeze(failures) };
}

export interface ProjectRegistryReport {
  readonly ok: boolean;
  readonly entry_count: number;
  readonly verifications: readonly RegistryEntryVerification[];
  /**
   * Roadmap 23 §6 L1: whether `<persistenceDir>/project-registry.json`
   * actually exists on disk, as opposed to `entry_count === 0` because the
   * file legitimately holds zero entries. `.arbor/` is gitignored (correctly
   * — entries hold machine-specific absolute paths), so on a fresh clone or
   * a CI runner this is `false` by construction, not by anyone's choice
   * about how many projects to govern. This field does not change `ok` —
   * doing so would fail `gate:project-registry` on every CI run of THIS
   * repository too, since revoy2 itself never commits a populated registry;
   * that would not distinguish the two states, it would just make "no
   * durable state reached CI yet" indistinguishable from "the registry
   * regressed." See `docs/proposals/l1-project-registry-ci-visibility.md`
   * for why closing this further needs the centralized-vs-federated
   * decision ADR-076 declined to make. This field only makes the two
   * states reportable — both in `--json` output and in
   * `formatProjectRegistryReport`'s human-readable text — instead of
   * silently collapsing them into the same "0 entries" line.
   */
  readonly present: boolean;
}

/** ADR-076 requirement 6: a registry with zero entries passes — governing
 * no projects is a valid state, not a failure. `verifications` is simply
 * empty in that case, and `ok` is `true` by the vacuous `every`. */
export function evaluateProjectRegistry(persistenceDir: string, options: { readonly now?: string } = {}): ProjectRegistryReport {
  const present = existsSync(registryPath(persistenceDir));
  const registry = loadProjectRegistry(persistenceDir);
  const verifications = registry.entries.map((entry) => verifyRegistryEntry(entry, options));
  return { ok: verifications.every((v) => v.ok), entry_count: registry.entries.length, verifications: Object.freeze(verifications), present };
}

export function formatRegisterOutcome(outcome: RegisterProjectOutcome): string {
  if (outcome.registered && outcome.entry) {
    return `Registered ${outcome.entry.project_id} at ${outcome.entry.path} (discharged at revision ${outcome.entry.verified_at_revision.slice(0, 12)}, expires ${outcome.entry.expires}).`;
  }
  return `Not registered — discharge could not be established:\n${outcome.reasons.map((r) => `  - ${r}`).join("\n")}`;
}

export function formatRegistryList(registry: ProjectRegistry): string {
  if (registry.entries.length === 0) return "Project registry — 0 entries (governing no projects).";
  const lines = [`Project registry — ${registry.entries.length} entr${registry.entries.length === 1 ? "y" : "ies"}`];
  for (const entry of registry.entries) {
    lines.push(`  ${entry.project_id}  ${entry.path}  revision ${entry.verified_at_revision.slice(0, 12)}  verified ${entry.verified_at}  expires ${entry.expires}`);
  }
  return lines.join("\n");
}

export function formatProjectRegistryReport(report: ProjectRegistryReport): string {
  const lines = [`Project registry — ${report.entry_count} entr${report.entry_count === 1 ? "y" : "ies"}`];
  if (report.entry_count === 0) {
    lines.push(
      report.present
        ? "(governing no projects — a valid state, not a failure)"
        : "(no registry file present — nothing has been registered here yet, which is not evidence that every governed project passes; run `arbor project registry list` to confirm)",
    );
    return lines.join("\n");
  }
  for (const v of report.verifications) {
    lines.push(`  ${v.ok ? "OK" : "FAIL"}  ${v.project_id}  ${v.path}`);
    for (const f of v.failures) lines.push(`      [${f.code}] ${f.detail}`);
  }
  return lines.join("\n");
}
