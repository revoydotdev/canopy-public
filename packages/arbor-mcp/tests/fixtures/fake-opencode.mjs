#!/usr/bin/env node
/**
 * Fake `opencode` binary for hermetic tests of opencode-executor.ts's
 * subprocess `LoopExecutor`. No network, no real LLM — a test double for the
 * exact seam `runOpenCode` spawns (`opencodeBin`, argv, stdout/exit code).
 *
 * Controlled entirely via environment variables so one script serves every
 * contract-suite case:
 *   FAKE_OPENCODE_STDOUT     — printed to stdout verbatim.
 *   FAKE_OPENCODE_STDERR     — printed to stderr verbatim (default "").
 *   FAKE_OPENCODE_EXIT       — process exit code (default "0").
 *   FAKE_OPENCODE_SLEEP_MS   — block before exiting (default "0"). Used to
 *     simulate an in-flight `opencode run`/`serve` for child-lifecycle tests
 *     (e.g. the process-exit reap safety net in opencode-executor.ts) without
 *     racing a real timeout.
 */
const stdout = process.env.FAKE_OPENCODE_STDOUT ?? "";
const stderr = process.env.FAKE_OPENCODE_STDERR ?? "";
const exitCode = Number(process.env.FAKE_OPENCODE_EXIT ?? "0");
const sleepMs = Number(process.env.FAKE_OPENCODE_SLEEP_MS ?? "0");

if (stdout) process.stdout.write(stdout);
if (stderr) process.stderr.write(stderr);
setTimeout(() => process.exit(exitCode), sleepMs);
