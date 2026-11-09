import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { deriveProfileForNewProject, deriveProfileFromInspection, renderProfileJsonc, type DerivedProfile, type ProfileDerivationRefusal } from "./project-profile-derivation.js";
import { initializeGitRepositoryForScaffold } from "./project-registry.js";
import { DEFAULT_HOOK_DESCRIPTORS } from "./hooks/catalog.js";

export const PROJECT_OVERLAY_SCHEMA_VERSION = 1;
export const PROJECT_OVERLAY_DIRECTORIES = Object.freeze([
  ".arbor/commands",
  ".arbor/hooks",
  ".arbor/skills",
  ".arbor/plans",
  ".arbor/runs",
] as const);

export type ProjectEnrollmentMode = "existing" | "new" | "backfill";
export type ProjectOverlayState = "not_enrolled" | "ready" | "incomplete" | "invalid" | "moved";

export interface ProjectOverlayManifest {
  readonly schema_version: 1;
  readonly project_id: string;
  readonly name: string;
  readonly enrolled_root: string;
  readonly enrolled_at: string;
}

export interface ProjectOverlayFinding {
  readonly code: "manifest_missing" | "manifest_invalid" | "root_mismatch" | "config_missing" | "directory_missing";
  readonly severity: "error" | "warning";
  readonly path: string;
  readonly message: string;
  readonly remediation: string;
  readonly repairable: boolean;
}

export interface ProjectOverlayInspection {
  readonly root: string;
  readonly state: ProjectOverlayState;
  readonly manifest: ProjectOverlayManifest | null;
  readonly findings: readonly ProjectOverlayFinding[];
  readonly next_command: string | null;
}

export type ProjectChangeDisposition = "created" | "would_create" | "updated" | "would_update" | "preserved" | "refused";

export interface ProjectProfileOutcome {
  readonly path: string;
  readonly disposition: ProjectChangeDisposition;
  /** Fields the profile derivation could not prove and therefore omitted or,
   * on total refusal, why no profile was written at all. Empty when nothing
   * was refused. */
  readonly refusals: readonly { readonly field: string; readonly reason: string }[];
}

export interface ProjectLifecycleResult {
  readonly operation: "enroll" | "repair";
  readonly mode: ProjectEnrollmentMode | "repair";
  readonly dry_run: boolean;
  readonly root: string;
  readonly changes: readonly { readonly path: string; readonly disposition: ProjectChangeDisposition }[];
  readonly inspection: ProjectOverlayInspection;
  /** Roadmap 23 W4: joins enrollment to ADR-073 conformance. Derived, never
   * guessed — see project-profile-derivation.ts. */
  readonly profile: ProjectProfileOutcome;
}

const MANIFEST_RELATIVE_PATH = ".arbor/project.json";

/**
 * The scaffolded AGENTS.md must carry the marker conformance requires
 * (`agents-md-governance-marker`), and a brand-new project genuinely has zero
 * ADRs. Assembled by concatenation so this template is not itself read as a
 * count claim ABOUT REVOY2: the SUR-05 checker scans `packages/` source for
 * "<N> ADRs", and a literal here was reported as this repository claiming a
 * zero total of its own. Same technique, same reason, as `HISTORICAL_CLAIM_MARKER`
 * in `packages/arbor-governance/src/counts/check.ts`.
 */
const SCAFFOLD_ADR_COUNT_CLAIM = "0" + " ADRs";

