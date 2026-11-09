/**
 * ADR-111 decision 1: loads the hook handler functions a `T4`-admitted
 * plugin exports, so a `HookDescriptor.handler_ref` can resolve to
 * operator-authored code instead of only a `handlers.ts` built-in.
 *
 * This is the single place in the codebase that dynamically loads code from
 * a plugin's own root, and it does so synchronously and in-process — the
 * governed hook bus (`hooks/bus.ts`) dispatches every handler synchronously
 * under a measured wall-clock bound, so a plugin-backed handler must fit
 * that same contract rather than the async, sandboxed-subprocess model
 * `InstallableIntegrationSdk` uses for its own MCP adapters. What this
 * module does NOT do is grant a loaded function any new decision power: the
 * bus's `isVetoDecision`/`observeNote` runtime shape checks apply to a
 * plugin-backed handler's return value exactly as they do to a built-in
 * one, so a plugin export can still only ever produce `{ allow: true }` or
 * `{ allow: false; reason }` from a veto-shaped call site.
 *
 * Only `PluginRegistry.syncComponents` calls `loadPluginHookHandlers`, and
 * only after `validateTierAuthority` has already confirmed the owning
 * plugin declared `capabilities.code_execution: true` (which restricts it
 * to `T4`) — this module trusts that gate rather than re-deriving it, but
 * still refuses a caller that skips it (`requireCodeExecution`).
 */
import { createRequire } from "node:module";
import { existsSync, statSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import type { HookHandlerRegistry } from "../hooks/contracts.js";

const HOOK_HANDLER_MODULE_MAX_BYTES = 128 * 1024;
const HOOK_HANDLER_MAX_MODULES = 16;
const HOOK_HANDLER_MAX_EXPORTS_PER_MODULE = 32;

const require_ = createRequire(import.meta.url);

/**
 * Loads every named function export from each declared `.cjs` module under
 * `root`, and returns them as self-attributed `"plugin"` `HookHandlerEntry`
 * values keyed `plugin:<pluginId>:<exportName>` — ready to hand to
 * `HookCatalog.addPluginHandlers`.
 */
export function loadPluginHookHandlers(root: string, pluginId: string, modulePaths: readonly string[]): HookHandlerRegistry {
  if (modulePaths.length === 0) return Object.freeze({});
  if (modulePaths.length > HOOK_HANDLER_MAX_MODULES) throw new Error(`plugin declares more than ${HOOK_HANDLER_MAX_MODULES} hook_handlers modules`);
  const resolvedRoot = resolve(root);
  const entries: Record<string, HookHandlerRegistry[string]> = {};
  for (const modulePath of modulePaths) {
    const absolute = contained(resolvedRoot, modulePath);
    const stats = statSync(absolute);
    if (!stats.isFile() || stats.size === 0 || stats.size > HOOK_HANDLER_MODULE_MAX_BYTES) throw new Error(`plugin hook_handlers module '${modulePath}' is empty or oversized`);
    delete require_.cache[require_.resolve(absolute)];
    const loaded = require_(absolute) as unknown;
    if (typeof loaded !== "object" || loaded === null) throw new Error(`plugin hook_handlers module '${modulePath}' must export an object of named functions`);
    const exportNames = Object.keys(loaded as Record<string, unknown>).filter((name) => typeof (loaded as Record<string, unknown>)[name] === "function");
    if (exportNames.length === 0) throw new Error(`plugin hook_handlers module '${modulePath}' exports no functions`);
    if (exportNames.length > HOOK_HANDLER_MAX_EXPORTS_PER_MODULE) throw new Error(`plugin hook_handlers module '${modulePath}' exports more than ${HOOK_HANDLER_MAX_EXPORTS_PER_MODULE} functions`);
    for (const exportName of exportNames) {
      const key = `plugin:${pluginId}:${exportName}`;
      if (Object.prototype.hasOwnProperty.call(entries, key)) throw new Error(`plugin hook export '${exportName}' is declared by more than one hook_handlers module`);
      const fn = (loaded as Record<string, (context: unknown) => unknown>)[exportName]!;
      entries[key] = Object.freeze({ kind: "plugin" as const, plugin_id: pluginId, export_name: exportName, handler: (context: unknown) => fn(context) });
    }
  }
  return Object.freeze(entries);
}

function contained(root: string, modulePath: string): string {
  if (!modulePath.endsWith(".cjs") || modulePath.startsWith("/") || modulePath.includes("\\")) throw new Error(`plugin hook_handlers module path '${modulePath}' is unsafe`);
  const absolute = resolve(root, modulePath);
  const rel = relative(root, absolute);
  if (rel === ".." || rel.startsWith(`..${sep}`) || rel.split(sep).some((part) => part === "." || part === "..")) throw new Error(`plugin hook_handlers module '${modulePath}' escapes its plugin root`);
  if (!existsSync(absolute)) throw new Error(`plugin hook_handlers module '${modulePath}' does not exist`);
  return absolute;
}
