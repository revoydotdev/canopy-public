/**
 * Verifier network policy (operator decision 2026-10-06, ADR-PENDING
 * verifier-network-default-deny): every machine-verification command runs
 * with NO host network unless the operator granted its exact argv egress in
 * `verification.network_egress`, and the grant is recorded in the evidence.
 *
 * The real-bwrap block drives `createDeclaredOutputsVerifier` -- the one
 * production verifier every harness integration composes -- through the
 * default `SandboxedVerificationCommandPort` and a real bubblewrap broker,
 * against a listener bound on the HOST's 127.0.0.1. Before this policy a
 * specialist-written test could connect to any such host service.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDeclaredOutputsVerifier } from "../src/cli.js";
import { SandboxedVerificationCommandPort, verifierNetworkFor } from "../src/sandbox/confined-command.js";
import { createSandboxBroker } from "../src/sandbox/sandbox-broker.js";
import type { SandboxBroker, SandboxedCommandRequest } from "../src/sandbox/contracts.js";
import { WorktreeMachineVerifier, type MachineVerificationCommandPort, type SpecialistWorktreeVerificationInput } from "../src/worktree-machine-verifier.js";

const created: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const path of created.splice(0)) rmSync(path, { recursive: true, force: true });
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

function worktree(): string {
  const path = realpathSync(mkdtempSync(join(tmpdir(), "arbor-verifier-net-")));
  created.push(path);
  return path;
}

function inputFor(worktreePath: string): SpecialistWorktreeVerificationInput {
  return { campaign_id: "campaign", node_id: "node", specialist_agent: "seed", session_id: "session", worktree_path: worktreePath, final_message: "", history: [] };
}

/** A service on the HOST's loopback that counts every connection it accepts. */
async function hostLoopbackListener(): Promise<{ port: number; accepted: () => number }> {
  let accepted = 0;
  const server = createServer((socket) => { accepted += 1; socket.end("host-secret"); });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("listener has no port");
  return { port: address.port, accepted: () => accepted };
}

// Exit 0 only if it reached the host listener and read its reply; 7 on a
// connection error; 6 if nothing happened in time.
const HOST_PROBE = [
  "const net = require('node:net');",
  "const socket = net.connect(Number(process.argv[2]), '127.0.0.1');",
  "socket.on('data', (chunk) => { process.exit(String(chunk) === 'host-secret' ? 0 : 5); });",
  "socket.on('error', () => process.exit(7));",
  "setTimeout(() => process.exit(6), 3000);",
].join("\n");

// A test that binds its own localhost server -- must keep working when denied.
const OWN_LOOPBACK = [
  "const net = require('node:net');",
  "const server = net.createServer((socket) => socket.end('ok'));",
  "server.listen(0, '127.0.0.1', () => {",
  "  const client = net.connect(server.address().port, '127.0.0.1');",
  "  client.on('data', (chunk) => process.exit(String(chunk) === 'ok' ? 0 : 9));",
  "  client.on('error', () => process.exit(8));",
  "});",
].join("\n");

describe("verifierNetworkFor", () => {
  it("denies host network by default", () => {
    expect(verifierNetworkFor(["cargo", "test"], undefined)).toEqual({ network: "enforced_denied" });
    expect(verifierNetworkFor(["cargo", "test"], [])).toEqual({ network: "enforced_denied" });
  });

  it("grants egress only to an exactly equal argv, carrying the declared reason", () => {
    const grants = [{ argv: ["cargo", "test", "--quiet"], reason: "no Cargo.lock" }];
    expect(verifierNetworkFor(["cargo", "test", "--quiet"], grants)).toEqual({ network: "unrestricted", network_egress: { reason: "no Cargo.lock" } });
    // Never inferred from the command text: prefixes, extensions and
    // look-alikes of a granted argv stay denied.
    expect(verifierNetworkFor(["cargo", "test"], grants)).toEqual({ network: "enforced_denied" });
    expect(verifierNetworkFor(["cargo", "test", "--quiet", "--", "x"], grants)).toEqual({ network: "enforced_denied" });
    expect(verifierNetworkFor(["/usr/bin/cargo", "test", "--quiet"], grants)).toEqual({ network: "enforced_denied" });
  });
});