/** Read-only, bounded inspection of the project overlay. */
export function inspectProjectOverlay(inputRoot: string): ProjectOverlayInspection {
  const root = canonicalRoot(inputRoot);
  const manifestPath = join(root, MANIFEST_RELATIVE_PATH);
  const findings: ProjectOverlayFinding[] = [];
  let manifest: ProjectOverlayManifest | null = null;
  if (!existsSync(manifestPath)) {
    findings.push(finding("manifest_missing", "error", manifestPath, "This directory has not been enrolled in revoy2.", `arbor project enroll ${quote(root)}`, true));
  } else {
    try {
      if (lstatSync(manifestPath).isSymbolicLink()) throw new Error("Project manifest must not be a symbolic link.");
      manifest = parseManifest(readFileSync(manifestPath, "utf8"));
    } catch (error) {
      findings.push(finding("manifest_invalid", "error", manifestPath, error instanceof Error ? error.message : "Project manifest is invalid.", `Fix ${manifestPath} or move it aside, then run arbor project enroll ${quote(root)} --backfill`, false));
    }
  }
  if (manifest !== null && resolve(manifest.enrolled_root) !== root) {
    findings.push(finding("root_mismatch", "warning", manifestPath, `Overlay was enrolled at ${manifest.enrolled_root}; current root is ${root}.`, `arbor project repair ${quote(root)} --apply`, true));
  }
  const configPath = join(root, "arbor.jsonc");
  if (!existsSync(configPath) || !lstatSync(configPath).isFile()) findings.push(finding("config_missing", "error", configPath, "Project policy config is missing or is not a regular file.", `arbor project repair ${quote(root)} --apply`, !existsSync(configPath)));
  for (const relativePath of PROJECT_OVERLAY_DIRECTORIES) {
    const path = join(root, relativePath);
    if (!existsSync(path) || !lstatSync(path).isDirectory()) findings.push(finding("directory_missing", "warning", path, `Overlay directory ${relativePath} is missing or unusable.`, `arbor project repair ${quote(root)} --apply`, !existsSync(path)));
  }
  const state: ProjectOverlayState = manifest === null
    ? findings.some((item) => item.code === "manifest_invalid") ? "invalid" : "not_enrolled"
    : findings.some((item) => item.code === "root_mismatch") ? "moved"
      : findings.length > 0 ? "incomplete" : "ready";
  return Object.freeze({ root, state, manifest, findings: Object.freeze(findings), next_command: findings[0]?.remediation ?? null });
}

/**
 * Idempotently enroll a new/existing directory or backfill a partial overlay.
 * It never overwrites manifest/config content and never writes credentials.
 */
export function enrollProject(inputRoot: string, options: { readonly mode?: ProjectEnrollmentMode; readonly dry_run?: boolean; readonly now?: string } = {}): ProjectLifecycleResult {
  const mode = options.mode ?? "existing";
  const dryRun = options.dry_run === true;
  const requested = resolve(inputRoot);
  if (!existsSync(requested)) {
    if (mode !== "new") throw new Error(`Project root does not exist: ${requested}. Use --new to create it.`);
    if (!dryRun) mkdirSync(requested, { recursive: true });
  }
  const root = existsSync(requested) ? canonicalRoot(requested) : requested;
  const before = inspectProjectOverlayPreview(root);
  if (before.state === "invalid") throw new Error(`Cannot backfill an invalid overlay. ${before.next_command ?? "Repair the manifest first."}`);
  const changes: Array<{ path: string; disposition: ProjectChangeDisposition }> = [];
  ensureDirectory(join(root, ".arbor"), dryRun, changes);
  for (const relativePath of PROJECT_OVERLAY_DIRECTORIES) ensureDirectory(join(root, relativePath), dryRun, changes);
  const manifestPath = join(root, MANIFEST_RELATIVE_PATH);
  if (existsSync(manifestPath)) changes.push({ path: manifestPath, disposition: "preserved" });
  else {
    const manifest: ProjectOverlayManifest = Object.freeze({
      schema_version: 1,
      project_id: randomUUID(),
      name: basename(root) || "project",
      enrolled_root: root,
      enrolled_at: options.now ?? new Date().toISOString(),
    });
    if (!dryRun) writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    changes.push({ path: manifestPath, disposition: dryRun ? "would_create" : "created" });
  }
  ensureConfig(root, dryRun, changes);
  ensureDefaultHooks(root, dryRun, changes);
  const profile = deriveAndSeedProfile(root, mode, dryRun, changes);
  return Object.freeze({ operation: "enroll", mode, dry_run: dryRun, root, changes: Object.freeze(changes), inspection: dryRun ? before : inspectProjectOverlay(root), profile });
}

/**
 * ADR-080 — `arbor.profile.jsonc`'s optional `citation_roots` key (scripts/lib/
 * project-profile.mjs's `DEFAULT_PROFILE.citation_roots`, `null` by default)
 * has no representation in `DerivedProfile` (project-profile-derivation.ts,
 * not owned by this fix) and so is never scaffolded. Rather than guess a
 * value — the loader's own documented default, "same as source_roots", is
 * the correct behavior and must not change — this appends a comment
 * documenting the key's existence and its default fallback directly onto
 * the rendered profile, so an enrolled project's operator learns the key
 * exists without this scaffolder asserting a citation-bearing directory
 * that may not exist. JSONC comments are stripped structurally
 * (project-profile.mjs's `stripJsonComments`), so this is inert to the
 * loader either way.
 */
