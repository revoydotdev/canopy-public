import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { caTrustStoreRoots, countOwnedLinuxTasks, createSandboxBroker, SandboxConfinementUnavailableError, SANDBOX_CONFINEMENT_LEVELS, DEFAULT_SANDBOX_CONFINEMENT_LEVEL } from "../src/sandbox/sandbox-broker.js";
import { resolveLinkedDependencyRoots } from "../src/sandbox/confined-command.js";
import { buildNetworkDenySeccompProgram } from "../src/sandbox/seccomp.js";
import { buildSeatbeltProfile, probeSeatbeltAvailability } from "../src/sandbox/seatbelt-sandbox-broker.js";

const created: string[] = [];
afterEach(() => { for (const path of created.splice(0)) rmSync(path, { recursive: true, force: true }); });
function directory(prefix: string): string { const path = mkdtempSync(join(tmpdir(), prefix)); created.push(path); return path; }

describe("sandbox broker grade honesty", () => {
  it("counts same-UID Linux tasks rather than only process leaders for RLIMIT_NPROC", () => {
    const proc = directory("arbor-proc-fixture-");
    for (const [processId, taskIds] of [["100", ["100", "101", "102"]], ["200", ["200", "201"]]] as const) {
      mkdirSync(join(proc, processId, "task"), { recursive: true });
      for (const taskId of taskIds) mkdirSync(join(proc, processId, "task", taskId));
    }
    mkdirSync(join(proc, "not-a-process"));
    expect(countOwnedLinuxTasks(proc, process.getuid?.() ?? 0)).toBe(5);
  });

  it("discovers exact external dependency and workspace-package roots without mounting their common repository", () => {
    const context = directory("arbor-linked-context-");
    const external = directory("arbor-linked-external-");
    mkdirSync(join(context, "node_modules"), { recursive: true });
    mkdirSync(join(external, "node_modules", "@scope"), { recursive: true });
    mkdirSync(join(external, "packages", "worker"), { recursive: true });
    symlinkSync(join(external, "node_modules", "@scope"), join(context, "node_modules", "@scope"));
    symlinkSync(join(external, "packages", "worker"), join(external, "node_modules", "@scope", "worker"));
    expect(resolveLinkedDependencyRoots(context)).toEqual([
      join(external, "node_modules"),
      join(external, "packages", "worker"),
    ].sort());
  });

  // Audit 2026-08-23 WA-47 / J8-03: crossing the 256-root cap used to return
  // [] — every dependency mount vanished exactly when the link farm was big.
  it("keeps a bounded set of dependency roots at the cap instead of discarding all of them", () => {
    const context = directory("arbor-linked-cap-context-");
    const external = directory("arbor-linked-cap-external-");
    mkdirSync(join(context, "node_modules"), { recursive: true });
    for (let i = 0; i < 300; i++) {
      const pkg = join(external, `pkg-${String(i).padStart(3, "0")}`);
      mkdirSync(pkg, { recursive: true });
      symlinkSync(pkg, join(context, "node_modules", `dep-${String(i).padStart(3, "0")}`));
    }
    const roots = resolveLinkedDependencyRoots(context);
    expect(roots.length).toBe(256);
    expect(roots.every((root) => root.startsWith(external))).toBe(true);
  });

  it("reports application validation and refuses denied-network execution when OS confinement is unavailable", async () => {
    const root = directory("arbor-sandbox-fallback-");
    const broker = createSandboxBroker({ disable_os_confinement: true });
    expect(broker.confinement).toBe("application_validated");
    await expect(broker.run({ argv: [process.execPath, "-e", "process.exit(0)"], cwd: root, workspace_root: root, workspace_writable: true, network_denied: true, timeout_ms: 1_000, max_output_bytes: 1_024, signal: new AbortController().signal })).resolves.toEqual({ kind: "network_isolation_unavailable", confinement: "application_validated" });
  });

  it("rejects an application-validated cwd outside the declared workspace", async () => {
    const root = directory("arbor-sandbox-root-");
    const outside = directory("arbor-sandbox-outside-");
    const broker = createSandboxBroker({ disable_os_confinement: true });
    expect(() => broker.run({ argv: [process.execPath, "-e", "process.exit(0)"], cwd: outside, workspace_root: root, workspace_writable: true, network_denied: false, timeout_ms: 1_000, max_output_bytes: 1_024, signal: new AbortController().signal })).toThrow(/within workspace_root/);
  });
});

