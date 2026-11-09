/**
 * Outermost roundtrips for the product integration control plane
 * (audit/2026-09-06-remediation/manifest.md, "Declared capability gaps":
 * "Integrations and control" and "Rollback").
 *
 * Every mutation is driven through a real entry point — the `arbor` CLI's
 * `main()` (`arbor integration|remote|scheduler|command|plugin`) or
 * `ArborMCPServer.callTool("arbor_command"|"arbor_query")` — and every
 * assertion is made on what a later, independently composed surface
 * observes: the activated command catalog, a fresh remote-session
 * authority, a scheduler trigger, and the durable control receipts that
 * `integration.inspect` / `remote.inspect` / `scheduler.inspect` project.
 * Each CLI call composes its own runtime from the shared persistence
 * directory, so no assertion can be satisfied by in-memory state.
 */
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { ConnectorRegistry } from "@arbor/harness";
import { main } from "../src/cli.js";
import { canonicalPluginPayload, type PluginManifest } from "../src/extensibility/plugin-manifest.js";
import { INTEGRATION_CONTROL_RECEIPT_FILE } from "../src/integrations/control-receipts.js";
import { createRemoteSessionIdentity, RemoteSessionAuthority } from "../src/remote-session.js";
import { ArborRuntime } from "../src/runtime.js";
import { ArborMCPServer } from "../src/server.js";

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

interface Workspace { readonly cwd: string; readonly persistence: string; readonly privateKey: KeyObject }
interface CliResult { readonly code: number; readonly stdout: string; readonly stderr: string; readonly json: any }
interface Receipt { kind: string; outcome: string; target_id: string; refusal: { code: string; summary: string } | null; before: Record<string, unknown> | null; after: Record<string, unknown> | null; receipt_id: string; sequence: number }

function workspace(): Workspace {
  const cwd = mkdtempSync(join(tmpdir(), "integration-control-")); roots.push(cwd);
  const keys = generateKeyPairSync("ed25519");
  mkdirSync(join(cwd, ".arbor"), { recursive: true });
  writeFileSync(join(cwd, ".arbor", "plugin-trust.json"), JSON.stringify({ fixture: keys.publicKey.export({ type: "spki", format: "pem" }).toString() }));
  return { cwd, persistence: join(cwd, "state"), privateKey: keys.privateKey };
}

async function arbor(ws: Workspace, ...args: string[]): Promise<CliResult> {
  const stdout = new PassThrough(); const stderr = new PassThrough(); let out = ""; let err = "";
  stdout.on("data", (chunk) => { out += chunk; }); stderr.on("data", (chunk) => { err += chunk; });
  const code = await main(args, { cwd: ws.cwd, persistence_dir: ws.persistence, stdin: new PassThrough(), stdout, stderr });
  let json: unknown = null; try { json = JSON.parse(out); } catch { /* human output */ }
  return { code, stdout: out, stderr: err, json };
}

/** Writes one signed T3 plugin revision whose single command carries `body`. */
function pluginRevision(ws: Workspace, name: string, version: string, body: string, executionRole = "specialist-executor"): { manifest: string; root: string } {
  const root = join(ws.cwd, "packages", name); mkdirSync(join(root, "commands"), { recursive: true });
  writeFileSync(join(root, "commands", "review-kit.md"), `---\ndescription: Review kit ${version}\nallowed_tools: [file.read]\nexecution_role: ${executionRole}\n---\n${body} $ARGUMENTS\n`);
  const unsigned = {
    schema_version: 1 as const, plugin_id: "review-kit", version, source: { kind: "path" as const, path: root }, requested_tier: "T3" as const,
    capabilities: { tools: [], code_execution: false, network: false, filesystem_write: true },
    components: { commands: ["commands/review-kit.md"], hooks: [], skills: [], mcp_servers: [] },
    verification: { G1: "audit:g1", G2: "audit:g2", G3: "audit:g3", G4: "audit:g4" },
  };
  const provisional = { ...unsigned, signature: { algorithm: "ed25519" as const, key_id: "fixture", value: "" } } as PluginManifest;
  const manifest = { ...provisional, signature: { ...provisional.signature, value: sign(null, canonicalPluginPayload(provisional), ws.privateKey).toString("base64") } };
  const manifestPath = join(ws.cwd, `${name}.manifest.json`); writeFileSync(manifestPath, JSON.stringify(manifest));
  return { manifest: manifestPath, root };
}

