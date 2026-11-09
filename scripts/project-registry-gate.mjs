#!/usr/bin/env bun
/**
 * scripts/project-registry-gate.mjs — `gate:project-registry` (Roadmap 23
 * W2, ADR-076).
 *
 * Reads the project registry at `<root>/.arbor/project-registry.json`
 * (default `--root` is this checkout, matching every other gate's
 * `--root`-optional convention — see `project-conform.mjs`'s
 * `resolveRootArg`) and re-establishes discharge for every entry: expiry,
 * path reachability, `profile_hash` drift, and a live `project-conform`
 * run. See `packages/arbor-mcp/src/project-registry.ts` for the mechanism
 * (`evaluateProjectRegistry`) — this script is a thin CLI wrapper around it,
 * the same relationship `liveness-gate.ts` has to `runLiveness`.
 *
 * Usage:
 *   bun scripts/project-registry-gate.mjs           # human-readable report
 *   bun scripts/project-registry-gate.mjs --json     # machine-readable report
 *   bun scripts/project-registry-gate.mjs --root <p> # registry at <p>/.arbor
 *   bun run gate:project-registry                    # wired via package.json
 */

import { join, resolve as resolvePath } from "node:path";
import { evaluateProjectRegistry, formatProjectRegistryReport } from "@arbor/mcp";
import { resolveRootArg } from "./project-conform.mjs";

const JSON_OUTPUT = process.argv.includes("--json");

function main() {
  let root;
  try {
    root = resolveRootArg(process.argv);
  } catch (error) {
    console.error(`project-registry: ${error.message}`);
    return 2;
  }
  const persistenceDir = resolvePath(join(root, ".arbor"));
  const report = evaluateProjectRegistry(persistenceDir);

  if (JSON_OUTPUT) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatProjectRegistryReport(report));
    console.log("");
    console.log(
      "  Strength: this gate proves that every REGISTERED entry's claim still holds — the path",
    );
    console.log(
      "  exists, its arbor.profile.jsonc is byte-identical to what was hashed at registration,",
    );
    console.log(
      "  the entry has not expired, and a live project-conform run against it passes RIGHT NOW.",
    );
    console.log(
      "  It does NOT prove the registry is COMPLETE — a project under real governance that was",
    );
    console.log(
      "  never enrolled is invisible to this gate, exactly as ADR-076 designed: registration is",
    );
    console.log(
      "  an explicit act, not something this gate can discover on its own. An empty registry",
    );
    console.log(
      "  passes trivially; that is a fact about how many projects are governed, not evidence",
    );
    console.log(
      "  that none should be.",
    );
    console.log("");
    console.log(report.ok ? "PASS" : `FAIL — ${report.verifications.filter((v) => !v.ok).length} of ${report.entry_count} entr${report.entry_count === 1 ? "y" : "ies"} failed discharge`);
  }
  return report.ok ? 0 : 1;
}

process.exit(main());
