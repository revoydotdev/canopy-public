#!/usr/bin/env bun
/**
 * Launch the installed source-bound canopy-debug TUI and retain machine-
 * readable proof of its durable capture boundary. This drives the dedicated
 * launcher, sends F8/F9, then reads the SQLite database produced by it.
 */
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

const repo = resolve(import.meta.dir, "..");
const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
const argv = process.argv.slice(2);
const launcherIndex = argv.indexOf("--launcher");
const rootIndex = argv.indexOf("--root");
const timeoutIndex = argv.indexOf("--timeout-ms");
const launcher = resolve(launcherIndex >= 0 ? argv[launcherIndex + 1] : join(homedir(), ".local", "bin", "canopy-debug"));
const root = resolve(rootIndex >= 0 ? argv[rootIndex + 1] : join(repo, ".arbor", "canopy-debug-smoke", stamp));
const timeoutMs = Number(timeoutIndex >= 0 ? argv[timeoutIndex + 1] : 45_000);
if (argv.includes("--help") || argv.includes("-h")) {
  process.stdout.write("usage: bun scripts/canopy-debug-smoke.mjs [--launcher path] [--root path] [--timeout-ms n]\n");
  process.exit(0);
}
if (!existsSync(launcher)) throw new Error(`installed canopy-debug launcher is missing: ${launcher}`);
if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 5_000 || timeoutMs > 180_000) throw new Error("--timeout-ms must be between 5000 and 180000");
mkdirSync(root, { recursive: true, mode: 0o700 });
function findJournal(directory) {
  if (!existsSync(directory)) return null;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isFile() && entry.name === "journal.sqlite") return path;
    if (entry.isDirectory()) { const nested = findJournal(path); if (nested !== null) return nested; }
  }
  return null;
}
const wait = (milliseconds) => new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));
const child = spawn(launcher, ["--renderer", "stdout", "--notification-mechanism", "off"], {
  cwd: repo,
  env: { ...process.env, CANOPY_DEBUG_STATE_DIR: join(root, "state") },
  stdio: ["pipe", "pipe", "pipe"],
});
let output = "";
const collect = (chunk) => { output = `${output}${String(chunk)}`.slice(-32_768); };
child.stdout.on("data", collect);
child.stderr.on("data", collect);
const started = Date.now();
let dbPath = null;
while (dbPath === null && Date.now() - started < timeoutMs) { await wait(100); dbPath = findJournal(join(root, "state")); }
if (dbPath === null) { child.kill("SIGTERM"); throw new Error(`canopy-debug did not create journal under ${root}\n${output}`); }
// VT220/xterm function keys: F8 = CSI 19~, F9 = CSI 20~.
await wait(1_000);
child.stdin.write("\u001b[19~");
await wait(350);
child.stdin.write("\u001b[20~");
await wait(350);
child.stdin.write("\u001b[20~");
await wait(500);
// EOF is the TUI's owned shutdown door for a piped process. Give its
// renderer/journal teardown a short window before the signal fallback.
child.stdin.end();
await wait(2_000);
if (child.exitCode === null) child.kill("SIGTERM");
const exited = await Promise.race([
  new Promise((resolveExit) => child.once("exit", (code, signal) => resolveExit({ code, signal }))),
  wait(20_000).then(() => null),
]);
let termination = "signal";
if (exited === null) {
  // The TUI has already restored its terminal and closed the journal before
  // a few background projection handles settle. Preserve that durable close
  // edge, then reap the remaining process so the evidence command itself is
  // bounded and cannot strand a live launcher.
  termination = "forced_after_graceful_timeout";
  child.kill("SIGKILL");
}
if (exited !== null && exited.code !== 0) throw new Error(`canopy-debug exited ${exited.code ?? exited.signal}\n${output}`);
const { Database } = await import("bun:sqlite");
const db = new Database(dbPath, { readonly: true });
const sessions = db.query("SELECT session_id, status, opened_at, closed_at FROM sessions ORDER BY opened_at").all();
const lifecycle = db.query("SELECT kind FROM events WHERE kind IN ('session_open','session_close') ORDER BY sequence").all();
const events = db.query("SELECT kind, COUNT(*) AS count FROM events GROUP BY kind ORDER BY kind").all();
const artifacts = db.query("SELECT artifact_id, session_id, event_id, path, mime, bytes, sha256, created_at FROM artifacts ORDER BY created_at").all();
db.close();
if (sessions.length !== 1 || sessions[0].status !== "closed") throw new Error(`unexpected session lifecycle: ${JSON.stringify(sessions)}`);
if (lifecycle.length < 2 || lifecycle[0].kind !== "session_open" || lifecycle.at(-1).kind !== "session_close") throw new Error(`missing lifecycle events: ${JSON.stringify(lifecycle)}`);
if (!events.some((row) => row.kind === "input") || !events.some((row) => row.kind === "output")) throw new Error(`missing input/output events: ${JSON.stringify(events)}`);
if (artifacts.length < 1) throw new Error("F8 did not create an indexed artifact");
const sessionRoot = resolve(dbPath, "..");
for (const artifact of artifacts) {
  const artifactPath = resolve(sessionRoot, artifact.path);
  if (!existsSync(artifactPath) || !statSync(artifactPath).isFile()) throw new Error(`indexed artifact is missing: ${artifact.path}`);
}
const evidence = { schema: 1, kind: "canopy-debug.launch_smoke", started_at: new Date(started).toISOString(), finished_at: new Date().toISOString(), termination, launcher, source_root: repo, state_root: root, journal_path: resolve(dbPath), session: sessions[0], lifecycle, event_counts: events, artifacts, stdout_tail: output };
const evidencePath = join(root, "evidence.json");
writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
process.stdout.write(`${JSON.stringify({ ...evidence, evidence_path: evidencePath })}\n`);
