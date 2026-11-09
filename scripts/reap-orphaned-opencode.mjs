#!/usr/bin/env node
/**
 * scripts/reap-orphaned-opencode.mjs — report, and on explicit request reclaim,
 * `opencode run`/`opencode serve` processes that this repo's tooling spawned
 * and then lost track of.
 *
 *   node scripts/reap-orphaned-opencode.mjs              # report only (default, safe)
 *   node scripts/reap-orphaned-opencode.mjs --json        # report only, machine-readable
 *   node scripts/reap-orphaned-opencode.mjs --kill         # kill, with an interactive
 *                                                           # confirmation prompt
 *   node scripts/reap-orphaned-opencode.mjs --kill --yes   # kill, non-interactive
 *
 * THE PROBLEM THIS EXISTS FOR. `opencode-executor.ts` (subprocess `opencode
 * run` transport) and `opencode-server-executor.ts` (`opencode serve`
 * transport) both spawn the `opencode` binary as a plain child process (no
 * `detached`). Verified empirically (2026-08-08, see the leak investigation
 * report): if the Node parent that spawned one of these dies — SIGKILLed, a
 * raw SIGTERM/SIGINT with no listener anywhere in the process, or any other
 * non-graceful death — the child is orphaned. It is reparented to PID 1 and
 * keeps running forever; nothing ever calls it again. On this box that
 * produced 125 leaked `opencode serve` processes holding ~33GB of RSS,
 * accumulated over many past sessions. `opencode-executor.ts` now tracks its
 * own children and reaps them on process `exit` (defense-in-depth), but that
 * cannot intercept SIGKILL — no process can. This script is the OS-level
 * backstop for whatever gets through anyway.
 *
 * SAFETY MODEL — read this before adding `--kill` to anything automated.
 * A process is a kill CANDIDATE only if every one of these holds:
 *
 *   1. Its argv is exactly `opencode run ...` or `opencode serve ...`
 *      (argv[0]'s basename is literally "opencode"; argv[1] is "run" or
 *      "serve"). Anything else is not our process shape at all.
 *   2. Its parent PID is 1, or the GitHub Actions Runner.Listener subreaper
 *      (PPid/cmdline in /proc). This is the load-bearing check: a process
 *      with another live parent is somebody's in-progress session. Linux
 *      reparents an orphan to the nearest child subreaper, and self-hosted
 *      runners install Runner.Listener as that subreaper rather than PID 1.
 *   3. Its cwd (via the /proc/<pid>/cwd symlink, still valid as long as the
 *      process itself is alive, even after reparenting) resolves to a
 *      directory whose nearest ancestor `package.json` has
 *      `"name": "revoy2"`. This positively attributes the process to THIS
 *      project rather than any other opencode user on the same box — a
 *      collision that matters because two clones of this repo are known to
 *      exist on this operator's machines (see `AGENTS.md`/environment notes)
 *      and other unrelated opencode usage cannot be ruled out.
 *
 * Any process failing #1 is not even listed. Any process failing #2 or #3 is
 * listed under "excluded" with the specific reason — never silently dropped,
 * per the "absence is a value, not a default" rule: a process this script
 * cannot read (cwd unreadable, status unreadable, a PID that vanished
 * mid-scan) is reported as `unavailable`, never treated as safe-to-kill and
 * never treated as absent.
 *
 * Immediately before actually sending a signal, each candidate is
 * RE-VERIFIED (argv + PPID re-read fresh) to close the PID-reuse race
 * between the report and the kill — the OS is free to recycle a PID between
 * those two reads.
 *
 * This script never kills anything on its own. `--kill` still only PREVIEWS
 * (prints the exact list) and requires either an interactive "yes" or
 * `--yes` for non-interactive use. Termination is SIGTERM first, escalating
 * to SIGKILL after a 3s grace period only for whatever is still alive —
 * courteous, though nothing is listening for the polite version anymore.
 */
