import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, type Dirent } from "node:fs";
import { basename, join } from "node:path";
import { redactNativeText } from "@arbor/harness";
import { NATIVE_ROLE_PROFILES, type NativeRoleProfileId } from "@arbor/prompts";
import type { HookBus } from "../hooks/bus.js";
import { SKILL_MAX_INPUTS, SKILL_MAX_INPUT_BYTES } from "../skills/catalog.js";

export const COMMAND_MAX_DESCRIPTORS = 64;
export const COMMAND_MAX_BYTES = 64 * 1024;
export const COMMAND_MAX_ARGUMENTS = 32;
export const COMMAND_MAX_ARGUMENT_BYTES = 8 * 1024;

export interface UserCommand {
  readonly name: string;
  readonly description: string;
  readonly allowed_tools: readonly string[];
  readonly execution_role: NativeRoleProfileId;
  readonly argument_hint: string | null;
  readonly skill_id: string | null;
  readonly skill_version?: string;
  readonly skill_input_arguments?: Readonly<Record<string, number>>;
  readonly prompt: string;
  readonly source: "user" | "project" | "plugin";
  readonly descriptor_hash: string;
  readonly plugin_id?: string;
}

export type CommandCatalogErrorCode = "malformed" | "descriptor_bound" | "identity" | "command_escalation" | "immutable_conflict";
export class CommandCatalogError extends Error {
  constructor(readonly code: CommandCatalogErrorCode, message: string) { super(message); this.name = "CommandCatalogError"; }
}
export interface CommandCatalogDiagnostic { readonly source: string; readonly code: CommandCatalogErrorCode; readonly message: string }

export class CommandCatalog {
  private readonly commands = new Map<string, UserCommand>();
  private readonly activation = new Map<string, () => boolean>();
  private readonly failures: CommandCatalogDiagnostic[] = [];

  static fromLocations(userDirectory: string, projectDirectory: string): CommandCatalog {
    const catalog = new CommandCatalog();
    catalog.loadDirectory(userDirectory, "user", false);
    catalog.loadDirectory(projectDirectory, "project", true);
    return catalog;
  }

  register(bytes: Uint8Array | string, sourceName = "in-memory.md", source: UserCommand["source"] = "plugin", replace = false, active?: () => boolean, pluginId?: string): UserCommand {
    const raw = typeof bytes === "string" ? Buffer.from(bytes, "utf8") : Buffer.from(bytes);
    if (raw.byteLength === 0 || raw.byteLength > COMMAND_MAX_BYTES) throw new CommandCatalogError("descriptor_bound", "command is empty or oversized");
    const name = basename(sourceName, ".md");
    if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(name)) throw new CommandCatalogError("identity", "command filename must be bounded canonical kebab-case");
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(raw);
    const { frontmatter, body } = parseCommandMarkdown(decoded);
    const executionRole = field(frontmatter, "execution_role") as NativeRoleProfileId;
    if (!Object.prototype.hasOwnProperty.call(NATIVE_ROLE_PROFILES, executionRole)) throw new CommandCatalogError("malformed", "command execution_role is unknown");
    const allowedTools = listField(frontmatter, "allowed_tools");
    const roleTools = new Set(NATIVE_ROLE_PROFILES[executionRole].tool_policy.allowed_tools);
    if (allowedTools.some((tool) => !roleTools.has(tool))) throw new CommandCatalogError("command_escalation", "command allowed_tools exceeds its execution role");
    const skillVersion = optionalSemver(frontmatter, "skill_version");
    const skillInputArguments = frontmatter.has("skill_input_arguments") ? parseSkillInputArguments(frontmatter.get("skill_input_arguments")) : undefined;
    const command: UserCommand = Object.freeze({
      name,
      description: boundedField(frontmatter, "description", 512),
      allowed_tools: Object.freeze(allowedTools),
      execution_role: executionRole,
      argument_hint: optionalField(frontmatter, "argument_hint", 256),
      skill_id: optionalIdentifier(frontmatter, "skill_id"),
      ...(skillVersion === null ? {} : { skill_version: skillVersion }),
      ...(skillInputArguments === undefined ? {} : { skill_input_arguments: skillInputArguments }),
      prompt: redactNativeText(body.trim()), source,
      descriptor_hash: createHash("sha256").update(raw).digest("hex"), ...(pluginId === undefined ? {} : { plugin_id: pluginId }),
    });
    if (!command.prompt) throw new CommandCatalogError("malformed", "command prompt is empty");
    const existing = this.commands.get(name);
    if (existing !== undefined) {
      if (existing.descriptor_hash !== command.descriptor_hash && (!replace || (pluginId !== undefined && (existing.source !== "plugin" || existing.plugin_id !== pluginId)))) throw new CommandCatalogError("immutable_conflict", `command ${name} is immutable`);
      if (existing.descriptor_hash !== command.descriptor_hash) { this.commands.set(name, command); this.activation.set(name, active ?? (() => true)); return command; }
      if (pluginId !== undefined && existing.plugin_id === pluginId) this.activation.set(name, active ?? (() => true));
      return existing;
    }
    if (existing === undefined && this.commands.size >= COMMAND_MAX_DESCRIPTORS) throw new CommandCatalogError("descriptor_bound", `command catalog exceeds ${COMMAND_MAX_DESCRIPTORS} descriptors`);
    this.commands.set(name, command); this.activation.set(name, active ?? (() => true));
    return command;
  }

  resolve(name: string): UserCommand | null { const command = this.commands.get(name); return command === undefined || !(this.activation.get(name) ?? (() => true))() ? null : command; }
  list(): readonly UserCommand[] { return Object.freeze([...this.commands.values()].filter((command) => (this.activation.get(command.name) ?? (() => true))()).sort((a, b) => a.name.localeCompare(b.name))); }
  diagnostics(): readonly CommandCatalogDiagnostic[] { return Object.freeze(this.failures.map((item) => Object.freeze({ ...item }))); }

  private loadDirectory(directory: string, source: "user" | "project", replace: boolean): void {
    if (!existsSync(directory)) return;
    let files: Dirent[];
    try { files = readdirSync(directory, { withFileTypes: true, encoding: "utf8" }); }
    catch { this.failures.push(Object.freeze({ source: directory, code: "malformed", message: "command directory could not be read" })); return; }
    files = files.filter((entry) => entry.isFile() && entry.name.endsWith(".md")).sort((a, b) => a.name.localeCompare(b.name));
    if (files.length > COMMAND_MAX_DESCRIPTORS) { this.failures.push(Object.freeze({ source: directory, code: "descriptor_bound", message: "command directory exceeds descriptor bound" })); return; }
    for (const file of files) {
      try { this.register(readFileSync(join(directory, file.name)), file.name, source, replace); }
      catch (error) { this.failures.push(Object.freeze({ source: file.name, code: error instanceof CommandCatalogError ? error.code : "malformed", message: redactNativeText(error instanceof Error ? error.message : "command failed validation").slice(0, 512) })); }
    }
  }
}

