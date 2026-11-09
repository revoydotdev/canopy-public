import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  RepoFlightExecutionPlanError,
  compareRepoFlightExecutionPlanShadow,
  createRepoFlightExecutionPlan,
  runnableRepoFlightPlanGates,
  signRepoFlightExecutionPlan,
  verifyRepoFlightExecutionPlan,
} from "../src/repo-flight-execution-plan.js";

const contexts = (selected: readonly string[]) => ({
  stop: selected.includes("stop"), precommit: selected.includes("precommit"), prepush: selected.includes("prepush"), trunk_submit: selected.includes("trunk_submit"), ci: selected.includes("ci"),
});
const gate = (id: string, overrides: Record<string, unknown> = {}) => ({
  command: `bun run ${id}`,
  prerequisites: [],
  contexts: contexts(["prepush", "ci"]),
  excluded_contexts: {},
  timeout_ms: 30_000,
  cost_class: "fast",
  mutability: "read_only",
  required: true,
  scope: "self",
  ...overrides,
});

function input() {
  return {
    schema_version: 1 as const,
    context: "prepush" as const,
    candidate: { candidate_oid: "a".repeat(40), input_digest: `sha256:${"b".repeat(64)}` as const },
    toolchain: { runtime_id: "bun", runtime_version: "1.2.3", platform: "linux", architecture: "x64", lockfile_digest: `sha256:${"c".repeat(64)}` as const },
    profile: {
      schema_version: 1,
      profile_version: "2026.08.test.1",
      execution: {
        contexts: {
          stop: { max_readers: 1, failure_policy: "fail_fast" }, precommit: { max_readers: 1, failure_policy: "fail_fast" }, prepush: { max_readers: 2, failure_policy: "fail_fast" }, trunk_submit: { max_readers: 1, failure_policy: "fail_fast" }, ci: { max_readers: 2, failure_policy: "complete_all" },
        },
        gate_order: [
          { id: "admission", gates: ["gate:a", "gate:b"] },
          { id: "verify", gates: ["gate:c"] },
        ],
        finalization: { phases: [] },
        managed_hooks: {},
      },
      gates: {
        "gate:a": gate("gate:a"),
        "gate:b": gate("gate:b"),
        "gate:c": gate("gate:c", { prerequisites: ["gate:a", "gate:b"], mutability: "verification_sandbox", cost_class: "full" }),
      },
    },
  };
}

function keys() {
  const pair = generateKeyPairSync("ed25519");
  return { private_key_pem: pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(), public_key_pem: pair.publicKey.export({ type: "spki", format: "pem" }).toString() };
}

