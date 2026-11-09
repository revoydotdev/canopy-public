#!/usr/bin/env node
/**
 * scripts/stop-guard-debt.mjs — the only writer of `scripts/stop-guard/debt.json`
 * (Arboretum M2, owned baseline debt).
 *
 * Usage:
 *   bun scripts/stop-guard-debt.mjs open <gate> --owner ADR-NNN --reason "..."
 *   bun scripts/stop-guard-debt.mjs close <gate>
 *   bun scripts/stop-guard-debt.mjs list [--json]
 *
 * WHAT A DEBT ENTRY MEANS. The native stop battery
 * (`packages/arbor-mcp/src/hooks/stop-battery-scope.ts`) attributes a blocking
 * red on a gate listed here to the baseline rather than to the session, and
 * does not refuse a turn on it. That is a real relaxation, so an entry is not
 * something anyone can assert:
 *
 *   - the tree must be CLEAN, so the red belongs to the committed revision and
 *     not to work in progress;
 *   - the gate is RUN, here, and must exit non-zero — a gate that is green at
 *     HEAD has no debt to own, and the observed exit code is recorded;
 *   - the owner must name a decision record that exists in `decisions/`, so
 *     every relaxation points at the record that is accountable for it.
 *
 * The entry then lands as an ordinary governed commit under `scripts/`, which
 * is where a reviewer sees it. `close` needs none of this: removing a
 * relaxation can only make the battery stricter.
 *
 * The same validation rules are applied on the read side by
 * `loadBaselineDebt` in TypeScript; `stop-battery-scope.test.ts` loads a file
 * this script wrote, so the two cannot drift apart silently.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO = resolvePath(__dirname, "..");

export const DEBT_RELATIVE_PATH = join("scripts", "stop-guard", "debt.json");
export const DEBT_KIND = "revoy2.stop_baseline_debt";
const OWNER_RE = /^ADR-(?:\d{3,}|PENDING-[a-z0-9][a-z0-9-]*)$/;
const DEFAULT_GATE_TIMEOUT_MS = 300_000;

const EMPTY_RECORD = Object.freeze({
  schema_version: 1,
  kind: DEBT_KIND,
  _doc: "Arboretum M2. A blocking stop-tier gate listed here was observed red at opened_at_revision on a clean tree and is owned by the named decision record; the native stop battery attributes its red to the baseline and does not refuse a turn on it. Written only by `bun scripts/stop-guard-debt.mjs open|close`. The battery never writes this file.",
  entries: [],
});

export class DebtRefusal extends Error {}

/** Whether `owner` names an existing decision record; the read side applies the same rule. */
export function debtOwnerExists(repo, owner) {
  if (typeof owner !== "string" || !OWNER_RE.test(owner)) return false;
  try {
    return readdirSync(join(repo, "decisions")).some((name) => owner.startsWith("ADR-PENDING-") ? name === `${owner}.md` : name.startsWith(`${owner}-`) && name.endsWith(".md"));
  } catch { return false; }
}

export function readDebtRecord(repo) {
  let raw;
  try { raw = readFileSync(join(repo, DEBT_RELATIVE_PATH), "utf8"); }
  catch { return { ...EMPTY_RECORD, entries: [] }; }
  const parsed = JSON.parse(raw);
  if (parsed?.schema_version !== 1 || parsed?.kind !== DEBT_KIND || !Array.isArray(parsed?.entries)) {
    throw new DebtRefusal(`${DEBT_RELATIVE_PATH} is malformed; refusing to rewrite it`);
  }
  return parsed;
}

function writeDebtRecord(repo, record) {
  const path = join(repo, DEBT_RELATIVE_PATH);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
}

const git = (repo, args) => spawnSync("git", args, { cwd: repo, encoding: "utf8" });

/**
 * Open one debt entry, after witnessing the red. Every refusal throws
 * `DebtRefusal` with the reason; nothing is written unless all checks pass.
 * `runGate` is injectable so a test can observe that the gate was actually run.
 */
