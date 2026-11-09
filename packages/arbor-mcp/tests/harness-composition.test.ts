import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConnectorRegistry, HarnessIntegrationRegistry, InMemoryCredentialLeaseBroker, type ConnectorDescriptor } from "@arbor/harness";
import { ArborRuntime, CAMPAIGN_RUN_JOB_KIND, type CampaignRunner } from "../src/runtime.js";
import { NATIVE_HARNESS_CONNECTOR_ID } from "../src/harness-control-plane.js";
import { createCliRuntime, createProductionCampaignRunner, DEFAULT_NATIVE_CAMPAIGN_REQUIREMENTS, resolveNativeRoleModelIdentity } from "../src/cli.js";
import { RuntimeCatalogRouter } from "../src/runtime-catalog.js";
import type { CampaignHarnessIntegration } from "../src/campaign-harness-integration.js";

const observedAt = "2026-08-09T12:00:00.000Z";

function governedConnector(id: string): ConnectorDescriptor {
  return {
    connector_id: id,
    implementation_version: "test",
    supported_upstream_range: "test-only",
    health: "healthy",
    capabilities: [
      { capability: "interruption", grade: "governed", evidence: { implementation_id: id, observed_at: observedAt, detail: "test interruption boundary" } },
      { capability: "tool_policy", grade: "governed", evidence: { implementation_id: id, observed_at: observedAt, detail: "test immutable policy" } },
    ],
  };
}