describe("network policy plumbing", () => {
  it("maps the verifier policy onto the broker's network_denied flag", async () => {
    const seen: SandboxedCommandRequest[] = [];
    const broker: SandboxBroker = { confinement: "os_confined", diagnostic: "fixture", async run(request) { seen.push(request); return { kind: "exited", exit: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), confinement: "os_confined" }; } };
    const port = new SandboxedVerificationCommandPort(broker);
    const root = worktree();
    const base = { argv: ["true"] as [string], cwd: root, timeout_ms: 1_000, max_output_bytes: 1_024, signal: new AbortController().signal };
    await port.run({ ...base, network: "enforced_denied" });
    await port.run({ ...base, network: "unrestricted" });
    expect(seen.map((request) => request.network_denied)).toEqual([true, false]);
  });

  it("refuses an egress record on a command that is not actually unrestricted, or one with no reason", () => {
    expect(() => new WorktreeMachineVerifier({ command: { argv: ["true"], network: "enforced_denied", network_egress: { reason: "x" } } })).toThrow(/requires network "unrestricted"/);
    expect(() => new WorktreeMachineVerifier({ command: { argv: ["true"], network: "unrestricted", network_egress: { reason: " " } } })).toThrow(/non-empty reason/);
  });

  it("records which stage ran with network, and why, on a FAILED outcome too", async () => {
    const port: MachineVerificationCommandPort = { async run(request) { return { kind: "exited", exit: request.network === "unrestricted" ? 3 : 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }; } };
    const verifier = new WorktreeMachineVerifier({
      command_port: port,
      command: { stages: [
        { argv: ["make", "build"], network: "enforced_denied" },
        { argv: ["cargo", "fetch"], network: "unrestricted", network_egress: { reason: "crates.io fetch" } },
      ] },
    });
    const outcome = await verifier.verifyOutcome(inputFor(worktree()), new AbortController().signal);
    expect(outcome).toMatchObject({ outcome: "failed", code: "command_exit_nonzero", network_egress: [{ display: 'cargo fetch [network:egress reason="crates.io fetch"]', reason: "crates.io fetch" }] });
  });
});

const realBroker = createSandboxBroker();
describe.runIf(realBroker.confinement === "os_confined")("production verifier against a real bubblewrap sandbox", () => {
  it("by default, a verifier command cannot reach a listener on the host's loopback", async () => {
    const root = worktree();
    writeFileSync(join(root, "probe.cjs"), HOST_PROBE);
    const host = await hostLoopbackListener();
    const argv = [process.execPath, "probe.cjs", String(host.port)];
    const outcome = await createDeclaredOutputsVerifier({ current: null }, [argv]).verifyOutcome(inputFor(root), new AbortController().signal);

    expect(outcome).toMatchObject({ outcome: "failed", code: "command_exit_nonzero", exit: 7 });
    expect(outcome).not.toHaveProperty("network_egress");
    expect(host.accepted()).toBe(0);
  });

  it("by default, a test that binds its own localhost server still verifies", async () => {
    const root = worktree();
    writeFileSync(join(root, "own-loopback.cjs"), OWN_LOOPBACK);
    const argv = [process.execPath, "own-loopback.cjs"];
    const outcome = await createDeclaredOutputsVerifier({ current: null }, [argv]).verifyOutcome(inputFor(root), new AbortController().signal);

    expect(outcome.outcome).toBe("verified");
    if (outcome.outcome !== "verified") return;
    expect(outcome.provenance.cmd).not.toContain("[network:egress");
    expect(outcome).not.toHaveProperty("network_egress");
  });

  it("with the operator's exact-argv opt-in, the command reaches the host and the grant is in the verified evidence", async () => {
    const root = worktree();
    writeFileSync(join(root, "probe.cjs"), HOST_PROBE);
    const host = await hostLoopbackListener();
    const argv = [process.execPath, "probe.cjs", String(host.port)];
    const reason = "fixture: acceptance needs host network";
    const outcome = await createDeclaredOutputsVerifier({ current: null }, [argv], [{ argv, reason }]).verifyOutcome(inputFor(root), new AbortController().signal);

    expect(outcome.outcome).toBe("verified");
    if (outcome.outcome !== "verified") return;
    expect(host.accepted()).toBe(1);
    // The durable record: the verified provenance names the grant and its reason.
    expect(outcome.provenance.cmd).toContain(`[network:egress reason=${JSON.stringify(reason)}]`);
    expect(outcome.network_egress).toEqual([{ display: outcome.provenance.cmd, reason }]);
  });

  it("a grant for a different argv does not leak to this command", async () => {
    const root = worktree();
    writeFileSync(join(root, "probe.cjs"), HOST_PROBE);
    const host = await hostLoopbackListener();
    const argv = [process.execPath, "probe.cjs", String(host.port)];
    const outcome = await createDeclaredOutputsVerifier({ current: null }, [argv], [{ argv: [process.execPath, "probe.cjs"], reason: "other command" }]).verifyOutcome(inputFor(root), new AbortController().signal);

    expect(outcome).toMatchObject({ outcome: "failed", code: "command_exit_nonzero", exit: 7 });
    expect(host.accepted()).toBe(0);
  });
});
