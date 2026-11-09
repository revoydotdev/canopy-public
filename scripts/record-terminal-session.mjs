#!/usr/bin/env bun
import { mkdirSync } from "node:fs";
import { resolve, sep } from "node:path";
import { spawn } from "node:child_process";

const SENSITIVE_NAME = /(?:api[_-]?key|token|secret|password|credential)/i;
const CREDENTIAL_SHAPE = /(?:sk-[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9._~+/-]{16,}|(?:api[_-]?key|token|secret|password|credential)=[^\s]+)/i;

export function validateCommandArguments(argv, env = process.env) {
  if (!Array.isArray(argv) || argv.length === 0 || argv.some((arg) => typeof arg !== "string" || arg.length === 0 || arg.includes("\0"))) {
    throw new Error("recording command must contain non-empty, NUL-free argv entries");
  }
  const inheritedSecrets = Object.entries(env)
    .filter(([name, value]) => SENSITIVE_NAME.test(name) && typeof value === "string" && value.length >= 8)
    .map(([, value]) => value);
  for (const arg of argv) {
    if (CREDENTIAL_SHAPE.test(arg) || inheritedSecrets.some((secret) => arg.includes(secret))) {
      throw new Error("recording command contains credential material; inherit secrets through the environment instead");
    }
  }
  return Object.freeze([...argv]);
}

function shellQuote(value) { return `'${value.replaceAll("'", `'\\''`)}'`; }
export function scriptArguments(argv, rawPath, timingPath) {
  return ["--quiet", "--flush", "--log-out", rawPath, "--log-timing", timingPath, "--command", argv.map(shellQuote).join(" ")];
}

function parse(argv) {
  const separator = argv.indexOf("--");
  const options = separator < 0 ? argv : argv.slice(0, separator);
  const command = separator < 0 ? [] : argv.slice(separator + 1);
  const outIndex = options.indexOf("--out-dir");
  if (outIndex < 0 || !options[outIndex + 1] || options.length !== 2) throw new Error("usage: record-terminal-session --out-dir /mnt/sda2/... -- <command> [args...]");
  const output = resolve(options[outIndex + 1]);
  const root = resolve("/mnt/sda2");
  if (output !== root && !output.startsWith(`${root}${sep}`)) throw new Error("terminal recordings must be written beneath /mnt/sda2");
  return { output, command: validateCommandArguments(command) };
}

export async function recordTerminalSession({ output, command, cwd = process.cwd(), env = process.env }) {
  mkdirSync(output, { recursive: true, mode: 0o700 });
  const rawPath = resolve(output, "tui-live.raw");
  const timingPath = resolve(output, "tui-live.timing");
  const child = spawn("script", scriptArguments(validateCommandArguments(command, env), rawPath, timingPath), {
    cwd, env, detached: true, stdio: "inherit",
  });
  let escalation = null;
  const terminate = (signal) => {
    try { process.kill(-child.pid, signal); } catch { /* already settled */ }
    if (signal !== "SIGKILL" && escalation === null) {
      escalation = setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch { /* settled */ } }, 2_000);
      escalation.unref?.();
    }
  };
  const onSigint = () => terminate("SIGTERM");
  const onSigterm = () => terminate("SIGTERM");
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);
  try {
    const result = await new Promise((resolveResult, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolveResult({ code, signal }));
    });
    if (result.code !== 0) throw new Error(`terminal recording process exited ${result.code ?? result.signal ?? "without status"}`);
    return Object.freeze({ raw_path: rawPath, timing_path: timingPath });
  } finally {
    if (escalation !== null) clearTimeout(escalation);
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    terminate("SIGKILL");
  }
}

if (import.meta.main) {
  try {
    const parsed = parse(process.argv.slice(2));
    const result = await recordTerminalSession(parsed);
    process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
