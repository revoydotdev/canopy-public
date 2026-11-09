import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { EvidenceLedger } from "@arbor/audit";
import { inspectHarnessIntegrationEnvironment, inspectOperatorEnvironment, reconcileStore } from "../src/doctor.js";
import { main } from "../src/cli.js";

function snapshot(id: string): object {
  return {
    id, plan_path: "plan.md", root_id: "root", started_at: "2026-08-12T00:00:00.000Z",
    config: { max_seconds: 60, min_score: 0, convergence_iterations: 2, score_config: { exploration_constant: 1 } },
    nodes: [{
      id: "root", parent_id: null,
      action: { description: "root", estimated_gain: 1, estimated_cost: 1, category: "planning", delegate_to: "seed" },
      children_ids: [], state: "pending", provenance: null, score: 0, visit_count: 0,
      kb_entries_extracted: 0, created_at: "2026-08-12T00:00:00.000Z", gate_records: [],
      memory_mode: "accumulate", memory_mode_version: 1,
    }],
    iterations_completed: 0, iterations_without_kb_entry: 0, best_score: 0, halted: false, halt_reason: null,
  };
}

describe("operator doctor", () => {
  it("reports Claude Code OAuth readiness without projecting identity or credential data", () => {
    const report = inspectHarnessIntegrationEnvironment(
      { ARBOR_HARNESS_INTEGRATION: "claude-code" },
      () => JSON.stringify({ loggedIn: true, authMethod: "claude.ai", email: "never-project@example.invalid", token: "never-project" }),
    );
    expect(report).toEqual({ integration_id: "claude-code", executable_present: true, authenticated: true, detail: "authenticated (claude.ai)" });
    expect(JSON.stringify(report)).not.toContain("never-project");
  });
  it("probes configured Codex executable version only and keeps authentication indeterminate", () => {
    const calls: Array<readonly [string, readonly string[]]> = [];
    const report = inspectHarnessIntegrationEnvironment(
      { ARBOR_HARNESS_INTEGRATION: "codex", ARBOR_CODEX_BIN: "codex-wrapper", ARBOR_CODEX_MODEL: "gpt-5.6-codex" },
      (file, args) => { calls.push([file, args]); return "codex-cli 1.2.3\n"; },
    );
    expect(calls).toEqual([["codex-wrapper", ["--version"]]]);
    expect(report).toEqual({ integration_id: "codex", executable_present: true, authenticated: null, detail: "installed (codex-cli); model gpt-5.6-codex; authentication is indeterminate (version probe only)" });
  });

  it("reports absent Codex with actionable remediation without claiming an auth result", () => {
    const report = inspectHarnessIntegrationEnvironment(
      { ARBOR_HARNESS_INTEGRATION: "codex" },
      () => { throw new Error("not found"); },
    );
    expect(report).toMatchObject({ integration_id: "codex", executable_present: false, authenticated: null });
    expect(report.detail).toContain("install Codex or set ARBOR_CODEX_BIN");
    expect(report.detail).toContain("model Codex default");
  });
  // Parity gap #4: ARBOR_HARNESS_INTEGRATION=native is the natural guess for
  // "use the native harness" — before this branch it fell through to the
  // generic unsupported-id path and doctor reported "unsupported integration
  // id" on a fully ready native-mode install.
  it("reports real native readiness instead of an unsupported integration id", () => {
    const report = inspectHarnessIntegrationEnvironment(
      { ARBOR_HARNESS_INTEGRATION: "native" },
      () => { throw new Error("native has no executable to probe"); },
      {
        execution: { kind: "direct_native", selected_by: "native" },
        credential: { required: true, present: true, source: "env", authentication_owner: "canopy_credential_source", env_var: "ARBOR_NATIVE_API_KEY", file_path: null, mechanism: "api_key", state: "present" },
        adapter: { adapter_id: "openai-compatible", availability: "available", implementation_id: "openai-compatible-adapter", transport: "http" },
        selection: { mode: "native", auth_route: "provider_api", adapter_id: "openai-compatible", provider_id: "openai", model_id: "gpt-5", endpoint_configured: true },
      },
    );
    expect(report).toEqual({
      integration_id: "native",
      executable_present: true,
      authenticated: true,
      detail: "direct native execution ready (mode native, adapter openai-compatible, model gpt-5)",
    });
  });

  it("reports native execution unavailable with its real reason, not a fabricated success", () => {
    const report = inspectHarnessIntegrationEnvironment(
      { ARBOR_HARNESS_INTEGRATION: "native" },
      () => { throw new Error("native has no executable to probe"); },
      {
        execution: { kind: "unavailable", reason: "credential_absent", adapter_id: "openai-compatible" },
        credential: { required: true, present: false, source: "absent", authentication_owner: "canopy_credential_source", env_var: null, file_path: null, mechanism: "api_key", state: "absent" },
        adapter: { adapter_id: "openai-compatible", availability: "available", implementation_id: "openai-compatible-adapter", transport: "http" },
        selection: { mode: "native", auth_route: "provider_api", adapter_id: "openai-compatible", provider_id: "openai", model_id: "gpt-5", endpoint_configured: true },
      },
    );
    expect(report).toEqual({
      integration_id: "native",
      executable_present: true,
      authenticated: false,
      detail: "native execution unavailable (mode native): credential_absent",
    });
  });

  it("reports native readiness as unsupplied rather than probing an executable that doesn't exist", () => {
    const report = inspectHarnessIntegrationEnvironment({ ARBOR_HARNESS_INTEGRATION: "native" }, () => { throw new Error("must not be called"); });
    expect(report).toEqual({ integration_id: "native", executable_present: false, authenticated: null, detail: "native harness readiness was not supplied to this probe; run `arbor doctor` for the merged report" });
  });

  it("reports a clean tree/ledger inventory agreement", () => {
    const root = mkdtempSync(join(tmpdir(), "arbor-doctor-clean-"));
    try {
      mkdirSync(join(root, "tree")); mkdirSync(join(root, "audit"));
      writeFileSync(join(root, "tree", "campaign.json"), JSON.stringify(snapshot("campaign")));
      writeFileSync(join(root, "audit", "campaign.jsonl"), "");
      expect(reconcileStore(root)).toMatchObject({ inventory_agrees: true, tree_files: 1, ledger_files: 1, record_sources: {}, mismatches: [] });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("names malformed JSON and cross-store absence", () => {
    const root = mkdtempSync(join(tmpdir(), "arbor-doctor-bad-"));
    try {
      mkdirSync(join(root, "tree")); mkdirSync(join(root, "audit"));
      writeFileSync(join(root, "tree", "broken.json"), "{");
      writeFileSync(join(root, "audit", "orphan.jsonl"), "{not-json}\n");
      const report = reconcileStore(root);
      expect(report.inventory_agrees).toBe(false);
      expect(report.mismatches.map((item) => item.kind)).toEqual(expect.arrayContaining(["invalid_tree_json", "invalid_ledger_json", "tree_without_ledger", "ledger_without_tree"]));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("reports environment decisions and presence without projecting values", () => {
    const root = mkdtempSync(join(tmpdir(), "arbor-doctor-env-"));
    try {
      writeFileSync(join(root, "arbor.jsonc"), "secret-value-that-must-not-project");
      const report = inspectOperatorEnvironment({ persistence_dir: join(root, ".arbor"), cwd: root, streams: { stdin: true, stdout: false, stderr: true }, env: { TMUX: "/tmp/tmux", NO_COLOR: "1" }, native_credential_present: true });
      expect(report).toMatchObject({ terminal: { multiplexer: { kind: "tmux" }, color_output: { enabled: false, reason: "stdout is not a terminal" }, focus_reporting: { kind: "unknown" } }, stored: { config_file: true, keymap_file: false, native_credential_present: true } });
      expect(JSON.stringify(report)).not.toContain("secret-value");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("feeds focus and multiplexer decisions from durable renderer capability evidence", () => {
    const root = mkdtempSync(join(tmpdir(), "arbor-doctor-profile-"));
    try {
      const persistence = join(root, ".arbor");
      mkdirSync(join(persistence, "tree"), { recursive: true }); mkdirSync(join(persistence, "audit"), { recursive: true });
      writeFileSync(join(persistence, "tree", "campaign.json"), JSON.stringify(snapshot("campaign")));
      const ledger = new EvidenceLedger();
      ledger.recordTerminalProfile({ campaign_id: "campaign", node_id: "root", operation_id: "profile-1", idempotency_key: "profile-1",
        capabilities: { focus_tracking: true, notifications: true, rgb: true, ansi256: true, remote: true, multiplexer: "tmux", terminal_name: "fixture", terminal_version: "1" },
        theme_mode: "dark", theme_source: "terminal", provenance: { tag: "generated", generator: "test", input_hash: "profile-1" } });
      ledger.recordTerminalNotification({ campaign_id: "campaign", node_id: "root", operation_id: "notice-1", idempotency_key: "notice-1",
        notification_ref: `sha256:${"a".repeat(64)}`, focus: "blurred", emitted: false,
        provenance: { tag: "generated", generator: "test", input_hash: "notice-1" } });
      ledger.recordTerminalNotification({ campaign_id: "campaign", node_id: "root", operation_id: "notice-2", idempotency_key: "notice-2",
        notification_ref: `sha256:${"b".repeat(64)}`, focus: "blurred", emitted: true,
        provenance: { tag: "generated", generator: "test", input_hash: "notice-2" } });
      writeFileSync(join(persistence, "audit", "campaign.jsonl"), ledger.toJSONL());
      const report = inspectOperatorEnvironment({ persistence_dir: persistence, cwd: root, streams: { stdin: true, stdout: true, stderr: true }, env: {}, native_credential_present: false });
      expect(report.terminal).toMatchObject({ focus_reporting: { kind: "available" }, multiplexer: { kind: "tmux", reason: expect.stringContaining("renderer capability") } });
      expect(report.store.record_sources).toEqual({ terminal_notification: 2, terminal_profile: 1 });
      expect(report.store.notification_delivery).toEqual({ attempted: 2, emitted: 1, dropped: 1, false_fraction: 0.5 });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  // C5: doctor was blind to project governance entirely — an operator could
  // see a clean doctor report while sitting on an undischarged or
  // profile-drifted registry entry that only `gate:project-registry` (run
  // separately) would ever surface. `evaluateProjectRegistry` is the SAME
  // authority the gate calls, reused rather than re-derived here.
  it("reports an empty, present-or-absent project registry when nothing is registered", () => {
    const root = mkdtempSync(join(tmpdir(), "arbor-doctor-registry-empty-"));
    try {
      const report = inspectOperatorEnvironment({ persistence_dir: join(root, ".arbor"), cwd: root, streams: { stdin: false, stdout: false, stderr: false }, env: {}, native_credential_present: false });
      expect(report.project_governance).toEqual({ ok: true, entry_count: 0, verifications: [], present: false });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("surfaces a real registry entry whose registered path no longer exists", () => {
    const root = mkdtempSync(join(tmpdir(), "arbor-doctor-registry-broken-"));
    try {
      const persistence = join(root, ".arbor");
      mkdirSync(persistence, { recursive: true });
      writeFileSync(join(persistence, "project-registry.json"), JSON.stringify({
        schema_version: 1,
        entries: [{
          project_id: "vanished-project",
          path: join(root, "does-not-exist"),
          profile_hash: `sha256:${"c".repeat(64)}`,
          verified_at_revision: "0".repeat(40),
          verified_at: "2026-08-01T00:00:00.000Z",
          expires: "2099-01-01",
        }],
      }));
      const report = inspectOperatorEnvironment({ persistence_dir: persistence, cwd: root, streams: { stdin: false, stdout: false, stderr: false }, env: {}, native_credential_present: false });
      expect(report.project_governance.present).toBe(true);
      expect(report.project_governance.entry_count).toBe(1);
      expect(report.project_governance.ok).toBe(false);
      expect(report.project_governance.verifications[0]).toMatchObject({ project_id: "vanished-project", ok: false, failures: [{ code: "path_unreachable", detail: expect.stringContaining("does-not-exist") }] });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe("arbor doctor (CLI) — read-only diagnostic (Q1) and connector-aware remediation (Q2)", () => {
  // (e): a read-only diagnostic must never bring `.arbor/` into existence in
  // a target repo that was never enrolled. Before Q1's fix, `doctor` called
  // `createCliRuntime`, which constructs a real `ArborRuntime` whose
  // constructor unconditionally `mkdirSync`s `token-epochs`/
  // `native-campaign-budget` under the persistence dir.
  it("leaves an unenrolled target directory untouched — no .arbor is created", async () => {
    const root = mkdtempSync(join(tmpdir(), "arbor-doctor-readonly-"));
    try {
      expect(existsSync(join(root, ".arbor"))).toBe(false);
      const stdout = new PassThrough(); let out = "";
      stdout.on("data", (chunk: Buffer) => { out += chunk.toString(); });
      await main(["doctor", "--json"], { cwd: root, stdin: new PassThrough(), stdout, stderr: new PassThrough() });
      expect(existsSync(join(root, ".arbor"))).toBe(false);
      // Sanity: the command genuinely ran and produced a real projection,
      // not an early return that happened to skip the runtime for an
      // unrelated reason.
      expect(JSON.parse(out)).toHaveProperty("execution");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  // Q2: once a configured harness integration is present and authenticated,
  // native.* remediation must read as an optional alternative, not a
  // blocking requirement — in both the human text and the --json
  // `missing_requirements` field.
  it("reframes native missing_requirements as optional once a ready harness integration is detected", async () => {
    const root = mkdtempSync(join(tmpdir(), "arbor-doctor-connector-"));
    try {
      const stdout = new PassThrough(); let out = "";
      stdout.on("data", (chunk: Buffer) => { out += chunk.toString(); });
      await main(["doctor", "--json"], {
        cwd: root, stdin: new PassThrough(), stdout, stderr: new PassThrough(),
        env: { ARBOR_HARNESS_INTEGRATION: "claude-code" },
        execute_integration_probe: () => JSON.stringify({ loggedIn: true, authMethod: "claude.ai" }),
      });
      const report = JSON.parse(out) as { missing_requirements: { code: string; action: string }[]; harness_integration: unknown };
      expect(report.missing_requirements.length).toBeGreaterThan(0);
      for (const item of report.missing_requirements) {
        expect(item.code.startsWith("native_")).toBe(true);
        expect(item.action).toContain("Optional");
        expect(item.action).toContain("claude-code");
      }

      const humanOut = new PassThrough(); let humanText = "";
      humanOut.on("data", (chunk: Buffer) => { humanText += chunk.toString(); });
      await main(["doctor"], {
        cwd: root, stdin: new PassThrough(), stdout: humanOut, stderr: new PassThrough(),
        env: { ARBOR_HARNESS_INTEGRATION: "claude-code" },
        execute_integration_probe: () => JSON.stringify({ loggedIn: true, authMethod: "claude.ai" }),
      });
      expect(humanText).toContain("Optional: native config is not required");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("leaves unready-connector remediation unchanged (native.* still reads as required)", async () => {
    const root = mkdtempSync(join(tmpdir(), "arbor-doctor-connector-unready-"));
    try {
      const stdout = new PassThrough(); let out = "";
      stdout.on("data", (chunk: Buffer) => { out += chunk.toString(); });
      await main(["doctor", "--json"], {
        cwd: root, stdin: new PassThrough(), stdout, stderr: new PassThrough(),
        env: { ARBOR_HARNESS_INTEGRATION: "claude-code" },
        execute_integration_probe: () => { throw new Error("claude not installed"); },
      });
      const report = JSON.parse(out) as { missing_requirements: { code: string; action: string }[] };
      expect(report.missing_requirements.length).toBeGreaterThan(0);
      for (const item of report.missing_requirements) expect(item.action).not.toContain("Optional");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("projects configured Codex readiness through the shared CLI doctor without a provider probe", async () => {
    const root = mkdtempSync(join(tmpdir(), "arbor-doctor-codex-"));
    try {
      const stdout = new PassThrough(); let out = "";
      stdout.on("data", (chunk: Buffer) => { out += chunk.toString(); });
      await main(["doctor", "--json"], {
        cwd: root, stdin: new PassThrough(), stdout, stderr: new PassThrough(),
        env: { ARBOR_HARNESS_INTEGRATION: "codex", ARBOR_CODEX_BIN: "codex-wrapper", ARBOR_CODEX_MODEL: "gpt-5.6-codex" },
        execute_integration_probe: (file, args) => { expect(file).toBe("codex-wrapper"); expect(args).toEqual(["--version"]); return "codex-cli 1.2.3"; },
      });
      const report = JSON.parse(out) as { integration: { integration_id: string; executable_present: boolean; authenticated: boolean | null; detail: string }; probe_scope: { network: string }; next_actions: { code: string }[] };
      expect(report.integration).toMatchObject({ integration_id: "codex", executable_present: true, authenticated: null, detail: expect.stringContaining("model gpt-5.6-codex") });
      expect(report.probe_scope.network).toBe("not_run");
      expect(report.next_actions.some((item) => item.code === "integration_unready")).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