export function openDebt({ repo = DEFAULT_REPO, gate, owner, reason, now = new Date(), runGate = defaultRunGate } = {}) {
  if (typeof gate !== "string" || !gate.startsWith("gate:")) throw new DebtRefusal("open needs a gate:* name");
  const scripts = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")).scripts ?? {};
  if (!(gate in scripts)) throw new DebtRefusal(`${gate} is not declared in package.json`);
  if (!debtOwnerExists(repo, owner)) throw new DebtRefusal(`--owner ${String(owner)} does not name an existing decisions/ADR-* record`);
  if (typeof reason !== "string" || reason.trim() === "") throw new DebtRefusal("--reason is required and must say why the red is not this session's to fix");
  const status = git(repo, ["status", "--porcelain", "--untracked-files=all"]);
  if (status.status !== 0) throw new DebtRefusal("git status failed; cannot prove the tree is clean");
  if (status.stdout.trim() !== "") throw new DebtRefusal("the working tree is dirty; debt is owned against a committed revision, so commit or stash first");
  const head = git(repo, ["rev-parse", "HEAD"]);
  if (head.status !== 0) throw new DebtRefusal("HEAD does not resolve");
  const record = readDebtRecord(repo);
  if (record.entries.some((entry) => entry?.gate === gate)) throw new DebtRefusal(`${gate} already has an open debt entry; close it first to re-open`);
  const exitCode = runGate(repo, gate);
  if (exitCode === 0) throw new DebtRefusal(`${gate} is green at HEAD; there is no red to own`);
  if (exitCode === null) throw new DebtRefusal(`${gate} could not be run to completion, so its red was not witnessed`);
  const entry = {
    gate,
    owner,
    reason: reason.trim(),
    opened_at: now.toISOString(),
    opened_at_revision: head.stdout.trim(),
    observed_exit_code: exitCode,
  };
  writeDebtRecord(repo, { ...record, entries: [...record.entries, entry].sort((a, b) => String(a.gate).localeCompare(String(b.gate))) });
  return entry;
}

export function closeDebt({ repo = DEFAULT_REPO, gate } = {}) {
  const record = readDebtRecord(repo);
  const remaining = record.entries.filter((entry) => entry?.gate !== gate);
  if (remaining.length === record.entries.length) throw new DebtRefusal(`${String(gate)} has no open debt entry`);
  writeDebtRecord(repo, { ...record, entries: remaining });
  return remaining.length;
}

function defaultRunGate(repo, gate) {
  const result = spawnSync("bun", ["run", gate], { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: DEFAULT_GATE_TIMEOUT_MS });
  if (result.error || result.status === null) return null;
  return result.status;
}

function argValue(argv, flag) {
  const index = argv.indexOf(flag);
  return index >= 0 && index + 1 < argv.length ? argv[index + 1] : null;
}

function main(argv = process.argv.slice(2)) {
  const repo = resolvePath(argValue(argv, "--repo") ?? DEFAULT_REPO);
  const [command, gate] = argv;
  try {
    if (command === "open") {
      const entry = openDebt({ repo, gate, owner: argValue(argv, "--owner"), reason: argValue(argv, "--reason") });
      console.log(`stop-guard-debt: opened ${entry.gate} (exit ${entry.observed_exit_code} at ${entry.opened_at_revision.slice(0, 8)}), owned by ${entry.owner}. Commit ${DEBT_RELATIVE_PATH} under that record's ADR trailer.`);
      return 0;
    }
    if (command === "close") {
      const remaining = closeDebt({ repo, gate });
      console.log(`stop-guard-debt: closed ${gate}; ${remaining} entr${remaining === 1 ? "y" : "ies"} remain.`);
      return 0;
    }
    if (command === "list") {
      const record = readDebtRecord(repo);
      if (argv.includes("--json")) console.log(JSON.stringify(record.entries, null, 2));
      else if (record.entries.length === 0) console.log("stop-guard-debt: no open baseline debt.");
      else for (const entry of record.entries) console.log(`${entry.gate}\t${entry.owner}\t${String(entry.opened_at_revision).slice(0, 8)}\t${entry.reason}`);
      return 0;
    }
    console.error("usage: stop-guard-debt.mjs open <gate> --owner ADR-NNN --reason \"...\" | close <gate> | list [--json]");
    return 2;
  } catch (error) {
    if (error instanceof DebtRefusal) {
      console.error(`stop-guard-debt: refused — ${error.message}`);
      return 1;
    }
    throw error;
  }
}

if (process.argv[1] && resolvePath(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