describe("Profile-to-Flight execution plans", () => {
  it("derives canonical argv, waves, resources, and stable reporting order from the whole profile", () => {
    const plan = createRepoFlightExecutionPlan(input());
    expect(plan.gates).toEqual([
      expect.objectContaining({ gate_id: "gate:a", argv: ["bun", "run", "gate:a"], wave: 1, reporting_ordinal: 1, resources: [{ kind: "candidate.snapshot", key: "candidate", mode: "shared" }] }),
      expect.objectContaining({ gate_id: "gate:b", argv: ["bun", "run", "gate:b"], wave: 1, reporting_ordinal: 2, resources: [{ kind: "candidate.snapshot", key: "candidate", mode: "shared" }] }),
      expect.objectContaining({ gate_id: "gate:c", argv: ["bun", "run", "gate:c"], prerequisites: ["gate:a", "gate:b"], wave: 2, reporting_ordinal: 3, resources: [{ kind: "workspace.verification", key: "workspace:gate:c", mode: "exclusive" }] }),
    ]);
    expect(plan.reporting_order).toEqual(["gate:a", "gate:b", "gate:c"]);
    expect(plan.terminal_semantics).toEqual({ failure_policy: "fail_fast", terminal_statuses: ["passed", "failed", "timed_out", "cancelled", "blocked_by_prerequisite", "identity_mismatch", "cached"] });
    expect(runnableRepoFlightPlanGates(plan, new Set())).toEqual(plan.gates.slice(0, 2));
    expect(runnableRepoFlightPlanGates(plan, new Set(["gate:a"]))).toEqual([plan.gates[1]!]);
    expect(runnableRepoFlightPlanGates(plan, new Set(["gate:a", "gate:b"]))).toEqual([]);
  });

  it("requires a trusted external Ed25519 issuer and rejects tampering", () => {
    const trusted = keys(), attacker = keys();
    const signed = signRepoFlightExecutionPlan(createRepoFlightExecutionPlan(input()), { issuer_id: "profile-adapter", private_key_pem: trusted.private_key_pem });
    expect(verifyRepoFlightExecutionPlan(signed, new Map([["profile-adapter", trusted.public_key_pem]]))).toEqual(signed);
    expect(() => verifyRepoFlightExecutionPlan(signed, new Map([["profile-adapter", attacker.public_key_pem]]))).toThrow(/signature/);
    expect(() => verifyRepoFlightExecutionPlan(signed, new Map([["attacker", attacker.public_key_pem]]))).toThrow(/not trusted/);
    const tampered = structuredClone(signed);
    (tampered as any).gates[0].timeout_ms = 1;
    expect(() => verifyRepoFlightExecutionPlan(tampered, new Map([["profile-adapter", trusted.public_key_pem]]))).toThrow(RepoFlightExecutionPlanError);
  });

  it("rejects command-only, unknown-field, noncanonical argv, omitted, and cyclic profile inputs", () => {
    expect(() => createRepoFlightExecutionPlan({ schema_version: 1, context: "prepush", gates: [], profile_digest: `sha256:${"d".repeat(64)}` })).toThrow(/schema/);
    const withUnknown = input() as any;
    withUnknown.profile.gates["gate:a"].shell = "rm -rf /";
    expect(() => createRepoFlightExecutionPlan(withUnknown)).toThrow(/malformed/);
    const commandInjection = input() as any;
    commandInjection.profile.gates["gate:a"].command = "bun run gate:a && echo escaped";
    expect(() => createRepoFlightExecutionPlan(commandInjection)).toThrow(/argv-only/);
    const omitted = input() as any;
    omitted.profile.execution.gate_order[0].gates = ["gate:a"];
    expect(() => createRepoFlightExecutionPlan(omitted)).toThrow(/enumerate every gate/);
    const cyclic = input() as any;
    cyclic.profile.gates["gate:a"].prerequisites = ["gate:b"];
    cyclic.profile.gates["gate:b"].prerequisites = ["gate:a"];
    expect(() => createRepoFlightExecutionPlan(cyclic)).toThrow(/earlier execution group|cycle/);
  });

  it("reports explicit shadow mismatches for changed waves, omitted gates, argv, resources, and terminal semantics", () => {
    const base = input();
    const reordered = input() as any;
    reordered.profile.execution.gate_order = [{ id: "b", gates: ["gate:b"] }, { id: "a", gates: ["gate:a"] }, { id: "verify", gates: ["gate:c"] }];
    const waveParity = compareRepoFlightExecutionPlanShadow(base, createRepoFlightExecutionPlan(reordered));
    expect(waveParity.ok).toBe(false);
    expect(waveParity.findings).toEqual(expect.arrayContaining([expect.objectContaining({ code: "wave", path: "gates.gate:a.wave" }), expect.objectContaining({ code: "reporting_order" })]));

    const missing = input() as any;
    delete missing.profile.gates["gate:b"];
    missing.profile.execution.gate_order[0].gates = ["gate:a"];
    missing.profile.gates["gate:c"].prerequisites = ["gate:a"];
    const gateParity = compareRepoFlightExecutionPlanShadow(base, createRepoFlightExecutionPlan(missing));
    expect(gateParity.findings).toEqual(expect.arrayContaining([expect.objectContaining({ code: "gate_set" })]));

    const changed = input() as any;
    changed.profile.gates["gate:a"].mutability = "evidence_writer";
    changed.profile.gates["gate:a"].timeout_ms = 40_000;
    changed.profile.execution.contexts.prepush.failure_policy = "complete_all";
    const semanticParity = compareRepoFlightExecutionPlanShadow(base, createRepoFlightExecutionPlan(changed));
    expect(semanticParity.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "mutability", path: "gates.gate:a.mutability" }),
      expect.objectContaining({ code: "timeout", path: "gates.gate:a.timeout_ms" }),
      expect.objectContaining({ code: "resources", path: "gates.gate:a.resources" }),
      expect.objectContaining({ code: "terminal_semantics" }),
    ]));
  });
});
