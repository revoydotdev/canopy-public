import { spawn, spawnSync } from "node:child_process";
import { GOVERNED_RUN_ENV, withGovernedRun } from "@arbor/core";
import { type Dirent, existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import type { SandboxBroker, SandboxedCommandRequest, SandboxedCommandResult } from "./contracts.js";
import { buildNetworkDenySeccompProgram, closeSeccompFd, openSeccompProgramFd, probeSeccompAvailability } from "./seccomp.js";
import { probeSeatbeltAvailability, SeatbeltSandboxBroker } from "./seatbelt-sandbox-broker.js";

/**
 * The operator-facing confinement policy, distinct from the `ConfinementGrade`
 * evidence fact a run actually produced. `off`/`app_only` both resolve to the
 * `application_validated` broker today: application-level path/workspace
 * validation is the floor this codebase enforces unconditionally (see
 * `validateRequest`), so there is no weaker rung to give `off` a distinct
 * runtime behaviour without discarding checks other callers depend on. The
 * two levels are kept separate in configuration because they carry different
 * operator intent — `off` is an explicit acknowledgement that no OS boundary
 * is wanted, `app_only` is a request that happens to match today's floor —
 * and a future weaker mechanism could give them independent meaning without
 * a schema migration. `os_best_effort` (the recommended default) uses OS
 * confinement when the runtime probe succeeds and otherwise honestly falls
 * back to `application_validated`. `os_required` fails closed: it never
 * silently downgrades, so composition must refuse to run rather than execute
 * a command it cannot prove is OS-confined.
 */
export type SandboxConfinementLevel = "off" | "app_only" | "os_best_effort" | "os_required";

export const SANDBOX_CONFINEMENT_LEVELS: readonly SandboxConfinementLevel[] = ["off", "app_only", "os_best_effort", "os_required"];

/** The recommended default: prefer OS confinement, degrade honestly when unavailable. */
export const DEFAULT_SANDBOX_CONFINEMENT_LEVEL: SandboxConfinementLevel = "os_best_effort";

/** Thrown by `createSandboxBroker` when `confinement_level: "os_required"` cannot be satisfied. Composition must let this fail the run rather than catch-and-downgrade. */
export class SandboxConfinementUnavailableError extends Error {
  constructor(readonly diagnostic: string) {
    super(`sandbox confinement_level "os_required" cannot be satisfied: ${diagnostic}`);
    this.name = "SandboxConfinementUnavailableError";
  }
}

export interface SandboxBrokerOptions {
  readonly platform?: NodeJS.Platform;
  readonly bubblewrap_path?: string;
  /** macOS backend executable. Defaults to `/usr/bin/sandbox-exec`. */
  readonly seatbelt_path?: string;
  /** @deprecated use `confinement_level: "app_only"` (or `"off"`); kept for the existing composition/tests that already pass this. */
  readonly disable_os_confinement?: boolean;
  readonly confinement_level?: SandboxConfinementLevel;
  /**
   * Injectable Linux (bubblewrap) OS-confinement availability probe, purely
   * for detection/level-resolution unit tests. Defaults to the real
   * bubblewrap namespace probe. Returns `null` when the mechanism is usable,
   * or a diagnostic string when it is not.
   */
  readonly probe_os_confinement?: (platform: NodeJS.Platform, executable: string) => string | null;
  /**
   * Injectable macOS (Seatbelt) availability probe, same shape and purpose
   * as `probe_os_confinement`. Defaults to the real `sandbox-exec` probe.
   */
  readonly probe_seatbelt_confinement?: (platform: NodeJS.Platform, executable: string) => string | null;
  /**
   * Injectable Linux seccomp-layer availability probe, purely for unit
   * tests exercising the ADR-102 item-3 degradation ladder (bubblewrap
   * succeeds, seccomp does not). Defaults to the real bwrap `--seccomp`
   * probe. Returns `null` when installable, a diagnostic string otherwise.
   */
  readonly probe_seccomp?: (bubblewrapExecutable: string, program: Buffer) => string | null;
}

/**
 * The sole capability decision for local command confinement. Dispatches on
 * `options.platform ?? process.platform` to the registered backend for that
 * platform (ADR-102 item 1): `BubblewrapSandboxBroker` on Linux,
 * `SeatbeltSandboxBroker` on macOS, and `ApplicationValidatedSandboxBroker`
 * — the explicit floor — on every other platform (Windows included) and on
 * any platform whose registered backend's probe reports unavailable.
 */
export function createSandboxBroker(options: SandboxBrokerOptions = {}): SandboxBroker {
  const platform = options.platform ?? process.platform;
  const level = resolveSandboxConfinementLevel(options);
  if (level === "off" || level === "app_only") {
    return new ApplicationValidatedSandboxBroker(options.disable_os_confinement === true
      ? "OS confinement disabled by composition"
      : `OS confinement disabled by configuration (confinement_level=${level})`);
  }
  const { broker, diagnostic } = resolvePlatformBackend(platform, options);
  if (broker !== null) return broker;
  if (level === "os_required") throw new SandboxConfinementUnavailableError(diagnostic);
  return new ApplicationValidatedSandboxBroker(diagnostic);
}

/**
 * ADR-102's degradation ladder, per platform: Linux tries bubblewrap (with
 * seccomp layered in independently inside `BubblewrapSandboxBroker` itself —
 * seccomp availability never gates whether bubblewrap confinement is used at
 * all, only whether the extra syscall layer rides along). macOS tries
 * Seatbelt. Every other platform — Windows included — has no OS-backend rung
 * and goes straight to the `application_validated` floor, same as an
 * unavailable Linux/macOS probe does.
 */
function resolvePlatformBackend(platform: NodeJS.Platform, options: SandboxBrokerOptions): { broker: SandboxBroker | null; diagnostic: string } {
  if (platform === "linux") {
    const executable = options.bubblewrap_path ?? "/usr/bin/bwrap";
    const probe = options.probe_os_confinement ?? probeBubblewrapAvailability;
    const diagnostic = probe(platform, executable);
    if (diagnostic !== null) return { broker: null, diagnostic };
    return { broker: new BubblewrapSandboxBroker(executable, options.probe_seccomp), diagnostic: "" };
  }
  if (platform === "darwin") {
    const executable = options.seatbelt_path ?? "/usr/bin/sandbox-exec";
    const probe = options.probe_seatbelt_confinement ?? probeSeatbeltAvailability;
    const diagnostic = probe(platform, executable);
    if (diagnostic !== null) return { broker: null, diagnostic };
    return { broker: new SeatbeltSandboxBroker(executable), diagnostic: "" };
  }
  return { broker: null, diagnostic: `OS confinement is unavailable on ${platform}` };
}

/**
 * `disable_os_confinement` predates `confinement_level` and several
 * composition sites and tests still pass it; it is equivalent to
 * `confinement_level: "app_only"` and takes precedence only when no explicit
 * level was supplied, so a caller that sets both gets the explicit level.
 */
function resolveSandboxConfinementLevel(options: SandboxBrokerOptions): SandboxConfinementLevel {
  if (options.confinement_level !== undefined) {
    // The level can arrive from JSON config (arbor.jsonc / ARBOR_CONFIG__ env),
    // so the compile-time type is not a runtime guarantee — reject an unknown
    // value loudly rather than silently treating it as the default.
    if (!SANDBOX_CONFINEMENT_LEVELS.includes(options.confinement_level)) {
      throw new SandboxConfinementUnavailableError(`unknown confinement_level "${options.confinement_level}" (expected one of: ${SANDBOX_CONFINEMENT_LEVELS.join(", ")})`);
    }
    return options.confinement_level;
  }
  if (options.disable_os_confinement === true) return "app_only";
  return DEFAULT_SANDBOX_CONFINEMENT_LEVEL;
}

function probeBubblewrapAvailability(platform: NodeJS.Platform, executable: string): string | null {
  if (platform !== "linux") return `OS confinement is unavailable on ${platform}`;
  if (!isAbsolute(executable) || !existsSync(executable)) return "Bubblewrap executable is unavailable";
  const probeRoot = realpathSync(process.cwd());
  const probe = spawnSync(executable, bubblewrapArguments({
    argv: ["/usr/bin/true"], cwd: probeRoot, workspace_root: probeRoot,
    workspace_writable: false, network_denied: true, timeout_ms: 2_000,
    max_output_bytes: 4_096, signal: new AbortController().signal,
  }), { stdio: "ignore", timeout: 3_000, env: { PATH: "/usr/bin" } });
  if (probe.status !== 0 || probe.error !== undefined) return "Bubblewrap namespace probe failed";
  return null;
}

class ApplicationValidatedSandboxBroker implements SandboxBroker {
  readonly confinement = "application_validated" as const;
  constructor(readonly diagnostic: string) {}

  run(request: SandboxedCommandRequest): Promise<SandboxedCommandResult> {
    validateRequest(request);
    if (request.network_denied) return Promise.resolve({ kind: "network_isolation_unavailable", confinement: "application_validated" });
    return runSpawn(request.argv[0], request.argv.slice(1), request, "application_validated", { PATH: process.env.PATH ?? "" });
  }
}

/**
 * ADR-102 item 2: seccomp is a second, independent layer that rides along
 * inside the same `bwrap` invocation whenever it is installable and the
 * request actually asks for network denial — it never gates whether
 * bubblewrap confinement itself is used (that would turn an orthogonal
 * defense-in-depth improvement into an availability regression for hosts
 * whose kernel lacks it). Availability is probed once at broker construction
 * and cached; the resulting diagnostic distinguishes "seccomp active",
 * "seccomp unavailable for this architecture", and "seccomp unavailable
 * (probe failed)" so a degraded run is never silently reported as identical
 * to a fully layered one (ADR-102 item 3).
 */
class BubblewrapSandboxBroker implements SandboxBroker {
  readonly confinement = "os_confined" as const;
  readonly diagnostic: string;
  private readonly seccompProgram: Buffer | null;

  constructor(private readonly executable: string, probeSeccomp: ((bubblewrapExecutable: string, program: Buffer) => string | null) = probeSeccompAvailability) {
    const program = buildNetworkDenySeccompProgram();
    if (program === null) {
      this.seccompProgram = null;
      this.diagnostic = `Bubblewrap mount/user/PID/network namespace probe succeeded; seccomp network-syscall filter unavailable (no filter implemented for architecture ${process.arch})`;
      return;
    }
    const seccompDiagnostic = probeSeccomp(executable, program);
    if (seccompDiagnostic === null) {
      this.seccompProgram = program;
      this.diagnostic = "Bubblewrap mount/user/PID/network namespace probe succeeded; seccomp network-syscall filter active";
    } else {
      this.seccompProgram = null;
      this.diagnostic = `Bubblewrap mount/user/PID/network namespace probe succeeded; seccomp network-syscall filter unavailable (${seccompDiagnostic})`;
    }
  }

  run(request: SandboxedCommandRequest): Promise<SandboxedCommandResult> {
    validateRequest(request);
    if (this.seccompProgram === null || !request.network_denied) {
      return runSpawn(this.executable, bubblewrapArguments(request, null), request, "os_confined", { PATH: "/usr/bin" });
    }
    // The fd is duplicated into the child synchronously inside `spawn()`,
    // which `runSpawn` calls synchronously before returning its Promise, so
    // it is safe to close the host-side fd immediately after this call.
    const fd = openSeccompProgramFd(this.seccompProgram);
    const result = runSpawn(this.executable, bubblewrapArguments(request, 3), request, "os_confined", { PATH: "/usr/bin" }, [fd]);
    closeSeccompFd(fd);
    return result;
  }
}

function bubblewrapArguments(request: SandboxedCommandRequest, seccompFdIndex: number | null = null): string[] {
  validateRequest(request);
  const root = realpathSync(request.workspace_root);
  const cwd = realpathSync(request.cwd);
  const contextRoot = request.readonly_context_root === undefined ? null : realpathSync(request.readonly_context_root);
  const dependencyRoots = [...new Set([
    ...(request.readonly_dependency_root === undefined ? [] : [request.readonly_dependency_root]),
    ...(request.readonly_dependency_roots ?? []),
  ].map((path) => realpathSync(path)))];
  const resolvedExecutable = isAbsolute(request.argv[0]) && existsSync(request.argv[0])
    ? realpathSync(request.argv[0])
    : null;
  // /usr is already mounted wholesale. Re-binding a resolved executable to
  // its original path is not merely redundant when that path is a symlink:
  // bwrap refuses to mount on the symlink destination (for example Arch's
  // /usr/bin/python3 -> python3.14), so an otherwise valid confined command
  // exits before the seccomp policy can run.
  const requestedExecutable = resolvedExecutable !== null && !within("/usr", resolvedExecutable)
    ? { source: resolvedExecutable, destination: request.argv[0] }
    : null;
  const rustToolchain = rustToolchainContext(request.argv[0]);
  const dirs = [...new Set([
    ...destinationParents(root),
    ...(contextRoot === null ? [] : destinationParents(contextRoot)),
    ...dependencyRoots.flatMap(destinationParents),
    ...(requestedExecutable === null ? [] : destinationParents(requestedExecutable.destination)),
    ...rustToolchain.roots.flatMap(destinationParents),
  ])].flatMap((path) => ["--dir", path]);
  const processLimit = boundedHostTaskLimit();
  const resourceLimits = [
    "--nofile=256:256", `--nproc=${processLimit}:${processLimit}`, "--as=68719476736:68719476736",
    `--cpu=${Math.max(1, Math.ceil(request.timeout_ms / 1_000) + 1)}`,
  ];
  // A fresh network namespace has no usable loopback device. Test suites and
  // local tools legitimately use 127.0.0.1 for in-process IPC; bring only
  // that device up while retaining the namespace's denial of host networking.
  const command = request.network_denied
    ? ["/usr/bin/sh", "-c", "/usr/bin/ip link set lo up && exec /usr/bin/prlimit \"$@\"", "arbor-sandbox", ...resourceLimits, "--", ...request.argv]
    : ["/usr/bin/prlimit", ...resourceLimits, "--", ...request.argv];
  return [
    "--die-with-parent", "--unshare-user",
    ...(request.network_denied ? ["--uid", "0", "--gid", "0"] : []),
    "--unshare-pid", "--unshare-ipc", "--unshare-uts",
    // CAP_NET_ADMIN exists only inside the new, otherwise empty network
    // namespace and is required to activate its loopback device. It grants no
    // authority over the host namespace or any external network interface.
    ...(request.network_denied ? ["--unshare-net", "--cap-add", "CAP_NET_ADMIN"] : []),
    // ADR-102 item 2: seccomp joins, not replaces, the namespace-level
    // network denial above. `seccompFdIndex` names the child's stdio index
    // (the caller has already duplicated the compiled filter's fd there).
    ...(seccompFdIndex === null ? [] : ["--seccomp", String(seccompFdIndex)]),
    "--ro-bind", "/usr", "/usr", "--ro-bind", "/lib", "/lib", "--ro-bind", "/lib64", "/lib64",
    // Name resolution: without these, `localhost` itself fails
    // (getaddrinfo EAI_AGAIN) and any acceptance test that binds a local
    // server cannot run. Existence-guarded; read-only.
    ...["/etc/hosts", "/etc/resolv.conf", "/etc/nsswitch.conf"].filter((path) => existsSync(path)).flatMap((path) => ["--ro-bind", path, path]),
    // TLS verification: /etc/ssl is mounted together with every CA trust
    // store it links into (see caTrustStoreRoots). Read-only; no write or
    // network-policy widening.
    ...caTrustStoreRoots().flatMap((path) => ["--ro-bind", path, path]),
    "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp",
    ...dirs,
    // The context uses a private writable upper layer: linked-worktree test
    // tools may create caches beside dependencies, while the host checkout
    // remains byte-for-byte immutable. The workspace bind follows and wins
    // wherever it overlaps this enclosing context.
    ...(contextRoot === null ? [] : ["--overlay-src", contextRoot, "--tmp-overlay", contextRoot]),
    // Dependencies remain immutable on the host, while a private tmp-backed
    // upper layer lets package managers/test runners write caches, bytecode,
    // and metadata required for normal execution. All writes disappear with
    // the sandbox. Multiple exact roots support external workspace-package
    // links without exposing their common repository ancestor.
    ...dependencyRoots.flatMap((path) => ["--overlay-src", path, "--tmp-overlay", path]),
    // Rustup's /usr/bin proxies discover the selected compiler through these
    // user-scoped stores. Mount only the two declared stores, read-only, and
    // only for an explicitly invoked Rust proxy; never expose the rest of
    // the user's home or turn a model-authored command into ambient access.
    ...rustToolchain.roots.flatMap((path) => ["--ro-bind", path, path]),
    request.workspace_writable ? "--bind" : "--ro-bind", root, root,
    // setup-node and other harness managers install runtimes outside /usr.
    // The command capability has already authorized this exact argv[0]; bind
    // only that executable, never its tool-cache directory or sibling tools.
    ...(requestedExecutable === null ? [] : ["--ro-bind", requestedExecutable.source, requestedExecutable.destination]),
    // HOME points at the sandbox's private tmpfs: toolchains (npm, git)
    // refuse to start at all when the platform cannot resolve a home
    // directory (uv_os_homedir ENOENT), and /tmp is the only writable
    // non-workspace path in the mount plan.
    "--chdir", cwd, "--clearenv", "--setenv", "PATH", "/usr/bin", "--setenv", "HOME", "/tmp",
    // --clearenv also drops the governed-run marker runSpawn sets on bwrap
    // itself, so the command inside must be given it again.
    "--setenv", GOVERNED_RUN_ENV, "1",
    ...Object.entries(rustToolchain.environment).flatMap(([name, value]) => ["--setenv", name, value]),
    "--",
    // 64 GiB ADDRESS-SPACE cap, not resident memory: V8/node reserves tens
    // of GiB of virtual space for wasm/pointer-compression cages, and the
    // previous 8 GiB cap killed any acceptance test whose dependency loads
    // a wasm module ("Cannot allocate Wasm memory"). Runaway allocation is
    // still bounded; real RSS pressure is the OS/oomd's job.
    ...command,
  ];
}

/**
 * Host directories a sandboxed TLS client needs to verify certificates.
 * `/etc/ssl` is the conventional root, but on many distributions its
 * `certs/` entries are symlinks into `/etc/ca-certificates` (Debian, Arch) or
 * `/etc/pki` (RHEL family), which would dangle inside the sandbox if only
 * `/etc/ssl` were mounted. Returns the existing well-known stores plus the
 * resolved parent directory of every symlink found under `<etc>/ssl` (up to
 * two levels deep) whose target lives under `<etc>` outside `<etc>/ssl` itself.
 * Targets under `/usr` are already mounted wholesale and are skipped; nested
 * results are collapsed to their outermost directory. `etcRoot` exists for
 * tests.
 */
export function caTrustStoreRoots(etcRoot = "/etc"): string[] {
  const ssl = join(etcRoot, "ssl");
  const candidates = new Set<string>();
  for (const path of [ssl, join(etcRoot, "ca-certificates"), join(etcRoot, "pki")]) {
    if (existsSync(path)) candidates.add(path);
  }
  const etcReal = existsSync(etcRoot) ? realpathSync(etcRoot) : etcRoot;
  const scan = (dir: string, depth: number): void => {
    let entries: Dirent[];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        let target: string;
        try { target = realpathSync(full); } catch { continue; }
        const parent = statSync(target).isDirectory() ? target : dirname(target);
        if (within(etcReal, parent) && parent !== etcReal && !within(realpathSync(ssl), parent)) candidates.add(parent);
      } else if (entry.isDirectory() && depth > 0) scan(full, depth - 1);
    }
  };
  if (existsSync(ssl)) scan(ssl, 2);
  const sorted = [...candidates].sort();
  return sorted.filter((path) => !sorted.some((other) => other !== path && within(other, path)));
}

