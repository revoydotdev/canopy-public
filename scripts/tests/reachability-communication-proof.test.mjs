import { describe, expect, it } from "vitest";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const script = join(repo, "scripts", "reachability.mjs");
const baselineManifest = JSON.parse(readFileSync(join(repo, "scripts", "reachability", "entry-points.json"), "utf8"));

function run(manifest, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), "revoy-reachability-proof-"));
  const manifestPath = join(dir, "entry-points.json");
  writeFileSync(manifestPath, JSON.stringify(manifest));
  try {
    const args = [script, "--json", "--entry-points", manifestPath];
    if (options.repo) args.push("--repo", options.repo);
    const result = spawnSync("bun", args, { cwd: repo, encoding: "utf8" });
    return {
      status: result.status,
      stderr: result.stderr,
      report: JSON.parse(result.stdout),
      stdout: result.stdout,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function cloneManifest() {
  return structuredClone(baselineManifest);
}

function runWithMutatedHost(mutate) {
  const fixture = mkdtempSync(join(tmpdir(), "revoy-reachability-host-mutation-"));
  try {
    mkdirSync(join(fixture, "packages", "arbor-mcp", "src"), { recursive: true });
    writeFileSync(join(fixture, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext" } }));
    const host = join(repo, "packages", "arbor-mcp", "src", "native-tool-host.ts");
    const fixtureHost = join(fixture, "packages", "arbor-mcp", "src", "native-tool-host.ts");
    cpSync(host, fixtureHost);
    writeFileSync(fixtureHost, mutate(readFileSync(fixtureHost, "utf8")));
    return run(cloneManifest(), { repo: fixture });
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}

describe("ADR-083 communication reachability proof", () => {
  it("emits deterministic, named per-entry-point results", () => {
    const first = run(cloneManifest());
    const second = run(cloneManifest());
    // The process also checks exported-symbol reachability. An unrelated
    // exported symbol can make the aggregate gate exit 1 while this scoped
    // communication proof remains valid; keep the exit tied to the report.
    expect(first.status, first.stderr).toBe(first.report.ok ? 0 : 1);
    expect(second.status, second.stderr).toBe(second.report.ok ? 0 : 1);
    expect(first.stdout).toBe(second.stdout);

    const proof = first.report.communicationProof;
    expect(proof.ok).toBe(true);
    expect(proof.entry_points.map((entry) => entry.id)).toEqual([...proof.entry_points.map((entry) => entry.id)].sort());
    expect(proof.scoped_port_emissions.map((emission) => emission.tool)).toEqual([...proof.scoped_port_emissions.map((emission) => emission.tool)].sort());
    expect(proof.entry_points.find((entry) => entry.id === "arbor-mcp-cli")).toMatchObject({
      required: true,
      missing: [],
      reaches: proof.landmarks,
    });
  });

  it("TEETH: fails when the required public entry point is removed", () => {
    const manifest = cloneManifest();
    manifest.entryPoints = manifest.entryPoints.filter((entry) => entry.id !== "arbor-mcp-cli");
    const result = run(manifest);
    expect(result.status).not.toBe(0);
    expect(result.report.communicationProof.errors).toContain("ADR-083 required entry point is absent from entry-points.json: arbor-mcp-cli");
  });

  it("TEETH: fails when a second or alternate mechanism is declared", () => {
    const manifest = cloneManifest();
    manifest.communicationProof.mechanisms.push({
      id: "alternate-ledger",
      native_tool_factory_file: "packages/arbor-mcp/src/native-tool-host.ts",
    });
    const result = run(manifest);
    expect(result.status).not.toBe(0);
    expect(result.report.communicationProof.errors).toContain("ADR-083 requires exactly one declared mechanism; found 2");
  });

  it("TEETH: fails when the manifest weakens the canonical required-root list", () => {
    const manifest = cloneManifest();
    manifest.communicationProof.required_entry_points = ["arbor-eval-cli"];
    const result = run(manifest);
    expect(result.status).not.toBe(0);
    expect(result.report.communicationProof.errors).toContain("ADR-083 communicationProof.required_entry_points does not match the canonical contract");
  });

  it("TEETH: fails when the manifest removes a scoped port or a canonical landmark", () => {
    const withoutPort = cloneManifest();
    withoutPort.communicationProof.scoped_ports = withoutPort.communicationProof.scoped_ports.filter((port) => port !== "bus.thread.send");
    withoutPort.communicationProof.scope_checked_ports = withoutPort.communicationProof.scope_checked_ports.filter((port) => port !== "bus.thread.send");
    delete withoutPort.communicationProof.factory.port_handlers["bus.thread.send"];
    const portResult = run(withoutPort);
    expect(portResult.status).not.toBe(0);
    expect(portResult.report.communicationProof.errors).toContain("ADR-083 communicationProof.scoped_ports does not match the canonical contract");

    const withoutLandmark = cloneManifest();
    withoutLandmark.communicationProof.landmarks = withoutLandmark.communicationProof.landmarks.filter((landmark) => !landmark.id.endsWith("::CampaignManager"));
    const landmarkResult = run(withoutLandmark);
    expect(landmarkResult.status).not.toBe(0);
    expect(landmarkResult.report.communicationProof.errors).toContain("ADR-083 communicationProof.landmarks does not match the canonical contract");
  });

  it("TEETH: fails when a handler mapping does not exactly cover every scoped port", () => {
    const manifest = cloneManifest();
    delete manifest.communicationProof.factory.port_handlers["bus.thread.send"];
    const result = run(manifest);
    expect(result.status).not.toBe(0);
    expect(result.report.communicationProof.errors).toContain("ADR-083 communicationProof.factory.port_handlers keys must exactly cover scoped_ports");
  });

  it("TEETH: fails closed for malformed communication proof schema", () => {
    const manifest = cloneManifest();
    manifest.communicationProof = { version: 1, mechanisms: [] };
    const result = run(manifest);
    expect(result.status).not.toBe(0);
    expect(result.report.communicationProof.ok).toBe(false);
    expect(result.report.communicationProof.errors).toContain("ADR-083 communicationProof.required_entry_points must be a non-empty string array");
    expect(result.report.communicationProof.errors).toContain("ADR-083 communicationProof.factory must name a factory, scope check, scope fields, and port handlers");
  });

  it("TEETH: fails when a production source emits a scoped port a second time", () => {
    const result = runWithMutatedHost((host) => `${host}\nexport const adversarialDuplicateBusPort = { tool: "bus.thread.send" };\n`);
    expect(result.status).not.toBe(0);
    expect(result.report.communicationProof.errors).toContain("ADR-083 scoped port bus.thread.send must have exactly one native-tool emission; found 2");
  });

  it("TEETH: fails when tool literals retain their ports but their execute handlers are swapped", () => {
    const result = runWithMutatedHost((host) => {
      const send = "execute: (request: NativeToolRequest, _secret: string | null, signal: AbortSignal) => busThreadSend(options, request, now, randomId, signal)";
      const ack = "execute: (request: NativeToolRequest, _secret: string | null, signal: AbortSignal) => busThreadAck(options, request, now, randomId, signal)";
      return host.replace(send, "__ADR083_SEND__").replace(ack, send).replace("__ADR083_SEND__", ack);
    });
    expect(result.status).not.toBe(0);
    expect(result.report.communicationProof.errors).toContain("ADR-083 canonical factory does not bind bus.thread.send to busThreadSend");
    expect(result.report.communicationProof.errors).toContain("ADR-083 canonical factory does not bind bus.thread.ack to busThreadAck");
  });

  it("TEETH: fails when a scope field is used without a strict-inequality refusal", () => {
    const result = runWithMutatedHost((host) => host.replace(
      "campaignId !== scope.campaign_id",
      "campaignId + scope.campaign_id",
    ));
    expect(result.status).not.toBe(0);
    expect(result.report.communicationProof.errors).toContain("ADR-083 scope check does not fail closed for: campaign_id");
  });
});
