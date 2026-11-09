#!/usr/bin/env node
/**
 * scripts/store-freshness-gate.mjs — do committed stores describe these bytes?
 *
 *   bun scripts/store-freshness-gate.mjs [--json]
 *
 * THE PROBLEM THIS EXISTS FOR. Four subsystems now commit a generated store:
 *
 *   .claim-ledger/          bun run claims:refresh
 *   .determinism-baseline/  captest bun run determinism:refresh
 *   .completion-depth/      bun run completion-depth:refresh
 *
 * A manual producer with no staleness signal is a store that quietly stops being
 * true. Nobody notices, because a stale store still parses, still passes its own
 * gate, and still looks like evidence. `.visual-intelligence/` already lived
 * through exactly this: it sat 37 commits behind, built from a dirty tree,
 * declaring entry-point roots from a file that had never existed — and the only
 * reason it was ever caught is that someone went looking. `gate:vi-freshness`
 * was written afterwards to bound that, and this gate is the same instrument
 * pointed at the stores that did not have one. Routine evidence closure
 * refreshes the three automatic stores; determinism remains manual (ADR-034).
 *
 * WHY DISTANCE AND NOT EQUALITY. Regenerating to compare would mean running the
 * producers, and two of the three are expensive by design — the determinism
 * baseline deliberately never runs in CI (ADR-034), because a flake rate
 * measured on a shared runner measures the runner. So this measures how far each
 * store trails HEAD using only git and each manifest, which runs anywhere in
 * ~100ms. It is the weaker check, and it says so.
 *
 * BUDGETS, NOT ZERO. Each store has one writer and legitimately trails by
 * however many commits land between refreshes. The budget is per-store because
 * the cost of refreshing differs by an order of magnitude: re-deriving the claim
 * ledger is seconds, re-measuring the determinism baseline is minutes.
 *
 * WHAT IT REFUSES TO ACCEPT AS PASSING:
 *   - a manifest whose revision is not a commit in this repository
 *   - a manifest whose revision is not an ancestor of HEAD (the store describes
 *     a tree not in this history — distance is undefined, not zero)
 *   - distance above the store's budget
 *   - a store directory that exists with no manifest at all (it cannot be aged,
 *     so it cannot be trusted; an unmeasurable store is a gap, not a pass)
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { CLAIM_LEDGER_BUDGET_COMMITS } from "./lib/store-budgets.mjs";
import {
  assessEvidenceProvenance,
  computeEvidenceContentHash,
  computeEvidenceContentHashForStore,
  hasRegenerationMarker,
} from "./lib/store-provenance.mjs";
import { evidenceTransactionReadStatus } from "./evidence-transaction.mjs";
import { assertGovernanceConsumerReady } from "./lib/governance-plan.mjs";

function argValue(argv, flag) {
  const index = argv.indexOf(flag);
  return index === -1 ? undefined : argv[index + 1];
}

const REPO_ROOT = resolve(argValue(process.argv, "--repo") ?? join(dirname(fileURLToPath(import.meta.url)), ".."));
const JSON_OUT = process.argv.includes("--json");

/**
 * ENFORCEMENT_CLASS — what actually happens when this store's OWN consuming
 * gate is wrong, independent of how stale the store is. Added because this
 * gate printed an identical flat FAIL for every store regardless of that
 * distinction: a stale `claim-ledger` silently corrupts every completeness
 * claim `gate:obligations` discharges, while a stale `completion-depth`
 * store at worst hides a finding until the next refresh. Both looked the
 * same in this gate's output. This is the one place that classification is
 * recorded as data rather than left scattered across prose comments, per
 * governance-walk item 9 (deliberately skipped when this gate was written).
 *
 * This does NOT change which stores fail the gate — see `assess()` below,
 * still driven solely by content-hash provenance (ADR-055). It is reported
 * alongside the existing verdict so a FAIL can be read for what it actually
 * puts at risk.
 *
 * Classes, and where each is sourced:
 *
 *   - "blocking" — the store's consuming gate fails the build outright when
 *     the store's DATA is wrong, with no triage/waiver escape valve.
 *       - claim-ledger: `scripts/claim-ledger.ts` resolves rule M-B, which
 *         `obligations-gate.ts` treats as blocking (see claim-ledger.ts's own
 *         comment at its M-B resolution site), and every completeness claim
 *         in ROADMAP.md/decisions/*.md is discharged through it.
 *       - determinism-baseline: ADR-034 decision point 4 names DB-B (flake
 *         ceiling) and DB-R (unmeasured cited seam) as "(blocking)" rules of
 *         `gate:determinism`. Staleness of the RECORDED baseline is itself
 *         "reported, never gated" per that same ADR (§"Measurement is a
 *         manual, operator-invoked act") — but that carve-out is about commit
 *         distance, which this gate treats as advisory already; a
 *         content-hash mismatch means the measured code has actually changed
 *         underneath a still-passing baseline, which is exactly what DB-B/
 *         DB-R exist to catch, so the store's class is blocking.
 *   - "blocking-on-untriaged" — the store's consuming gate fails the build
 *     only when a finding has no recorded human verdict; a triaged finding
 *     (however severe) does not block. This is a distinct, intentional
 *     design (see ADR-035 O4's 2026-08-19 correction below) from a bare
 *     "report-only" and from unconditional "blocking".
 *       - completion-depth: ADR-035 O4 explicitly corrects an earlier,
 *         inaccurate claim that this gate was report-only — the gate's own
 *         `mode: "blocking-on-untriaged"` field and `scripts/completion-depth.mjs`
 *         both confirm it exits non-zero on an untriaged finding past its
 *         30-day window, never on a merely-unfixed one.
 *       - vi-observed: `scripts/vi-findings.mjs` gates the observed-coverage
 *         findings this store backs with the identical triage-or-block shape
 *         (`--triage`/verdict/expiry, `gate()` exits non-zero on an untriaged
 *         violation) — the same pattern completion-depth uses, applied to a
 *         different evidence source.
 *
 * Budgets, in commits, below. Each may FALL and must not RISE — the
 * convention `MAX_COMMITS_BEHIND`, `POL_04_FLOOR` and `INDETERMINATE_FLOOR`
 * already set. Raising one to make a red build green is the drift these
 * stores exist to catch.
 */
