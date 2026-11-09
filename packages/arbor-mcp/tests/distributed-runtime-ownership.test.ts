import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DistributedControlRuntime, type DistributedAuthorityConfig } from "../src/distributed-control-runtime.js";
import { ArborRuntime } from "../src/runtime.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const secret = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
function config(root: string): DistributedAuthorityConfig { return { version: 1, role: "authority", persistence_dir: join(root, "control"), listener: { host: "127.0.0.1", port: 0 }, grants: { operator: { secret_ref: { kind: "env", name: "CONTROL_SECRET" }, routes: ["health.read"], resource_prefixes: [], audiences: [], capabilities: [], expires_at: "2099-01-01T00:00:00.000Z" } } }; }

describe("ArborRuntime distributed control ownership", () => {
  it("projects actionable disabled guidance without fabricating health", () => { const runtime = new ArborRuntime(); expect(runtime.distributedControlProjection("control.status")).toEqual({ availability: "disabled", kind: "control.status", reason: "distributed control is not configured", remediation: "Set ARBOR_DISTRIBUTED_CONTROL_CONFIG to a closed v1 authority or join config, then restart this runtime." }); });
  it("starts and closes the configured authority as the canonical runtime lifecycle participant", async () => { const root = mkdtempSync(join(tmpdir(), "revoy-runtime-control-")); roots.push(root); const control = new DistributedControlRuntime(config(root), { env: { CONTROL_SECRET: secret } }); const runtime = new ArborRuntime({ distributed_control: control }); expect((await runtime.start()).ok).toBe(true); expect(runtime.distributedControlProjection("control.status")).toMatchObject({ availability: "configured", value: { state: "started", role: "authority" } }); expect((await runtime.close()).value?.state).toBe("closed"); const replacement = new DistributedControlRuntime(config(root), { env: { CONTROL_SECRET: secret } }); await replacement.start(); await replacement.close(); });
});