// Deliberately column-0 (never indented), matching renderProfileJsonc's own
// header comment: a downstream reader that strips "^//" lines to recover
// the underlying JSON (as this file's own tests do) only strips column-0
// comment lines, so an indented one would corrupt that recovery.
const CITATION_ROOTS_NOTE = [
  "// citation_roots (ADR-080, optional): repo-relative directories scanned for ADR-NNN",
  "// citations, separate from source_roots (a package tree) — e.g. \"scripts\" if governance",
  "// machinery lives outside source_roots. Unset means \"same as source_roots\", the",
  "// documented safe default; add this key only when a citation-bearing directory is",
  "// NOT already covered by source_roots.",
].join("\n");

function withCitationRootsNote(renderedJsonc: string): string {
  const marker = '\n  "governance":';
  const idx = renderedJsonc.indexOf(marker);
  // Shape changed upstream (DerivedProfile field order/name) — never fail
  // scaffolding over an informational comment; just skip it.
  if (idx === -1) return renderedJsonc;
  return `${renderedJsonc.slice(0, idx)}\n${CITATION_ROOTS_NOTE}${renderedJsonc.slice(idx)}`;
}

/**
 * Roadmap 23 W4 — closes the split brain between the enrollment surface and
 * ADR-073's conformance surface (docs/roadmaps/23-multi-project-enrollment.md
 * §2.5). Writes `arbor.profile.jsonc` if and only if one does not already
 * exist (never clobbers a hand-authored profile) and, only when a profile
 * was actually written, seeds the directories it declares. Derivation is
 * delegated to project-profile-derivation.ts, which refuses rather than
 * guesses; this function only decides WHICH derivation strategy applies
 * (scaffold vs. inspect) and performs the (dry-run-aware) writes.
 */
