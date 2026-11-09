#!/usr/bin/env -S node
/**
 * scripts/liveness-gate.ts — the liveness attestation gate.
 *
 * Every other gate in this repository asks a static question. This one calls
 * things and reports what came back. See `packages/arbor-mcp/src/liveness.ts`
 * for why that distinction has been worth several defects.
 *
 * WHAT FAILS THE BUILD, and what deliberately does not:
 *
 *   UNREACHABLE seams — BLOCKING. A declared catalog kind that receives a
 *   well-posed request and finds no working handler is broken, full stop.
 *
 *   UNREACHABLE consumers — BLOCKING. A declared consumer whose OWN request
 *   does not validate is the diagnostics defect exactly: `refreshScreenData`
 *   sent `cursor: 0` where a `RuntimeCursor` record was required, every
 *   dispatch failed, and the screen rendered nothing on any real run while
 *   every static gate stayed green.
 *
 *   REFUSED — never a failure. A seam that declines with a typed reason is
 *   working. `foreground.derive` refusing with "no live source of per-node
 *   model/skill inputs is wired yet" is the catalog being honest about itself,
 *   and turning that into a build break would train people to make seams lie.
 *
 *   INDETERMINATE — ratcheted, not blocking. Nothing is known about these:
 *   mutating kinds not invoked, seams with no declared probe, or probes whose
 *   own payload failed validation. That is a coverage gap, not a defect, so it
 *   is held at a floor that may fall and must not rise. Treating it as a
 *   failure would push someone to fabricate a probe payload just to clear it,
 *   which is the fabricated-evidence shape (G-22, G-25) this repository has
 *   already paid for twice.
 */

import { runLiveness, formatLivenessReport } from "@arbor/mcp";

/**
 * Seams nothing currently probes. Ratchet only: lower it as probes are added,
 * never raise it to make room for a new unprobed seam.
 *
 * This falls only when a disposable runtime executes and asserts a real
 * command trajectory. It is never adjusted to disguise missing probes.
 */
const INDETERMINATE_FLOOR = 30;

async function main(): Promise<number> {
  // The composition root is a fresh mkdtemp runtime and its disposer removes
  // it after the report. Mutating catalog entries therefore run only as real
  // disposable trajectories with state assertions, never against operator
  // state or synthetic acknowledgement fixtures.
  const report = await runLiveness({ at: new Date().toISOString(), includeMutating: true });
  console.log(formatLivenessReport(report));

  const s = report.summary;
  const failures: string[] = [];

  // The consumer table mirrors real request shapes and a mirror can fall
  // behind, so a screen that gains a dispatch with nothing attesting to it
  // blocks the merge. `null` is not "clear" — it means the check could not run,
  // which must never read as a pass.
  if (report.consumer_drift === null) {
    failures.push("consumer drift could not be determined — the screen source was unreadable, so nothing is known");
  } else if (report.consumer_drift.length > 0) {
    failures.push(
      `${report.consumer_drift.length} screen(s) dispatch a query with no declared consumer ` +
      `(${report.consumer_drift.join(", ")}) — a real request shape nothing attests to`,
    );
  }

  if (s.catalog_unreachable > 0) {
    failures.push(`${s.catalog_unreachable} catalog seam(s) unreachable — declared, well-posed request, no working handler`);
  }
  if (s.consumers_unreachable > 0) {
    failures.push(`${s.consumers_unreachable} consumer(s) unreachable — the request that consumer actually sends does not reach a working handler`);
  }
  if (s.consumers_indeterminate > 0) {
    failures.push(`${s.consumers_indeterminate} consumer(s) indeterminate — a declared consumer whose seam could not be resolved at all`);
  }
  if (s.catalog_indeterminate > INDETERMINATE_FLOOR) {
    failures.push(
      `${s.catalog_indeterminate} unprobed seam(s), above the floor of ${INDETERMINATE_FLOOR}. ` +
      `Add a probe payload, or lower the floor only if a seam was legitimately removed.`,
    );
  }

  // Zero answered would mean the prober itself is broken and every other count
  // is meaningless — a gate that passes because it measured nothing is the
  // failure mode this whole file exists to prevent.
  if (s.catalog_answered === 0) {
    failures.push("no catalog seam answered at all — the prober is not exercising the runtime");
  }

  console.log("");
  if (failures.length === 0) {
    console.log("PASS");
    return 0;
  }
  for (const failure of failures) console.log(`FAIL — ${failure}`);
  return 1;
}

process.exit(await main());
