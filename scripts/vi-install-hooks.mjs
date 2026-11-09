#!/usr/bin/env node
/**
 * scripts/vi-install-hooks.mjs — register the vendored VI hooks for this repo.
 *
 * The hooks (a freshness report at session start, a graph-debt report at stop)
 * are what make staleness *visible at the moment it matters* rather than at the
 * next CI run. They shipped with the vendored skill; this registers them in
 * project-scoped settings so a clone gets them without anyone installing a
 * global skill. Dirty-tracking is NOT here: it is the native observe handler
 * `observe.vi-dirty-tracker` (hooks/vi-dirty-tracker.ts), because it is the
 * SOLE writer of `.visual-intelligence/.dirty` and had to be provably still
 * writing, not merely present.
 *
 * OPT-IN, deliberately. These run shell on session start and around tool use.
 * Writing that into a shared settings file as a side effect of `bun install`
 * would be a surprising execution change for anyone who clones this
 * repository, so it takes a command and says what it did. Same reasoning, and
 * the same shape, as `bun run install-hooks` for the git pre-push hook.
 *
 * DOUBLE-FIRING. If the upstream skill is also registered in `~/.claude/
 * settings.json`, both copies fire and every hook runs twice. Detected and
 * reported here rather than left to be discovered as duplicated output.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(join(dirname(fileURLToPath(import.meta.url)), ".."));
const SETTINGS = join(REPO_ROOT, ".claude/settings.json");
const VI_HOOK_DIR = ".claude/skills/repository-visual-intelligence/hooks";
const CLAIM_HOOK_DIR = ".claim-ledger";
const WRAPPER = ".hook-liveness/wrap.sh";
const LIVENESS_LOG = ".hook-liveness/invocations.jsonl";
const LIVENESS_MANIFEST = ".hook-liveness/hook-manifest.json";

/**
 * hook script -> expect_variability, read from the liveness manifest so the
 * declaration lives in exactly one place. A hook absent from the manifest gets
 * `conditional`, the cheaper and more conservative default: record only when the
 * hook actually decided something.
 */
function hookVariability() {
  const map = new Map();
  const path = join(REPO_ROOT, LIVENESS_MANIFEST);
  if (!existsSync(path)) return map;
  try {
    for (const entry of JSON.parse(readFileSync(path, "utf8")).hooks ?? []) {
      if (entry?.hook_id) map.set(entry.hook_id, entry.expect_variability ?? "conditional");
    }
  } catch { /* a malformed manifest degrades to the safe default, never blocks install */ }
  return map;
}

/** Directories the drift check owns. A `.sh` in any of these must be declared. */
const OWNED_HOOK_DIRS = [VI_HOOK_DIR, CLAIM_HOOK_DIR];

/**
 * event -> hook script. Kept in the shape Claude Code's settings expect.
 *
 * `dir` is per-entry because this repository now has hooks from more than one
 * concern, and the drift check below verifies EVERY declared directory against
 * this manifest. A single hardcoded directory is what let `vi-graph-debt.sh`
 * sit vendored and unregistered.
 */
// `vi-freshness.sh` and `vi-graph-debt.sh` were both removed from this list
// when they were devolved: the SessionStart report is the native
// `inject.vi-freshness` handler behind the `session-graph-freshness`
// descriptor, and the per-turn debt report is the native `observe.vi-graph-debt`
// handler behind the `vi-graph-debt` descriptor. Neither has a `.sh` to check
// for existence any more, and the drift check below walks the same directory,
// so leaving a row here would fail the installer on a file that is gone on
// purpose.
const HOOKS = [];

