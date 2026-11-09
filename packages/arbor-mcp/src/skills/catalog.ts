import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, type Dirent } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import { redactNativeText } from "@arbor/harness";
import { NATIVE_ROLE_PROFILES, type NativeRoleProfileId } from "@arbor/prompts";
import { SKILL_DESCRIPTOR_SCHEMA_VERSION, SKILL_STRUCTURED_OUTPUT_IDS } from "./capabilities.js";
import { SKILL_DESCRIPTOR_MANIFEST } from "../native-capability-manifest.js";

export const SKILL_SCHEMA_VERSION = SKILL_DESCRIPTOR_SCHEMA_VERSION;
export { SKILL_STRUCTURED_OUTPUT_IDS };
export const SKILL_MAX_DESCRIPTORS = 64;
export const SKILL_MAX_DESCRIPTOR_BYTES = 64 * 1024;
export const SKILL_MAX_INSTRUCTION_BYTES = 16 * 1024;
export const SKILL_MAX_BUNDLE_BYTES = 256 * 1024;
export const SKILL_MAX_BUNDLE_FILES = 64;
export const SKILL_MAX_TURN_BUDGET = SKILL_DESCRIPTOR_MANIFEST.budget_contract.max_turns;
export const SKILL_MAX_INPUTS = SKILL_DESCRIPTOR_MANIFEST.input_contract.max_names;
export const SKILL_MAX_INPUT_BYTES = SKILL_DESCRIPTOR_MANIFEST.input_contract.max_value_bytes;
export type SkillStructuredOutputId = (typeof SKILL_STRUCTURED_OUTPUT_IDS)[number];

export interface SkillBundleFile {
  readonly path: string;
  readonly sha256: `sha256:${string}`;
}

export interface SkillDescriptor {
  readonly schema_version: 1;
  readonly skill_id: string;
  readonly version: string;
  readonly role: NativeRoleProfileId;
  /** Redacted composed instruction. Bundle descriptors derive this from SKILL.md. */
  readonly instruction: string;
  readonly bundle: string | null;
  readonly bundle_files: readonly SkillBundleFile[];
  readonly allowed_tools: readonly string[];
  readonly write_path_patterns: readonly string[];
  readonly structured_output: SkillStructuredOutputId | null;
  /** Caller-supplied values the skill explicitly accepts. */
  readonly inputs: readonly string[];
  /** A requested upper bound, intersected with the executor's host budget. */
  readonly max_turns?: number;
}

export interface ValidatedSkill extends SkillDescriptor {
  /** SHA-256 of the exact descriptor bytes, including bundle hashes and all declared reductions. */
  readonly descriptor_hash: string;
}

export type SkillCatalogErrorCode = "descriptor_bound" | "malformed" | "identity" | "version" | "role" | "tool_escalation" | "path_escalation" | "contract" | "immutable_conflict" | "bundle_missing" | "bundle_identity" | "bundle_traversal" | "bundle_symlink" | "bundle_bound" | "bundle_integrity";
export class SkillCatalogError extends Error {
  constructor(readonly code: SkillCatalogErrorCode, message: string) { super(message); this.name = "SkillCatalogError"; }
}
export interface SkillCatalogDiagnostic { readonly source: string; readonly code: SkillCatalogErrorCode; readonly message: string; }

export class SkillCatalog {
  private readonly skills = new Map<string, ValidatedSkill>();
  private readonly repositoryRoots = new Map<string, string | undefined>();
  private readonly activation = new Map<string, () => boolean>();
  private readonly owners = new Map<string, string>();
  private readonly failures: SkillCatalogDiagnostic[] = [];
  private readonly activationFailures = new Set<string>();
  private readonly bundleFailures = new Set<string>();

  static fromDirectory(directory: string): SkillCatalog {
    const catalog = new SkillCatalog();
    if (!existsSync(directory)) return catalog;
    let files: Dirent[];
    try { files = readdirSync(directory, { withFileTypes: true, encoding: "utf8" }); }
    catch { catalog.failures.push(Object.freeze({ source: directory, code: "malformed", message: "skill directory could not be read" })); return catalog; }
    files = files.filter((entry) => entry.isFile() && entry.name.endsWith(".json")).sort((left, right) => left.name.localeCompare(right.name));
    if (files.length > SKILL_MAX_DESCRIPTORS) {
      catalog.failures.push(Object.freeze({ source: directory, code: "descriptor_bound", message: `skill catalog exceeds ${SKILL_MAX_DESCRIPTORS} descriptors` }));
      return catalog;
    }
    for (const file of files) {
      const path = join(directory, file.name);
      try { catalog.register(readFileSync(path), file.name, undefined, undefined, false, resolve(directory, "..", "..")); }
      catch (error) { catalog.capture(file.name, error); }
    }
    return catalog;
  }