describe("reference harness control-plane composition", () => {
  it("keeps unconfigured connector and credential services as typed absence", () => {
    const runtime = new ArborRuntime();

    expect(runtime.harnessControl.connectorRegistry).toBeNull();
    expect(runtime.harnessControl.credentialBroker).toBeNull();
    expect(runtime.listHarnessConnectors()).toEqual([]);
    expect(runtime.inspectHarnessConnector(NATIVE_HARNESS_CONNECTOR_ID)).toBeNull();
    expect(runtime.selectHarnessConnector([])).toEqual({ kind: "unavailable", reason: "not_configured", candidates: [] });
  });

  it("registers a truthful native descriptor into an injected registry without exposing credential material", () => {
    const registry = new ConnectorRegistry();
    const broker = new InMemoryCredentialLeaseBroker();
    broker.register({ provider_id: "provider", account_id: "account", scopes: ["run"], secret: "never-render-this" });
    const runtime = new ArborRuntime({
      harness_connector_registry: registry,
      credential_lease_broker: broker,
      native_harness_observed_at: observedAt,
    });

    expect(runtime.harnessControl.credentialBroker).toBe(broker);
    expect(runtime.listHarnessConnectors()).toEqual([
      expect.objectContaining({ connector_id: NATIVE_HARNESS_CONNECTOR_ID, health: "healthy" }),
    ]);
    const selected = runtime.selectHarnessConnector([
      { capability: "interruption", minimum_grade: "governed" },
      { capability: "tool_policy", minimum_grade: "governed" },
    ]);
    expect(selected).toMatchObject({ kind: "selected", connector: { connector_id: NATIVE_HARNESS_CONNECTOR_ID } });
    expect(JSON.stringify(runtime.listHarnessConnectors())).not.toContain("never-render-this");
  });

  it("registers direct-native campaign capability evidence only for a complete native selection", () => {
    const root = mkdtempSync(join(tmpdir(), "arbor-native-admission-"));
    const previousKey = process.env.ARBOR_NATIVE_API_KEY;
    try {
      // The default empty auto selection must not make a subordinate fallback
      // look like a selectable revoy-native campaign executor.
      const absent = createCliRuntime(root);
      expect(absent.inspectHarnessConnector(NATIVE_HARNESS_CONNECTOR_ID)).toBeNull();
      // Canopy-only (amends ADR-061): with the native lane unready nothing
      // else is registered behind it — there is no default connector.
      expect(absent.selectHarnessConnector([])).toMatchObject({ kind: "unavailable" });

      // `native.mode: "fallback"` exists only to force a connector, so it is
      // a deprecated lane and refused at composition without the opt-in.
      writeFileSync(join(root, "arbor.jsonc"), JSON.stringify({
        native: { mode: "fallback", provider_id: "fixture", base_url: "https://fixture.invalid/v1", model: "fixture-model" },
      }), "utf8");
      expect(() => createCliRuntime(root, ".arbor-fallback")).toThrow(/native\.mode "fallback".*connectors\.allow_deprecated/s);

      writeFileSync(join(root, "arbor.jsonc"), JSON.stringify({
        native: { mode: "native", provider_id: "fixture", base_url: "https://fixture.invalid/v1", model: "fixture-model" },
      }), "utf8");
      // Explicit native cannot be advertised before its documented opaque
      // credential source is present; it must fail closed rather than become
      // a later provider error or a hidden fallback.
      delete process.env.ARBOR_NATIVE_API_KEY;
      const credentialAbsent = createCliRuntime(root, ".arbor-credential-absent");
      expect(credentialAbsent.inspectHarnessConnector(NATIVE_HARNESS_CONNECTOR_ID)).toBeNull();
      process.env.ARBOR_NATIVE_API_KEY = "test-only-native-key";
      const configured = createCliRuntime(root, ".arbor-configured");
      expect(configured.selectHarnessConnector(DEFAULT_NATIVE_CAMPAIGN_REQUIREMENTS)).toMatchObject({ kind: "selected", connector: { connector_id: NATIVE_HARNESS_CONNECTOR_ID } });
      // The direct campaign composition has governed crash continuation but
      // no general fork entrypoint. It composes its one fixed critic schema, but still exposes no
      // caller-owned schema selection despite the lower-level protocol's
      // wider in-memory vocabulary.
      expect(configured.selectHarnessConnector([{ capability: "resumption", minimum_grade: "governed" }])).toMatchObject({ kind: "selected", connector: { connector_id: NATIVE_HARNESS_CONNECTOR_ID } });
      expect(configured.selectHarnessConnector([{ capability: "forking", minimum_grade: "governed" }])).toMatchObject({ kind: "unavailable" });
      expect(configured.selectHarnessConnector([{ capability: "structured_output", minimum_grade: "native" }])).toMatchObject({ kind: "selected", connector: { connector_id: NATIVE_HARNESS_CONNECTOR_ID } });
      expect(configured.selectHarnessConnector([{ capability: "artifact_capture", minimum_grade: "native" }])).toMatchObject({ kind: "selected", connector: { connector_id: NATIVE_HARNESS_CONNECTOR_ID } });

    } finally {
      if (previousKey === undefined) delete process.env.ARBOR_NATIVE_API_KEY; else process.env.ARBOR_NATIVE_API_KEY = previousKey;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not invent a connector fallback when no healthy integration is registered", async () => {
    const runtimeBox: { current: ArborRuntime | null } = { current: null };
    // allow_primary_checkout: this test exercises connector fallback, not the
    // target-isolation guard (which has its own tests) — without the opt-out
    // its verdict would depend on which branch the live checkout happens to be on.
    const runner = createProductionCampaignRunner(runtimeBox, process.cwd(), {}, {
      native_selection: { kind: "unavailable", reason: "native_adapter_unsupported", adapter_id: "unshipped-wire" },
      allow_primary_checkout: true,
    });
    const runtime = new ArborRuntime({ campaign_runner: runner });
    runtimeBox.current = runtime;

    await expect(runner.run("must-not-fallback", new AbortController().signal))
      .rejects.toThrow("no healthy harness integration satisfies campaign requirements");
  });

  it("constructs executor, independent reviewer, and decomposer only from the capability-selected integration", async () => {
    const integrations = new HarnessIntegrationRegistry<CampaignHarnessIntegration>();
    const constructed: string[] = [];
    integrations.register(governedConnector("integration-fixture"), {
      createExecutor: () => {
        constructed.push("executor");
        return { specialize: async () => { throw new Error("not reached"); }, review: async () => { throw new Error("not reached"); }, log: () => {} };
      },
      createReviewer: () => { constructed.push("reviewer"); return async () => ({ approved: true, rationale: "fixture" }); },
      createDecomposer: () => { constructed.push("decomposer"); return { decompose: async () => ({ ok: false, reason: "fixture" }) }; },
    });
    const runtimeBox: { current: ArborRuntime | null } = { current: null };
    // allow_primary_checkout: see the fallback test above — guard verdicts must not leak in here.
    const runner = createProductionCampaignRunner(runtimeBox, process.cwd(), {}, { native_selection: { kind: "unavailable", reason: "credential_absent", adapter_id: null }, integrations, allow_primary_checkout: true });
    const runtime = new ArborRuntime({ campaign_runner: runner, harness_connector_registry: integrations.connectors, register_native_harness_connector: false });
    runtimeBox.current = runtime;

    await expect(runner.run("missing-campaign", new AbortController().signal)).rejects.toThrow();
    expect(constructed).toEqual(["reviewer", "decomposer", "executor"]);
  });

  it("does not apply a selected-model revision pin to an agent model override", () => {
    const selection = { kind: "native" as const, selected_by: "native" as const, adapter_id: "openai-compatible", provider_id: "fixture", base_url: "https://fixture.invalid/v1", model: "selected-model", revision: "selected-fingerprint" };
    expect(resolveNativeRoleModelIdentity(selection, { seed: { model: "override-model" } }, "seed"))
      .toEqual({ model_id: "override-model", revision: null });
    expect(resolveNativeRoleModelIdentity(selection, { seed: { model: "auto" } }, "seed"))
      .toEqual({ model_id: "selected-model", revision: "selected-fingerprint" });
  });

  it("isolates native drift and selects another healthy connector without mutating campaign authority", () => {
    const registry = new ConnectorRegistry();
    registry.register(governedConnector("external-test"));
    const runtime = new ArborRuntime({ harness_connector_registry: registry, native_harness_observed_at: observedAt });
    const requirements = [
      { capability: "interruption" as const, minimum_grade: "governed" as const },
      { capability: "tool_policy" as const, minimum_grade: "governed" as const },
    ];

    expect(runtime.selectHarnessConnector(requirements)).toMatchObject({ kind: "selected", connector: { connector_id: NATIVE_HARNESS_CONNECTOR_ID } });
    registry.setHealth(NATIVE_HARNESS_CONNECTOR_ID, "degraded", "synthetic upstream drift");

    expect(runtime.inspectHarnessConnector(NATIVE_HARNESS_CONNECTOR_ID)).toMatchObject({ health: "degraded", diagnostic: "synthetic upstream drift" });
    expect(runtime.selectHarnessConnector(requirements)).toMatchObject({ kind: "selected", connector: { connector_id: "external-test" } });
  });

  // Isolation-guard gap: `arbor selfhost` refuses a forbidden-branch target
  // before it ever constructs a worktree (`checkTargetIsolationSafety`); the
  // generic `arbor task`/`arbor run` campaign runner rooted its own
  // `WorktreeManager` at `cwd` with no equivalent check. These two tests
  // drive `createProductionCampaignRunner.run()` directly against a real,
  // throwaway git repo on a forbidden branch.
  function makeForbiddenBranchRepo(): string {
    const repo = mkdtempSync(join(tmpdir(), "arbor-task-isolation-guard-"));
    mkdirSync(repo, { recursive: true });
    spawnSync("git", ["init", "-q", "-b", "master", repo], { stdio: "ignore" });
    spawnSync("git", ["-C", repo, "config", "user.email", "t@t"], { stdio: "ignore" });
    spawnSync("git", ["-C", repo, "config", "user.name", "t"], { stdio: "ignore" });
    writeFileSync(join(repo, "README.md"), "isolation guard fixture\n");
    spawnSync("git", ["-C", repo, "add", "-A"], { stdio: "ignore" });
    spawnSync("git", ["-C", repo, "commit", "-qm", "init"], { stdio: "ignore" });
    return repo;
  }

  it("(isolation-guard scope) an ordinary repository on master is NOT refused — the daily-driver flow", async () => {
    const repo = makeForbiddenBranchRepo();
    try {
      const runtimeBox: { current: ArborRuntime | null } = { current: null };
      const runner = createProductionCampaignRunner(runtimeBox, repo, {}, {
        native_selection: { kind: "unavailable", reason: "native_adapter_unsupported", adapter_id: "unshipped-wire" },
      });
      const runtime = new ArborRuntime({ campaign_runner: runner });
      runtimeBox.current = runtime;

      // Not the harness's own checkout, so the guard stays silent and the run
      // proceeds to the next real refusal. The first wiring refused every
      // master-branch repo — the exact opposite of a usable harness.
      await expect(runner.run("ordinary-repo-on-master", new AbortController().signal))
        .rejects.toThrow("no healthy harness integration satisfies campaign requirements");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("(isolation-guard gap) refuses a generic campaign whose target is the harness's own source checkout", async () => {
    const repo = makeForbiddenBranchRepo();
    try {
      const runtimeBox: { current: ArborRuntime | null } = { current: null };
      const runner = createProductionCampaignRunner(runtimeBox, repo, {}, {
        native_selection: { kind: "unavailable", reason: "native_adapter_unsupported", adapter_id: "unshipped-wire" },
        isolation_guard: { harness_checkout: realpathSync(repo) },
      });
      const runtime = new ArborRuntime({ campaign_runner: runner });
      runtimeBox.current = runtime;

      await expect(runner.run("must-not-run-on-harness-master", new AbortController().signal))
        .rejects.toThrow(/forbidden branch.*master.*--allow-primary-checkout/s);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("(isolation-guard gap) allow_primary_checkout bypasses the guard, reaching the next real refusal instead", async () => {
    const repo = makeForbiddenBranchRepo();
    try {
      const runtimeBox: { current: ArborRuntime | null } = { current: null };
      const runner = createProductionCampaignRunner(runtimeBox, repo, {}, {
        native_selection: { kind: "unavailable", reason: "native_adapter_unsupported", adapter_id: "unshipped-wire" },
        isolation_guard: { harness_checkout: realpathSync(repo) },
        allow_primary_checkout: true,
      });
      const runtime = new ArborRuntime({ campaign_runner: runner });
      runtimeBox.current = runtime;

      // The guard no longer fires; the run proceeds to the next real
      // failure (no healthy integration), proving the bypass is exact.
      await expect(runner.run("allowed-on-master", new AbortController().signal))
        .rejects.toThrow("no healthy harness integration satisfies campaign requirements");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("only runs a campaign after the existing campaign.run job submission path", async () => {
    let runs = 0;
    const runner: CampaignRunner = {
      async run() {
        runs++;
        return { halted: false, halt_reason: null, cancelled: false, awaiting_user_input: false };
      },
    };
    const runtime = new ArborRuntime({ campaign_runner: runner });
    const router = new RuntimeCatalogRouter(runtime);
    const campaignId = "harness-authority";
    const metadata = {
      operation_id: "start", idempotency_key: "start", correlation_id: "correlation", actor_id: "operator", requested_at: observedAt,
    };

    runtime.selectHarnessConnector([]);
    expect(runs).toBe(0);
    expect(await router.dispatchCommand({
      schema_version: 1,
      metadata,
      command: {
        kind: "campaign.start",
        campaign_id: campaignId,
        plan_path: "plan.md",
        root_action: { description: "root", estimated_gain: 1, estimated_cost: 1, category: "root", delegate_to: "crown" },
      },
    })).toMatchObject({ ok: true, value: { accepted: true } });
    expect(await router.dispatchCommand({
      schema_version: 1,
      metadata: { ...metadata, operation_id: "job", idempotency_key: "job" },
      command: {
        kind: "job.submit",
        id: "harness-job",
        operation_id: "job",
        job_kind: CAMPAIGN_RUN_JOB_KIND,
        owner_scope_id: campaignId,
        idempotency_key: "job",
      },
    })).toMatchObject({ ok: true, value: { accepted: true, dispatched: true } });

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(runs).toBe(1);
  });
});