function rustToolchainContext(executable: string): { readonly roots: readonly string[]; readonly environment: Readonly<Record<string, string>> } {
  if (!["cargo", "rustc", "rustup"].includes(basename(executable))) return { roots: [], environment: {} };
  const environment: Record<string, string> = {};
  const roots: string[] = [];
  for (const name of ["CARGO_HOME", "RUSTUP_HOME"] as const) {
    const value = process.env[name];
    if (value === undefined || !isAbsolute(value) || !existsSync(value)) continue;
    const root = realpathSync(value);
    environment[name] = root;
    roots.push(root);
  }
  return { roots: [...new Set(roots)], environment };
}

/**
 * On Linux RLIMIT_NPROC counts every thread owned by the host uid, not just
 * process leaders and not merely tasks visible in the new PID namespace.
 * Preserve a fixed 128-task sandbox allowance above
 * the measured baseline so concurrent harness sessions do not make a valid
 * worker spawn fail with EAGAIN. The hard cap remains fail-closed on an
 * already pathologically saturated account.
 */
function boundedHostTaskLimit(): number {
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (uid === null) return 4_096;
  const owned = countOwnedLinuxTasks("/proc", uid);
  if (owned === null) return 4_096;
  return Math.min(32_768, Math.max(128, owned + 128));
}

