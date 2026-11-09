/**
 * interview-command.ts — `arbor interview`, the operator decision interview
 * asked through arbor's own native human-input port (ADR-178).
 *
 * ADR-178 makes the host's native question tool the sole egress for owed
 * governance decisions. In Claude Code that is AskUserQuestion; in arbor it is
 * `NativeHumanInputPort`. This command is the arbor half, end to end:
 *
 *   1. derive the question pack — `scripts/interview-pack.mjs`, the one
 *      derivation `gate:decision-queue` also reads;
 *   2. ask it through a terminal-backed `NativeHumanInputPort` with
 *      `askInterviewPack` (@arbor/harness), which keeps every reply verbatim
 *      and invents nothing;
 *   3. record the answers through `scripts/interview-record.mjs`, the
 *      validating front of the sole ledger writer, under the egress channel
 *      `arbor.native.human_input`.
 *
 * WHY IT SUBPROCESSES THE SCRIPTS. Same reason as `inject.operator-decision-queue`
 * (hooks/operator-decision-queue.ts): the queue is derived from nine stores by
 * script-owned code, and a TypeScript re-derivation would be a second
 * implementation of an invariant the gate already owns. The pack digest makes
 * the boundary safe — the recorder re-verifies the pack it is handed, so a pack
 * that changed between asking and recording is refused, not silently re-bound.
 *
 * WHAT IT NEVER DOES. Answer on the operator's behalf. A closed input stream
 * is `unavailable`, `q` is `declined`, and either stops the interview with
 * nothing invented; when no question was answered, the recorder is not run at
 * all. `--dry-run` asks and validates but writes nothing: the recorder runs
 * with its own `--dry-run`, and the pack it reads lives in a private temp
 * directory removed before this command returns.
 */
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import {
  askInterviewPack, INTERVIEW_QUESTION_PACK_KIND,
  type InterviewQuestionPack, type NativeHumanInputPort, type NativeHumanInputResult,
} from "@arbor/harness";
import { EXIT_CODES } from "./exit-codes.js";

export interface InterviewCommandEnvironment {
  readonly cwd: string;
  readonly stdin: Readable;
  readonly stdout: Writable;
  readonly stderr: Writable;
}

const USAGE = "Usage: arbor interview [--dry-run] [--include-upcoming] [--repo <dir>]\n";

const HELP = [
  USAGE,
  "Ask every owed governance decision (scripts/decision-queue.mjs) as a numbered multiple-choice",
  "question on this terminal, and record the verbatim answers to decisions/interviews.jsonl",
  "through scripts/interview-record.mjs under the egress `arbor.native.human_input` (ADR-178).",
  "",
  "  Reply with an option's number or label; anything after it is kept as your words.",
  "  A blank line skips a question. `q` ends the interview; end of input does too.",
  "  Nothing is recorded for a question you did not answer.",
  "",
  "  Asking somewhere else (AskUserQuestion in Claude Code)? Use the same two halves directly:",
  "    bun run interview:pack > pack.json        # the questions this command asks",
  "    bun run interview:record --pack pack.json --answers answers.json",
  "",
  "  --dry-run           Ask and validate, print the payload, write nothing",
  "  --include-upcoming  Also ask the not-yet-blocking items",
  "  --repo <dir>        Governed repository whose decisions are asked (default: the current directory)",
  "",
].join("\n");

/**
 * A `NativeHumanInputPort` over a line stream. One request writes the rendered
 * question and reads one line. The reply is returned verbatim: choosing what it
 * means is `parseInterviewChoice`'s job, not the terminal's.
 */