  register(bytes: Uint8Array | string, source = "in-memory.json", active?: () => boolean, pluginId?: string, replace = false, repositoryRoot?: string): ValidatedSkill {
    const raw = typeof bytes === "string" ? Buffer.from(bytes, "utf8") : Buffer.from(bytes);
    if (raw.byteLength === 0 || raw.byteLength > SKILL_MAX_DESCRIPTOR_BYTES) throw new SkillCatalogError("descriptor_bound", "skill descriptor is empty or oversized");
    let parsed: unknown;
    try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)); } catch { throw new SkillCatalogError("malformed", "skill descriptor is not valid UTF-8 JSON"); }
    const hash = createHash("sha256").update(raw).digest("hex");
    const skill = validateDescriptor(parsed, hash, repositoryRoot);
    const expectedName = `${skill.skill_id}@${skill.version}.json`;
    if (basename(source) !== "in-memory.json" && basename(source) !== expectedName) throw new SkillCatalogError("identity", `skill filename must be ${expectedName}`);
    const key = identity(skill.skill_id, skill.version); const existing = this.skills.get(key);
    if (existing !== undefined) {
      if (existing.descriptor_hash !== hash && (!replace || pluginId === undefined || this.owners.get(key) !== pluginId)) throw new SkillCatalogError("immutable_conflict", `skill ${skill.skill_id}@${skill.version} is immutable`);
      if (existing.descriptor_hash !== hash) { this.skills.set(key, skill); this.repositoryRoots.set(key, repositoryRoot); this.activation.set(key, active ?? (() => true)); if (pluginId !== undefined) this.owners.set(key, pluginId); return skill; }
      if (pluginId !== undefined && this.owners.get(key) === pluginId) this.activation.set(key, active ?? (() => true));
      return existing;
    }
    if (this.skills.size >= SKILL_MAX_DESCRIPTORS) throw new SkillCatalogError("descriptor_bound", `skill catalog exceeds ${SKILL_MAX_DESCRIPTORS} descriptors`);
    this.skills.set(key, skill); this.repositoryRoots.set(key, repositoryRoot); this.activation.set(key, active ?? (() => true)); if (pluginId !== undefined) this.owners.set(key, pluginId); return skill;
  }

  resolve(skillId: string, version: string): ValidatedSkill | null {
    const key = identity(skillId, version);
    const skill = this.skills.get(key);
    return skill === undefined || !this.isActive(key, skill) || !this.isBundleCurrent(key, skill) ? null : skill;
  }
  list(): readonly ValidatedSkill[] { return Object.freeze([...this.skills].filter(([key, skill]) => this.isActive(key, skill) && this.isBundleCurrent(key, skill)).map(([, skill]) => skill)); }
  diagnostics(): readonly SkillCatalogDiagnostic[] { return Object.freeze(this.failures.map((failure) => Object.freeze({ ...failure }))); }
  private isActive(key: string, skill: ValidatedSkill): boolean {
    try { return (this.activation.get(key) ?? (() => true))() === true; }
    catch (error) {
      // Plugin activation only controls availability. A broken predicate
      // hides its skill and cannot abort dispatch or grant authority.
      if (!this.activationFailures.has(key)) {
        this.activationFailures.add(key);
        this.capture(`${skill.skill_id}@${skill.version}`, error);
      }
      return false;
    }
  }
  private isBundleCurrent(key: string, skill: ValidatedSkill): boolean {
    if (skill.bundle === null) return true;
    try {
      const loaded = loadBundle(skill.bundle, skill.bundle_files, skill.skill_id, this.repositoryRoots.get(key));
      if (loaded.instruction !== skill.instruction) throw new SkillCatalogError("bundle_integrity", "skill bundle instruction changed after descriptor validation");
      return true;
    } catch (error) {
      if (!this.bundleFailures.has(key)) {
        this.bundleFailures.add(key);
        this.capture(`${skill.skill_id}@${skill.version}`, error);
      }
      return false;
    }
  }
  private capture(source: string, error: unknown): void {
    const code = error instanceof SkillCatalogError ? error.code : "malformed";
    const message = redactNativeText(error instanceof Error ? error.message : "skill descriptor failed validation").slice(0, 512);
    this.failures.push(Object.freeze({ source, code, message }));
  }
}