import { readFileSync, readdirSync, readlinkSync, statSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { createInterface } from "node:readline";

const PROC = "/proc";

function fail(reason) {
  process.stderr.write(`reap-orphaned-opencode: ${reason}\n`);
  process.exit(1);
}

if (process.platform !== "linux") {
  fail(`unsupported platform "${process.platform}" — this script reads /proc, Linux only.`);
}

// ---------------------------------------------------------------------------
// /proc readers. Every read is individually guarded: a process can vanish
// between readdir() and the read, and that is a normal race, not an error.
// ---------------------------------------------------------------------------

/** Returns undefined (typed absence) rather than throwing, for a pid that raced away. */
function readProcFile(pid, name) {
  try {
    return readFileSync(join(PROC, String(pid), name), "utf8");
  } catch {
    return undefined;
  }
}

function readCmdline(pid) {
  const raw = readProcFile(pid, "cmdline");
  if (raw === undefined) return undefined;
  return raw.split("\0").filter((s) => s.length > 0);
}

function readPpid(pid) {
  const raw = readProcFile(pid, "status");
  if (raw === undefined) return undefined;
  const m = raw.match(/^PPid:\s*(\d+)/m);
  return m ? Number(m[1]) : undefined;
}

function readRssKb(pid) {
  const raw = readProcFile(pid, "status");
  if (raw === undefined) return undefined;
  const m = raw.match(/^VmRSS:\s*(\d+)\s*kB/m);
  return m ? Number(m[1]) : undefined;
}

function readCwd(pid) {
  try {
    return readlinkSync(join(PROC, String(pid), "cwd"));
  } catch {
    return undefined;
  }
}

function readStartClockTicks(pid) {
  const raw = readProcFile(pid, "stat");
  if (raw === undefined) return undefined;
  // Field 22 (starttime), but comm (field 2) is parenthesized and may itself
  // contain spaces/parens — split on the LAST ')' to get past it reliably.
  const afterComm = raw.slice(raw.lastIndexOf(")") + 1).trim().split(/\s+/);
  // afterComm[0] is field 3 (state); starttime is field 22, i.e. index 19 here.
  const v = afterComm[19];
  return v !== undefined ? Number(v) : undefined;
}

function systemUptimeSeconds() {
  const raw = readFileSync(join(PROC, "uptime"), "utf8");
  return Number(raw.trim().split(/\s+/)[0]);
}

const CLK_TCK = 100; // Linux default (sysconf(_SC_CLK_TCK)); true on every distro this repo targets.

function ageSeconds(pid, uptimeS) {
  const ticks = readStartClockTicks(pid);
  if (ticks === undefined) return undefined;
  return Math.round(uptimeS - ticks / CLK_TCK);
}

/**
 * Walk up from `dir` to find the nearest ancestor `package.json` and read its
 * `name`. Stops at the FIRST package.json found (nearest-owning-project
 * semantics) — a revoy2 checkout nested under some unrelated ancestor project
 * must not inherit that ancestor's identity, and vice versa.
 */
function nearestPackageName(dir) {
  let cur = dir;
  for (let i = 0; i < 64; i++) {
    const candidate = join(cur, "package.json");
    try {
      const pkg = JSON.parse(readFileSync(candidate, "utf8"));
      return typeof pkg.name === "string" ? pkg.name : null;
    } catch {
      // no package.json here, or unreadable/unparsable — keep climbing.
    }
    const parent = dirname(cur);
    if (parent === cur) break; // reached filesystem root
    cur = parent;
  }
  return undefined; // no package.json found anywhere in the ancestry
}

function listPids() {
  return readdirSync(PROC)
    .filter((name) => /^\d+$/.test(name))
    .map(Number);
}

// ---------------------------------------------------------------------------
// Candidate classification
// ---------------------------------------------------------------------------

function isOpencodeArgv(argv) {
  if (!argv || argv.length < 2) return false;
  return basename(argv[0]) === "opencode" && (argv[1] === "run" || argv[1] === "serve");
}

/** GitHub's self-hosted Runner.Listener is a Linux child subreaper. */
function isOrphanReaperParent(ppid) {
  if (ppid === 1) return true;
  const argv = readCmdline(ppid);
  return argv !== undefined && argv.some((value) => basename(value) === "Runner.Listener");
}

/**
 * Classify one pid. Returns:
 *   { pid, kind: "not_opencode" }                         — not our process shape, excluded from output entirely
 *   { pid, kind: "excluded", reason, ...evidence }         — an opencode process, but not safely attributable/orphaned
 *   { pid, kind: "candidate", ...evidence }                — verified orphan, verified revoy2 attribution
 */
function classify(pid, uptimeS) {
  const argv = readCmdline(pid);
  if (!isOpencodeArgv(argv)) return { pid, kind: "not_opencode" };

  const mode = argv[1]; // "run" | "serve"
  const ppid = readPpid(pid);
  const cwd = readCwd(pid);
  const rssKb = readRssKb(pid);
  const age = ageSeconds(pid, uptimeS);
  const evidence = { pid, mode, argv: argv.join(" "), ppid, cwd, rssKb, ageSeconds: age };

  if (ppid === undefined) return { ...evidence, kind: "excluded", reason: "ppid_unavailable (process vanished mid-scan or /proc unreadable)" };
  if (!isOrphanReaperParent(ppid)) return { ...evidence, kind: "excluded", reason: `has a live parent (PPid=${ppid}) — not orphaned, not touched` };
  if (cwd === undefined) return { ...evidence, kind: "excluded", reason: "cwd_unavailable (permission denied or process vanished mid-scan)" };

  const pkgName = nearestPackageName(cwd);
  if (pkgName === undefined) return { ...evidence, kind: "excluded", reason: `cwd "${cwd}" has no ancestor package.json — cannot attribute to revoy2` };
  if (pkgName !== "revoy2") return { ...evidence, kind: "excluded", reason: `cwd "${cwd}" belongs to project "${pkgName}", not revoy2` };

  return { ...evidence, kind: "candidate" };
}

/** Immediately-before-kill re-verification, closing the PID-reuse race. */
function reverifyStillCandidate(prior) {
  const argv = readCmdline(prior.pid);
  if (!isOpencodeArgv(argv) || argv[1] !== prior.mode) return false;
  const ppid = readPpid(prior.pid);
  if (ppid === undefined || !isOrphanReaperParent(ppid)) return false;
  const cwd = readCwd(prior.pid);
  if (cwd !== prior.cwd) return false; // pid reuse would very likely change cwd
  return true;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  return {
    json: argv.includes("--json"),
    kill: argv.includes("--kill"),
    yes: argv.includes("--yes"),
  };
}

async function confirm(promptText) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((resolve) => rl.question(promptText, resolve));
  rl.close();
  return answer.trim().toLowerCase() === "yes";
}