describe("sandbox confinement-level resolution (LR-NH-04)", () => {
  const available = (): string | null => null;
  const unavailable = (): string | null => "fixture: bubblewrap namespace probe failed";

  it("declares exactly the four levels with os_best_effort as the recommended default", () => {
    expect(SANDBOX_CONFINEMENT_LEVELS).toEqual(["off", "app_only", "os_best_effort", "os_required"]);
    expect(DEFAULT_SANDBOX_CONFINEMENT_LEVEL).toBe("os_best_effort");
  });

  it("defaults to os_best_effort when no level is supplied, using OS confinement once the probe succeeds", () => {
    const broker = createSandboxBroker({ probe_os_confinement: available });
    expect(broker.confinement).toBe("os_confined");
  });

  it("os_best_effort honestly falls back to application_validated when the probe fails, without throwing", () => {
    const broker = createSandboxBroker({ confinement_level: "os_best_effort", probe_os_confinement: unavailable });
    expect(broker.confinement).toBe("application_validated");
    expect(broker.diagnostic).toBe("fixture: bubblewrap namespace probe failed");
  });

  for (const level of ["off", "app_only"] as const) {
    it(`${level} forces application_validated even when the OS mechanism is available`, () => {
      const broker = createSandboxBroker({ confinement_level: level, probe_os_confinement: available });
      expect(broker.confinement).toBe("application_validated");
      expect(broker.diagnostic).toContain(`confinement_level=${level}`);
    });
  }

  it("os_required uses OS confinement when the probe succeeds", () => {
    const broker = createSandboxBroker({ confinement_level: "os_required", probe_os_confinement: available });
    expect(broker.confinement).toBe("os_confined");
  });

  it("os_required fails closed — refuses to construct a broker at all — when the probe reports unavailable", () => {
    expect(() => createSandboxBroker({ confinement_level: "os_required", probe_os_confinement: unavailable })).toThrow(SandboxConfinementUnavailableError);
    try {
      createSandboxBroker({ confinement_level: "os_required", probe_os_confinement: unavailable });
      expect.unreachable("must throw");
    } catch (error) {
      expect(error).toBeInstanceOf(SandboxConfinementUnavailableError);
      expect((error as SandboxConfinementUnavailableError).diagnostic).toBe("fixture: bubblewrap namespace probe failed");
      expect((error as Error).message).toContain("os_required");
    }
  });

  it("never silently downgrades os_required: the probe is consulted rather than assumed", () => {
    let probed = false;
    const probe = (): string | null => { probed = true; return "fixture: unavailable"; };
    expect(() => createSandboxBroker({ confinement_level: "os_required", probe_os_confinement: probe })).toThrow();
    expect(probed).toBe(true);
  });

  it("legacy disable_os_confinement:true resolves to the app_only level when no explicit level is given", () => {
    const broker = createSandboxBroker({ disable_os_confinement: true, probe_os_confinement: available });
    expect(broker.confinement).toBe("application_validated");
  });

  it("an explicit confinement_level takes precedence over the legacy disable_os_confinement flag", () => {
    const broker = createSandboxBroker({ disable_os_confinement: true, confinement_level: "os_best_effort", probe_os_confinement: available });
    expect(broker.confinement).toBe("os_confined");
  });
});