function validateDescriptor(value: unknown, hash: string, repositoryRoot?: string): ValidatedSkill {
  if (!plain(value) || value.schema_version !== SKILL_SCHEMA_VERSION) throw new SkillCatalogError("malformed", "skill descriptor shape or schema_version is invalid");
  const inlineKeys = ["schema_version", "skill_id", "version", "role", "instruction", "allowed_tools", "write_path_patterns", "structured_output"];
  const bundledKeys = ["schema_version", "skill_id", "version", "role", "bundle", "bundle_files", "allowed_tools", "write_path_patterns", "structured_output"];
  const inline = [inlineKeys, [...inlineKeys, "inputs"], [...inlineKeys, "max_turns"], [...inlineKeys, "inputs", "max_turns"]].some((keys) => exactKeys(value, keys));
  const bundled = [bundledKeys, [...bundledKeys, "inputs"], [...bundledKeys, "max_turns"], [...bundledKeys, "inputs", "max_turns"]].some((keys) => exactKeys(value, keys));
  if (!inline && !bundled) throw new SkillCatalogError("malformed", "skill descriptor must contain exactly one of instruction or bundle");
  if (typeof value.skill_id !== "string" || !/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(value.skill_id)) throw new SkillCatalogError("identity", "skill_id is not bounded canonical kebab-case");
  if (typeof value.version !== "string" || value.version.length > 128 || !SEMVER.test(value.version)) throw new SkillCatalogError("version", "skill version must be canonical SemVer");
  if (typeof value.role !== "string" || !Object.prototype.hasOwnProperty.call(NATIVE_ROLE_PROFILES, value.role)) throw new SkillCatalogError("role", "skill role is unknown");
  const inputs = value.inputs ?? [];
  if (!stringList(inputs, SKILL_MAX_INPUTS, SKILL_DESCRIPTOR_MANIFEST.input_contract.max_name_bytes) || inputs.some((name) => !new RegExp(SKILL_DESCRIPTOR_MANIFEST.input_contract.name_pattern, "u").test(name))) throw new SkillCatalogError("contract", "skill inputs must be unique bounded lower-case identifiers");
  if (value.max_turns !== undefined && (typeof value.max_turns !== "number" || !Number.isSafeInteger(value.max_turns) || value.max_turns < 1 || value.max_turns > SKILL_MAX_TURN_BUDGET)) throw new SkillCatalogError("contract", `skill max_turns must be a positive safe integer no greater than ${SKILL_MAX_TURN_BUDGET}`);
  const role = value.role as NativeRoleProfileId;
  let instruction: string;
  let bundle: string | null = null;
  let bundleFiles: readonly SkillBundleFile[] = Object.freeze([]);
  if (inline) {
    if (typeof value.instruction !== "string" || !value.instruction.trim() || Buffer.byteLength(value.instruction, "utf8") > SKILL_MAX_INSTRUCTION_BYTES) throw new SkillCatalogError("malformed", "skill instruction is empty or oversized");
    instruction = redactNativeText(value.instruction);
  } else {
    const loaded = loadBundle(value.bundle, value.bundle_files, value.skill_id, repositoryRoot);
    instruction = loaded.instruction;
    bundle = loaded.bundle;
    bundleFiles = loaded.files;
  }
  if (!stringList(value.allowed_tools, 64, 128)) throw new SkillCatalogError("malformed", "skill allowed_tools is invalid or oversized");
  const roleTools = new Set(NATIVE_ROLE_PROFILES[role].tool_policy.allowed_tools);
  if (value.allowed_tools.some((tool) => !roleTools.has(tool))) throw new SkillCatalogError("tool_escalation", "skill allowed_tools exceeds its base role");
  if (!stringList(value.write_path_patterns, 32, 512) || value.write_path_patterns.some((pattern) => !safePattern(pattern))) throw new SkillCatalogError("malformed", "skill write_path_patterns is invalid or unsafe");
  const rolePaths = NATIVE_ROLE_PROFILES[role].tool_policy.documentation_path_patterns;
  if (NATIVE_ROLE_PROFILES[role].tool_policy.implementation_writes_forbidden && value.write_path_patterns.some((pattern) => !rolePaths.some((parent) => skillPatternCoveredBy(pattern, parent)))) throw new SkillCatalogError("path_escalation", "skill write paths exceed the documentation role");
  if (value.structured_output !== null && (typeof value.structured_output !== "string" || !(SKILL_STRUCTURED_OUTPUT_IDS as readonly string[]).includes(value.structured_output))) throw new SkillCatalogError("contract", "skill structured_output is not in the closed catalog");
  return Object.freeze({
    schema_version: 1, skill_id: value.skill_id, version: value.version, role,
    instruction, bundle, bundle_files: bundleFiles, allowed_tools: Object.freeze([...value.allowed_tools]),
    write_path_patterns: Object.freeze([...value.write_path_patterns]), structured_output: value.structured_output as SkillStructuredOutputId | null,
    inputs: Object.freeze([...inputs]),
    ...(value.max_turns === undefined ? {} : { max_turns: value.max_turns }),
    descriptor_hash: hash,
  });
}