function fmtMb(kb) {
  return kb === undefined ? "unavailable" : `${(kb / 1024).toFixed(0)}MB`;
}

function fmtAge(s) {
  if (s === undefined) return "unavailable";
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h${m}m` : `${m}m`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const uptimeS = systemUptimeSeconds();
  const results = listPids().map((pid) => classify(pid, uptimeS));

  const candidates = results.filter((r) => r.kind === "candidate");
  const excluded = results.filter((r) => r.kind === "excluded");

  if (args.json) {
    process.stdout.write(JSON.stringify({ candidates, excluded }, null, 2) + "\n");
  } else {
    const totalMb = candidates.reduce((acc, c) => acc + (c.rssKb ?? 0), 0) / 1024;
    process.stdout.write(
      `Orphaned revoy2 opencode processes (reparented to init or Runner.Listener, cwd attributed to package "revoy2"):\n`,
    );
    if (candidates.length === 0) {
      process.stdout.write("  none found.\n");
    } else {
      for (const c of candidates) {
        process.stdout.write(`  pid=${c.pid} mode=${c.mode} age=${fmtAge(c.ageSeconds)} rss=${fmtMb(c.rssKb)} cwd=${c.cwd}\n`);
      }
      process.stdout.write(`  ${candidates.length} process(es), ~${totalMb.toFixed(1)}MB RSS total.\n`);
    }
    if (excluded.length > 0) {
      process.stdout.write(`\nopencode processes seen but NOT touched (${excluded.length}):\n`);
      for (const e of excluded) {
        process.stdout.write(`  pid=${e.pid} mode=${e.mode} — ${e.reason}\n`);
      }
    }
  }

  if (!args.kill) {
    process.stdout.write(args.json ? "" : "\n(report-only; pass --kill to reclaim these — you will be asked to confirm)\n");
    process.exit(0);
  }

  if (candidates.length === 0) {
    process.stdout.write("\nNothing to kill.\n");
    process.exit(0);
  }

  if (!args.yes) {
    const ok = await confirm(
      `\nAbout to SIGTERM (then SIGKILL if still alive after 3s) ${candidates.length} process(es) listed above. Type "yes" to proceed: `,
    );
    if (!ok) {
      process.stdout.write("Aborted — nothing was killed.\n");
      process.exit(1);
    }
  }

  const killed = [];
  const skippedRace = [];
  for (const c of candidates) {
    if (!reverifyStillCandidate(c)) {
      skippedRace.push(c.pid);
      continue;
    }
    try {
      process.kill(c.pid, "SIGTERM");
      killed.push(c.pid);
    } catch (e) {
      process.stderr.write(`  pid=${c.pid}: SIGTERM failed (${e.message}) — skipped\n`);
    }
  }

  if (killed.length > 0) {
    await new Promise((r) => setTimeout(r, 3000));
    for (const pid of killed) {
      try {
        process.kill(pid, 0); // liveness probe; throws ESRCH if the process is gone
        process.kill(pid, "SIGKILL");
        process.stdout.write(`  pid=${pid}: still alive after SIGTERM, sent SIGKILL\n`);
      } catch {
        // gone — SIGTERM was enough.
      }
    }
  }

  if (skippedRace.length > 0) {
    process.stdout.write(`Skipped (PID no longer matched the verified candidate — reuse race): ${skippedRace.join(", ")}\n`);
  }
  process.stdout.write(`Reclaimed ${killed.length} process(es).\n`);
}

main();
