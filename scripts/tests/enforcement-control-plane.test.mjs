import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  auditExecutionProfile,
  auditGateAllTierAgreement,
  auditWorkflowProfile,
  createImmutableSnapshot,
  EXECUTION_CONTEXTS,
  freezeTrackedInputs,
  canonicalJson,
  executeGateDag,
  loadExecutionProfile,
  planGateDag,
  runImmutableBattery,
  runDeadlineProcess,
  selectedGates,
  sha256,
  validateAggregateExecutionReport,
} from "../enforcement-control-plane.mjs";
import {
  EvidenceTransactionRefusal,
  acquireEvidenceTransaction,
  assertEvidenceProducerAuthority,
  evidenceTransactionPaths,
  evidenceTransactionStatus,
  evidenceTransactionReadStatus,
  publishEvidencePatch,
  recoverEvidenceTransaction,
  resolveEvidenceSourceIdentity,
  acquireEvidenceTransactionWithWait,
  runEvidenceRefreshTransaction,
  runEvidenceStagingSetup,
} from "../evidence-transaction.mjs";
import { assertGovernanceConsumerReady } from "../lib/governance-plan.mjs";
import { collectGitHubEnrollmentReceipt, githubEnrollmentReceiptDigest, reconcileEnrollment, validateGitHubEnrollmentReceipt } from "../enrollment-reconcile.mjs";
import { attestationDigest, collectGitHubActionsAttestationReceipt, collectGitHubProtectionReceipt, makeAggregateAttestation, requiredCiGateNames, serverEnforcementReadiness, validateGitHubActionsAttestationReceipt, validateGitHubProtectionReceipt, verifyCentralAttestation } from "../enforcement-attestation.mjs";

const ROOT = resolve(import.meta.dirname, "..", "..");
const dirs = [];
function temporary(prefix) { const path = mkdtempSync(join(tmpdir(), prefix)); dirs.push(path); return path; }
afterEach(() => { while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true }); });
function hash(value) { return createHash("sha256").update(value).digest("hex"); }
function fixtureRepo() {
  const repo = temporary("revoy2-enforcement-test-");
  spawnSync("git", ["init", "-q"], { cwd: repo });
  spawnSync("git", ["config", "user.email", "test@example.invalid"], { cwd: repo });
  spawnSync("git", ["config", "user.name", "Test"], { cwd: repo });
  writeFileSync(join(repo, "tracked.txt"), "one\n");
  spawnSync("git", ["add", "."], { cwd: repo });
  spawnSync("git", ["commit", "-qm", "fixture"], { cwd: repo });
  return repo;
}
function gate(name, prerequisites = []) {
  const contexts = Object.fromEntries(["stop", "precommit", "prepush", "trunk_submit", "ci"].map((context) => [context, context === "ci"]));
  const excluded_contexts = Object.fromEntries(Object.entries(contexts).filter(([, on]) => !on).map(([context]) => [context, { code: "fixture", detail: "fixture exclusion" }]));
  return { command: `bun run ${name}`, prerequisites, contexts, excluded_contexts, timeout_ms: 1000, cost_class: "fast", mutability: "read_only", effect: "blocking", resource_class: "light", required: true, scope: "target" };
}
function fixtureRegistry(gates) { return { schema_version: 1, profile_version: "fixture-v1", gates }; }
const identity = Object.freeze({ candidate_oid: "a".repeat(40), input_digest: "b".repeat(64) });
function enrollmentReceipt({ inventory, manifests, repositories, coverage = null, observedAt = new Date().toISOString() }) {
  const direct = (inventory.repositories ?? []).map((entry) => entry.repository).sort();
  const observedRepositories = repositories.map((entry) => ({ ...entry, private: entry.private ?? true }));
  const canonicalRepository = observedRepositories.find((entry) => entry.repository === inventory.canonical_repository) ?? null;
  const payload = {
    schema_version: 3,
    kind: "revoy2.github_enrollment_receipt",
    source: "github_api",
    authenticated: true,
    repository_access_proof: {
      kind: "github_api_private_repository_contents",
      repository: inventory.canonical_repository,
      private: canonicalRepository?.private === true,
      default_branch: canonicalRepository?.default_branch ?? null,
      workflow_paths: canonicalRepository?.workflow_paths ?? [],
    },
    organization: inventory.organization,
    observed_at: observedAt,
    inventory_digest: sha256(canonicalJson(inventory)),
    manifests_digest: sha256(canonicalJson(manifests)),
    candidate: { oid: identity.candidate_oid, input_digest: identity.input_digest },
    profile_version: "fixture-v1",
    coverage: coverage ?? { mode: "allowlist", organization_enumeration_complete: false, authority: "direct_governed_repository_queries", directly_queried_repositories: direct, observed_active_repositories: observedRepositories.filter((entry) => !entry.archived).map((entry) => entry.repository).sort(), workflow_queries_complete: true },
    repositories: observedRepositories,
  };
  return { ...payload, receipt_digest: githubEnrollmentReceiptDigest(payload) };
}
function platformReceipt(attestation) {
  const repository = attestation.issuer.repository;
  const suffix = attestation.issuer.workflow_ref.slice(`${repository}/`.length);
  const separator = suffix.lastIndexOf("@");
  const workflow_path = suffix.slice(0, separator);
  const workflow_revision = suffix.slice(separator + 1);
  const digest = attestationDigest(attestation);
  return {
    schema_version: 2,
    kind: "revoy2.github_actions_attestation_receipt",
    source: "github_api",
    authenticated: true,
    principal: { login: "fixture", id: 1, type: "User" },
    repository,
    observed_at: new Date().toISOString(),
    workflow: { workflow_ref: attestation.issuer.workflow_ref, workflow_path, workflow_revision, content_ref: attestation.candidate.oid, content_blob_sha: "f".repeat(40) },
    run: { id: attestation.issuer.run_id, attempt: attestation.issuer.run_attempt, head_sha: attestation.candidate.oid, conclusion: "success", workflow_path },
    artifact: { id: 7, name: `revoy2-aggregate-enforcement-attestation-${attestation.candidate.oid}`, digest: "sha256:fixture", remote_attestation_digest: digest },
    attestation_digest: digest,
  };
}