const osBroker = createSandboxBroker();
describe("CA trust-store mounts", () => {
  it("covers /etc/ssl, sibling stores, and the directories its symlinks resolve into, outermost only", () => {
    const etc = directory("arbor-sandbox-etc-");
    mkdirSync(join(etc, "ssl/certs"), { recursive: true });
    mkdirSync(join(etc, "ca-certificates/extracted/cadir"), { recursive: true });
    mkdirSync(join(etc, "pki/tls"), { recursive: true });
    mkdirSync(join(etc, "other-store"), { recursive: true });
    writeFileSync(join(etc, "ca-certificates/extracted/cadir/root.pem"), "pem");
    writeFileSync(join(etc, "ca-certificates/extracted/bundle.pem"), "pem");
    writeFileSync(join(etc, "other-store/odd.pem"), "pem");
    symlinkSync("../../ca-certificates/extracted/cadir/root.pem", join(etc, "ssl/certs/root.pem"));
    symlinkSync("../../ca-certificates/extracted/bundle.pem", join(etc, "ssl/certs/ca-certificates.crt"));
    symlinkSync("../../other-store/odd.pem", join(etc, "ssl/certs/odd.pem"));
    const roots = caTrustStoreRoots(etc);
    expect(roots).toEqual(["ca-certificates", "other-store", "pki", "ssl"].map((name) => join(etc, name)));
  });

  it("never mounts a symlink target outside /etc, in /usr, or /etc itself", () => {
    const etc = directory("arbor-sandbox-etc-escape-");
    const outside = directory("arbor-sandbox-outside-");
    mkdirSync(join(etc, "ssl/certs"), { recursive: true });
    writeFileSync(join(outside, "x.pem"), "pem");
    symlinkSync(join(outside, "x.pem"), join(etc, "ssl/certs/x.pem"));
    symlinkSync("../../hosts", join(etc, "ssl/certs/hosts"));
    writeFileSync(join(etc, "hosts"), "h");
    expect(caTrustStoreRoots(etc)).toEqual([join(etc, "ssl")]);
  });

  it("returns nothing for a host without any trust store", () => {
    expect(caTrustStoreRoots(directory("arbor-sandbox-etc-empty-"))).toEqual([]);
  });
});