export interface InvokedUserCommand {
  readonly command: UserCommand;
  readonly rendered_prompt: string;
  readonly effective_tools: readonly string[];
  readonly skill_inputs: Readonly<Record<string, string>>;
  readonly skill_inputs_hash: string | null;
}

export function invokeUserCommand(catalog: Pick<CommandCatalog, "resolve">, name: string, args: readonly string[], hookBus?: HookBus): InvokedUserCommand {
  const command = catalog.resolve(name);
  if (command === null) throw new CommandCatalogError("identity", `unknown command ${name}`);
  if (args.length > COMMAND_MAX_ARGUMENTS || args.some((arg) => Buffer.byteLength(arg, "utf8") > COMMAND_MAX_ARGUMENT_BYTES)) throw new CommandCatalogError("descriptor_bound", "command arguments exceed bounds");
  const skillInputArguments: Readonly<Record<string, unknown>> = command.skill_input_arguments ?? Object.freeze({});
  if ((command.skill_version !== undefined && command.skill_id === null) || (Object.keys(skillInputArguments).length > 0 && (command.skill_id === null || command.skill_version === undefined))) throw new CommandCatalogError("malformed", "skill input bindings require an exact skill_id and skill_version");
  const skillInputs: Record<string, string> = {};
  for (const inputName of Object.keys(skillInputArguments)) {
    const position: unknown = skillInputArguments[inputName];
    if (typeof position !== "number" || !Number.isSafeInteger(position) || position < 1 || position > COMMAND_MAX_ARGUMENTS) {
      throw new CommandCatalogError("malformed", `command has an invalid positional argument for declared skill input ${inputName}`);
    }
    const value = args[position - 1];
    if (value === undefined) throw new CommandCatalogError("malformed", `command requires argument $${position} for declared skill input ${inputName}`);
    if (Buffer.byteLength(value, "utf8") > SKILL_MAX_INPUT_BYTES) throw new CommandCatalogError("descriptor_bound", `command argument for skill input ${inputName} exceeds the skill input bound`);
    skillInputs[inputName] = value;
  }
  const inputs = Object.freeze(skillInputs);
  const skillInputsHash = Object.keys(inputs).length === 0 ? null : `sha256:${createHash("sha256").update(canonicalInputJson(inputs)).digest("hex")}`;
  const invocationId = `command:${command.name}:${command.descriptor_hash.slice(0, 16)}`;
  const admission = hookBus?.lifecycleSessionStart({ session_id: invocationId, campaign_id: invocationId, node_id: "command" });
  if (admission !== undefined && !admission.allowed) throw new CommandCatalogError("command_escalation", admission.reason);
  const all = args.join(" ");
  const rendered = command.prompt.replace(/\$ARGUMENTS\b/g, all).replace(/\$(\d+)\b/g, (_match, index: string) => args[Number(index) - 1] ?? "");
  hookBus?.lifecycleObserve("plan_confirm", { session_id: invocationId, campaign_id: invocationId, node_id: "command" });
  const roleTools = new Set(NATIVE_ROLE_PROFILES[command.execution_role].tool_policy.allowed_tools);
  return Object.freeze({ command, rendered_prompt: rendered, effective_tools: Object.freeze(command.allowed_tools.filter((tool) => roleTools.has(tool))), skill_inputs: inputs, skill_inputs_hash: skillInputsHash });
}