describe("execution-profile roster and immutable DAG", () => {
  it("plans stable topological waves independent of registry insertion order", () => {
    const definitions = {
      writer: { ...gate("writer", ["shared"]), mutability: "evidence_writer" },
      readerB: gate("readerB", ["shared"]),
      shared: gate("shared"),
      readerA: gate("readerA", ["shared"]),
    };
    const first = planGateDag(fixtureRegistry(definitions), "ci", { maxReaders: 2 });
    const reversed = planGateDag(fixtureRegistry(Object.fromEntries(Object.entries(definitions).reverse())), "ci", { maxReaders: 2 });
    expect(first).toEqual(reversed);
    expect(first.waves).toEqual([
      { wave: 1, mutability: "read_only", resources: { light: 1 }, gates: ["shared"] },
      { wave: 2, mutability: "evidence_writer", resources: { light: 1 }, gates: ["writer"] },
      { wave: 3, mutability: "read_only", resources: { light: 2 }, gates: ["readerA", "readerB"] },
    ]);
  });

  it("gives a wave to an evidence writer alone, but lets a verification sandbox share one", () => {
    // The two are not equivalent. An evidence_writer rewrites tracked evidence
    // in the shared tree; a verification_sandbox writes only into its own
    // detached snapshot. Giving the sandbox class exclusivity too put
    // gate:coverage -- the most expensive gate in the system -- alone in CI's
    // first wave with fifty gates waiting behind it, for no correctness reason.
    const sandbox = planGateDag(fixtureRegistry({
      sandbox: { ...gate("sandbox"), mutability: "verification_sandbox" },
      readerA: gate("readerA"),
      readerB: gate("readerB"),
    }), "ci", { maxReaders: 3 });
    expect(sandbox.waves).toHaveLength(1);
    expect(sandbox.waves[0].gates).toEqual(["readerA", "readerB", "sandbox"]);
    // The wave still reports the strongest mutability it carries.
    expect(sandbox.waves[0].mutability).toBe("verification_sandbox");

    const evidence = planGateDag(fixtureRegistry({
      writer: { ...gate("writer"), mutability: "evidence_writer" },
      readerA: gate("readerA"),
      readerB: gate("readerB"),
    }), "ci", { maxReaders: 3 });
    expect(evidence.waves[0].gates).toEqual(["writer"]);
    expect(evidence.waves[0].mutability).toBe("evidence_writer");
  });

  it("uses profile gate groups as the canonical order and rejects an undeclared omission", () => {
    const registry = loadExecutionProfile();
    const plan = planGateDag(registry, "prepush");
    expect(plan.waves[0].gates).toContain("gate:execution-profile");
    const waveOf = (gateName) => plan.waves.findIndex((wave) => wave.gates.includes(gateName));
    for (const entry of selectedGates(registry, "prepush")) {
      for (const prerequisite of entry.prerequisites) {
        if (registry.gates[prerequisite]?.contexts.prepush) {
          expect(waveOf(prerequisite), `${prerequisite} must precede ${entry.name}`).toBeLessThan(waveOf(entry.name));
        }
      }
    }
    expect(selectedGates(registry, "prepush").every((entry) => entry.contexts.prepush)).toBe(true);
    const omitted = {
      ...registry,
      execution: { ...registry.execution, gate_order: registry.execution.gate_order.slice(1) },
    };
    expect(auditExecutionProfile(omitted, JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")))).toContain("execution.gate_order omits gate:execution-profile");
  });

  it("rejects a dependency cycle during cheap roster audit before snapshot setup", () => {
    const registry = fixtureRegistry({ first: gate("first", ["second"]), second: gate("second", ["first"]) });
    const pkg = { scripts: { first: "true", second: "true" } };
    expect(auditExecutionProfile(registry, pkg).some((problem) => problem.includes("dependency cycle"))).toBe(true);
  });

  // ADR-108 O4: loadExecutionProfile's validation path (auditExecutionProfile,
  // the function it and gate:execution-profile --verify both run) rejects a
  // gates entry with a missing or unrecognized scope, the same way it already
  // rejects a package.json gate absent from the manifest.
  it("rejects a gates entry with a missing or unrecognized scope (ADR-108)", () => {
    const missingScope = fixtureRegistry({ only: (() => { const { scope, ...rest } = gate("only"); return rest; })() });
    const pkgMissing = { scripts: { only: "true" } };
    expect(auditExecutionProfile(missingScope, pkgMissing)).toContain("only must declare scope self, target, or both");

    const unrecognizedScope = fixtureRegistry({ only: { ...gate("only"), scope: "everywhere" } });
    expect(auditExecutionProfile(unrecognizedScope, pkgMissing)).toContain("only must declare scope self, target, or both");

    for (const scope of ["self", "target", "both"]) {
      const validScope = fixtureRegistry({ only: { ...gate("only"), scope } });
      expect(auditExecutionProfile(validScope, pkgMissing).some((problem) => problem.includes("must declare scope"))).toBe(false);
    }
  });

  // Arboretum M2: an `inputs` declaration schedules a gate out of the stop
  // battery when none of its paths changed, so a malformed one is a scheduling
  // defect. Absent is valid (the gate always runs); empty or escaping is not.
  it("accepts absent or well-formed inputs and rejects empty, non-string, absolute or escaping ones", () => {
    const pkg = { scripts: { only: "true" } };
    const inputProblems = (inputs) => auditExecutionProfile(fixtureRegistry({ only: { ...gate("only"), ...(inputs === undefined ? {} : { inputs }) } }), pkg)
      .filter((problem) => problem.includes("inputs"));
    expect(inputProblems(undefined)).toEqual([]);
    expect(inputProblems(["decisions/**", "package.json"])).toEqual([]);
    for (const bad of [[], "decisions/**", [""], [3], ["/etc/passwd"], ["../outside/**"]]) {
      expect(inputProblems(bad).length, JSON.stringify(bad)).toBeGreaterThan(0);
    }
  });

  it("uses one aggregate Linux authority and retains only non-replayable platform lanes", () => {
    const workflow = readFileSync(join(ROOT, ".github", "workflows", "ci.yml"), "utf8");
    expect(workflow.match(/runs-on: \[self-hosted, Linux, X64\]/g)).toHaveLength(1);
    expect(workflow).toContain("platform-smoke-windows:");
    expect(workflow).toContain("platform-smoke-macos:");
    expect(workflow).not.toContain("coverage-floor-gate:");
    expect(workflow).not.toContain("build-test-gate:");
  });

  it("keeps detached inputs copy-safe while preserving the identity watcher", () => {
    const repo = fixtureRepo();
    const executable = join(repo, "tracked.txt");
    chmodSync(executable, 0o755);
    mkdirSync(join(repo, ".visual-intelligence", "graph"), { recursive: true });
    const evidence = join(repo, ".visual-intelligence", "graph", "nodes.jsonl");
    writeFileSync(evidence, "{}\n");
    spawnSync("git", ["add", "tracked.txt", ".visual-intelligence/graph/nodes.jsonl"], { cwd: repo });
    spawnSync("git", ["commit", "-qm", "freeze fixture"], { cwd: repo });
    freezeTrackedInputs(repo);
    expect(statSync(executable).mode & 0o111).not.toBe(0);
    expect(statSync(executable).mode & 0o222).not.toBe(0);
    expect(statSync(evidence).mode & 0o200).not.toBe(0);
    const fixtureCopy = join(temporary("revoy2-copy-safe-fixture-"), "fixture-copy.txt");
    cpSync(executable, fixtureCopy);
    writeFileSync(fixtureCopy, "fixture may write its copy\n");
    expect(spawnSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" }).stdout).toBe("");
  });

  it("fails if a fictitious package gate is not CI-enrolled", () => {
    const registry = loadExecutionProfile();
    const fictional = {
      ...registry.gates["gate:execution-profile"],
      command: "bun run gate:fictional-stop-ci",
      contexts: { ...registry.gates["gate:execution-profile"].contexts, stop: true, ci: false },
      excluded_contexts: { ...registry.gates["gate:execution-profile"].excluded_contexts, ci: { code: "fixture_unenrolled", detail: "deliberately omitted to prove roster failure" } },
    };
    const mutated = { ...registry, gates: { ...registry.gates, "gate:fictional-stop-ci": fictional } };
    const pkg = { scripts: Object.fromEntries(Object.keys(mutated.gates).map((name) => [name, "bun scripts/noop.mjs"])) };
    const problems = auditExecutionProfile(mutated, pkg);
    expect(problems.some((problem) => problem.includes("gate:fictional-stop-ci") && problem.includes("not represented in authoritative CI"))).toBe(true);
  });

  // A gate with `required: false` and every `contexts.<x>` false, but a fully
  // typed excluded_contexts reason for each one, satisfies every existing
  // per-context and CI-enrollment rule. Nothing before this test required a
  // gate to be selected by ANY context, so such a gate can sit in
  // package.json and execution-profile.json, be fully "valid" by every other
  // rule, and never execute anywhere — the exact silent-omission shape this
  // module exists to catch. gate:all is the one deliberate exception: an
  // operator-facing aggregate that would recursively invoke the profile
  // runner if the DAG ever selected it.
  it("rejects a gate that is not selected by any execution context", () => {
    const registry = loadExecutionProfile();
    const template = registry.gates["gate:execution-profile"];
    const ghost = {
      ...template,
      command: "bun run gate:ghost",
      required: false,
      contexts: Object.fromEntries(EXECUTION_CONTEXTS.map((context) => [context, false])),
      excluded_contexts: Object.fromEntries(EXECUTION_CONTEXTS.map((context) => [context, { code: "fixture_never_selected", detail: "deliberately excluded everywhere to prove the never-selected rule" }])),
    };
    const mutated = {
      ...registry,
      gates: { ...registry.gates, "gate:ghost": ghost },
      execution: { ...registry.execution, gate_order: [...registry.execution.gate_order, { id: "ghost_group", gates: ["gate:ghost"] }] },
    };
    const pkg = { scripts: { ...Object.fromEntries(Object.keys(registry.gates).map((name) => [name, "bun scripts/noop.mjs"])), "gate:ghost": "bun scripts/noop.mjs" } };
    const problems = auditExecutionProfile(mutated, pkg);
    expect(problems.some((problem) => problem.includes("gate:ghost") && problem.includes("not selected by any execution context"))).toBe(true);
  });

  it("still allows gate:all itself to be selected by no context", () => {
    const registry = loadExecutionProfile();
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    const problems = auditExecutionProfile(registry, pkg);
    expect(problems.some((problem) => problem.includes("gate:all") && problem.includes("not selected by any execution context"))).toBe(false);
  });

  it("runs a shared prerequisite once and distinguishes blocked dependents", async () => {
    const registry = fixtureRegistry({ shared: gate("shared"), good: gate("good", ["shared"]), bad: gate("bad", ["shared"]), blocked: gate("blocked", ["bad"]) });
    let sharedRuns = 0;
    const report = await executeGateDag({ registry, context: "ci", identity, cwd: ROOT, executor: async (entry) => {
      if (entry.name === "shared") sharedRuns += 1;
      return { ok: entry.name !== "bad", status: entry.name === "bad" ? "failed" : "passed", exit_code: entry.name === "bad" ? 1 : 0, duration_ms: 1, output: "" };
    } });
    expect(sharedRuns).toBe(1);
    expect(report.gates.find((result) => result.gate === "good")?.status).toBe("passed");
    expect(report.gates.find((result) => result.gate === "bad")?.status).toBe("failed");
    expect(report.gates.find((result) => result.gate === "blocked")).toMatchObject({ status: "blocked_by_prerequisite", prerequisite_failures: ["bad"] });
  });

  it("emits deterministic cancellation status and does not run later groups after a fail-fast timeout", async () => {
    const registry = fixtureRegistry({ first: gate("first"), second: gate("second"), third: gate("third") });
    registry.execution = {
      contexts: Object.fromEntries(["stop", "precommit", "prepush", "trunk_submit", "ci"].map((context) => [context, { max_readers: 1, failure_policy: "fail_fast" }])),
      gate_order: [{ id: "first", gates: ["first"] }, { id: "later", gates: ["second", "third"] }],
      finalization: { phases: [{ id: "source", depends_on: [], mutability: "read_only" }] },
    };
    const calls = [];
    const report = await executeGateDag({ registry, context: "ci", identity, cwd: ROOT, executor: async (entry) => {
      calls.push(entry.name);
      return { ok: false, status: "timed_out", exit_code: null, duration_ms: 1, output: "fixture timeout" };
    } });
    expect(calls).toEqual(["first"]);
    expect(report.gates.map((result) => [result.gate, result.status])).toEqual([["first", "timed_out"], ["second", "cancelled"], ["third", "cancelled"]]);
    expect(report.execution_emissions).toEqual([
      { sequence: 1, wave: 1, gate: "first", status: "timed_out" },
      { sequence: 2, wave: 2, gate: "second", status: "cancelled" },
      { sequence: 3, wave: 3, gate: "third", status: "cancelled" },
    ]);
  });

  it("serializes evidence writers, bounds readers, and keeps advisory failures visible without failing the battery", async () => {
    // evidence_writer is the class that must never overlap: it rewrites tracked
    // evidence in the shared tree. verification_sandbox is covered separately,
    // where the point is that it MAY share a wave.
    const writer = { ...gate("writer"), mutability: "evidence_writer" };
    const advisory = { ...gate("advisory"), effect: "advisory", required: false };
    const registry = fixtureRegistry({ writerA: writer, writerB: writer, readerA: gate("readerA"), readerB: gate("readerB"), readerC: gate("readerC"), readerD: gate("readerD"), readerE: gate("readerE"), advisory });
    let active = 0;
    let peak = 0;
    let writerOverlap = false;
    const report = await executeGateDag({ registry, context: "ci", identity, cwd: ROOT, executor: async (entry) => {
      active += 1;
      peak = Math.max(peak, active);
      if (entry.mutability !== "read_only" && active !== 1) writerOverlap = true;
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      const ok = entry.name !== "advisory";
      return { ok, status: ok ? "passed" : "failed", exit_code: ok ? 0 : 1, duration_ms: 5, output: "" };
    } });
    expect(writerOverlap).toBe(false);
    expect(peak).toBeLessThanOrEqual(4);
    expect(report).toMatchObject({ ok: true, status: "passed" });
    expect(report.gates.find((result) => result.gate === "advisory")?.status).toBe("failed");
    expect(report.timing_ms.critical_path_ms).toBeGreaterThanOrEqual(0);
  });

  it("admits disjoint groups together but enforces per-resource caps deterministically", () => {
    const registry = fixtureRegistry({
      lightA: gate("lightA"),
      lightB: gate("lightB"),
      typeA: { ...gate("typeA"), resource_class: "typescript" },
      typeB: { ...gate("typeB"), resource_class: "typescript" },
      vitestA: { ...gate("vitestA"), resource_class: "vitest" },
    });
    registry.execution = {
      contexts: Object.fromEntries(EXECUTION_CONTEXTS.map((context) => [context, {
        max_readers: 4,
        failure_policy: "complete_all",
        resource_limits: { light: 4, git_admin: 1, typescript: 1, vitest: 1, coverage: 1, lsp: 1, network: 1 },
      }])),
      gate_order: [{ id: "early", gates: ["typeA", "lightA"] }, { id: "later", gates: ["typeB", "vitestA", "lightB"] }],
      finalization: { phases: [{ id: "source", depends_on: [], mutability: "read_only" }] },
    };
    const plan = planGateDag(registry, "ci");
    expect(plan.waves[0]).toMatchObject({ resources: { light: 2, typescript: 1, vitest: 1 }, gates: ["lightA", "typeA", "lightB", "vitestA"] });
    expect(plan.waves[1]).toMatchObject({ resources: { typescript: 1 }, gates: ["typeB"] });
  });

  // Arboretum M1's third state, at the control plane rather than the canary
  // runner: a gate that declares `observes.min` and exits 0 having observed
  // fewer things (or reported nothing) is `unresolved`, and the battery is not
  // green on it.
  it("downgrades an exit-0 gate that observed less than its declared minimum to unresolved, and fails the battery", async () => {
    const registry = fixtureRegistry({ empty: { ...gate("empty"), observes: { min: 1 } }, silent: { ...gate("silent"), observes: { min: 1 } }, seen: { ...gate("seen"), observes: { min: 1 } }, plain: gate("plain") });
    const outputs = { empty: "observed_count: 0\nPASS", silent: "PASS", seen: "observed_count: 3\nPASS", plain: "PASS" };
    const report = await executeGateDag({ registry, context: "ci", identity, cwd: ROOT, executor: async (entry) => ({ ok: true, status: "passed", exit_code: 0, duration_ms: 1, output: outputs[entry.name] }) });
    const statusOf = (name) => report.gates.find((result) => result.gate === name)?.status;
    expect([statusOf("empty"), statusOf("silent"), statusOf("seen"), statusOf("plain")]).toEqual(["unresolved", "unresolved", "passed", "passed"]);
    expect(report.ok).toBe(false);
  });

  it("invalidates a green battery if watched input identity changes", async () => {
    const registry = fixtureRegistry({ only: gate("only") });
    let watched = "before";
    const report = await executeGateDag({ registry, context: "ci", identity, cwd: ROOT, beforeIdentity: () => watched, afterIdentity: () => watched, executor: async () => {
      watched = "after";
      return { ok: true, status: "passed", exit_code: 0, duration_ms: 1, output: "" };
    } });
    expect(report).toMatchObject({ ok: false, status: "identity_mismatch" });
    expect(report.gates[0].invalidated_by).toBe("watched_input_identity_mismatch");
  });

  it("fails a fixture battery when a gate mutates the detached candidate input", async () => {
    const repo = fixtureRepo();
    writeFileSync(join(repo, "package.json"), JSON.stringify({ scripts: { "gate:fixture": "true" } }));
    const profilePath = join(repo, "profile.json");
    writeFileSync(profilePath, JSON.stringify(fixtureRegistry({ "gate:fixture": gate("gate:fixture") })));
    spawnSync("git", ["add", "package.json", "profile.json"], { cwd: repo });
    spawnSync("git", ["commit", "-qm", "fixture profile"], { cwd: repo });
    const report = await runImmutableBattery({
      repo,
      registryPath: profilePath,
      context: "ci",
      prepareSnapshot: false,
      executor: async (_entry, _identity, execution) => {
        writeFileSync(join(execution.cwd, "tracked.txt"), "mutated\n");
        return { ok: true, status: "passed", exit_code: 0, duration_ms: 1, output: "" };
      },
    });
    expect(report).toMatchObject({ ok: false, status: "identity_mismatch" });
    expect(report.timing_ms).toMatchObject({ snapshot: expect.any(Number), dependency_install: 0, candidate_build: 0, gates: expect.any(Number) });
    expect(report.timing_ms.snapshot).toBeGreaterThanOrEqual(0);
    expect(report.timing_ms.gates).toBeGreaterThanOrEqual(0);
  });

  it("binds roster and execution to the candidate while the live checkout is dirty and changing", async () => {
    const repo = fixtureRepo();
    writeFileSync(join(repo, "package.json"), JSON.stringify({ scripts: { "gate:fixture": "true" } }));
    const profilePath = join(repo, "profile.json");
    writeFileSync(profilePath, JSON.stringify(fixtureRegistry({ "gate:fixture": gate("gate:fixture") })));
    spawnSync("git", ["add", "package.json", "profile.json"], { cwd: repo });
    spawnSync("git", ["commit", "-qm", "fixture profile"], { cwd: repo });
    const candidate = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).stdout.trim();

    writeFileSync(join(repo, "package.json"), JSON.stringify({ scripts: {} }));
    writeFileSync(profilePath, JSON.stringify({ schema_version: 1, profile_version: "live-dirty", gates: {} }));
    writeFileSync(join(repo, "untracked-audit.md"), "operator work\n");
    const report = await runImmutableBattery({
      repo,
      candidate,
      registryPath: profilePath,
      context: "ci",
      prepareSnapshot: false,
      executor: async (entry, _identity, execution) => {
        expect(entry.name).toBe("gate:fixture");
        expect(execution.cwd).not.toBe(repo);
        writeFileSync(join(repo, "tracked.txt"), "changed while candidate runs\n");
        return { ok: true, status: "passed", exit_code: 0, duration_ms: 1, output: "" };
      },
    });
    expect(report).toMatchObject({ ok: true, status: "passed", candidate_oid: candidate });
  });

  it("reuses an exact detached prepared snapshot without creating a nested worktree", async () => {
    const repo = fixtureRepo();
    writeFileSync(join(repo, "package.json"), JSON.stringify({ scripts: { "gate:fixture": "true" } }));
    const profilePath = join(repo, "profile.json");
    writeFileSync(profilePath, JSON.stringify(fixtureRegistry({ "gate:fixture": gate("gate:fixture") })));
    spawnSync("git", ["add", "package.json", "profile.json"], { cwd: repo });
    spawnSync("git", ["commit", "-qm", "prepared fixture"], { cwd: repo });
    const snapshot = createImmutableSnapshot(repo, "HEAD");
    try {
      const report = await runImmutableBattery({ repo, candidate: "HEAD", registryPath: profilePath, preparedSnapshotPath: snapshot.path, prepareSnapshot: false, context: "ci", executor: async (_entry, _identity, execution) => {
        expect(execution.cwd).toBe(snapshot.path);
        return { ok: true, status: "passed", exit_code: 0, duration_ms: 1, output: "" };
      } });
      expect(report).toMatchObject({ ok: true, status: "passed" });
    } finally { snapshot.cleanup(); }
  });

  it("rejects a report that registers but does not execute a required CI gate", () => {
    const registry = fixtureRegistry({ required: gate("required") });
    const report = { candidate_oid: identity.candidate_oid, input_digest: identity.input_digest, profile_version: registry.profile_version, profile_fingerprint: "fixture", status: "passed", gates: [], execution_manifest: { digest: "forged" } };
    expect(validateAggregateExecutionReport({ report, registry, expectedCandidate: identity }).failures).toContain("required_gate_not_executed:required");
    expect(validateAggregateExecutionReport({ report, registry, expectedCandidate: identity }).failures).toContain("report_profile_fingerprint_mismatch");
  });

  it("terminates timed-out process groups and removes detached snapshots", async () => {
    const timed = await runDeadlineProcess({ command: process.execPath, args: ["-e", "setTimeout(() => {}, 1000)"], cwd: ROOT, timeout_ms: 20 });
    expect(timed.status).toBe("timed_out");
    const marker = join(temporary("revoy2-timeout-child-"), "cleanup.txt");
    // This is a real OS process-group probe, kept outside Vitest's Bun worker:
    // a SIGTERM-aware grandchild must flush cleanup, then the group must be
    // gone after the bounded SIGKILL. It mirrors runDeadlineProcess's
    // detached-group deadline protocol without making the test worker itself
    // a signal target.
    const probeSource = `
      const fs = require("node:fs");
      const { spawn } = require("node:child_process");
      const marker = process.argv[1];
      const grandchild = 'const fs=require("node:fs");process.on("SIGTERM",()=>fs.appendFileSync(process.argv[1],"term\\\\n"));fs.writeFileSync(process.argv[1],String(process.pid)+"\\\\nready\\\\n");setInterval(()=>{},1000)';
      const leader = 'const {spawn}=require("node:child_process");spawn(process.execPath,["-e",process.argv[2],process.argv[1]],{stdio:"ignore"});setInterval(()=>{},1000)';
      const child = spawn(process.execPath, ["-e", leader, marker, grandchild], { detached: true, stdio: "ignore" });
      setTimeout(() => { process.kill(-child.pid, "SIGTERM"); setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch {} }, 25); }, 100);
      child.on("close", () => setTimeout(() => {
        const content = fs.readFileSync(marker, "utf8");
        const pid = Number(content.match(/^\\d+/)?.[0]);
        let state = null; try { state = fs.readFileSync(\`/proc/\${pid}/stat\`, "utf8").split(" ")[2]; } catch {}
        console.log(JSON.stringify({ content, state }));
      }, 100));
    `;
    const probe = spawnSync("node", ["-e", probeSource, marker], { cwd: ROOT, encoding: "utf8", timeout: 5_000 });
    expect(probe.status).toBe(0);
    const observed = JSON.parse(probe.stdout);
    expect(observed.content).toContain("ready");
    expect(observed.content).toContain("term");
    expect(observed.state).toBeNull();
    const repo = fixtureRepo();
    const snapshot = createImmutableSnapshot(repo);
    expect(existsSync(snapshot.path)).toBe(true);
    snapshot.cleanup();
    expect(existsSync(snapshot.path)).toBe(false);
  });
});

describe("atomic evidence transaction", () => {
  it("permits exactly one owner and only owner-delegated producers", () => {
    const repo = fixtureRepo();
    const lease = acquireEvidenceTransaction({ repo, transactionId: "owner-tx" });
    expect(() => acquireEvidenceTransaction({ repo, transactionId: "contender" })).toThrow(EvidenceTransactionRefusal);
    expect(assertEvidenceProducerAuthority(repo, lease.environment)).toMatchObject({ delegated: true, transaction_id: "owner-tx" });
    expect(() => assertEvidenceProducerAuthority(repo, { REVOY_EVIDENCE_TRANSACTION_ID: "owner-tx", REVOY_EVIDENCE_DELEGATION_TOKEN: "forged" })).toThrow(EvidenceTransactionRefusal);
    lease.release();
  });

  it("refuses live or ambiguous lease theft and recovers a provably dead owner only explicitly", () => {
    const repo = fixtureRepo();
    const live = acquireEvidenceTransaction({ repo, transactionId: "live-tx" });
    expect(() => recoverEvidenceTransaction({ repo, transactionId: "live-tx" })).toThrow(/still live/);
    live.release();
    const paths = evidenceTransactionPaths(repo);
    mkdirSync(paths.lock, { recursive: true });
    const state = { schema_version: 1, transaction_id: "dead-tx", owner: { owner_id: "dead", pid: 999999, process_start_identity: "linux-proc-start:0" }, expected_candidate_oid: identity.candidate_oid, expected_input_digest: identity.input_digest, phase: "stalled", heartbeat_at: "2020-01-01T00:00:00.000Z", delegation_token_digest: hash("dead-token") };
    writeFileSync(paths.state, `${JSON.stringify(state)}\n`);
    const recovered = recoverEvidenceTransaction({ repo, transactionId: "dead-tx" });
    expect(recovered.ok).toBe(true);
    expect(existsSync(paths.lock)).toBe(false);
    mkdirSync(paths.lock, { recursive: true });
    writeFileSync(paths.state, `${JSON.stringify({ ...state, transaction_id: "ambiguous-tx", owner: { owner_id: "ambiguous", pid: process.pid, process_start_identity: null } })}\n`);
    expect(() => acquireEvidenceTransaction({ repo, transactionId: "new-tx" })).toThrow(/not removed or stolen/);
    expect(() => recoverEvidenceTransaction({ repo, transactionId: "ambiguous-tx" })).toThrow(/cannot be proven dead/);
  });

  it("limits contender waiting and fails closed when delegated identity fields are absent", async () => {
    const repo = fixtureRepo();
    const owner = acquireEvidenceTransaction({ repo, transactionId: "wait-owner" });
    await expect(acquireEvidenceTransactionWithWait({ repo, transactionId: "waiter", wait_ms: 1 })).rejects.toMatchObject({ code: "bounded_wait_exhausted" });
    expect(() => assertEvidenceProducerAuthority(repo, { REVOY_EVIDENCE_TRANSACTION_ID: "wait-owner", REVOY_EVIDENCE_DELEGATION_TOKEN: owner.delegation_token })).toThrow(/candidate OID/);
    owner.release();
  });

  it("permits the transaction's delegated detached setup build, but not an ordinary consumer", () => {
    const repo = fixtureRepo();
    const transactionModule = resolve(ROOT, "scripts/evidence-transaction.mjs");
    const planModule = resolve(ROOT, "scripts/lib/governance-plan.mjs");
    writeFileSync(join(repo, "package.json"), JSON.stringify({ scripts: { build: "bun build-check.mjs" } }));
    writeFileSync(join(repo, "build-check.mjs"), [
      `import { evidenceTransactionReadStatus } from ${JSON.stringify(transactionModule)};`,
      `import { assertGovernanceConsumerReady } from ${JSON.stringify(planModule)};`,
      "const status = evidenceTransactionReadStatus({ repo: process.cwd() });",
      "const result = assertGovernanceConsumerReady({ consumer: 'staging build', evidenceStatus: status });",
      "if (result.status !== 'delegated_read_ready') throw new Error('missing delegated setup authority');",
    ].join("\n"));
    spawnSync("git", ["add", "package.json", "build-check.mjs"], { cwd: repo });
    expect(spawnSync("git", ["commit", "-qm", "staging setup fixture"], { cwd: repo }).status).toBe(0);
    const staging = temporary("revoy2-detached-staging-");
    rmSync(staging, { recursive: true, force: true });
    expect(spawnSync("git", ["worktree", "add", "--detach", staging, "HEAD"], { cwd: repo }).status).toBe(0);
    const lease = acquireEvidenceTransaction({ repo, transactionId: "setup-read-tx" });
    const setupEnvironment = { ...lease.environment, REVOY_EVIDENCE_READ_SCOPE: "candidate_setup" };
    try {
      // The source and detached candidate share git-common-dir, which is the
      // real refresh topology: only the explicit delegated setup may read.
      expect(() => assertGovernanceConsumerReady({ consumer: "ordinary consumer", evidenceStatus: evidenceTransactionStatus({ repo: staging }) })).toThrow(/refuses derived governance evidence/);
      expect(() => assertGovernanceConsumerReady({
        consumer: "forged delegated consumer",
        evidenceStatus: evidenceTransactionReadStatus({ repo: staging, environment: { REVOY_EVIDENCE_READ_SCOPE: "candidate_setup" } }),
      })).toThrow(/refuses derived governance evidence/);
      expect(evidenceTransactionReadStatus({ repo: staging, environment: setupEnvironment })).toMatchObject({ held: true, delegated_read: true, read_scope: "candidate_setup" });
      expect(() => runEvidenceStagingSetup({ cwd: staging, environment: setupEnvironment })).not.toThrow();
    } finally {
      lease.release();
      spawnSync("git", ["worktree", "remove", "--force", staging], { cwd: repo });
    }
  });

  it("publishes newly-created evidence through the staging index and refuses producer source edits", async () => {
    const repo = fixtureRepo();
    const published = await runEvidenceRefreshTransaction({ repo, producer: async ({ cwd }) => {
      mkdirSync(join(cwd, ".claim-ledger"), { recursive: true });
      writeFileSync(join(cwd, ".claim-ledger", "new-evidence.jsonl"), "{\"evidence\":true}\n");
      return { output: "fixture producer" };
    } });
    expect(published).toMatchObject({ ok: true, published: true });
    expect(published.phase_events).toEqual([
      { schema_version: 1, kind: "revoy2.governance_producer_plan", name: "evidence-refresh", sequence: 1, phase: "producer", status: "started" },
      { schema_version: 1, kind: "revoy2.governance_producer_plan", name: "evidence-refresh", sequence: 2, phase: "producer", status: "succeeded" },
      { schema_version: 1, kind: "revoy2.governance_producer_plan", name: "evidence-refresh", sequence: 3, phase: "normalization", status: "started" },
      { schema_version: 1, kind: "revoy2.governance_producer_plan", name: "evidence-refresh", sequence: 4, phase: "normalization", status: "succeeded" },
      { schema_version: 1, kind: "revoy2.governance_producer_plan", name: "evidence-refresh", sequence: 5, phase: "commit", status: "started" },
      { schema_version: 1, kind: "revoy2.governance_producer_plan", name: "evidence-refresh", sequence: 6, phase: "commit", status: "succeeded" },
    ]);
    expect(readFileSync(join(repo, ".claim-ledger", "new-evidence.jsonl"), "utf8")).toContain("evidence");
    expect(spawnSync("git", ["diff", "--cached", "--name-only"], { cwd: repo, encoding: "utf8" }).stdout).toContain(".claim-ledger/new-evidence.jsonl");

    const large = fixtureRepo();
    const largePublished = await runEvidenceRefreshTransaction({ repo: large, producer: async ({ cwd }) => {
      mkdirSync(join(cwd, ".claim-ledger"), { recursive: true });
      writeFileSync(join(cwd, ".claim-ledger", "large-evidence.jsonl"), "x".repeat(1_200_000));
      return { output: "large fixture producer" };
    } });
    expect(largePublished.published).toBe(true);
    expect(spawnSync("git", ["diff", "--cached", "--name-only"], { cwd: large, encoding: "utf8" }).stdout).toContain(".claim-ledger/large-evidence.jsonl");

    const rejected = fixtureRepo();
    await expect(runEvidenceRefreshTransaction({ repo: rejected, producer: async ({ cwd }) => {
      writeFileSync(join(cwd, "tracked.txt"), "producer source edit\n");
      return { output: "bad producer" };
    } })).rejects.toMatchObject({ code: "candidate_identity_mismatch" });
    expect(readFileSync(join(rejected, "tracked.txt"), "utf8")).toBe("one\n");
    expect(spawnSync("git", ["status", "--porcelain"], { cwd: rejected, encoding: "utf8" }).stdout).toBe("");
  });

  it("seals a tracked source overlay into commit-ready evidence and refuses concurrent source tampering", async () => {
    const repo = fixtureRepo();
    writeFileSync(join(repo, "tracked.txt"), "candidate source edit\n");
    const refreshed = await runEvidenceRefreshTransaction({ repo, producer: async ({ cwd }) => {
      expect(readFileSync(join(cwd, "tracked.txt"), "utf8")).toBe("candidate source edit\n");
      mkdirSync(join(cwd, ".claim-ledger"), { recursive: true });
      writeFileSync(join(cwd, ".claim-ledger", "source-overlay.jsonl"), "{\"candidate\":true}\n");
      return { output: "source overlay producer" };
    } });
    expect(refreshed).toMatchObject({ ok: true, published: true });
    expect(readFileSync(join(repo, ".claim-ledger", "source-overlay.jsonl"), "utf8")).toContain("candidate");
    spawnSync("git", ["add", "tracked.txt"], { cwd: repo });
    expect(spawnSync("git", ["commit", "-qm", "source and evidence"], { cwd: repo }).status).toBe(0);
    expect(spawnSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" }).stdout).toBe("");

    const tampered = fixtureRepo();
    writeFileSync(join(tampered, "tracked.txt"), "candidate source edit\n");
    await expect(runEvidenceRefreshTransaction({ repo: tampered, producer: async ({ cwd }) => {
      mkdirSync(join(cwd, ".claim-ledger"), { recursive: true });
      writeFileSync(join(cwd, ".claim-ledger", "should-not-publish.jsonl"), "{\"candidate\":true}\n");
      writeFileSync(join(tampered, "tracked.txt"), "concurrent source tamper\n");
      return { output: "tampering producer" };
    } })).rejects.toMatchObject({ code: "candidate_identity_mismatch" });
    expect(existsSync(join(tampered, ".claim-ledger", "should-not-publish.jsonl"))).toBe(false);
    expect(spawnSync("git", ["diff", "--cached", "--name-only"], { cwd: tampered, encoding: "utf8" }).stdout).toBe("");
  });

  it("evidence:status — reports absence, a live owner, and a dead owner with its exact recovery command", () => {
    const repo = fixtureRepo();

    // No lock: a normal state, reported plainly, never an error.
    expect(evidenceTransactionStatus({ repo })).toMatchObject({ ok: true, held: false, message: "no evidence transaction held" });

    // Live owner: reported, never a recovery command (that would be theft).
    const lease = acquireEvidenceTransaction({ repo, transactionId: "status-live-tx" });
    const live = evidenceTransactionStatus({ repo });
    expect(live).toMatchObject({ ok: true, held: true, transaction_id: "status-live-tx", liveness: "live", recovery_command: null });
    expect(live.message).toContain("status-live-tx");
    expect(live.message).toContain("LIVE");
    lease.release();

    // Dead owner: reported with the transaction id already filled into the
    // exact `evidence:recover` command an operator would otherwise have to
    // dig out of state.json by hand.
    const paths = evidenceTransactionPaths(repo);
    mkdirSync(paths.lock, { recursive: true });
    writeFileSync(paths.state, `${JSON.stringify({
      schema_version: 1,
      transaction_id: "status-dead-tx",
      owner: { owner_id: "dead", pid: 999999, process_start_identity: "linux-proc-start:0", acquired_at: "2020-01-01T00:00:00.000Z" },
      expected_candidate_oid: identity.candidate_oid,
      expected_input_digest: identity.input_digest,
      phase: "stalled",
      heartbeat_at: "2020-01-01T00:00:00.000Z",
      delegation_token_digest: hash("dead-token"),
    })}\n`);
    const dead = evidenceTransactionStatus({ repo });
    expect(dead).toMatchObject({ ok: true, held: true, transaction_id: "status-dead-tx", liveness: "dead", recovery_command: "bun run evidence:recover -- --transaction status-dead-tx" });
    expect(dead.message).toContain("bun run evidence:recover -- --transaction status-dead-tx");
  });

  it("names evidence:status as the first diagnostic step in the not_lock_owner and owner_exists refusals", () => {
    const repo = fixtureRepo();
    const owner = acquireEvidenceTransaction({ repo, transactionId: "diagnostics-tx" });
    expect(() => acquireEvidenceTransaction({ repo, transactionId: "contender" })).toThrow(/bun run evidence:status/);
    expect(() => assertEvidenceProducerAuthority(repo, { REVOY_EVIDENCE_TRANSACTION_ID: "diagnostics-tx", REVOY_EVIDENCE_DELEGATION_TOKEN: "forged" })).toThrow(/bun run evidence:status/);
    owner.release();
  });

  it("rolls back an applied evidence patch when the source races in the post-apply window", () => {
    const staging = fixtureRepo();
    mkdirSync(join(staging, ".claim-ledger"), { recursive: true });
    writeFileSync(join(staging, ".claim-ledger", "post-apply-race.jsonl"), "{\"evidence\":true}\n");
    spawnSync("git", ["add", ".claim-ledger/post-apply-race.jsonl"], { cwd: staging });
    const patch = spawnSync("git", ["diff", "--cached", "--binary", "--full-index", "HEAD"], { cwd: staging, encoding: "utf8" }).stdout;
    const target = fixtureRepo();
    const sourceIdentity = resolveEvidenceSourceIdentity(target);
    expect(() => publishEvidencePatch({ repo: target, patch, identity: sourceIdentity, afterApply: () => writeFileSync(join(target, "tracked.txt"), "post-apply source race\n") })).toThrow(EvidenceTransactionRefusal);
    expect(existsSync(join(target, ".claim-ledger", "post-apply-race.jsonl"))).toBe(false);
    expect(spawnSync("git", ["diff", "--cached", "--name-only"], { cwd: target, encoding: "utf8" }).stdout).toBe("");
  });
});

describe("organization enrollment", () => {
  it("fails known missing enrollment and required empty inventories, while required authority is fail-closed", () => {
    const inventory = { schema_version: 1, mode: "required", organization: "org", canonical_repository: "org/known", scope: { kind: "allowlist" }, repositories: [{ repository: "org/known", required_profile_version: "fixture-v1" }] };
    const missing = reconcileEnrollment({ inventory, manifests: { entries: [] }, candidate: identity, profileVersion: "fixture-v1" });
    expect(missing.failures[0].code).toBe("missing_enrollment");
    const empty = reconcileEnrollment({ inventory: { ...inventory, repositories: [] }, manifests: { entries: [] }, candidate: identity, profileVersion: "fixture-v1" });
    expect(empty.failures.some((failure) => failure.code === "required_inventory_empty")).toBe(true);
    const bootstrap = reconcileEnrollment({ inventory: { ...inventory, mode: "bootstrap", repositories: [] }, manifests: { entries: [] }, candidate: identity, profileVersion: "fixture-v1" });
    expect(bootstrap).toMatchObject({ ok: true, authoritative: false, mode: "bootstrap" });
    const manifests = { entries: [{ schema_version: 1, repository: "org/known", organization: "org", profile_version: "fixture-v1", ci_contract: { aggregate_check: "fixture", workflow_path: ".github/workflows/ci.yml", attestation_kind: "revoy2.aggregate_gate_attestation" }, attestation: { endpoint: "fixture://attestation", status: "unverifiable" } }] };
    const unverifiable = reconcileEnrollment({ inventory, manifests, candidate: identity, profileVersion: "fixture-v1", provider: { status: "configured" } });
    expect(unverifiable).toMatchObject({ ok: true, gate_ok: false, authoritative: false, reconciliation: { status: "unverifiable" } });
    const repositories = [{ repository: "org/known", archived: false, default_branch: "main", workflow_paths: [".github/workflows/ci.yml"] }];
    const receipt = enrollmentReceipt({ inventory, manifests, repositories });
    expect(validateGitHubEnrollmentReceipt({ receipt, inventory, manifests, candidate: identity, profileVersion: "fixture-v1" }).ok).toBe(true);
    expect(reconcileEnrollment({ inventory, manifests, candidate: identity, profileVersion: "fixture-v1", providerReceipt: receipt })).toMatchObject({ gate_ok: true, authoritative: true });
    expect(validateGitHubEnrollmentReceipt({ receipt: { ...receipt, repository_access_proof: { ...receipt.repository_access_proof, private: false } }, inventory, manifests, candidate: identity, profileVersion: "fixture-v1" }).failures).toContain("provider_repository_access_proof_invalid");
    expect(reconcileEnrollment({ inventory, manifests, candidate: identity, profileVersion: "fixture-v1", providerReceipt: { ...receipt, organization: "wrong" } }).authoritative).toBe(false);
    expect(validateGitHubEnrollmentReceipt({ receipt: enrollmentReceipt({ inventory, manifests, repositories, observedAt: "2000-01-01T00:00:00.000Z" }), inventory, manifests, candidate: identity, profileVersion: "fixture-v1" }).failures).toContain("provider_receipt_stale");
    expect(validateGitHubEnrollmentReceipt({ receipt: enrollmentReceipt({ inventory, manifests, repositories: [] }), inventory, manifests, candidate: identity, profileVersion: "fixture-v1" }).failures).toContain("provider_allowlist_repository_set_mismatch");
  });

  it("directly queries every allowlisted repository and never calls organization enumeration", () => {
    const inventory = { schema_version: 1, mode: "required", organization: "org", canonical_repository: "org/known", scope: { kind: "allowlist" }, repositories: [{ repository: "org/known", required_profile_version: "fixture-v1" }, { repository: "org/second", required_profile_version: "fixture-v1" }] };
    const manifests = { entries: [] };
    const calls = [];
    const receipt = collectGitHubEnrollmentReceipt({ inventory, manifests, candidate: identity, profileVersion: "fixture-v1", gh: (args) => {
      calls.push(args.join(" "));
      if (args[0] === "/repos/org/known") return { full_name: "org/known", private: true, archived: false, default_branch: "main" };
      if (args[0] === "/repos/org/second") return { full_name: "org/second", private: true, archived: false, default_branch: "main" };
      if (args[0]?.includes("/contents/.github/workflows?ref=main")) return [{ path: ".github/workflows/ci.yml" }];
      throw new Error(`unexpected API call ${args.join(" ")}`);
    } });
    expect(calls).toEqual(expect.arrayContaining(["/repos/org/known", "/repos/org/second", "/repos/org/known/contents/.github/workflows?ref=main", "/repos/org/second/contents/.github/workflows?ref=main"]));
    expect(calls).not.toContain("user");
    expect(calls.some((call) => call.includes("/orgs/org/repos"))).toBe(false);
    expect(calls.some((call) => call.includes("/actions/workflows"))).toBe(false);
    expect(receipt.coverage).toMatchObject({ mode: "allowlist", organization_enumeration_complete: false, authority: "direct_governed_repository_queries" });
    expect(receipt.repository_access_proof).toMatchObject({ kind: "github_api_private_repository_contents", repository: "org/known", private: true, default_branch: "main", workflow_paths: [".github/workflows/ci.yml"] });
    expect(validateGitHubEnrollmentReceipt({ receipt, inventory, manifests, candidate: identity, profileVersion: "fixture-v1" }).ok).toBe(true);
    expect(() => collectGitHubEnrollmentReceipt({ inventory: { ...inventory, repositories: [inventory.repositories[0]] }, manifests, candidate: identity, profileVersion: "fixture-v1", gh: (args) => {
      if (args[0] === "/repos/org/known") return { full_name: "org/known", private: true, archived: false, default_branch: "main" };
      if (args[0]?.includes("/contents/.github/workflows?ref=main")) throw new Error("gh: Resource not accessible by integration (HTTP 403)");
      throw new Error(`unexpected API call ${args.join(" ")}`);
    } })).toThrow("GitHub Contents API workflow verification failed");
  });

  it("rejects partial organization visibility and dynamically reports workflow-scoped enrollment gaps", () => {
    const inventory = { schema_version: 1, mode: "required", organization: "org", canonical_repository: "org/known", scope: { kind: "all_non_archived_with_workflows" }, repositories: [{ repository: "org/known", required_profile_version: "fixture-v1" }] };
    const manifests = { entries: [{ schema_version: 1, repository: "org/known", organization: "org", profile_version: "fixture-v1", ci_contract: { aggregate_check: "fixture", workflow_path: ".github/workflows/ci.yml", attestation_kind: "revoy2.aggregate_gate_attestation" }, attestation: { endpoint: "fixture://attestation", status: "unverifiable" } }] };
    const repositories = [
      { repository: "org/known", archived: false, default_branch: "main", workflow_paths: [".github/workflows/ci.yml"] },
      { repository: "org/unmanaged", archived: false, default_branch: "main", workflow_paths: [".github/workflows/ci.yml"] },
      { repository: "org/no-ci", archived: false, default_branch: "main", workflow_paths: [] },
    ];
    const partial = enrollmentReceipt({ inventory, manifests, repositories, coverage: { mode: "all_non_archived_with_workflows", organization_enumeration_complete: false, authority: "organization_enumeration_unverified", membership: { state: "active", role: "member" }, observed_active_repositories: repositories.map((entry) => entry.repository), workflow_queries_complete: true } });
    expect(validateGitHubEnrollmentReceipt({ receipt: partial, inventory, manifests, candidate: identity, profileVersion: "fixture-v1" }).failures).toContain("provider_organization_enumeration_incomplete");
    const falseComplete = enrollmentReceipt({ inventory, manifests, repositories, coverage: { mode: "all_non_archived_with_workflows", organization_enumeration_complete: true, authority: "direct_governed_repository_queries", membership: { state: "active", role: "admin" }, observed_active_repositories: repositories.map((entry) => entry.repository), workflow_queries_complete: true } });
    expect(validateGitHubEnrollmentReceipt({ receipt: falseComplete, inventory, manifests, candidate: identity, profileVersion: "fixture-v1" }).failures).toContain("provider_organization_enumeration_authority_invalid");
    const complete = enrollmentReceipt({ inventory, manifests, repositories, coverage: { mode: "all_non_archived_with_workflows", organization_enumeration_complete: true, authority: "organization_owner_membership", membership: { state: "active", role: "admin" }, observed_active_repositories: repositories.map((entry) => entry.repository), workflow_queries_complete: true } });
    const result = reconcileEnrollment({ inventory, manifests, candidate: identity, profileVersion: "fixture-v1", providerReceipt: complete });
    expect(result.authoritative).toBe(false);
    expect(result.failures.some((failure) => failure.code === "unenrolled_observed_repository" && failure.repository === "org/unmanaged")).toBe(true);
    expect(result.reconciliation.non_ci_active_repositories).toEqual(["org/no-ci"]);
  });

  it("returns a nonzero required-gate CLI result without an authenticated receipt", () => {
    const process = spawnSync("bun", ["scripts/enrollment-reconcile.mjs", "--repo", ROOT], { cwd: ROOT, encoding: "utf8" });
    expect(process.status).toBe(1);
    expect(JSON.parse(process.stdout)).toMatchObject({ ok: true, gate_ok: false, authoritative: false, reconciliation: { status: "unverifiable" } });
  });
});

describe("central attestation boundary", () => {
  it("accepts complete platform-authenticated CI evidence and distinguishes all non-authoritative states", () => {
    const registry = loadExecutionProfile();
    const report = { candidate_oid: identity.candidate_oid, input_digest: identity.input_digest, status: "passed", gates: requiredCiGateNames(registry).map((gateName) => ({ gate: gateName, status: "passed", candidate_oid: identity.candidate_oid, input_digest: identity.input_digest, profile_version: registry.profile_version, duration_ms: 1 })) };
    const attestation = makeAggregateAttestation({ report, registry, repository: "org/repo", workflowRef: "org/repo/.github/workflows/ci.yml@main", runId: "42", runAttempt: "1" });
    const receipt = platformReceipt(attestation);
    expect(verifyCentralAttestation({ attestation, registry, expectedCandidate: identity, expectedRepository: "org/repo", fixturePlatformReceipt: receipt }).ok).toBe(true);
    expect(validateGitHubActionsAttestationReceipt({ receipt, attestation, expectedCandidate: identity, expectedRepository: "org/repo" }).ok).toBe(true);
    const collected = collectGitHubActionsAttestationReceipt({ attestation, repository: "org/repo", gh: (args) => {
      if (args[0] === "user") return { login: "fixture", id: 1, type: "User" };
      // GitHub's live run endpoint returns a path only, not `path@revision`.
      if (args[0] === "/repos/org/repo/actions/runs/42") return { id: "42", run_attempt: "1", head_sha: identity.candidate_oid, conclusion: "success", path: ".github/workflows/ci.yml" };
      if (args[0] === `/repos/org/repo/contents/.github/workflows/ci.yml?ref=${identity.candidate_oid}`) return { sha: "f".repeat(40) };
      if (args[0].includes("/artifacts?")) return { artifacts: [{ id: 7, name: receipt.artifact.name, digest: "sha256:fixture" }] };
      throw new Error(`unexpected ${args.join(" ")}`);
    }, artifactFetcher: () => attestation });
    expect(validateGitHubActionsAttestationReceipt({ receipt: collected, attestation, expectedCandidate: identity, expectedRepository: "org/repo" }).ok).toBe(true);
    expect(collected).toMatchObject({ workflow: { workflow_path: ".github/workflows/ci.yml", content_ref: identity.candidate_oid, content_blob_sha: "f".repeat(40) }, run: { workflow_path: ".github/workflows/ci.yml" } });
    expect(verifyCentralAttestation({ attestation: null, registry, expectedCandidate: identity, expectedRepository: "org/repo" }).code).toBe("attestation_absent");
    expect(verifyCentralAttestation({ attestation: { ...attestation, issuer: { ...attestation.issuer, kind: "local" } }, registry, expectedCandidate: identity, expectedRepository: "org/repo", fixturePlatformReceipt: receipt }).failures).toContain("issuer_untrusted");
    expect(verifyCentralAttestation({ attestation: { ...attestation, candidate: { ...attestation.candidate, oid: "c".repeat(40) } }, registry, expectedCandidate: identity, expectedRepository: "org/repo", fixturePlatformReceipt: receipt }).failures).toContain("candidate_sha_mismatch");
    expect(verifyCentralAttestation({ attestation: { ...attestation, candidate: { ...attestation.candidate, input_digest: "d".repeat(64) } }, registry, expectedCandidate: identity, expectedRepository: "org/repo", fixturePlatformReceipt: receipt }).failures).toContain("input_digest_mismatch");
    expect(verifyCentralAttestation({ attestation: { ...attestation, execution_profile: { ...attestation.execution_profile, version: "forged-profile" } }, registry, expectedCandidate: identity, expectedRepository: "org/repo", fixturePlatformReceipt: receipt }).failures).toContain("profile_mismatch");
    const unavailable = { ...attestation, gates: attestation.gates.map((gate) => gate.gate === attestation.required_gates[0] ? { ...gate, status: "runner_unavailable" } : gate) };
    expect(verifyCentralAttestation({ attestation: unavailable, registry, expectedCandidate: identity, expectedRepository: "org/repo", fixturePlatformReceipt: receipt }).failures.some((failure) => failure.startsWith("runner_unavailable:"))).toBe(true);
    const missingGate = { ...attestation, gates: attestation.gates.slice(1) };
    expect(verifyCentralAttestation({ attestation: missingGate, registry, expectedCandidate: identity, expectedRepository: "org/repo", fixturePlatformReceipt: receipt }).failures.some((failure) => failure.startsWith("required_gate_missing:"))).toBe(true);
    expect(verifyCentralAttestation({ attestation, registry, expectedCandidate: identity, expectedRepository: "org/repo", fixturePlatformReceipt: { ...receipt, run: { ...receipt.run, id: "wrong" } } }).failures).toContain("platform_receipt_run_mismatch");
    expect(verifyCentralAttestation({ attestation, registry, expectedCandidate: identity, expectedRepository: "org/repo", fixturePlatformReceipt: { ...receipt, artifact: { ...receipt.artifact, name: "forged" } } }).failures).toContain("platform_receipt_artifact_mismatch");
    expect(verifyCentralAttestation({ attestation, registry, expectedCandidate: identity, expectedRepository: "org/repo", fixturePlatformReceipt: { ...receipt, workflow: { ...receipt.workflow, content_ref: "c".repeat(40) } } }).failures).toContain("platform_receipt_workflow_content_ref_mismatch");
    expect(verifyCentralAttestation({ attestation, registry, expectedCandidate: identity, expectedRepository: "org/repo", fixturePlatformReceipt: { source: "github_api", authenticated: true } }).failures).toContain("platform_receipt_schema_invalid");
  });

  it("refuses production verification without a GitHub API token or with a local receipt file", () => {
    const noToken = spawnSync("bun", ["scripts/enforcement-attestation.mjs", "verify", "--github-api", "--repository", "org/repo"], { cwd: ROOT, encoding: "utf8", env: { ...process.env, GH_TOKEN: "" } });
    expect(noToken.status).toBe(1);
    expect(noToken.stderr).toContain("requires GH_TOKEN");
    const localReceipt = spawnSync("bun", ["scripts/enforcement-attestation.mjs", "verify", "--receipt", "fixture.json"], { cwd: ROOT, encoding: "utf8", env: { ...process.env, GH_TOKEN: "fixture" } });
    expect(localReceipt.status).toBe(1);
    expect(localReceipt.stderr).toContain("not a production authority input");
  });

  it("proves the workflow, hook, and trunk commands are mechanically bound to the profile", () => {
    const registry = loadExecutionProfile();
    const problems = auditWorkflowProfile({ registry, workflowText: readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8"), prePushText: readFileSync(join(ROOT, "scripts/hooks/pre-push"), "utf8"), preCommitText: readFileSync(join(ROOT, "scripts/hooks/pre-commit"), "utf8"), trunkSubmitText: readFileSync(join(ROOT, "scripts/trunk-submit.mjs"), "utf8") });
    expect(problems).toEqual([]);
    const permissionDrift = auditWorkflowProfile({ registry, workflowText: readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8").replace("contents: read", "contents: none"), prePushText: readFileSync(join(ROOT, "scripts/hooks/pre-push"), "utf8"), trunkSubmitText: readFileSync(join(ROOT, "scripts/trunk-submit.mjs"), "utf8") });
    expect(permissionDrift).toContain("gate:organization-enrollment requires CI permission contents: read");
  });

  it("never upgrades to BLOCKED when branch protection or platform inspection is absent", () => {
    const readiness = serverEnforcementReadiness({ repository: "org/repo" });
    expect(readiness).toMatchObject({ ok: false, tier: "DETECTED" });
    expect(readiness.failures).toEqual(expect.arrayContaining([
      "platform_protection_unverifiable",
      "protected_ref_not_enabled",
    ]));
    const forged = { schema_version: 1, kind: "revoy2.github_protection_receipt", source: "caller", authenticated: true, principal: { login: "forged" }, repository: "org/repo", observed_at: new Date().toISOString(), visibility: "private", plan: "free", branch_protection: { enabled: false, required_checks: [] } };
    expect(validateGitHubProtectionReceipt({ receipt: forged, repository: "org/repo" }).ok).toBe(false);
    const collected = collectGitHubProtectionReceipt({ repository: "org/repo", gh: (path) => {
      if (path === "user") return { login: "fixture", id: 1 };
      if (path === "/repos/org/repo") return { private: true, default_branch: "main", organization: { plan: { name: "free" } } };
      if (path === "/repos/org/repo/branches/main/protection") return { required_status_checks: { contexts: [] } };
      throw new Error(`unexpected ${path}`);
    } });
    expect(collected.plan).toBe("unknown");
  });
});

describe("gate-all.mjs / execution-profile tier agreement (2026-08-24)", () => {
  it("agrees exactly against the real repository's profile", async () => {
    const problems = await auditGateAllTierAgreement({ repo: ROOT });
    expect(problems).toEqual([]);
  });

  it("names a gate the profile selects at `stop` but gate-all's stop battery would not run (contexts vs cost_class disagree)", async () => {
    const registry = loadExecutionProfile();
    // gate:adr-status is real cost_class "fast" — declaring it contexts.stop:
    // true (without also lowering its cost_class) is exactly the drift this
    // assertion exists to catch: the profile now says it belongs at Stop, but
    // gate-all's cost_class-budgeted stop tier still would not run it.
    const drifted = {
      ...registry,
      gates: {
        ...registry.gates,
        "gate:adr-status": { ...registry.gates["gate:adr-status"], contexts: { ...registry.gates["gate:adr-status"].contexts, stop: true } },
      },
    };
    const problems = await auditGateAllTierAgreement({ repo: ROOT, registry: drifted });
    expect(problems.some((problem) => problem.includes("gate:adr-status") && problem.includes('--tier stop is missing'))).toBe(true);
  });

  it("the real incident is caught the other way too: restoring gate:organization-enrollment's contexts.stop to true resolves the divergence", async () => {
    // Today's real profile has contexts.stop:false for this gate, and
    // gate-all.mjs's own fixed tierRoster already excludes it — so the real
    // repo passes (previous test). This proves the assertion is sensitive to
    // the exact bug: giving the gate BACK contexts.stop:true (undoing the
    // profile's own exclusion) must make the two selectors agree again,
    // since tierRoster is a subset of selectedGates by construction.
    const registry = loadExecutionProfile();
    const restored = {
      ...registry,
      gates: {
        ...registry.gates,
        "gate:organization-enrollment": { ...registry.gates["gate:organization-enrollment"], contexts: { ...registry.gates["gate:organization-enrollment"].contexts, stop: true } },
      },
    };
    expect(await auditGateAllTierAgreement({ repo: ROOT, registry: restored })).toEqual([]);
  });
});

describe("evidence source identity refusal messages (gate design rule: name every cause)", () => {
  it("lists every untracked source path and the three remedies in one refusal", () => {
    const target = fixtureRepo();
    writeFileSync(join(target, "stray-one.txt"), "a\n");
    mkdirSync(join(target, "notes"), { recursive: true });
    writeFileSync(join(target, "notes", "stray-two.md"), "b\n");
    let thrown = null;
    try { resolveEvidenceSourceIdentity(target); } catch (error) { thrown = error; }
    expect(thrown).toBeInstanceOf(EvidenceTransactionRefusal);
    expect(thrown.code).toBe("untracked_source_input_refused");
    expect(thrown.message).toContain("2 untracked source path(s)");
    expect(thrown.message).toContain("stray-one.txt");
    expect(thrown.message).toContain("notes/stray-two.md");
    expect(thrown.message).toContain("commit them, add them to .gitignore, or move them out of the tree");
  });
});

describe("the prerequisite/gate_order audit asks a structural question", () => {
  // It used to route through compareGateOrder, whose group tie-break is the
  // gate's NAME -- correct for giving the scheduler a stable total order,
  // wrong for deciding whether a declared dependency is legal. Two structurally
  // identical same-group pairs got opposite verdicts, and the real profile
  // passed only because "gate:coverage" sorts before "gate:hollow-parity".
  const PKG = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

  function withPrerequisite(dependent, prerequisite) {
    const registry = JSON.parse(JSON.stringify(loadExecutionProfile()));
    for (const gate of [dependent, prerequisite]) registry.gates[gate].prerequisites = [];
    registry.gates[dependent].prerequisites = [prerequisite];
    // A prerequisite must be selected wherever its dependent is; keep that
    // separate rule satisfied so only the ordering rule is under test.
    registry.gates[prerequisite].contexts = { ...registry.gates[dependent].contexts };
    registry.gates[prerequisite].required = false;
    registry.gates[prerequisite].effect = "advisory";
    return auditExecutionProfile(registry, PKG).filter((problem) => problem.includes("gate_order group"));
  }

  it("gives two same-group pairs the same verdict, whichever way round they are", () => {
    // Both in conformance_and_delivery. Alphabetical order must not decide this.
    expect(withPrerequisite("gate:hollow-parity", "gate:coverage")).toEqual([]);
    expect(withPrerequisite("gate:coverage", "gate:hollow-parity")).toEqual([]);
  });

  it("still rejects a prerequisite that sits in a LATER group", () => {
    // gate:lockfile is snapshot_admission; gate:coverage is conformance_and_delivery.
    // That is a genuine contradiction between the two ordering mechanisms.
    expect(withPrerequisite("gate:lockfile", "gate:coverage")).toEqual([
      "gate:lockfile prerequisite gate:coverage must not occur in a later execution.gate_order group",
    ]);
  });

  it("accepts the real profile, which declares a same-group prerequisite today", () => {
    expect(auditExecutionProfile(loadExecutionProfile(), PKG)).toEqual([]);
  });
});