describe.runIf(osBroker.confinement === "os_confined")("active Linux OS confinement", () => {
  it("lets a confined process read a CA file reached through an /etc/ssl symlink, read-only", async () => {
    const certs = "/etc/ssl/certs";
    const link = existsSync(certs) ? readdirSync(certs).map((name) => join(certs, name)).find((path) => realpathSync(path).startsWith("/etc/") && !realpathSync(path).startsWith("/etc/ssl/")) : undefined;
    if (link === undefined) return;
    const root = directory("arbor-sandbox-ca-");
    const read = await osBroker.run({ argv: ["/usr/bin/head", "-c", "1", link], cwd: root, workspace_root: root, workspace_writable: true, network_denied: true, timeout_ms: 2_000, max_output_bytes: 2_048, signal: new AbortController().signal });
    expect(read).toMatchObject({ kind: "exited", exit: 0, confinement: "os_confined" });
    const write = await osBroker.run({ argv: ["/usr/bin/sh", "-c", `echo x >> '${realpathSync(link)}'`], cwd: root, workspace_root: root, workspace_writable: true, network_denied: true, timeout_ms: 2_000, max_output_bytes: 2_048, signal: new AbortController().signal });
    expect(write).toMatchObject({ kind: "exited", confinement: "os_confined" });
    if (write.kind === "exited") expect(write.exit).not.toBe(0);
  });

  it("executes an explicitly authorized absolute executable outside /usr", async () => {
    const root = directory("arbor-sandbox-root-");
    const toolDir = directory("arbor-sandbox-authorized-tool-");
    const tool = join(toolDir, "authorized-tool");
    writeFileSync(tool, "#!/usr/bin/sh\nprintf 'authorized:%s' \"$1\"\n");
    chmodSync(tool, 0o755);

    const result = await osBroker.run({ argv: [tool, "proof"], cwd: root, workspace_root: root, workspace_writable: true, network_denied: true, timeout_ms: 2_000, max_output_bytes: 2_048, signal: new AbortController().signal });

    expect(result).toMatchObject({ kind: "exited", exit: 0, confinement: "os_confined" });
    if (result.kind === "exited") expect(result.stdout.toString()).toBe("authorized:proof");
  });

  it("mounts an explicitly authorized dependency in a host-immutable ephemeral overlay", async () => {
    const context = directory("arbor-sandbox-context-");
    const dependencyRoot = directory("arbor-sandbox-dependencies-");
    const workspace = join(context, ".worktrees", "node");
    mkdirSync(join(context, "node_modules"), { recursive: true });
    mkdirSync(join(dependencyRoot, "proof"), { recursive: true });
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(dependencyRoot, "proof", "value"), "dependency-proof");
    symlinkSync(join(dependencyRoot, "proof"), join(context, "node_modules", "proof"));
    const read = `const f=require('node:fs');process.stdout.write(f.readFileSync(${JSON.stringify(join(context, "node_modules", "proof", "value"))},'utf8'))`;
    const base = { argv: [process.execPath, "-e", read] as [string, ...string[]], cwd: workspace, workspace_root: workspace, workspace_writable: true, readonly_context_root: context, network_denied: true, timeout_ms: 2_000, max_output_bytes: 2_048, signal: new AbortController().signal };

    const hidden = await osBroker.run(base);
    expect(hidden).toMatchObject({ kind: "exited", confinement: "os_confined" });
    if (hidden.kind === "exited") expect(hidden.exit).not.toBe(0);

    const visible = await osBroker.run({ ...base, readonly_dependency_root: dependencyRoot });
    expect(visible).toMatchObject({ kind: "exited", exit: 0, confinement: "os_confined" });
    if (visible.kind === "exited") expect(visible.stdout.toString()).toBe("dependency-proof");

    const write = await osBroker.run({ ...base, argv: [process.execPath, "-e", `require('node:fs').writeFileSync(${JSON.stringify(join(dependencyRoot, "proof", "value"))},'changed')`], readonly_dependency_root: dependencyRoot });
    expect(write).toMatchObject({ kind: "exited", exit: 0, confinement: "os_confined" });
    expect(readFileSync(join(dependencyRoot, "proof", "value"), "utf8")).toBe("dependency-proof");
  });

  it("hides host paths and defeats a symlink escape while preserving the explicit workspace bind", async () => {
    const root = directory("arbor-sandbox-root-");
    const outside = directory("arbor-sandbox-outside-");
    writeFileSync(join(outside, "secret"), "host-secret");
    symlinkSync(join(outside, "secret"), join(root, "escape"));
    const script = `const f=require('node:fs');if(f.existsSync(${JSON.stringify(join(outside, "secret"))})||f.existsSync('escape'))process.exit(9);f.writeFileSync('inside','confined')`;
    const result = await osBroker.run({ argv: [process.execPath, "-e", script], cwd: root, workspace_root: root, workspace_writable: true, network_denied: true, timeout_ms: 2_000, max_output_bytes: 2_048, signal: new AbortController().signal });
    expect(result).toMatchObject({ kind: "exited", exit: 0, confinement: "os_confined" });
    expect(readFileSync(join(root, "inside"), "utf8")).toBe("confined");
  });

  it("enforces a read-only workspace at the mount boundary", async () => {
    const root = directory("arbor-sandbox-readonly-");
    const result = await osBroker.run({ argv: [process.execPath, "-e", "require('node:fs').writeFileSync('escape','no')"], cwd: root, workspace_root: root, workspace_writable: false, network_denied: true, timeout_ms: 2_000, max_output_bytes: 4_096, signal: new AbortController().signal });
    expect(result).toMatchObject({ kind: "exited", confinement: "os_confined" });
    if (result.kind === "exited") expect(result.exit).not.toBe(0);
    expect(existsSync(join(root, "escape"))).toBe(false);
  });

  it("isolates the network namespace and kills detached descendants with the namespace", async () => {
    const root = directory("arbor-sandbox-process-");
    const network = await osBroker.run({ argv: [process.execPath, "-e", "const n=require('node:net').connect(9,'127.0.0.1');n.on('connect',()=>process.exit(8));n.on('error',()=>process.exit(0));setTimeout(()=>process.exit(0),200)"], cwd: root, workspace_root: root, workspace_writable: true, network_denied: true, timeout_ms: 2_000, max_output_bytes: 2_048, signal: new AbortController().signal });
    expect(network).toMatchObject({ kind: "exited", exit: 0, confinement: "os_confined" });
    const child = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify("setTimeout(()=>require('node:fs').writeFileSync('orphan','bad'),300)")}],{detached:true,stdio:'ignore'}).unref()`;
    const spawned = await osBroker.run({ argv: [process.execPath, "-e", child], cwd: root, workspace_root: root, workspace_writable: true, network_denied: true, timeout_ms: 2_000, max_output_bytes: 2_048, signal: new AbortController().signal });
    expect(spawned).toMatchObject({ kind: "exited", exit: 0 });
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(existsSync(join(root, "orphan"))).toBe(false);
  });

  it("reserves descendant capacity above the host uid process baseline", async () => {
    const root = directory("arbor-sandbox-process-budget-");
    const script = "const c=require('node:child_process').spawnSync(process.execPath,['-e','process.exit(0)']);process.exit(c.status===0?0:9)";
    const result = await osBroker.run({ argv: [process.execPath, "-e", script], cwd: root, workspace_root: root, workspace_writable: true, network_denied: true, timeout_ms: 2_000, max_output_bytes: 2_048, signal: new AbortController().signal });
    expect(result).toMatchObject({ kind: "exited", exit: 0, confinement: "os_confined" });
  });

  it("keeps loopback available for local IPC while external networking remains denied", async () => {
    const root = directory("arbor-sandbox-loopback-");
    const script = [
      "const net = require('node:net');",
      "const server = net.createServer((socket) => socket.end('ok'));",
      "server.listen(0, '127.0.0.1', () => {",
      "  const address = server.address();",
      "  const client = net.connect(address.port, '127.0.0.1');",
      "  client.on('data', (chunk) => { if (String(chunk) !== 'ok') process.exitCode = 9; });",
      "  client.on('error', () => { process.exitCode = 8; server.close(); });",
      "  client.on('end', () => server.close());",
      "});",
    ].join("\n");
    const result = await osBroker.run({ argv: [process.execPath, "-e", script], cwd: root, workspace_root: root, workspace_writable: true, network_denied: true, timeout_ms: 2_000, max_output_bytes: 2_048, signal: new AbortController().signal });

    expect(result).toMatchObject({ kind: "exited", exit: 0, confinement: "os_confined" });
  });

  it("bounds aggregate output", async () => {
    const root = directory("arbor-sandbox-output-");
    const result = await osBroker.run({ argv: [process.execPath, "-e", "process.stdout.write('x'.repeat(100000))"], cwd: root, workspace_root: root, workspace_writable: true, network_denied: true, timeout_ms: 2_000, max_output_bytes: 64, signal: new AbortController().signal });
    expect(result).toMatchObject({ kind: "output_limited", confinement: "os_confined" });
  });
});

// ADR-102: platform-dispatching backends, the seccomp layer, and the
// explicit per-platform degradation ladder.
describe("ADR-102 platform dispatch (LR-NH-04 successor)", () => {
  const available = (): string | null => null;
  const unavailable = (): string | null => "fixture: probe failed";

  it("dispatches to the Linux bubblewrap backend and reports it in the diagnostic", () => {
    const broker = createSandboxBroker({ platform: "linux", probe_os_confinement: available });
    expect(broker.confinement).toBe("os_confined");
  });

  it("dispatches to the macOS Seatbelt backend when the probe succeeds", () => {
    const broker = createSandboxBroker({ platform: "darwin", probe_seatbelt_confinement: available });
    expect(broker.confinement).toBe("os_confined");
    expect(broker.diagnostic).toContain("Seatbelt");
  });

  it("falls back to application_validated on macOS when the Seatbelt probe fails, without touching the Linux probe", () => {
    let linuxProbed = false;
    const broker = createSandboxBroker({
      platform: "darwin",
      probe_seatbelt_confinement: unavailable,
      probe_os_confinement: () => { linuxProbed = true; return null; },
    });
    expect(broker.confinement).toBe("application_validated");
    expect(broker.diagnostic).toBe("fixture: probe failed");
    expect(linuxProbed).toBe(false);
  });

  it("os_required throws on macOS without a working Seatbelt, exactly as it does on Linux without bubblewrap (O3)", () => {
    expect(() => createSandboxBroker({ platform: "darwin", confinement_level: "os_required", probe_seatbelt_confinement: unavailable }))
      .toThrow(SandboxConfinementUnavailableError);
    try {
      createSandboxBroker({ platform: "darwin", confinement_level: "os_required", probe_seatbelt_confinement: unavailable });
      expect.unreachable("must throw");
    } catch (error) {
      expect((error as SandboxConfinementUnavailableError).diagnostic).toBe("fixture: probe failed");
    }
  });

  it("Windows (and any platform without a registered backend) goes straight to application_validated — no OS-backend rung", () => {
    const broker = createSandboxBroker({ platform: "win32" });
    expect(broker.confinement).toBe("application_validated");
    expect(broker.diagnostic).toContain("win32");
    expect(() => createSandboxBroker({ platform: "win32", confinement_level: "os_required" })).toThrow(SandboxConfinementUnavailableError);
  });

  it("real probe: the macOS probe reports unavailable on this Linux host without assuming from platform alone", () => {
    expect(probeSeatbeltAvailability("darwin", "/usr/bin/sandbox-exec")).not.toBeNull();
    // Real, un-injected probe on the actual current platform (linux, per env.mts) also fails closed.
    expect(probeSeatbeltAvailability(process.platform, "/usr/bin/sandbox-exec")).toBe(`OS confinement is unavailable on ${process.platform}`);
  });
});

describe("ADR-102 O4: Linux seccomp network-syscall layer, independent of the namespace unshare", () => {
  it("reports the seccomp layer as active in the broker diagnostic on this host", () => {
    const broker = createSandboxBroker();
    expect(broker.diagnostic).toContain("seccomp network-syscall filter active");
  });

  it("builds a real x86_64 cBPF program and returns null for an unimplemented architecture, rather than a filter tuned for the wrong syscall numbers", () => {
    const program = buildNetworkDenySeccompProgram("x64");
    expect(program).not.toBeNull();
    expect(program!.length % 8).toBe(0);
    expect(program!.length).toBeGreaterThan(0);
    expect(buildNetworkDenySeccompProgram("arm64")).toBeNull();
  });

  it("denies AF_PACKET raw-socket creation inside a network_denied run while leaving AF_INET/AF_UNIX untouched (real execution, this host is Linux)", async () => {
    const osBroker = createSandboxBroker();
    if (osBroker.confinement !== "os_confined") return; // no bubblewrap on this CI shape; O4 cannot be exercised.
    const root = directory("arbor-seccomp-packet-");
    const script = "import socket\ntry:\n    socket.socket(socket.AF_PACKET, socket.SOCK_RAW)\n    raise SystemExit(0)\nexcept PermissionError:\n    raise SystemExit(9)\n";
    const denied = await osBroker.run({
      argv: ["/usr/bin/python3", "-c", script],
      cwd: root, workspace_root: root, workspace_writable: true, network_denied: true, timeout_ms: 3_000, max_output_bytes: 4_096, signal: new AbortController().signal,
    });
    expect(denied).toMatchObject({ kind: "exited", exit: 9, confinement: "os_confined" });

    const allowed = await osBroker.run({
      argv: [process.execPath, "-e", "process.exit(0)"],
      cwd: root, workspace_root: root, workspace_writable: true, network_denied: false, timeout_ms: 2_000, max_output_bytes: 2_048, signal: new AbortController().signal,
    });
    expect(allowed).toMatchObject({ kind: "exited", exit: 0, confinement: "os_confined" });
  });

  it("degrades to bubblewrap-only (a distinct diagnostic, not a silent seccomp-less os_confined) when the seccomp probe fails", () => {
    const broker = createSandboxBroker({ probe_seccomp: () => "fixture: kernel lacks CONFIG_SECCOMP_FILTER" });
    expect(broker.confinement).toBe("os_confined");
    expect(broker.diagnostic).toContain("seccomp network-syscall filter unavailable");
    expect(broker.diagnostic).toContain("fixture: kernel lacks CONFIG_SECCOMP_FILTER");
  });

  it("still runs a network_denied command correctly when seccomp is degraded away (namespace unshare alone still enforces the floor)", async () => {
    const broker = createSandboxBroker({ probe_seccomp: () => "fixture: unavailable" });
    if (broker.confinement !== "os_confined") return;
    const root = directory("arbor-seccomp-degraded-");
    const result = await broker.run({ argv: [process.execPath, "-e", "process.exit(0)"], cwd: root, workspace_root: root, workspace_writable: true, network_denied: true, timeout_ms: 2_000, max_output_bytes: 2_048, signal: new AbortController().signal });
    expect(result).toMatchObject({ kind: "exited", exit: 0, confinement: "os_confined" });
  });
});

/**
 * REALITY CONSTRAINT: this host is Linux. `sandbox-exec` does not exist
 * here, so `SeatbeltSandboxBroker.run()`'s actual spawn is never executed by
 * this suite — only profile construction (a pure function) is verified.
 * See `seatbelt-sandbox-broker.ts`'s module header for the same statement in
 * the implementation itself.
 */
describe("ADR-102 O3: Seatbelt profile construction (pure — not an execution test)", () => {
  it("denies by default and grants only the scoped read/write/network predicates the request asks for", () => {
    const root = directory("arbor-seatbelt-root-");
    const profile = buildSeatbeltProfile({
      argv: [process.execPath, "-e", "0"], cwd: root, workspace_root: root, workspace_writable: true,
      network_denied: true, timeout_ms: 1_000, max_output_bytes: 1_024, signal: new AbortController().signal,
    });
    expect(profile).toContain("(deny default)");
    expect(profile).toContain(`(allow file-write* (subpath "${root}"))`);
    expect(profile).not.toContain("(allow network*)");
  });

  it("omits the write grant for a read-only workspace and grants network* only when network is not denied", () => {
    const root = directory("arbor-seatbelt-readonly-");
    const profile = buildSeatbeltProfile({
      argv: [process.execPath, "-e", "0"], cwd: root, workspace_root: root, workspace_writable: false,
      network_denied: false, timeout_ms: 1_000, max_output_bytes: 1_024, signal: new AbortController().signal,
    });
    expect(profile).not.toContain("file-write*");
    expect(profile).toContain("(allow network*)");
  });

  it("scopes readonly context/dependency roots into their own file-read* predicates", () => {
    const root = directory("arbor-seatbelt-context-root-");
    const dependencyRoot = directory("arbor-seatbelt-dependency-root-");
    const profile = buildSeatbeltProfile({
      argv: [process.execPath, "-e", "0"], cwd: root, workspace_root: root, workspace_writable: true,
      readonly_dependency_root: dependencyRoot, network_denied: true, timeout_ms: 1_000, max_output_bytes: 1_024,
      signal: new AbortController().signal,
    });
    expect(profile).toContain(`(allow file-read* (subpath "${dependencyRoot}"))`);
  });
});
