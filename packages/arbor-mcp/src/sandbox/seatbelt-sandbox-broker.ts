import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { withGovernedRun } from "@arbor/core";
import type { SandboxBroker, SandboxedCommandRequest, SandboxedCommandResult } from "./contracts.js";

/**
 * ADR-102 item 1: the macOS backend, wrapping Apple's Seatbelt
 * (`sandbox-exec`) with a generated `.sb` profile scoped to the same
 * workspace-root/dependency-root/writable-overlay shape
 * `bubblewrapArguments` already encodes for Linux. Seatbelt's policy
 * language (`(allow ...)`/`(deny ...)` s-expressions matched against
 * `subpath`/`literal` file operations, plus a `network*` predicate) is not
 * bubblewrap's argv/namespace model — this is a translation of intent, not a
 * mechanical port, exactly as ADR-102's Consequences section says it must
 * be.
 *
 * REALITY CONSTRAINT: this module is written and unit-tested for profile
 * construction and backend selection on a Linux development host. It has
 * never been executed against a real `sandbox-exec` binary — there is no
 * macOS host in this environment. Selection logic (`probeSeatbeltAvailability`
 * failing closed when `sandbox-exec` is missing, `createSandboxBroker`
 * falling back to `ApplicationValidatedSandboxBroker`) and the exact profile
 * text `buildSeatbeltProfile` emits are exercised by
 * `sandbox-broker.test.ts`; the actual `sandbox-exec` invocation in `run()`
 * is not.
 */

/**
 * Probe shape mirrors `probeBubblewrapAvailability`: returns `null` when
 * Seatbelt is usable, a diagnostic string otherwise. Never throws. The probe
 * runs `sandbox-exec -p <trivial deny-default profile> -- /usr/bin/true` so
 * that a present-but-non-functional `sandbox-exec` (e.g. sandboxd not
 * running, or the binary rejects generated profiles) degrades honestly
 * instead of being assumed available from its mere existence on disk.
 */
export function probeSeatbeltAvailability(platform: NodeJS.Platform, executable: string): string | null {
  if (platform !== "darwin") return `OS confinement is unavailable on ${platform}`;
  if (!isAbsolute(executable) || !existsSync(executable)) return "sandbox-exec executable is unavailable";
  const probe = spawnSync(executable, ["-p", "(version 1)(deny default)(allow process-exec)", "--", "/usr/bin/true"], {
    stdio: "ignore", timeout: 3_000, env: { PATH: "/usr/bin" },
  });
  if (probe.status !== 0 || probe.error !== undefined) return "sandbox-exec probe failed";
  return null;
}

/**
 * Builds the `.sb` policy text for one request. Pure and independently
 * testable without spawning `sandbox-exec` — the property this file's tests
 * can genuinely verify on a Linux host.
 */
export function buildSeatbeltProfile(request: SandboxedCommandRequest): string {
  const root = realpathSync(request.workspace_root);
  const contextRoot = request.readonly_context_root === undefined ? null : realpathSync(request.readonly_context_root);
  const dependencyRoots = [...new Set([
    ...(request.readonly_dependency_root === undefined ? [] : [request.readonly_dependency_root]),
    ...(request.readonly_dependency_roots ?? []),
  ].map((path) => realpathSync(path)))];
  const readOnlyRoots = [...new Set([...(contextRoot === null ? [] : [contextRoot]), ...dependencyRoots])];

  const lines: string[] = [
    "(version 1)",
    "(deny default)",
    "; Base process/system surface required to exec and run an ordinary binary.",
    "(allow process-exec)",
    "(allow process-fork)",
    "(allow file-read* (subpath \"/usr\") (subpath \"/System\") (subpath \"/Library\") (subpath \"/bin\") (subpath \"/private/etc\"))",
    "(allow sysctl-read)",
    "(allow mach-lookup)",
    "(allow signal (target self))",
  ];
  for (const path of readOnlyRoots) lines.push(`(allow file-read* (subpath ${sbString(path)}))`);
  lines.push(`(allow file-read* (subpath ${sbString(root)}))`);
  if (request.workspace_writable) lines.push(`(allow file-write* (subpath ${sbString(root)}))`);
  lines.push(request.network_denied ? "; network_denied: no network predicate granted, so all network* operations fall through to (deny default)." : "(allow network*)");
  return lines.join("\n");
}