function loadBundle(bundleValue: unknown, filesValue: unknown, skillId: string, repositoryRoot: string | undefined): { readonly instruction: string; readonly bundle: string; readonly files: readonly SkillBundleFile[] } {
  if (typeof bundleValue !== "string" || !safePath(bundleValue)) throw new SkillCatalogError("bundle_traversal", "skill bundle must be a safe repository-relative directory");
  if (basename(bundleValue) !== skillId) throw new SkillCatalogError("bundle_identity", `skill bundle directory must be named ${skillId}`);
  if (repositoryRoot === undefined) throw new SkillCatalogError("bundle_missing", "bundle descriptors require a repository root");
  if (!Array.isArray(filesValue) || filesValue.length === 0 || filesValue.length > SKILL_MAX_BUNDLE_FILES) throw new SkillCatalogError("bundle_bound", `skill bundle manifest must contain from 1 to ${SKILL_MAX_BUNDLE_FILES} files`);
  const declared = new Map<string, SkillBundleFile>();
  for (const candidate of filesValue) {
    if (!plain(candidate) || !exactKeys(candidate, ["path", "sha256"]) || typeof candidate.path !== "string" || !safePath(candidate.path) || typeof candidate.sha256 !== "string" || !/^sha256:[a-f0-9]{64}$/.test(candidate.sha256)) throw new SkillCatalogError("bundle_integrity", "skill bundle manifest contains an invalid path or hash");
    if (declared.has(candidate.path)) throw new SkillCatalogError("bundle_integrity", `skill bundle manifest repeats ${candidate.path}`);
    declared.set(candidate.path, Object.freeze({ path: candidate.path, sha256: candidate.sha256 as `sha256:${string}` }));
  }
  if (!declared.has("SKILL.md")) throw new SkillCatalogError("bundle_missing", "skill bundle manifest must name SKILL.md");

  const root = realpathOrBundleError(repositoryRoot, "bundle_missing", "repository root could not be resolved");
  const candidateRoot = resolve(root, bundleValue);
  if (!inside(root, candidateRoot)) throw new SkillCatalogError("bundle_traversal", "skill bundle resolves outside the repository");
  const bundleRoot = realpathOrBundleError(candidateRoot, "bundle_missing", "skill bundle directory is missing");
  if (!inside(root, bundleRoot)) throw new SkillCatalogError("bundle_traversal", "skill bundle resolves outside the repository");
  if (!lstatSync(bundleRoot).isDirectory()) throw new SkillCatalogError("bundle_missing", "skill bundle path is not a directory");

  const observed = enumerateBundle(bundleRoot);
  if (observed.length > SKILL_MAX_BUNDLE_FILES) throw new SkillCatalogError("bundle_bound", `skill bundle exceeds ${SKILL_MAX_BUNDLE_FILES} files`);
  if (observed.length !== declared.size || observed.some((path) => !declared.has(path))) throw new SkillCatalogError("bundle_integrity", "skill bundle manifest does not exactly cover the directory");
  let totalBytes = 0;
  let skillMarkdown: Buffer | null = null;
  for (const path of observed) {
    const absolute = resolve(bundleRoot, path);
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) throw new SkillCatalogError("bundle_symlink", `skill bundle contains symlink ${path}`);
    if (!stat.isFile()) throw new SkillCatalogError("bundle_integrity", `skill bundle contains unsupported entry ${path}`);
    totalBytes += stat.size;
    if (totalBytes > SKILL_MAX_BUNDLE_BYTES) throw new SkillCatalogError("bundle_bound", `skill bundle exceeds ${SKILL_MAX_BUNDLE_BYTES} bytes`);
    const bytes = readFileSync(absolute);
    const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    if (declared.get(path)?.sha256 !== digest) throw new SkillCatalogError("bundle_integrity", `skill bundle hash mismatch for ${path}`);
    if (path === "SKILL.md") skillMarkdown = bytes;
  }
  if (skillMarkdown === null) throw new SkillCatalogError("bundle_missing", "skill bundle is missing SKILL.md");
  let markdown: string;
  try { markdown = new TextDecoder("utf-8", { fatal: true }).decode(skillMarkdown); }
  catch { throw new SkillCatalogError("malformed", "skill bundle SKILL.md is not valid UTF-8"); }
  const body = markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/u, "");
  if (!body.trim()) throw new SkillCatalogError("malformed", "skill bundle SKILL.md body is empty");
  return { instruction: redactNativeText(body), bundle: bundleValue, files: Object.freeze([...declared.values()].sort((left, right) => left.path.localeCompare(right.path))) };
}