function main() {
  for (const hook of HOOKS) {
    const file = join(REPO_ROOT, hook.dir, hook.script);
    if (!existsSync(file)) {
      console.error(`vi-install-hooks — FAILED: missing ${hook.dir}/${hook.script}. Restore it with \`git checkout -- ${hook.dir}\`.`);
      return 1;
    }
  }

  // DRIFT CHECK — the list above is a hand-maintained manifest of a directory
  // that changes as the skill does. Nothing previously compared the
  // two, and they had already diverged: `vi-graph-debt.sh` shipped with the
  // vendored skill and was never registered, so the Stop hook simply did not
  // exist for anyone who installed via this script. That is the failure mode
  // this whole line of work exists to remove — a step that leaves no checkable
  // trace — and it was sitting in the installer for the hooks that detect it.
  //
  // Fail loudly rather than silently under-registering. A new vendored hook is
  // a deliberate decision to make, not something to discover months later.
  const unregistered = [];
  for (const dir of OWNED_HOOK_DIRS) {
    const abs = join(REPO_ROOT, dir);
    if (!existsSync(abs)) continue;
    const registered = new Set(HOOKS.filter((h) => h.dir === dir).map((h) => h.script));
    for (const name of readdirSync(abs).filter((n) => n.endsWith(".sh")).sort()) {
      // The liveness wrapper is infrastructure that wraps hooks; it is not
      // itself a hook and is never registered against an event.
      if (dir === CLAIM_HOOK_DIR && name === "wrap.sh") continue;
      if (!registered.has(name)) unregistered.push(`${dir}/${name}`);
    }
  }
  if (unregistered.length > 0) {
    console.error(
      `vi-install-hooks — FAILED: ${unregistered.length} hook script(s) exist on disk but are not in this\n` +
      `  installer's HOOKS manifest, so they would never be registered:\n` +
      unregistered.map((name) => `    ${name}`).join("\n") + "\n\n" +
      `  Add each to HOOKS with its dir, event and a one-line 'why', or delete it. Silently\n` +
      `  ignoring it is how the Stop hook went unregistered for the life of this installer.`,
    );
    return 1;
  }

  const settings = existsSync(SETTINGS) ? JSON.parse(readFileSync(SETTINGS, "utf8")) : {};
  settings.hooks ??= {};

  // Register through the liveness wrapper rather than pointing at the hook
  // directly. The wrapper records that the hook fired and what it decided, so
  // `bun run gate:hook-liveness` can answer "has this hook's verdict stopped
  // varying" — the question nothing could answer while a SessionStart hook
  // reported the same false verdict for ~42 consecutive sessions.
  //
  // The instrumentation lives in the REGISTRATION rather than in the hooks.
  // That was forced while the hooks were treated as vendored (ADR-031); since
  // ADR-176 they are first-party and editable, and the wrapper stays because it
  // is still correct and keeps the hooks free of liveness plumbing.
  //
  // The wrapper is byte-transparent and fails open — if it is missing, fall back
  // to registering the hook directly rather than losing the hook entirely.
  // `--mode` and `--log` are resolved HERE, at registration, and baked into the
  // command. The wrapper runs on every tool use, so anything it must discover at
  // runtime (parsing stdin for `.cwd`, reading the manifest) is a tax on every
  // edit in the repository — measured at ~20ms against a ~5-7ms hook. Passing
  // them in costs nothing.
  const wrapper = join(REPO_ROOT, WRAPPER);
  const wrapped = existsSync(wrapper);
  const variability = hookVariability();
  for (const hook of HOOKS) {
    const target = `$CLAUDE_PROJECT_DIR/${hook.dir}/${hook.script}`;
    const mode = variability.get(hook.script) ?? "conditional";
    const command = wrapped
      ? `$CLAUDE_PROJECT_DIR/${WRAPPER} --mode ${mode} --log $CLAUDE_PROJECT_DIR/${LIVENESS_LOG} ${target}`
      : target;
    const existing = settings.hooks[hook.event] ?? [];
    const already = JSON.stringify(existing).includes(hook.script);
    if (already) continue;
    existing.push({ hooks: [{ type: "command", command }] });
    settings.hooks[hook.event] = existing;
  }

  mkdirSync(dirname(SETTINGS), { recursive: true });
  writeFileSync(SETTINGS, `${JSON.stringify(settings, null, 2)}\n`);

  console.log(`vi-install-hooks — registered ${HOOKS.length} hook(s) in .claude/settings.json`);
  for (const hook of HOOKS) console.log(`  ${hook.event.padEnd(12)} ${hook.script} — ${hook.why}`);

  const globalSettings = join(process.env.HOME ?? "", ".claude/settings.json");
  if (existsSync(globalSettings)) {
    const text = readFileSync(globalSettings, "utf8");
    const duplicated = HOOKS.filter((hook) => text.includes(hook.script)).map((hook) => hook.script);
    if (duplicated.length > 0) {
      console.log("");
      console.log(`  NOTE — ${duplicated.length} of these are ALSO registered in ~/.claude/settings.json:`);
      for (const name of duplicated) console.log(`    ${name}`);
      console.log("  Both copies will fire, so each hook runs twice. Remove the global registration");
      console.log("  if you want this repository's vendored copy to be the only one.");
    }
  }
  return 0;
}

process.exit(main());
