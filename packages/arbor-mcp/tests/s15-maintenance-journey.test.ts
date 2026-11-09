/**
 * S15 (audit/2026-09-06-remediation/manifest.md, "Maintenance" capability
 * group): `doctor.get`, `migration.inspect`, `migration.preview`,
 * `migration.apply`, `migration.rollback` through the real client surface —
 * `arbor_command`/`arbor_query` via `ArborMCPServer.callTool`, the same
 * generic dispatch `cli.ts`'s bespoke JSON-RPC methods and `webui.ts`'s HTTP
 * routes use, and the same path the TUI's migration operator-form actions
 * (`cmd:migration.apply`/`cmd:migration.rollback`, `packages/arbor-mcp/src/tui.ts:2670-2671`)
 * dispatch through.
 *
 * Required outermost trajectory: disposable old-state fixture -> operator
 * preview -> apply -> restart -> inspect -> rollback, with no secret
 * disclosure.
 *
 * The restart step spawns a real, independent `bun` process (fresh module
 * graph, fresh heap, fresh `ArborRuntime`/`ArborMCPServer`) against the same
 * `persistence_dir`/workspace root rather than re-reading in this process —
 * an in-process re-read cannot distinguish "wired to disk" from "still held
 * in a variable".
 */
import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ConfigInspectionService } from "../src/config-inspection.js";
import { createDoctorReadiness } from "../src/cli.js";
import { ArborRuntime } from "../src/runtime.js";
import { ArborMCPServer } from "../src/server.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const FAKE_SECRET = "sk-ant-FAKE-S15-MAINTENANCE-SECRET-99887766554433221100";
const OLD_STATE_FIXTURE = JSON.stringify({
  schema_version: 1,
  native: { mode: "native", adapter_id: "anthropic-messages", provider_id: "anthropic", model: "claude-old-fixture-model" },
});
const integration = { integration_id: "fixture", executable_present: true, authenticated: true, detail: "fixture integration is authenticated" } as const;

const roots: string[] = [];
function disposableRoot(): string {
  const value = mkdtempSync(join(tmpdir(), "s15-maintenance-"));
  roots.push(value);
  return value;
}
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

/** Real `bun` subprocess: a fresh module graph and process, not an in-process re-read. */
function callToolInFreshProcess(cwd: string, persistenceDir: string, calls: readonly { tool: string; args: Record<string, unknown> }[]): unknown[] {
  const script = `
    import { ConfigInspectionService } from ${JSON.stringify(join(REPO_ROOT, "packages/arbor-mcp/src/config-inspection.ts"))};
    import { createDoctorReadiness } from ${JSON.stringify(join(REPO_ROOT, "packages/arbor-mcp/src/cli.ts"))};
    import { ArborRuntime } from ${JSON.stringify(join(REPO_ROOT, "packages/arbor-mcp/src/runtime.ts"))};
    import { ArborMCPServer } from ${JSON.stringify(join(REPO_ROOT, "packages/arbor-mcp/src/server.ts"))};
    const cwd = process.argv[1];
    const persistenceDir = process.argv[2];
    const calls = JSON.parse(process.argv[3]);
    const integration = ${JSON.stringify(integration)};
    const readiness = createDoctorReadiness(cwd);
    const runtime = new ArborRuntime({ persistence_dir: persistenceDir, workspace_root: cwd, config_inspection: new ConfigInspectionService(), operator_doctor_integration: integration, native_harness_readiness: readiness });
    const server = new ArborMCPServer(runtime);
    const results = [];
    for (const call of calls) results.push(await server.callTool(call.tool, call.args));
    process.stdout.write(JSON.stringify(results));
  `;
  const output = execFileSync("bun", ["--eval", script, cwd, persistenceDir, JSON.stringify(calls)], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: 20_000,
    env: { ...process.env, ANTHROPIC_API_KEY: FAKE_SECRET },
  });
  return JSON.parse(output) as unknown[];
}