function enumerateBundle(root: string, prefix = ""): string[] {
  const result: string[] = [];
  for (const entry of readdirSync(resolve(root, prefix), { withFileTypes: true, encoding: "utf8" }).sort((left, right) => left.name.localeCompare(right.name))) {
    const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isSymbolicLink()) throw new SkillCatalogError("bundle_symlink", `skill bundle contains symlink ${path}`);
    if (entry.isDirectory()) result.push(...enumerateBundle(root, path));
    else if (entry.isFile()) result.push(path);
    else throw new SkillCatalogError("bundle_integrity", `skill bundle contains unsupported entry ${path}`);
    if (result.length > SKILL_MAX_BUNDLE_FILES) throw new SkillCatalogError("bundle_bound", `skill bundle exceeds ${SKILL_MAX_BUNDLE_FILES} files`);
  }
  return result;
}

function realpathOrBundleError(path: string, code: SkillCatalogErrorCode, message: string): string {
  try { return realpathSync(path); } catch { throw new SkillCatalogError(code, message); }
}

function inside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !path.startsWith(sep));
}

export function skillPatternMatches(pattern: string, path: string): boolean {
  if (!safePattern(pattern) || !safePath(path)) return false;
  let expression = "^";
  for (let index = 0; index < pattern.length;) {
    if (pattern.startsWith("**/", index)) { expression += "(?:.*/)?"; index += 3; continue; }
    if (pattern.startsWith("**", index)) { expression += ".*"; index += 2; continue; }
    const character = pattern[index++]!;
    if (character === "*") expression += "[^/]*";
    else if (character === "?") expression += "[^/]";
    else expression += character.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
  }
  return new RegExp(`${expression}$`, "u").test(path);
}

/** Conservative containment check reused at the runtime composition boundary. */
export function skillPatternCoveredBy(candidate: string, parent: string): boolean {
  if (candidate === parent) return true;
  if (!candidate.includes("*") && !candidate.includes("?") && skillPatternMatches(parent, candidate)) return true;
  const wildcard = parent.indexOf("**");
  return wildcard >= 0 && candidate.startsWith(parent.slice(0, wildcard)) && candidate.endsWith(parent.slice(wildcard + 2));
}
function safePattern(value: string): boolean { return safePath(value) && !value.includes("***") && !/[\[\]{}]/.test(value); }
function safePath(value: string): boolean { return value.length > 0 && !value.startsWith("/") && !value.includes("\\") && !value.includes("\u0000") && !value.includes(":") && value.split("/").every((part) => part.length > 0 && part !== "." && part !== ".."); }
function stringList(value: unknown, maximum: number, bytes: number): value is string[] { return Array.isArray(value) && value.length <= maximum && new Set(value).size === value.length && value.every((item) => typeof item === "string" && item.length > 0 && Buffer.byteLength(item, "utf8") <= bytes); }
function plain(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null); }
function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean { return Object.keys(value).length === expected.length && expected.every((key) => Object.prototype.hasOwnProperty.call(value, key)); }
function identity(skillId: string, version: string): string { return `${skillId}\u0000${version}`; }
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