export const ENFORCEMENT_CLASS = Object.freeze({
  "claim-ledger": "blocking",
  "determinism-baseline": "blocking",
  "completion-depth": "blocking-on-untriaged",
  "vi-observed": "blocking-on-untriaged",
});

export const STORES = [
  {
    name: "claim-ledger",
    dir: ".claim-ledger",
    manifest: ".claim-ledger/manifest.json", env: "REVOY2_CLAIM_LEDGER_DIR",
    refresh: "bun run claims:refresh",
    // Cheap to regenerate (~1s with a reused docs-truth report), and it governs
    // every completeness claim in the repository, so it should track closely.
    // Shared with the pre-commit auto-refresh hook (scripts/claim-ledger-precommit.mjs)
    // so the two never disagree about what "close" means.
    budget: CLAIM_LEDGER_BUDGET_COMMITS,
    enforcement_class: ENFORCEMENT_CLASS["claim-ledger"],
  },
  {
    name: "determinism-baseline",
    dir: ".determinism-baseline",
    manifest: ".determinism-baseline/manifest.json", env: "REVOY2_DETERMINISM_DIR",
    refresh: "captest bun run determinism:refresh",
    // Minutes to regenerate and deliberately never automated (ADR-034). A wide
    // budget is the honest price of keeping measurement off the critical path.
    budget: 60,
    enforcement_class: ENFORCEMENT_CLASS["determinism-baseline"],
  },
  {
    name: "completion-depth",
    dir: ".completion-depth",
    manifest: ".completion-depth/manifest.json", env: "REVOY2_COMPLETION_DEPTH_DIR",
    refresh: "bun run completion-depth:refresh",
    // Seconds to regenerate; blocking-on-untriaged, so lateness matters once a
    // finding sits unlooked-at past its 30-day window (see ENFORCEMENT_CLASS).
    budget: 25,
    enforcement_class: ENFORCEMENT_CLASS["completion-depth"],
  },
  {
    name: "vi-observed",
    dir: ".visual-intelligence/observed",
    manifest: ".visual-intelligence/observed/manifest.json", env: "REVOY2_VI_OBSERVED_DIR",
    refresh: "bun run vi:observe",
    // Manual/expensive class (ADR-042 Half A): a real child process per
    // scenario under NODE_V8_COVERAGE. Same rationale as determinism-baseline
    // — deliberately off the critical path, so it gets the same wide budget.
    budget: 60,
    enforcement_class: ENFORCEMENT_CLASS["vi-observed"],
  },
];

function git(args) {
  return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf-8" }).trim();
}

/** Honour the same overrides the individual gates use, so one fixture serves both. */
function storeDir(store) {
  const override = process.env[store.env];
  return override ? resolve(override) : join(REPO_ROOT, store.dir);
}

export function assess(store, head, currentContentHash, regenerationInFlight = false) {
  const dir = storeDir(store);
  if (!existsSync(dir)) {
    return {
      ...store,
      state: "fail",
      detail: `required store directory does not exist — run \`${store.refresh}\``,
    };
  }
  const manifestPath = join(dir, "manifest.json");
  if (!existsSync(manifestPath)) {
    return {
      ...store, state: "fail",
      detail: `store exists but has no manifest, so its age cannot be measured — run \`${store.refresh}\``,
    };
  }

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    return { ...store, state: "fail", detail: "manifest is unparseable" };
  }
  return { ...store, ...assessEvidenceProvenance({
    repo: REPO_ROOT, manifest, currentContentHash, head, regenerationInFlight, storeName: store.name,
  }) };
}

