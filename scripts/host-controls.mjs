#!/usr/bin/env node
/**
 * Reconcile repo-owned lifecycle hook adapters into host configuration.
 *
 * The manifest describes registrations only. Governance policy and decisions
 * remain in checked-in Canopy/repository source; Claude Code and Codex are
 * optional launch adapters. Unknown host configuration is preserved.
 *
 * Usage:
 *   bun scripts/host-controls.mjs check
 *   bun scripts/host-controls.mjs reconcile
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST_PATH = join(ROOT, "scripts/host-controls.json");
const MARKER_PREFIX = "# revoy2-hook:";

function loadManifest() {
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.adapters)) {
    throw new Error("unsupported scripts/host-controls.json schema");
  }
  const hosts = new Set();
  for (const adapter of manifest.adapters) {
    if (!adapter.host || !adapter.configPath || !Array.isArray(adapter.events)) {
      throw new Error("each host adapter needs host, configPath, and events");
    }
    if (hosts.has(adapter.host)) throw new Error(`duplicate host adapter ${adapter.host}`);
    hosts.add(adapter.host);
    const ids = new Set();
    for (const event of adapter.events) {
      if (!event.event || !Array.isArray(event.groups)) throw new Error(`${adapter.host}: malformed event`);
      for (const group of event.groups) {
        if (!Array.isArray(group.hooks)) throw new Error(`${adapter.host}/${event.event}: malformed group`);
        for (const hook of group.hooks) {
          if (!/^[a-z0-9][a-z0-9._-]*$/.test(hook.id ?? "")) throw new Error(`invalid hook id ${hook.id}`);
          if (ids.has(hook.id)) throw new Error(`duplicate hook id ${hook.id}`);
          ids.add(hook.id);
          if (typeof hook.command !== "string" || hook.command.includes(MARKER_PREFIX)) {
            throw new Error(`${hook.id}: command must be an unmarked string`);
          }
        }
      }
    }
  }
  return manifest;
}

function expectedHook(hook) {
  return {
    type: "command",
    command: `${hook.command} ${MARKER_PREFIX}${hook.id}`,
    ...(hook.options ?? {}),
  };
}

function markerId(command) {
  if (typeof command !== "string") return null;
  const match = command.match(/\s+# revoy2-hook:([a-z0-9][a-z0-9._-]*)\s*$/);
  return match?.[1] ?? null;
}

function configuredHookId(command, commandToId) {
  return markerId(command) ?? commandToId.get(command) ?? null;
}

function flattenAdapter(adapter) {
  const registrations = new Map();
  const commandToId = new Map();
  for (const event of adapter.events) {
    for (const group of event.groups) {
      for (const hook of group.hooks) {
        registrations.set(hook.id, { event: event.event, hook });
        commandToId.set(hook.command, hook.id);
      }
    }
  }
  return { registrations, commandToId };
}

/**
 * Find explicit repository script paths in a command without evaluating it.
 * The allowlist is intentionally narrow: absolute host executables such as
 * `bun` and shell built-ins remain host concerns, while paths under repo-owned
 * source roots must exist before either reconciliation or checking succeeds.
 */
function missingSourcePaths(adapter) {
  const roots = new Set(["scripts", ".claude", ".claim-ledger", ".hook-liveness"]);
  const missing = new Set();
  const sourcePathPattern = /(?:\$CLAUDE_PROJECT_DIR\/)?((?:scripts|\.claude|\.claim-ledger|\.hook-liveness)\/[A-Za-z0-9_./-]+\.(?:sh|mjs|js|cjs|ts|py))\b/g;

  for (const event of adapter.events) {
    for (const group of event.groups) {
      for (const hook of group.hooks) {
        for (const match of hook.command.matchAll(sourcePathPattern)) {
          const relativePath = match[1];
          const root = relativePath.split("/")[0];
          if (!roots.has(root)) continue;
          const absolutePath = resolve(ROOT, relativePath);
          const fromRoot = absolutePath.slice(ROOT.length + 1);
          if (fromRoot.startsWith("../") || fromRoot === ".." || !existsSync(absolutePath)) {
            missing.add(`${hook.id}: ${relativePath}`);
          }
        }
      }
    }
  }
  return [...missing].sort();
}

function readConfig(adapter) {
  const path = join(ROOT, adapter.configPath);
  if (!existsSync(path)) return { path, config: {} };
  const config = JSON.parse(readFileSync(path, "utf8"));
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error(`${adapter.configPath} must contain a JSON object`);
  }
  return { path, config };
}

function configuredGroups(config, eventName) {
  const groups = config.hooks?.[eventName];
  if (groups === undefined) return [];
  if (!Array.isArray(groups)) throw new Error(`hooks.${eventName} must be an array`);
  return groups;
}