function deriveAndSeedProfile(root: string, mode: ProjectEnrollmentMode | "repair", dryRun: boolean, changes: Array<{ path: string; disposition: ProjectChangeDisposition }>): ProjectProfileOutcome {
  const profilePath = join(root, "arbor.profile.jsonc");
  if (existsSync(profilePath)) {
    changes.push({ path: profilePath, disposition: "preserved" });
    return { path: profilePath, disposition: "preserved", refusals: [] };
  }

  // "new" mode against a target with no existing package.json is genuine
  // authorship of a brand-new project's initial state (Create, not Enroll) —
  // see project-profile-derivation.ts's module doc. Every other case derives
  // strictly by inspecting what already exists.
  const scaffoldNew = mode === "new" && !existsSync(join(root, "package.json"));

  let profile: DerivedProfile | null;
  let refusals: readonly ProfileDerivationRefusal[];
  let packageJsonScripts: Readonly<Record<string, string>> | null = null;
  if (scaffoldNew) {
    const scaffold = deriveProfileForNewProject(root);
    profile = scaffold.profile;
    packageJsonScripts = scaffold.packageJsonScripts;
    refusals = [];
  } else {
    const derived = deriveProfileFromInspection(root);
    profile = derived.profile;
    refusals = derived.refusals;
  }

  if (profile === null) {
    changes.push({ path: profilePath, disposition: "refused" });
    return { path: profilePath, disposition: "refused", refusals };
  }

  if (!dryRun) writeFileSync(profilePath, withCitationRootsNote(renderProfileJsonc(profile)), { encoding: "utf8", mode: 0o644, flag: "wx" });
  changes.push({ path: profilePath, disposition: dryRun ? "would_create" : "created" });

  if (packageJsonScripts !== null) {
    const pkgPath = join(root, "package.json");
    if (existsSync(pkgPath)) {
      changes.push({ path: pkgPath, disposition: "preserved" });
    } else {
      const pkgContent = { name: profile.project_id, version: "0.1.0", private: true, scripts: packageJsonScripts };
      if (!dryRun) writeFileSync(pkgPath, `${JSON.stringify(pkgContent, null, 2)}\n`, { encoding: "utf8", mode: 0o644, flag: "wx" });
      changes.push({ path: pkgPath, disposition: dryRun ? "would_create" : "created" });
    }
  }

  // Seed the directories the (possibly partial) profile declares. Creating
  // an empty directory is mechanically safe — the same posture
  // `scripts/project-conform.mjs`'s `attemptFix` already takes for any
  // `dir`-kind element — regardless of whether this was a full scaffold or
  // a partial inspection-derived profile.
  ensurePublicDirectory(join(root, profile.governance.decisions_dir), dryRun, changes);
  for (const store of profile.governance.evidence_stores) ensurePublicDirectory(join(root, store), dryRun, changes);
  for (const sourceRoot of profile.source_roots) ensurePublicDirectory(join(root, sourceRoot), dryRun, changes);

  // File CONTENT, by contrast, is only authored for a full new-project
  // scaffold — never for an inspected existing target, matching
  // `attemptFix`'s refusal to fabricate `file`-kind content.
  const finalRefusals = [...refusals];
  if (packageJsonScripts !== null) {
    ensureFileIfAbsent(
      join(root, profile.governance.decisions_dir, "registry.json"),
      `${JSON.stringify({ schema_version: 1, next_available: 1, reserved: [], reserved_reason: {}, allocations: [] }, null, 2)}\n`,
      dryRun,
      changes,
    );
    ensureFileIfAbsent(
      join(root, profile.governance.decisions_dir, "README.md"),
      "# ADR Index\n\n| # | Title | Status |\n|---|-------|--------|\n\nNo decisions recorded yet.\n",
      dryRun,
      changes,
    );
    ensureFileIfAbsent(
      join(root, "AGENTS.md"),
      `# AGENTS\n\nGovernance corpus: <!-- governance:adr_total -->${SCAFFOLD_ADR_COUNT_CLAIM}<!-- /governance:adr_total -->\n`,
      dryRun,
      changes,
    );
    // Roadmap 23 §6 L2: `enroll --new` scaffolds a brand-new project's
    // initial state (see this module's header doc on `scaffoldNew`), and a
    // project's git history is squarely part of that initial state — the
    // same "genuine authorship of a new project" reasoning that already
    // justifies writing package.json/AGENTS.md content here. Without a
    // resolvable revision, `registerProject` correctly refuses (ADR-076
    // requires provenance it does not have to remain unclaimed), but that
    // left the single most natural first command producing a conformant,
    // enrolled, permanently-unregistered project. Initializing the repo we
    // just authored closes that gap at its source instead of only
    // describing it in operator output. `ensureNewProjectGitRepo` only ever
    // acts on a target with no `.git` yet, so an existing repository is
    // never touched.
    ensureNewProjectGitRepo(root, dryRun, changes, finalRefusals);
  }

  return { path: profilePath, disposition: dryRun ? "would_create" : "created", refusals: Object.freeze(finalRefusals) };
}

/**
 * `git init` + a single initial commit for a target this call itself just
 * scaffolded from nothing (see the `scaffoldNew` guard at this function's
 * only call site). Never runs against a target that already has a `.git`
 * directory — that check is unconditional and comes before any git
 * subprocess is spawned, so a pre-existing repository (this project's own
 * checkout included) is structurally unreachable here. Failure (git
 * missing, permissions, etc.) is recorded as a refusal rather than thrown:
 * enrollment/profile scaffolding already succeeded and must not be
 * reported as failed because provenance could not also be established —
 * the same "refusal, not failure" posture `registerProject`'s `no_revision`
 * outcome already takes one layer up.
 */
function ensureNewProjectGitRepo(root: string, dryRun: boolean, changes: Array<{ path: string; disposition: ProjectChangeDisposition }>, refusals: ProfileDerivationRefusal[]): void {
  const gitDir = join(root, ".git");
  if (existsSync(gitDir)) {
    changes.push({ path: gitDir, disposition: "preserved" });
    return;
  }
  if (dryRun) {
    changes.push({ path: gitDir, disposition: "would_create" });
    return;
  }
  const result = initializeGitRepositoryForScaffold(root);
  if (result.ok) {
    changes.push({ path: gitDir, disposition: "created" });
  } else {
    changes.push({ path: gitDir, disposition: "refused" });
    refusals.push({ field: "git_init", reason: `could not initialize a git repository at ${root}: ${result.error}` });
  }
}