export function applyStoreFreshnessPolicy(store, result) {
  if (store.name === "determinism-baseline" && result.state === "fail" && result.detail.startsWith("content hash differs")) {
    return { ...result, state: "advisory", detail: `${result.detail} (reported only: ADR-034 forbids source drift from forcing measurement)` };
  }
  return result;
}

/**
 * The remedy an operator should actually follow — exactly one command.
 * `arbor evidence refresh --scope auto` is the ONE mechanism that encodes
 * the graph-before-stores ordering (ADR-079's constraint 3) and the
 * red-suite-poisons-the-baseline rule (see
 * packages/arbor-mcp/src/native-tools/evidence-refresh.ts). Staleness itself
 * is judged by content-hash provenance (ADR-055), not the manifest's
 * `scanned_up_to_revision` — see `assessEvidenceProvenance`. `--scope
 * auto` refreshes exactly the stale automatic stores and reports determinism
 * drift without measuring it. A prior
 * version of this remedy also printed a five-step bare-script fallback
 * sequence "for when arbor is unavailable" — that list is what taught
 * operators to run refreshes out of order in the first place (the ordering
 * it encoded is real, but a gate whose remedy block hands out the unsafe
 * path by name is not a remedy, it is a trap with a warning label), and it
 * duplicated — and could drift from — the procedure this repository already
 * has one authoritative source for (the `revoy2-procedure` skill). One
 * command, always safe to run, is the whole remedy.
 */
const REMEDY_COMMAND = "arbor evidence refresh --scope auto";

function printRemedy() {
  console.log(`  Remedy: \`${REMEDY_COMMAND}\``);
  console.log("  Regenerates stale claim-ledger, completion-depth, and vi-observed evidence in the");
  console.log("  required order. Determinism drift remains advisory until an operator explicitly runs");
  console.log("  `captest bun run determinism:refresh` under ADR-034.");
}

function main() {
  try {
    assertGovernanceConsumerReady({ consumer: "store-freshness-gate", evidenceStatus: evidenceTransactionReadStatus({ repo: REPO_ROOT }) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (JSON_OUT) console.log(JSON.stringify({ ok: false, code: error && typeof error === "object" && "code" in error ? error.code : "consumer_precondition", error: message }, null, 2));
    else console.error(`store-freshness gate — FAILED consumer precondition: ${message}`);
    return 1;
  }
  const head = git(["rev-parse", "HEAD"]);
  // Each store is measured against ITS OWN declared input scope
  // (store-provenance.mjs's STORE_SCOPES), not one shared whole-repo hash —
  // otherwise a change nothing in a given store's own extraction path reads
  // (a triage verdict, a README typo) would still report every OTHER store
  // stale too. `content_hash` below is kept for backward-compatible callers
  // that still want the legacy whole-repo digest; it is advisory only and no
  // store's `state` is decided against it.
  const legacyContentHash = computeEvidenceContentHash(REPO_ROOT);
  const regenerationInFlight = hasRegenerationMarker(REPO_ROOT);
  const results = STORES.map((s) => {
    const result = assess(s, head, computeEvidenceContentHashForStore(REPO_ROOT, s.name), regenerationInFlight);
    return applyStoreFreshnessPolicy(s, result);
  });
  const failures = results.filter((r) => r.state === "fail");

  if (JSON_OUT) {
    console.log(JSON.stringify({ ok: failures.length === 0, head, content_hash: legacyContentHash, regeneration_in_flight: regenerationInFlight, stores: results, remedy: REMEDY_COMMAND }, null, 2));
    return failures.length === 0 ? 0 : 1;
  }

  console.log(`store-freshness gate — how far each committed store trails HEAD ${head.slice(0, 12)}`);
  console.log("");
  for (const r of results) {
    const tag = r.state === "ok" ? "ok  " : r.state === "advisory" ? "NOTE" : "FAIL";
    console.log(`  ${tag} ${r.name.padEnd(22)} [${r.enforcement_class}]  ${r.detail}`);
  }
  console.log("");
  console.log("  [enforcement_class] names what fails when the STORE'S DATA is wrong, not how stale it");
  console.log("  is: blocking (no triage escape) or blocking-on-untriaged (a recorded verdict clears it).");
  console.log("  Content identity is authoritative; recorded commit identity and distance are advisory.");
  console.log("  Any regeneration marker makes mismatching evidence fail closed, including stale or malformed markers.");
  console.log("");

  if (failures.length === 0) { console.log("PASS"); return 0; }
  for (const f of failures) console.log(`FAIL — ${f.name}: ${f.detail}`);
  console.log("");
  printRemedy();
  return 1;
}

function isDirectExecution() {
  if (!process.argv[1]) return false;
  return resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
}

if (isDirectExecution()) process.exitCode = main();