export function createTerminalHumanInputPort(input: Readable, output: Writable): NativeHumanInputPort & { close(): void } {
  const reader = createInterface({ input, crlfDelay: Infinity });
  const buffered: string[] = [];
  const waiting: Array<(line: string | null) => void> = [];
  let closed = false;
  reader.on("line", (line) => {
    const next = waiting.shift();
    if (next) next(line); else buffered.push(line);
  });
  reader.on("close", () => {
    closed = true;
    while (waiting.length > 0) waiting.shift()!(null);
  });
  const nextLine = (signal: AbortSignal): Promise<string | null> => {
    if (buffered.length > 0) return Promise.resolve(buffered.shift()!);
    if (closed || signal.aborted) return Promise.resolve(null);
    return new Promise((settle) => {
      const onAbort = (): void => {
        const index = waiting.indexOf(deliver);
        if (index >= 0) waiting.splice(index, 1);
        settle(null);
      };
      const deliver = (line: string | null): void => { signal.removeEventListener("abort", onAbort); settle(line); };
      waiting.push(deliver);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  };
  return {
    async request(request, signal): Promise<NativeHumanInputResult> {
      output.write(`\n${request.question}\n> `);
      const line = await nextLine(signal);
      if (line === null) {
        output.write("\n");
        return { kind: "unavailable", reason: signal.aborted ? "the interview was cancelled" : "input ended before the operator answered" };
      }
      if (/^\s*(q|quit)\s*$/i.test(line)) return { kind: "declined", reason: "the operator ended the interview" };
      return { kind: "submitted", response: line, provenance: { tag: "claimed", claimant: "operator" } };
    },
    close() { reader.close(); },
  };
}

function flagValue(args: readonly string[], flag: string): string | null {
  const index = args.indexOf(flag);
  return index >= 0 && index + 1 < args.length ? args[index + 1]! : null;
}

function parsePack(stdout: string): InterviewQuestionPack | null {
  let parsed: unknown;
  try { parsed = JSON.parse(stdout); } catch { return null; }
  if (typeof parsed !== "object" || parsed === null) return null;
  const pack = parsed as Partial<InterviewQuestionPack>;
  if (pack.kind !== INTERVIEW_QUESTION_PACK_KIND || !Array.isArray(pack.questions) || typeof pack.pack_digest !== "string") return null;
  return parsed as InterviewQuestionPack;
}

export async function interviewCommand(args: readonly string[], environment: InterviewCommandEnvironment): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) { environment.stdout.write(HELP); return EXIT_CODES.SUCCESS; }
  const known = new Set(["--dry-run", "--include-upcoming", "--repo"]);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (!known.has(arg)) { environment.stderr.write(`arbor interview: unrecognized argument ${JSON.stringify(arg)}\n${USAGE}`); return EXIT_CODES.USAGE; }
    if (arg === "--repo") {
      if (flagValue(args, "--repo") === null) { environment.stderr.write(`arbor interview: --repo needs a directory\n${USAGE}`); return EXIT_CODES.USAGE; }
      index += 1;
    }
  }
  const dryRun = args.includes("--dry-run");
  const repo = resolve(environment.cwd, flagValue(args, "--repo") ?? ".");
  const packScript = join(environment.cwd, "scripts", "interview-pack.mjs");
  const recordScript = join(environment.cwd, "scripts", "interview-record.mjs");
  if (!existsSync(packScript) || !existsSync(recordScript)) {
    environment.stderr.write(`arbor interview runs from a revoy2 checkout: scripts/interview-pack.mjs and scripts/interview-record.mjs were not found under ${environment.cwd}\n`);
    return EXIT_CODES.USAGE;
  }

  const derived = spawnSync("bun", [packScript, "--repo", repo, ...(args.includes("--include-upcoming") ? ["--include-upcoming"] : [])], {
    cwd: environment.cwd, encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024,
  });
  const pack = derived.status === 0 && typeof derived.stdout === "string" ? parsePack(derived.stdout) : null;
  if (pack === null) {
    // UNKNOWN, never "nothing owed": a queue that could not be derived is not an empty one.
    environment.stderr.write(`arbor interview: could not derive the question pack (exit ${derived.status ?? "signal"})\n${derived.stderr ?? ""}`);
    return EXIT_CODES.FAILURE;
  }
  if (pack.questions.length === 0) {
    environment.stdout.write(`No owed decisions to ask (${pack.pack_digest}).\n`);
    return EXIT_CODES.SUCCESS;
  }

  environment.stdout.write(`${pack.questions.length} owed decision(s) in pack ${pack.pack_digest}${dryRun ? " — dry run, nothing will be recorded" : ""}.\nReply with an option number or label; a blank line skips; q ends.\n`);
  const port = createTerminalHumanInputPort(environment.stdin, environment.stdout);
  let asked: Awaited<ReturnType<typeof askInterviewPack>>;
  try {
    asked = await askInterviewPack(pack, port, { session_id: `arbor-interview-${randomUUID()}` });
  } finally {
    port.close();
  }

  for (const entry of asked.unanswered) environment.stdout.write(`unanswered ${entry.question_id}: ${entry.reason}\n`);
  if (asked.answers === null) {
    environment.stdout.write("Nothing answered; nothing recorded.\n");
    return EXIT_CODES.PARTIAL;
  }

  const scratch = mkdtempSync(join(tmpdir(), "arbor-interview-"));
  try {
    const packPath = join(scratch, "pack.json");
    writeFileSync(packPath, JSON.stringify(pack));
    const recorded = spawnSync("bun", [recordScript, "--pack", packPath, "--answers", "-", "--repo", repo, ...(dryRun ? ["--dry-run"] : [])], {
      cwd: environment.cwd, encoding: "utf8", windowsHide: true, input: JSON.stringify(asked.answers), maxBuffer: 64 * 1024 * 1024,
    });
    if (typeof recorded.stdout === "string") environment.stdout.write(recorded.stdout);
    if (typeof recorded.stderr === "string") environment.stderr.write(recorded.stderr);
    if (recorded.status !== 0) {
      environment.stderr.write("arbor interview: the recorder refused the answers; nothing was recorded\n");
      return EXIT_CODES.VIOLATION;
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  if (dryRun) environment.stdout.write("Dry run: answers validated; nothing recorded.\n");
  return asked.unanswered.length > 0 ? EXIT_CODES.PARTIAL : EXIT_CODES.SUCCESS;
}