/** Same-UID task count used by RLIMIT_NPROC; exported for fixture-backed proof. */
export function countOwnedLinuxTasks(procRoot: string, uid: number): number | null {
  let owned = 0;
  let processes: string[];
  try { processes = readdirSync(procRoot); } catch { return null; }
  for (const processId of processes) {
    if (!/^\d+$/.test(processId)) continue;
    const processRoot = join(procRoot, processId);
    try {
      if (statSync(processRoot).uid !== uid) continue;
      owned += readdirSync(join(processRoot, "task")).filter((taskId) => /^\d+$/.test(taskId)).length;
    } catch { /* process exited during the scan */ }
  }
  return owned;
}

function destinationParents(path: string): string[] {
  const parents: string[] = [];
  let current = dirname(path);
  while (current !== "/" && current !== ".") { parents.push(current); current = dirname(current); }
  return parents.reverse();
}

function within(root: string, candidate: string): boolean {
  const delta = relative(root, candidate);
  return delta === "" || (delta !== ".." && !delta.startsWith(`..${sep}`) && !isAbsolute(delta));
}

function validateRequest(request: SandboxedCommandRequest): void {
  if (!Array.isArray(request.argv) || request.argv.length === 0 || request.argv.some((value) => typeof value !== "string" || value.length === 0 || value.includes("\0"))) throw new Error("sandbox argv must be non-empty and NUL-free");
  if (!isAbsolute(request.workspace_root) || !isAbsolute(request.cwd)) throw new Error("sandbox paths must be absolute");
  const root = realpathSync(request.workspace_root);
  const cwd = realpathSync(request.cwd);
  const delta = relative(root, cwd);
  if (delta === ".." || delta.startsWith(`..${sep}`) || isAbsolute(delta)) throw new Error("sandbox cwd must be within workspace_root");
  if (!Number.isSafeInteger(request.timeout_ms) || request.timeout_ms <= 0 || !Number.isSafeInteger(request.max_output_bytes) || request.max_output_bytes <= 0) throw new Error("sandbox bounds must be positive safe integers");
}