/** The real downstream effect: the command catalog a fresh process composes. */
async function activeReviewCommand(ws: Workspace): Promise<{ prompt: string } | undefined> {
  const listed = await arbor(ws, "command", "list");
  expect(listed.code).toBe(0);
  return (listed.json.commands as { name: string; prompt: string }[]).find((command) => command.name === "review-kit");
}

async function inspect(ws: Workspace, id: string): Promise<{ state: string; version: string; receipts: Receipt[] }> {
  const result = await arbor(ws, "integration", "inspect", id);
  expect(result.code, result.stderr).toBe(0);
  return result.json.value;
}

const EXT = "extension.review-kit";

describe("product integration control plane — outermost roundtrips", () => {
  it("installs a signed extension, activates its command only after an acknowledged enable, and revokes it on disable, with durable receipts", async () => {
    const ws = workspace();
    const v1 = pluginRevision(ws, "v1", "1.0.0", "Review v1:");

    const before = await arbor(ws, "integration", "list");
    expect(before.code).toBe(0);
    expect((before.json.value.integrations as { id: string }[]).map((item) => item.id)).not.toContain(EXT);

    // A manifest naming a different plugin is refused before admission: nothing is persisted.
    const mismatched = await arbor(ws, "integration", "install", "extension.other-kit", "--plugin-manifest", v1.manifest, "--plugin-root", v1.root);
    expect(mismatched.code).toBe(4);
    expect(mismatched.json.error.summary).toContain("must match the signed plugin manifest id");
    expect((await arbor(ws, "plugin", "list")).json).toEqual([]);

    const installed = await arbor(ws, "integration", "install", EXT, "--plugin-manifest", v1.manifest, "--plugin-root", v1.root);
    expect(installed.code, installed.stdout + installed.stderr).toBe(0);
    expect(installed.json.value).toMatchObject({ accepted: true, receipt_id: expect.stringMatching(/^icr:/) });
    expect(await activeReviewCommand(ws)).toBeUndefined();
    expect(await inspect(ws, EXT)).toMatchObject({ state: "installed", version: "1.0.0" });

    // Denial: a risky (filesystem_write) activation without acknowledgement changes nothing.
    const unacknowledged = await arbor(ws, "integration", "enable", EXT);
    expect(unacknowledged.code).toBe(4);
    expect(unacknowledged.json.error.summary).toContain("acknowledgement");
    expect(await activeReviewCommand(ws)).toBeUndefined();

    // Denial: a transport caller without config.write authority is refused, and the refusal is a receipt.
    const junior = new ArborMCPServer(new ArborRuntime({ persistence_dir: ws.persistence, workspace_root: ws.cwd }), { caller_tier: "junior" });
    const denied = await junior.callTool("arbor_command", { kind: "integration.enable", integration_id: EXT, acknowledge_risk: true, provenance: { tag: "claimed", claimant: "junior" } }) as { ok: boolean; error: { code: string } };
    expect(denied).toMatchObject({ ok: false, error: { code: "permission" } });
    await junior.runtime.close();
    expect(await activeReviewCommand(ws)).toBeUndefined();

    const enabled = await arbor(ws, "integration", "enable", EXT, "--acknowledge-risk");
    expect(enabled.code, enabled.stdout + enabled.stderr).toBe(0);
    expect((await activeReviewCommand(ws))?.prompt).toContain("Review v1:");
    expect(await inspect(ws, EXT)).toMatchObject({ state: "enabled", version: "1.0.0" });

    // Revocation: disabling removes the live command from every later composition.
    const disabled = await arbor(ws, "integration", "disable", EXT);
    expect(disabled.code, disabled.stdout + disabled.stderr).toBe(0);
    expect(await activeReviewCommand(ws)).toBeUndefined();

    const projected = await inspect(ws, EXT);
    expect(projected.state).toBe("disabled");
    expect(projected.receipts.map((receipt) => [receipt.kind, receipt.outcome, receipt.refusal?.code ?? null])).toEqual([
      ["integration.install", "applied", null],
      ["integration.enable", "refused", "conflict"],
      ["integration.enable", "refused", "permission"],
      ["integration.enable", "applied", null],
      ["integration.disable", "applied", null],
    ]);
    expect(projected.receipts[0]).toMatchObject({ before: null, after: { state: "installed", version: "1.0.0" }, receipt_id: installed.json.value.receipt_id });
    expect(projected.receipts[3]).toMatchObject({ before: { state: "installed" }, after: { state: "enabled" } });
    expect(projected.receipts[4]).toMatchObject({ before: { state: "enabled" }, after: { state: "disabled" } });
    // The mismatched install targeted another id and is receipted against it, not this extension.
    expect((await arbor(ws, "integration", "inspect", "extension.other-kit")).code).toBe(4);
    const journal = readFileSync(join(ws.persistence, INTEGRATION_CONTROL_RECEIPT_FILE), "utf8").trim().split("\n").map((line) => JSON.parse(line) as Receipt);
    expect(journal.map((receipt) => receipt.sequence)).toEqual(journal.map((_, index) => index + 1));
    expect(journal[0]).toMatchObject({ kind: "integration.install", target_id: "extension.other-kit", outcome: "refused" });
  });

  it("upgrades a live extension, refuses a failed activation atomically, and rolls back to the previous functional revision with a visible receipt", async () => {
    const ws = workspace();
    const v1 = pluginRevision(ws, "v1", "1.0.0", "Review v1:");
    const broken = pluginRevision(ws, "broken", "1.2.0", "Review broken:", "no-such-role");
    const v2 = pluginRevision(ws, "v2", "1.1.0", "Review v2 regressed:");
    expect((await arbor(ws, "integration", "install", EXT, "--plugin-manifest", v1.manifest, "--plugin-root", v1.root)).code).toBe(0);
    expect((await arbor(ws, "integration", "enable", EXT, "--acknowledge-risk")).code).toBe(0);
    expect((await activeReviewCommand(ws))?.prompt).toContain("Review v1:");

    // Actual failed activation: the broken revision's command cannot be activated, so the swap is undone.
    const failed = await arbor(ws, "integration", "update", EXT, "1.2.0", "--plugin-manifest", broken.manifest, "--plugin-root", broken.root, "--acknowledge-risk");
    expect(failed.code).toBe(4);
    expect(failed.json.error.summary).toContain("execution_role");
    expect((await activeReviewCommand(ws))?.prompt).toContain("Review v1:");
    expect(await inspect(ws, EXT)).toMatchObject({ state: "enabled", version: "1.0.0" });
    // No rollback point was left behind by the refused upgrade.
    expect((await arbor(ws, "integration", "rollback", EXT, "--acknowledge-risk")).code).toBe(4);

    // The projected version is the signed manifest's, never a free label.
    const relabelled = await arbor(ws, "integration", "update", EXT, "9.9.9", "--plugin-manifest", v2.manifest, "--plugin-root", v2.root, "--acknowledge-risk");
    expect(relabelled.code).toBe(4);
    expect(relabelled.json.error.summary).toContain("must equal the signed plugin manifest version");

    const upgraded = await arbor(ws, "integration", "update", EXT, "1.1.0", "--plugin-manifest", v2.manifest, "--plugin-root", v2.root, "--acknowledge-risk");
    expect(upgraded.code, upgraded.stdout + upgraded.stderr).toBe(0);
    expect((await activeReviewCommand(ws))?.prompt).toContain("Review v2 regressed:");
    expect(await inspect(ws, EXT)).toMatchObject({ state: "enabled", version: "1.1.0" });

    // Authorized rollback: risky rollback needs acknowledgement, then restores v1's exact component.
    const unacknowledged = await arbor(ws, "integration", "rollback", EXT);
    expect(unacknowledged.code).toBe(4);
    expect((await activeReviewCommand(ws))?.prompt).toContain("Review v2 regressed:");
    const rolledBack = await arbor(ws, "integration", "rollback", EXT, "--acknowledge-risk");
    expect(rolledBack.code, rolledBack.stdout + rolledBack.stderr).toBe(0);
    expect((await activeReviewCommand(ws))?.prompt).toContain("Review v1:");
    expect((await arbor(ws, "plugin", "inspect", "review-kit")).json).toMatchObject({ state: "enabled", manifest: { version: "1.0.0" } });

    const projected = await inspect(ws, EXT);
    expect(projected).toMatchObject({ state: "enabled", version: "1.0.0" });
    const rollbackReceipt = projected.receipts.find((receipt) => receipt.kind === "integration.rollback" && receipt.outcome === "applied");
    expect(rollbackReceipt).toMatchObject({ before: { state: "enabled", version: "1.1.0" }, after: { state: "enabled", version: "1.0.0" }, receipt_id: rolledBack.json.value.receipt_id });
    expect(projected.receipts.filter((receipt) => receipt.kind === "integration.update").map((receipt) => receipt.outcome)).toEqual(["refused", "refused", "applied"]);
    // A rollback point is consumed exactly once.
    expect((await arbor(ws, "integration", "rollback", EXT, "--acknowledge-risk")).code).toBe(4);
    expect((await activeReviewCommand(ws))?.prompt).toContain("Review v1:");
  });

  it("admits browser capabilities only while an enabled composed browser integration declares them, and refuses descriptor transitions with no real effect", async () => {
    const ws = workspace();
    const connectors = new ConnectorRegistry();
    connectors.register({ connector_id: "browser-fixture", implementation_version: "1.0.0", supported_upstream_range: "fixture", health: "healthy", capabilities: [
      { capability: "browser_observe", grade: "governed", evidence: { implementation_id: "browser-fixture", observed_at: "2026-10-06T00:00:00.000Z", detail: "explicit browser port" } },
    ] });
    const server = new ArborMCPServer(new ArborRuntime({ persistence_dir: ws.persistence, workspace_root: ws.cwd, harness_connector_registry: connectors }));
    try {
      const listed = await server.callTool("arbor_query", { kind: "integration.list", category: "browser" }) as { ok: boolean; value: { integrations: { id: string; state: string; capabilities: string[] }[] } };
      const browser = listed.value.integrations.find((item) => item.id.startsWith("browser.connector-"))!;
      expect(browser).toMatchObject({ state: "discovered", capabilities: ["browser_observe"] });
      const admit = async () => (await server.callTool("arbor_query", { kind: "integration.admit", integration_id: browser.id, capabilities: ["browser_observe"] }) as { value: { admitted: boolean; reason: string } }).value;
      expect(await admit()).toMatchObject({ admitted: false, reason: expect.stringContaining("not enabled") });

      const enable = await server.callTool("arbor_command", { kind: "integration.enable", integration_id: browser.id, acknowledge_risk: true, provenance: { tag: "claimed", claimant: "operator" } }) as { ok: boolean; value: { accepted: boolean; receipt_id: string } };
      expect(enable).toMatchObject({ ok: true, value: { accepted: true, receipt_id: expect.stringMatching(/^icr:/) } });
      expect(await admit()).toMatchObject({ admitted: true });
      expect((await server.callTool("arbor_query", { kind: "integration.admit", integration_id: browser.id, capabilities: ["computer_use"] }) as { value: { admitted: boolean } }).value.admitted).toBe(false);

      // Revocation: disabling withdraws the admission decision.
      await server.callTool("arbor_command", { kind: "integration.disable", integration_id: browser.id, acknowledge_risk: true, provenance: { tag: "claimed", claimant: "operator" } });
      expect(await admit()).toMatchObject({ admitted: false });

      // Descriptor-only integrations have nothing to install, version, or activate in this runtime.
      for (const [kind, id, extra] of [["integration.install", "ide.vscode", {}], ["integration.update", "github.app", { version: "1.0.1" }], ["integration.rollback", "github.app", {}], ["integration.enable", "github.app", {}], ["integration.enable", "scheduler.control", {}]] as const) {
        const refused = await server.callTool("arbor_command", { kind, integration_id: id, ...extra, acknowledge_risk: true, provenance: { tag: "claimed", claimant: "operator" } }) as { ok: boolean; error: { code: string; summary: string } };
        expect(refused, `${kind} ${id}`).toMatchObject({ ok: false, error: { code: "unavailable" } });
      }
      const github = await server.callTool("arbor_query", { kind: "integration.inspect", integration_id: "github.app" }) as { value: { state: string; version: string; receipts: Receipt[] } };
      expect(github.value).toMatchObject({ state: "discovered", version: "1.0.0" });
      expect(github.value.receipts.map((receipt) => [receipt.kind, receipt.outcome])).toEqual([["integration.update", "refused"], ["integration.rollback", "refused"], ["integration.enable", "refused"]]);
      const browserInspect = await server.callTool("arbor_query", { kind: "integration.inspect", integration_id: browser.id }) as { value: { state: string; receipts: Receipt[] } };
      expect(browserInspect.value.receipts.map((receipt) => [receipt.kind, receipt.after?.state])).toEqual([["integration.enable", "enabled"], ["integration.disable", "disabled"]]);
    } finally { await server.runtime.close(); }
  });

  it("revokes a registered remote session and suspends then resumes a durable schedule through the CLI, with the downstream effect and receipts observed", async () => {
    const ws = workspace();
    const identity = createRemoteSessionIdentity({ session_id: "remote-operator", actor_id: "remote:operator", expires_at: new Date(Date.now() + 3_600_000).toISOString(), thread_audiences: [], approval_authority: true });
    mkdirSync(ws.persistence, { recursive: true });
    new RemoteSessionAuthority({ persistence_dir: ws.persistence }).register(identity.registration);
    const approvalProof = () => identity.sign({ kind: "approval.request", metadata: { operation_id: "op" }, params: {} });
    const verify = () => new RemoteSessionAuthority({ persistence_dir: ws.persistence }).verifyApproval(approvalProof(), { kind: "approval.request", metadata: { operation_id: "op" }, params: {} });
    expect(verify()).toMatchObject({ ok: true, session_id: "remote-operator" });

    const remoteBefore = await arbor(ws, "remote", "status");
    expect(remoteBefore.code).toBe(0);
    expect(remoteBefore.json.value.sessions).toEqual([expect.objectContaining({ session_id: "remote-operator", state: "active" })]);
    expect(JSON.stringify(remoteBefore.json)).not.toContain(identity.registration.public_key_pem.trim().split("\n")[1]!);

    const unknown = await arbor(ws, "remote", "revoke", "remote-absent");
    expect(unknown.code).toBe(4);
    const revoked = await arbor(ws, "remote", "revoke", "remote-operator");
    expect(revoked.code, revoked.stdout + revoked.stderr).toBe(0);
    // The effect: a fresh authority over the same durable state refuses the revoked session.
    expect(verify()).toMatchObject({ ok: false, error: "remote session is not active" });
    const remoteAfter = await arbor(ws, "remote", "status");
    expect(remoteAfter.json.value.sessions).toEqual([expect.objectContaining({ session_id: "remote-operator", state: "revoked" })]);
    expect(remoteAfter.json.value.receipts.map((receipt: Receipt) => [receipt.target_id, receipt.outcome, receipt.before?.state ?? null, receipt.after?.state ?? null])).toEqual([
      ["remote-absent", "refused", null, null],
      ["remote-operator", "applied", "active", "revoked"],
    ]);

    expect((await arbor(ws, "scheduler", "register", "nightly", "--campaign", "campaign-nightly", "--task", "audit the tree", "--external", "nightly-key", "--json")).code).toBe(0);
    const suspended = await arbor(ws, "integration", "scheduler", "suspend", "nightly", "operator", "review");
    expect(suspended.code, suspended.stdout + suspended.stderr).toBe(0);
    // The effect: a suspended schedule does not fire on its own trigger.
    const trigger = await arbor(ws, "scheduler", "trigger", "nightly-key", "--json");
    expect(trigger.json).toMatchObject({ key: "nightly-key", fired: [] });
    const whileSuspended = await arbor(ws, "integration", "scheduler");
    expect(whileSuspended.json.value.schedules).toEqual([expect.objectContaining({ schedule_id: "nightly", state: "human_required", human_reason: "operator review", version: 2 })]);
    expect(whileSuspended.json.value.runs).toEqual([]);

    const resumed = await arbor(ws, "integration", "scheduler", "resume", "nightly");
    expect(resumed.code, resumed.stdout + resumed.stderr).toBe(0);
    const afterResume = await arbor(ws, "integration", "scheduler");
    expect(afterResume.json.value.schedules).toEqual([expect.objectContaining({ schedule_id: "nightly", state: "active", human_reason: null, version: 3 })]);
    expect(afterResume.json.value.receipts.map((receipt: Receipt & { action: string }) => [receipt.action, receipt.before?.state, receipt.after?.state])).toEqual([
      ["suspend", "active", "human_required"],
      ["resume", "human_required", "active"],
    ]);
  });
});