describe("S15 Maintenance capability group — real client-surface journey", () => {
  it("previews, applies, survives a real restart, inspects, and rolls back through arbor_command/arbor_query with no secret disclosure", async () => {
    const cwd = disposableRoot();
    const persistenceDir = join(cwd, ".arbor");
    const targetPath = join(cwd, "arbor.jsonc");
    const sourcePath = join(cwd, "opencode.json");
    writeFileSync(targetPath, OLD_STATE_FIXTURE, "utf8");
    writeFileSync(sourcePath, JSON.stringify({ provider: "openrouter", model: "openrouter/new-fixture-model" }), "utf8");

    const priorKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = FAKE_SECRET;
    try {
      const readiness = createDoctorReadiness(cwd);
      const runtime = new ArborRuntime({ persistence_dir: persistenceDir, workspace_root: cwd, config_inspection: new ConfigInspectionService(), operator_doctor_integration: integration, native_harness_readiness: readiness });
      const server = new ArborMCPServer(runtime);

      // ---- doctor.get: exposes configured native provider, never the key ----
      const doctor = await server.callTool("arbor_query", { kind: "doctor.get" }) as { ok: boolean; value: Record<string, any> };
      expect(doctor.ok).toBe(true);
      expect(doctor.value.credentials.native).toMatchObject({ present: true, source: "env", env_var: "ANTHROPIC_API_KEY" });
      expect(doctor.value.configured.models[0]).toMatchObject({ provider_id: "anthropic", model_id: "claude-old-fixture-model" });
      expect(JSON.stringify(doctor)).not.toContain(FAKE_SECRET);

      // ---- migration.inspect: the disposable old-state fixture is visible ----
      const inspectBefore = await server.callTool("arbor_query", { kind: "migration.inspect" }) as { ok: boolean; value: Record<string, any> };
      expect(inspectBefore.ok).toBe(true);
      expect(inspectBefore.value).toMatchObject({ target: { present: true }, compatibility: { status: "compatible" } });

      // ---- operator preview ----
      const preview = await server.callTool("arbor_query", { kind: "migration.preview", source_path: "opencode.json" }) as { ok: boolean; value: Record<string, any> };
      expect(preview.ok).toBe(true);
      expect(preview.value).toMatchObject({ source: { kind: "opencode" }, target: { overwrite_required: true }, rollback: { available: true } });
      const sourceSha = preview.value.source.sha256 as string;

      // ---- apply ----
      const apply = await server.callTool("arbor_command", {
        kind: "migration.apply", source_path: "opencode.json", expected_source_sha256: sourceSha, overwrite: true,
        provenance: { tag: "s15-maintenance-journey" },
      }) as { ok: boolean; value: Record<string, any> };
      expect(apply.ok).toBe(true);
      expect(apply.value.accepted).toBe(true);
      expect(readFileSync(targetPath, "utf8")).toContain("openrouter");

      // REACHABILITY FINDING (reported, not fixed here — runtime-catalog.ts is
      // out of this lane's ownership): the command acknowledgement never
      // carries the migration receipt_id, even though `applyMigration`
      // computed and persisted one. A client limited to arbor_command/
      // arbor_query has no catalog-native way to learn the receipt_id
      // migration.rollback requires; it exists only on disk.
      expect(apply.value.receipt_id).toBeUndefined();
      const migrationsDir = join(persistenceDir, "migrations");
      const receiptFiles = readdirSync(migrationsDir).filter((name) => name.endsWith(".json"));
      expect(receiptFiles).toHaveLength(1);
      const receipt = JSON.parse(readFileSync(join(migrationsDir, receiptFiles[0]!), "utf8")) as { receipt_id: string };

      // ---- REAL RESTART: fresh bun process, fresh ArborRuntime/ArborMCPServer ----
      const [restartedInspect, restartedDoctor] = callToolInFreshProcess(cwd, persistenceDir, [
        { tool: "arbor_query", args: { kind: "migration.inspect" } },
        { tool: "arbor_query", args: { kind: "doctor.get" } },
      ]) as [{ ok: boolean; value: Record<string, any> }, { ok: boolean; value: Record<string, any> }];
      expect(restartedInspect.ok).toBe(true);
      expect(restartedInspect.value.target.sha256).toBe(preview.value.target.rendered_sha256);
      expect(restartedDoctor.ok).toBe(true);
      expect(restartedDoctor.value.configured.models[0]).toMatchObject({ provider_id: "openrouter" });
      expect(JSON.stringify([restartedInspect, restartedDoctor])).not.toContain(FAKE_SECRET);

      // ---- rollback (receipt_id obtained via the disk side-channel above,
      // since the catalog surface does not return it) ----
      const rollback = await server.callTool("arbor_command", {
        kind: "migration.rollback", receipt_id: receipt.receipt_id,
        provenance: { tag: "s15-maintenance-journey" },
      }) as { ok: boolean; value: Record<string, any> };
      expect(rollback.ok).toBe(true);
      expect(rollback.value.accepted).toBe(true);
      expect(readFileSync(targetPath, "utf8")).toBe(OLD_STATE_FIXTURE);

      // ---- rollback also survives a real restart ----
      const [restartedAfterRollback] = callToolInFreshProcess(cwd, persistenceDir, [
        { tool: "arbor_query", args: { kind: "migration.inspect" } },
      ]) as [{ ok: boolean; value: Record<string, any> }];
      expect(restartedAfterRollback.value.target.sha256).toBe(inspectBefore.value.target.sha256);

      // ---- final secret-disclosure sweep across every collected surface ----
      const everything = JSON.stringify([doctor, inspectBefore, preview, apply, restartedInspect, restartedDoctor, rollback, restartedAfterRollback, receipt]);
      expect(everything).not.toContain(FAKE_SECRET);
    } finally {
      if (priorKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = priorKey;
    }
  }, 30_000);

  it("refuses a fabricated receipt_id and a stale preview hash through the same real surface", async () => {
    const cwd = disposableRoot();
    const persistenceDir = join(cwd, ".arbor");
    writeFileSync(join(cwd, "arbor.jsonc"), OLD_STATE_FIXTURE, "utf8");
    writeFileSync(join(cwd, "opencode.json"), JSON.stringify({ provider: "openrouter", model: "m1" }), "utf8");
    const readiness = createDoctorReadiness(cwd);
    const runtime = new ArborRuntime({ persistence_dir: persistenceDir, workspace_root: cwd, config_inspection: new ConfigInspectionService(), operator_doctor_integration: integration, native_harness_readiness: readiness });
    const server = new ArborMCPServer(runtime);

    const preview = await server.callTool("arbor_query", { kind: "migration.preview", source_path: "opencode.json" }) as { value: Record<string, any> };
    writeFileSync(join(cwd, "opencode.json"), JSON.stringify({ provider: "openrouter", model: "m2-changed-after-preview" }), "utf8");
    const staleApply = await server.callTool("arbor_command", {
      kind: "migration.apply", source_path: "opencode.json", expected_source_sha256: preview.value.source.sha256, overwrite: true,
      provenance: { tag: "s15-refusal" },
    }) as { ok: boolean; value: Record<string, any> };
    expect(staleApply.ok).toBe(true);
    expect(staleApply.value.accepted).toBe(false);
    expect(staleApply.value.error.summary).toContain("changed since preview");

    const fabricatedRollback = await server.callTool("arbor_command", {
      kind: "migration.rollback", receipt_id: "migration-does-not-exist-00000000",
      provenance: { tag: "s15-refusal" },
    }) as { ok: boolean; value: Record<string, any> };
    expect(fabricatedRollback.ok).toBe(true);
    expect(fabricatedRollback.value.accepted).toBe(false);
    expect(fabricatedRollback.value.error.summary).toContain("migration receipt was not found");
  });
});