/** Repair only missing/moved overlay structure; malformed user content fails closed. */
export function repairProjectOverlay(inputRoot: string, apply = false): ProjectLifecycleResult {
  const root = canonicalRoot(inputRoot);
  const before = inspectProjectOverlay(root);
  if (before.state === "invalid") throw new Error(`Project overlay is invalid and was not modified. ${before.next_command ?? "Inspect .arbor/project.json."}`);
  if (before.state === "not_enrolled") return enrollProject(root, { mode: "backfill", dry_run: !apply });
  const changes: Array<{ path: string; disposition: ProjectChangeDisposition }> = [];
  for (const relativePath of PROJECT_OVERLAY_DIRECTORIES) ensureDirectory(join(root, relativePath), !apply, changes);
  ensureConfig(root, !apply, changes);
  ensureDefaultHooks(root, !apply, changes);
  const manifestPath = join(root, MANIFEST_RELATIVE_PATH);
  if (before.manifest !== null && before.state === "moved") {
    if (apply) {
      const updated = { ...before.manifest, enrolled_root: root };
      writeFileSync(manifestPath, `${JSON.stringify(updated, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    }
    changes.push({ path: manifestPath, disposition: apply ? "updated" : "would_update" });
  } else changes.push({ path: manifestPath, disposition: "preserved" });
  const profile = deriveAndSeedProfile(root, "repair", !apply, changes);
  return Object.freeze({ operation: "repair", mode: "repair", dry_run: !apply, root, changes: Object.freeze(changes), inspection: apply ? inspectProjectOverlay(root) : before, profile });
}

export function formatProjectLifecycle(value: ProjectOverlayInspection | ProjectLifecycleResult): string {
  const inspection = "operation" in value ? value.inspection : value;
  // Q3: `enroll --dry-run` previews the state the command exists to fix.
  // Rendering that baseline's findings as `[error]`/`[warning]` scolds an
  // operator for the exact not-yet-enrolled condition they are previewing a
  // fix for. Only this preview path gets the softer framing — `project
  // status` and `repair` keep the ordinary `[severity] code` findings
  // format, which genuinely does report a live problem there.
  const isEnrollPreview = "operation" in value && value.operation === "enroll" && value.dry_run;
  const lines = [`Project ${inspection.state.replaceAll("_", " ")}: ${inspection.root}`];
  if ("operation" in value) {
    const label = isEnrollPreview
      ? (inspection.state === "not_enrolled" ? "Preview: new enrollment" : "Preview: existing overlay detected")
      : `${value.dry_run ? "Preview" : "Applied"} ${value.operation} (${value.mode})`;
    lines.push(label, ...value.changes.map((change) => `  ${change.disposition}: ${change.path}`));
  }
  if (inspection.findings.length > 0) {
    if (isEnrollPreview) {
      lines.push("Baseline to be created by enroll", ...inspection.findings.map((item) => `  - ${item.code}: ${item.message}`));
    } else {
      lines.push("Findings", ...inspection.findings.map((item) => `  [${item.severity}] ${item.code}: ${item.message}\n    ${item.remediation}`));
    }
  } else lines.push("Overlay, policy config, command/skill roots, plans, and run storage agree.");
  if (inspection.next_command && !isEnrollPreview) lines.push(`Next: ${inspection.next_command}`);
  if ("operation" in value && value.profile.refusals.length > 0) {
    lines.push(
      `Profile derivation (${value.profile.disposition}) refused:`,
      ...value.profile.refusals.map((item) => `  - ${item.field}: ${item.reason}`),
    );
  }
  return lines.join("\n");
}

function canonicalRoot(root: string): string {
  const requested = resolve(root);
  if (!existsSync(requested)) throw new Error(`Project root does not exist: ${requested}`);
  return realpathSync(requested);
}
function inspectProjectOverlayPreview(root: string): ProjectOverlayInspection {
  if (existsSync(root)) return inspectProjectOverlay(root);
  return Object.freeze({ root, state: "not_enrolled", manifest: null, findings: Object.freeze([]), next_command: null });
}
function parseManifest(text: string): ProjectOverlayManifest {
  const value: unknown = JSON.parse(text);
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Project manifest must be a JSON object.");
  const item = value as Record<string, unknown>;
  const keys = Object.keys(item).sort();
  if (keys.join("\0") !== ["enrolled_at", "enrolled_root", "name", "project_id", "schema_version"].sort().join("\0")
    || item.schema_version !== PROJECT_OVERLAY_SCHEMA_VERSION
    || typeof item.project_id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(item.project_id)
    || typeof item.name !== "string" || !item.name.trim() || item.name.length > 256
    || typeof item.enrolled_root !== "string" || !item.enrolled_root.trim()
    || typeof item.enrolled_at !== "string" || !Number.isFinite(Date.parse(item.enrolled_at))) throw new Error("Project manifest does not satisfy schema version 1.");
  return Object.freeze(item as unknown as ProjectOverlayManifest);
}
function finding(code: ProjectOverlayFinding["code"], severity: ProjectOverlayFinding["severity"], path: string, message: string, remediation: string, repairable: boolean): ProjectOverlayFinding {
  return Object.freeze({ code, severity, path, message, remediation, repairable });
}
function ensureDirectory(path: string, dryRun: boolean, changes: Array<{ path: string; disposition: ProjectChangeDisposition }>): void {
  if (existsSync(path)) {
    if (!lstatSync(path).isDirectory()) throw new Error(`Required overlay directory is not a directory: ${path}`);
    changes.push({ path, disposition: "preserved" }); return;
  }
  if (!dryRun) mkdirSync(path, { recursive: true, mode: 0o700 });
  changes.push({ path, disposition: dryRun ? "would_create" : "created" });
}
function ensureConfig(root: string, dryRun: boolean, changes: Array<{ path: string; disposition: ProjectChangeDisposition }>): void {
  const destination = join(root, "arbor.jsonc");
  if (existsSync(destination)) {
    if (!lstatSync(destination).isFile()) throw new Error(`Project policy path is not a regular file: ${destination}`);
    changes.push({ path: destination, disposition: "preserved" }); return;
  }
  const source = new URL("../../../arbor.example.jsonc", import.meta.url);
  if (!dryRun) writeFileSync(destination, readFileSync(source, "utf8"), { encoding: "utf8", mode: 0o600, flag: "wx" });
  changes.push({ path: destination, disposition: dryRun ? "would_create" : "created" });
}
function ensureDefaultHooks(root: string, dryRun: boolean, changes: Array<{ path: string; disposition: ProjectChangeDisposition }>): void {
  // The hook bus ships a documented default set (a plan_confirm notifier and
  // a tool_audit log) so a freshly enrolled project has a working, editable
  // example rather than an empty, silent hooks directory (audit 2026-08-23
  // WA-43 / T3.2 follow-up). ensureFileIfAbsent never overwrites an operator's
  // own edits.
  for (const descriptor of DEFAULT_HOOK_DESCRIPTORS) {
    ensureFileIfAbsent(join(root, ".arbor", "hooks", descriptor.filename), descriptor.contents, dryRun, changes);
  }
}
function quote(value: string): string { return JSON.stringify(value); }
/** Like `ensureDirectory`, but for a normal (readable, non-overlay-secret)
 * project directory such as `decisions/` or an evidence store — mode 0o755
 * rather than the 0o700 used for `.arbor/*` state. */
function ensurePublicDirectory(path: string, dryRun: boolean, changes: Array<{ path: string; disposition: ProjectChangeDisposition }>): void {
  if (existsSync(path)) {
    if (!lstatSync(path).isDirectory()) throw new Error(`Expected a directory: ${path}`);
    changes.push({ path, disposition: "preserved" }); return;
  }
  if (!dryRun) mkdirSync(path, { recursive: true, mode: 0o755 });
  changes.push({ path, disposition: dryRun ? "would_create" : "created" });
}
/** Writes `content` to `path` only if nothing is there yet; never
 * overwrites. Used only for genuine new-project scaffolding, never for
 * inspection-derived profiles of an existing target (see
 * `deriveAndSeedProfile`) — matching `attemptFix`'s refusal to fabricate
 * file-kind content for a repo it did not author from scratch. */
function ensureFileIfAbsent(path: string, content: string, dryRun: boolean, changes: Array<{ path: string; disposition: ProjectChangeDisposition }>): void {
  if (existsSync(path)) {
    changes.push({ path, disposition: "preserved" }); return;
  }
  if (!dryRun) writeFileSync(path, content, { encoding: "utf8", mode: 0o644, flag: "wx" });
  changes.push({ path, disposition: dryRun ? "would_create" : "created" });
}