function runSpawn(executable: string, args: readonly string[], request: SandboxedCommandRequest, confinement: "application_validated" | "os_confined", env: NodeJS.ProcessEnv, extraFds: readonly number[] = []): Promise<SandboxedCommandResult> {
  if (request.signal.aborted) return Promise.resolve({ kind: "cancelled", stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), confinement });
  return new Promise((resolveResult) => {
    let settled = false, timedOut = false, cancelled = false, outputLimited = false;
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    let bytes = 0;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const detached = confinement === "os_confined" && process.platform !== "win32";
    // Extra fds (e.g. the compiled seccomp program) land at stdio indices
    // 3, 4, ... in the child — exactly the indices `--seccomp N` names.
    const child = spawn(executable, args, { cwd: request.cwd, shell: false, windowsHide: true, detached, env: withGovernedRun(env), stdio: [request.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe", ...extraFds] });
    const finish = (result: SandboxedCommandResult): void => { if (settled) return; settled = true; clearTimeout(timer); clearTimeout(killTimer); request.signal.removeEventListener("abort", abort); resolveResult(result); };
    const stop = (): void => {
      if (child.exitCode !== null) return;
      const signal = (name: NodeJS.Signals): void => { try { if (detached && child.pid !== undefined) process.kill(-child.pid, name); else child.kill(name); } catch { /* already gone */ } };
      if (!child.killed) signal("SIGTERM");
      killTimer = setTimeout(() => {
        if (child.exitCode === null) signal("SIGKILL");
      }, 250);
    };
    const append = (target: Buffer[], chunk: Buffer): void => { if (outputLimited) return; bytes += chunk.length; if (bytes > request.max_output_bytes) { outputLimited = true; stop(); } else target.push(Buffer.from(chunk)); };
    const abort = (): void => { cancelled = true; stop(); };
    const timer = setTimeout(() => { timedOut = true; stop(); }, request.timeout_ms);
    request.signal.addEventListener("abort", abort, { once: true });
    if (request.stdin !== undefined && child.stdin !== null) child.stdin.end(request.stdin);
    child.stdout?.on("data", (chunk: Buffer) => append(stdout, chunk)); child.stderr?.on("data", (chunk: Buffer) => append(stderr, chunk));
    child.once("error", () => finish({ kind: "spawn_failed", confinement }));
    child.once("close", (code) => setImmediate(() => {
      const output = { stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), confinement } as const;
      if (cancelled) finish({ kind: "cancelled", ...output }); else if (timedOut) finish({ kind: "timed_out", ...output });
      else if (outputLimited) finish({ kind: "output_limited", ...output }); else finish({ kind: "exited", exit: code ?? -1, ...output });
    }));
  });
}
