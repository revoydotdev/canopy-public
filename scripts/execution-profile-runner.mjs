#!/usr/bin/env node
/**
 * Run a managed-hook profile against its actual working tree.
 *
 * Immutable prepush/CI execution remains in enforcement-battery.mjs.  A
 * pre-commit hook intentionally operates on the staged working tree (the
 * claim-ledger precommit gate may create its bounded evidence output), so it
 * uses this shared profile executor instead of copying a shell roster.
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { auditExecutionProfile, executeGateDag, loadExecutionProfile, resolveCandidateIdentity } from "./enforcement-control-plane.mjs";

function value(flag, fallback = null) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] ?? fallback : fallback;
}

const repo = resolve(value("--repo", process.cwd()));
const context = value("--context", "precommit");
const variant = value("--variant", null);
const registry = loadExecutionProfile(join(repo, "scripts", "execution-profile.json"));
const packageJson = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
const problems = auditExecutionProfile(registry, packageJson);
if (problems.length > 0) {
  process.stdout.write(`${JSON.stringify({ ok: false, status: "roster_invalid", problems }, null, 2)}\n`);
  process.exitCode = 1;
} else {
  const omissions = variant === null
    ? {}
    : registry.execution?.managed_hooks?.[context]?.variants?.[variant]?.omitted_gates;
  if (variant !== null && (!omissions || typeof omissions !== "object")) {
    process.stdout.write(`${JSON.stringify({ ok: false, status: "variant_invalid", context, variant }, null, 2)}\n`);
    process.exitCode = 1;
  } else {
    const effectiveRegistry = variant === null ? registry : {
      ...registry,
      gates: Object.fromEntries(Object.entries(registry.gates).map(([name, entry]) => {
        const reason = omissions[name];
        return [name, reason ? {
          ...entry,
          contexts: { ...entry.contexts, [context]: false },
          excluded_contexts: { ...entry.excluded_contexts, [context]: reason },
        } : entry];
      })),
    };
  const report = await executeGateDag({
    registry: effectiveRegistry,
    context,
    identity: resolveCandidateIdentity(repo),
    cwd: repo,
  });
  process.stdout.write(`${JSON.stringify({ ...report, managed_hook_variant: variant, declared_omissions: omissions }, null, 2)}\n`);
  process.exitCode = report.ok ? 0 : 1;
  }
}
