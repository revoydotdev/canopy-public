/**
 * arbor-eval/stage0/proc — child-process helpers that always keep their logs.
 *
 * Every command's stdout and stderr are written to `<logs>/<name>.{stdout,stderr}.log`
 * and nothing is ever deleted. A long job that fails must keep its evidence.
 */
import { spawn, spawnSync } from "node:child_process";
import { createWriteStream, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface CommandResult {
  readonly name: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly exit_code: number | null;
  readonly signal: string | null;
  readonly timed_out: boolean;
  readonly ms: number;
  readonly stdout: string;
  readonly stderr: string;
}

export function runLogged(
  logs: string,
  name: string,
  argv: readonly string[],
  cwd: string,
  options: { timeoutMs?: number; env?: NodeJS.ProcessEnv; input?: Buffer | string } = {},
): CommandResult {
  mkdirSync(logs, { recursive: true });
  const started = Date.now();
  const result = spawnSync(argv[0], argv.slice(1), {
    cwd,
    encoding: "utf8",
    timeout: options.timeoutMs ?? 600_000,
    maxBuffer: 256 * 1024 * 1024,
    env: options.env ?? process.env,
    ...(options.input === undefined ? {} : { input: options.input }),
  });
  const stdout = result.stdout ?? "";
  const stderr = `${result.stderr ?? ""}${result.error ? `\n[spawn error] ${result.error.message}` : ""}`;
  writeFileSync(join(logs, `${name}.stdout.log`), stdout);
  writeFileSync(join(logs, `${name}.stderr.log`), stderr);
  const timedOut = result.error !== undefined && /ETIMEDOUT/.test(String((result.error as NodeJS.ErrnoException).code ?? result.error.message));
  return { name, argv, cwd, exit_code: result.status, signal: result.signal, timed_out: timedOut, ms: Date.now() - started, stdout, stderr };
}

/** Streamed variant for long commands: output goes straight to the log files. */
export function runStreamed(
  logs: string,
  name: string,
  argv: readonly string[],
  cwd: string,
  timeoutMs: number,
  env: NodeJS.ProcessEnv = process.env,
  signal?: AbortSignal,
): Promise<Omit<CommandResult, "stdout" | "stderr"> & { readonly aborted: boolean }> {
  mkdirSync(logs, { recursive: true });
  return new Promise((resolve) => {
    const started = Date.now();
    const out = createWriteStream(join(logs, `${name}.stdout.log`));
    const err = createWriteStream(join(logs, `${name}.stderr.log`));
    const child = spawn(argv[0], argv.slice(1), { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.pipe(out);
    child.stderr.pipe(err);
    let timedOut = false;
    let aborted = false;
    const stop = () => {
      child.kill("SIGINT");
      setTimeout(() => child.kill("SIGKILL"), 60_000).unref();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);
    // A run-guard stop (provider-fatal, spend or wall cap) ends the command the same way a timeout does.
    const onAbort = () => {
      aborted = true;
      stop();
    };
    if (signal?.aborted === true) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
    child.on("error", (error) => err.write(`\n[spawn error] ${error.message}\n`));
    child.on("close", (code, exitSignal) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      Promise.all([new Promise<void>((done) => out.end(done)), new Promise<void>((done) => err.end(done))]).then(() =>
        resolve({ name, argv, cwd, exit_code: code, signal: exitSignal, timed_out: timedOut, aborted, ms: Date.now() - started }));
    });
  });
}

/** Async variant of `runLogged`: same logs and result, without blocking sibling attempts. */
export function runLoggedAsync(
  logs: string,
  name: string,
  argv: readonly string[],
  cwd: string,
  options: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<CommandResult> {
  mkdirSync(logs, { recursive: true });
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(argv[0], argv.slice(1), { cwd, env: options.env ?? process.env, stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    let timedOut = false;
    let spawnError = "";
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 30_000).unref();
    }, options.timeoutMs ?? 600_000);
    child.on("error", (error) => {
      spawnError = `\n[spawn error] ${error.message}`;
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(out).toString("utf8");
      const stderr = `${Buffer.concat(err).toString("utf8")}${spawnError}`;
      writeFileSync(join(logs, `${name}.stdout.log`), stdout);
      writeFileSync(join(logs, `${name}.stderr.log`), stderr);
      resolve({ name, argv, cwd, exit_code: code, signal, timed_out: timedOut, ms: Date.now() - started, stdout, stderr });
    });
  });
}
