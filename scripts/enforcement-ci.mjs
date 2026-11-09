#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { loadExecutionProfile, resolveCandidateIdentity, runImmutableBattery, validateAggregateExecutionReport } from "./enforcement-control-plane.mjs";

const repo = resolve(process.cwd());
const out = resolve(process.argv[2] ?? ".arbor/enforcement/aggregate-report.json");
const registry = loadExecutionProfile();
const candidate = resolveCandidateIdentity(repo);
let report;
try {
  report = await runImmutableBattery({ repo, candidate: candidate.candidate_oid, context: "ci" });
} catch (error) {
  report = {
    ok: false,
    status: "runner_unavailable",
    candidate_oid: candidate.candidate_oid,
    input_digest: candidate.input_digest,
    profile_version: registry.profile_version,
    gates: [],
    error: error instanceof Error ? error.message : String(error),
  };
}
const remote_execution = validateAggregateExecutionReport({ report, registry, expectedCandidate: candidate });
report = Object.freeze({ ...report, ok: report.ok === true && remote_execution.ok, status: remote_execution.ok ? report.status : "remote_execution_unproven", remote_execution });
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ ok: report.ok, status: report.status, report: out, candidate_oid: report.candidate_oid ?? null, remote_execution: remote_execution.code }, null, 2));
process.exitCode = report.ok ? 0 : 1;