function sbString(path: string): string {
  // Seatbelt string literals are double-quoted with backslash escapes;
  // workspace/dependency paths never legitimately contain a `"`, but escape
  // defensively rather than trust that invariant here.
  return `"${path.replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"`;
}

export class SeatbeltSandboxBroker implements SandboxBroker {
  readonly confinement = "os_confined" as const;
  readonly diagnostic = "Seatbelt (sandbox-exec) probe succeeded";
  constructor(private readonly executable: string) {}

  async run(request: SandboxedCommandRequest): Promise<SandboxedCommandResult> {
    validateSeatbeltRequest(request);
    const directory = mkdtempSync(join(tmpdir(), "arbor-seatbelt-"));
    const profilePath = join(directory, "profile.sb");
    try {
      writeFileSync(profilePath, buildSeatbeltProfile(request), { mode: 0o600 });
      return await spawnSeatbelt(this.executable, profilePath, request);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
}

function validateSeatbeltRequest(request: SandboxedCommandRequest): void {
  if (!Array.isArray(request.argv) || request.argv.length === 0 || request.argv.some((value) => typeof value !== "string" || value.length === 0 || value.includes("\0"))) throw new Error("sandbox argv must be non-empty and NUL-free");
  if (!isAbsolute(request.workspace_root) || !isAbsolute(request.cwd)) throw new Error("sandbox paths must be absolute");
  if (!Number.isSafeInteger(request.timeout_ms) || request.timeout_ms <= 0 || !Number.isSafeInteger(request.max_output_bytes) || request.max_output_bytes <= 0) throw new Error("sandbox bounds must be positive safe integers");
}

/**
 * Not exercised on this host (no `sandbox-exec` to spawn) — see the module
 * header. Kept as its own function so the untestable surface is exactly
 * this one spawn call, not entangled with profile construction or request
 * validation, both of which are covered.
 */
function spawnSeatbelt(executable: string, profilePath: string, request: SandboxedCommandRequest): Promise<SandboxedCommandResult> {
  return new Promise((resolveResult) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    let outputLimited = false;
    let timedOut = false;
    let cancelled = false;
    const child = spawn(executable, ["-f", profilePath, "--", ...request.argv], {
      cwd: request.cwd, shell: false, env: withGovernedRun({ ...process.env }), stdio: [request.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    const finish = (result: SandboxedCommandResult): void => { if (settled) return; settled = true; clearTimeout(timer); resolveResult(result); };
    const timer = setTimeout(() => { timedOut = true; try { child.kill("SIGTERM"); } catch { /* already gone */ } }, request.timeout_ms);
    request.signal.addEventListener("abort", () => { cancelled = true; try { child.kill("SIGTERM"); } catch { /* already gone */ } }, { once: true });
    if (request.stdin !== undefined && child.stdin !== null) child.stdin.end(request.stdin);
    const append = (target: Buffer[], chunk: Buffer): void => {
      if (outputLimited) return;
      bytes += chunk.length;
      if (bytes > request.max_output_bytes) { outputLimited = true; try { child.kill("SIGTERM"); } catch { /* already gone */ } }
      else target.push(Buffer.from(chunk));
    };
    child.stdout?.on("data", (chunk: Buffer) => append(stdout, chunk));
    child.stderr?.on("data", (chunk: Buffer) => append(stderr, chunk));
    child.once("error", () => finish({ kind: "spawn_failed", confinement: "os_confined" }));
    child.once("close", (code) => {
      const output = { stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), confinement: "os_confined" as const };
      if (cancelled) finish({ kind: "cancelled", ...output });
      else if (timedOut) finish({ kind: "timed_out", ...output });
      else if (outputLimited) finish({ kind: "output_limited", ...output });
      else finish({ kind: "exited", exit: code ?? -1, ...output });
    });
  });
}