function inspectAdapter(adapter) {
  const { config } = readConfig(adapter);
  const { registrations, commandToId } = flattenAdapter(adapter);
  const found = new Map();
  const problems = [];
  const observedOrder = new Map();

  for (const [id, expected] of registrations) found.set(id, []);
  for (const [eventName, groups] of Object.entries(config.hooks ?? {})) {
    if (!Array.isArray(groups)) {
      problems.push(`${adapter.host}: hooks.${eventName} is not an array`);
      continue;
    }
    observedOrder.set(eventName, []);
    for (const group of groups) {
      for (const actual of group?.hooks ?? []) {
        const id = configuredHookId(actual.command, commandToId);
        if (!id) continue;
        const declared = registrations.get(id);
        if (!declared) {
          problems.push(`${adapter.host}: stale managed registration ${id} under ${eventName}`);
          continue;
        }
        const list = found.get(id);
        list.push({ eventName, actual });
        observedOrder.get(eventName).push(id);
        const expectedHookRecord = expectedHook(declared.hook);
        const groupOptions = Object.fromEntries(Object.entries(group ?? {}).filter(([key]) => key !== "hooks"));
        if (eventName !== declared.event || stableStringify(actual) !== stableStringify(expectedHookRecord) || Object.keys(groupOptions).length > 0) {
          problems.push(`${adapter.host}: registration ${id} is modified or registered under the wrong event`);
        }
      }
    }
  }

  for (const [id, entries] of found) {
    if (entries.length === 0) problems.push(`${adapter.host}: missing registration ${id}`);
    else if (entries.length > 1) problems.push(`${adapter.host}: duplicate registration ${id} (${entries.length})`);
  }
  for (const event of adapter.events) {
    const expectedOrder = event.groups.flatMap((group) => group.hooks.map((hook) => hook.id));
    const actualOrder = observedOrder.get(event.event) ?? [];
    if (stableStringify(actualOrder) !== stableStringify(expectedOrder)) {
      problems.push(`${adapter.host}: managed registration order differs under ${event.event}`);
    }
  }
  return problems;
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function reconcileAdapter(adapter) {
  const { path, config } = readConfig(adapter);
  const { registrations, commandToId } = flattenAdapter(adapter);
  config.hooks ??= {};

  // Remove only registrations recognized by stable marker or exact legacy
  // command. Mixed groups retain their foreign hook records and group options.
  for (const [eventName, groups] of Object.entries(config.hooks)) {
    if (!Array.isArray(groups)) throw new Error(`${adapter.configPath}: hooks.${eventName} must be an array`);
    const retainedGroups = [];
    for (const group of groups) {
      const hooks = Array.isArray(group?.hooks) ? group.hooks : null;
      if (!hooks) {
        retainedGroups.push(group);
        continue;
      }
      const retainedHooks = hooks.filter((hook) => {
        const id = configuredHookId(hook?.command, commandToId);
        return id === null;
      });
      if (retainedHooks.length > 0) retainedGroups.push({ ...group, hooks: retainedHooks });
    }
    if (retainedGroups.length > 0) config.hooks[eventName] = retainedGroups;
    else delete config.hooks[eventName];
  }

  for (const event of adapter.events) {
    const groups = config.hooks[event.event] ?? [];
    for (const group of event.groups) {
      groups.push({ hooks: group.hooks.map(expectedHook) });
    }
    config.hooks[event.event] = groups;
  }

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
}

function main(args) {
  const command = args[0];
  if (command !== "check" && command !== "reconcile") {
    console.error("usage: bun scripts/host-controls.mjs <check|reconcile>");
    return 2;
  }
  const manifest = loadManifest();
  const missingSources = manifest.adapters.flatMap((adapter) => missingSourcePaths(adapter).map((path) => `${adapter.host}: missing repository source ${path}`));
  if (missingSources.length > 0) {
    for (const problem of missingSources) console.error(`host-controls: ${problem}`);
    return 1;
  }
  if (command === "reconcile") {
    for (const adapter of manifest.adapters) reconcileAdapter(adapter);
    console.log(`host-controls: reconciled ${manifest.adapters.length} host adapter(s) from scripts/host-controls.json`);
    return 0;
  }

  const problems = manifest.adapters.flatMap(inspectAdapter);
  if (problems.length > 0) {
    for (const problem of problems) console.error(`host-controls: ${problem}`);
    return 1;
  }
  console.log(`host-controls: ${manifest.adapters.length} host adapter(s) match scripts/host-controls.json`);
  return 0;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  console.error(`host-controls: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