export function commandPaletteActions(commands: readonly UserCommand[]): readonly Readonly<{ id: string; title: string; description: string; source: "command"; bindings: readonly never[] }>[] {
  return Object.freeze(commands.map((command) => Object.freeze({ id: `user-command:${command.name}`, title: `/${command.name}`, description: command.description, source: "command" as const, bindings: Object.freeze([]) })));
}

function parseCommandMarkdown(text: string): { frontmatter: ReadonlyMap<string, string>; body: string } {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines[0] !== "---") throw new CommandCatalogError("malformed", "command requires frontmatter");
  const end = lines.indexOf("---", 1);
  if (end < 2 || end > 32) throw new CommandCatalogError("malformed", "command frontmatter is missing or oversized");
  const result = new Map<string, string>();
  for (const line of lines.slice(1, end)) {
    const match = /^([a-z_]+):\s*(.*?)\s*$/.exec(line);
    if (!match || result.has(match[1]!)) throw new CommandCatalogError("malformed", "command frontmatter is invalid");
    result.set(match[1]!, unquote(match[2]!));
  }
  const keys = [...result.keys()];
  if (keys.some((key) => !["description", "allowed_tools", "execution_role", "argument_hint", "skill_id", "skill_version", "skill_input_arguments"].includes(key))) throw new CommandCatalogError("malformed", "command frontmatter contains an unknown field");
  return { frontmatter: result, body: lines.slice(end + 1).join("\n") };
}
function unquote(value: string): string { return value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) ? value.slice(1, -1) : value; }
function field(map: ReadonlyMap<string, string>, key: string): string { const value = map.get(key); if (value === undefined || !value.trim()) throw new CommandCatalogError("malformed", `command ${key} is required`); return value.trim(); }
function boundedField(map: ReadonlyMap<string, string>, key: string, max: number): string { const value = field(map, key); if (Buffer.byteLength(value, "utf8") > max) throw new CommandCatalogError("descriptor_bound", `command ${key} is oversized`); return redactNativeText(value); }
function optionalField(map: ReadonlyMap<string, string>, key: string, max: number): string | null { const value = map.get(key)?.trim(); if (!value) return null; if (Buffer.byteLength(value, "utf8") > max) throw new CommandCatalogError("descriptor_bound", `command ${key} is oversized`); return redactNativeText(value); }
function optionalIdentifier(map: ReadonlyMap<string, string>, key: string): string | null { const value = map.get(key)?.trim(); if (!value) return null; if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(value)) throw new CommandCatalogError("malformed", `command ${key} is invalid`); return value; }
function optionalSemver(map: ReadonlyMap<string, string>, key: string): string | null { const value = map.get(key)?.trim(); if (!value) return null; if (value.length > 128 || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(value)) throw new CommandCatalogError("malformed", `command ${key} must be exact SemVer`); return value; }
function parseSkillInputArguments(value: string | undefined): Readonly<Record<string, number>> {
  if (!value?.trim()) return Object.freeze({});
  const result: Record<string, number> = {};
  if (value.split(",").length > SKILL_MAX_INPUTS) throw new CommandCatalogError("descriptor_bound", "skill_input_arguments exceeds the descriptor input limit");
  for (const item of value.split(",")) {
    const match = /^([a-z][a-z0-9_]{0,31})=\$(?:([1-9]|[1-2]\d|3[0-2]))$/.exec(item.trim());
    if (!match || Object.hasOwn(result, match[1]!)) throw new CommandCatalogError("malformed", "skill_input_arguments must map unique input names to $1 through $32");
    result[match[1]!] = Number(match[2]);
  }
  if (new Set(Object.values(result)).size !== Object.keys(result).length) throw new CommandCatalogError("malformed", "skill_input_arguments cannot reuse a positional argument");
  return Object.freeze(result);
}
function canonicalInputJson(value: Readonly<Record<string, string>>): string { return JSON.stringify(Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)))); }
function listField(map: ReadonlyMap<string, string>, key: string): string[] { const raw = field(map, key); const inner = raw.startsWith("[") && raw.endsWith("]") ? raw.slice(1, -1) : raw; const values = inner ? inner.split(",").map((item) => unquote(item.trim())).filter(Boolean) : []; if (values.length > 64 || new Set(values).size !== values.length || values.some((item) => Buffer.byteLength(item) > 128)) throw new CommandCatalogError("malformed", `command ${key} is invalid`); return values; }
