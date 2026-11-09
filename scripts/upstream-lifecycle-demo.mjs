#!/usr/bin/env bun
/** Provider-backed, lineage-linked lifecycle proof against pinned byteorder. */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderTmuxFrame } from "./tmux-demo-record.mjs";
import { publishLifecycleTrees } from "./lifecycle-tree-publication.mjs";
import { assertSecretFree } from "./lib/sizzle-redaction.mjs";
import { writeManifestAndChecksums } from "./lib/sizzle-manifest.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DRIVER = join(ROOT, "scripts", "generalist-campaign-driver.mjs");
const UPSTREAM = "https://github.com/BurntSushi/byteorder.git";
const UPSTREAM_REVISION = "5a82625fae462e8ba64cec8146b24a372b4d75c6";
const VERIFY = ["cargo", "test", "--quiet"];
const INITIAL_TASK = "Add documented ByteOrder::read_u40 and ByteOrder::write_u40 convenience methods for five-byte unsigned integers. Preserve no_std support and the existing generic read_uint/write_uint behavior. tests/revoy_u40.rs is an operator-owned acceptance oracle and must not be modified. Keep the change narrowly scoped to src/lib.rs and do not weaken or remove tests. Verify with cargo test --quiet and cargo check --no-default-features.";
const INITIAL_TEST = `use byteorder::{BigEndian, ByteOrder, LittleEndian};

#[test]
fn five_byte_unsigned_api_has_exact_endian_layout_and_round_trips() {
    let value = 0x01_02_03_04_05_u64;
    let mut bytes = [0_u8; 5];
    BigEndian::write_u40(&mut bytes, value);
    assert_eq!(bytes, [1, 2, 3, 4, 5]);
    assert_eq!(BigEndian::read_u40(&bytes), value);
    LittleEndian::write_u40(&mut bytes, value);
    assert_eq!(bytes, [5, 4, 3, 2, 1]);
    assert_eq!(LittleEndian::read_u40(&bytes), value);
}
`;
const FOLLOWUPS = [{
  task: "Extend the newly accepted five-byte API through ReadBytesExt::read_u40 and WriteBytesExt::write_u40 in src/io.rs. tests/revoy_u40_io.rs is an operator-owned acceptance oracle and must not be modified. Reuse the ByteOrder methods, preserve existing I/O error semantics and no_std behavior, and do not weaken tests. The authorized write path is src/io.rs. Verify with cargo test --quiet and cargo check --no-default-features.",
  commit_message: "test: require five-byte unsigned I/O extension API",
  files: {
    "tests/revoy_u40_io.rs": `use byteorder::{BigEndian, LittleEndian, ReadBytesExt, WriteBytesExt};
use std::io::Cursor;

#[test]
fn five_byte_unsigned_io_extensions_round_trip_both_endiannesses() {
    let value = 0x01_02_03_04_05_u64;
    let mut bytes = Vec::new();
    bytes.write_u40::<BigEndian>(value).unwrap();
    bytes.write_u40::<LittleEndian>(value).unwrap();
    assert_eq!(bytes, [1, 2, 3, 4, 5, 5, 4, 3, 2, 1]);
    let mut cursor = Cursor::new(bytes);
    assert_eq!(cursor.read_u40::<BigEndian>().unwrap(), value);
    assert_eq!(cursor.read_u40::<LittleEndian>().unwrap(), value);
}
`,
  },
}];

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: options.cwd, env: options.env ?? process.env, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  return { exit_code: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}
function mustRun(command, args, options = {}) {
  const result = run(command, args, options);
  if (result.exit_code !== 0) throw new Error(`${command} failed (${result.exit_code}): ${result.stderr || result.stdout}`);
  return result;
}
function git(cwd, args) { return mustRun("git", args, { cwd }).stdout.trim(); }
function quote(value) { return `'${String(value).replaceAll("'", `'\\''`)}'`; }
function sha256(path) { return createHash("sha256").update(readFileSync(path)).digest("hex"); }
function sanitize(text, workspace) {
  return String(text)
    .replaceAll(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
    .replaceAll(workspace, "<upstream-workspace>")
    .replaceAll(ROOT, "<revoy2>")
    .replaceAll(process.env.HOME ?? "/home/user", "~")
    .replaceAll(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[account withheld]")
    .replaceAll(/\b(?:sk-[A-Za-z0-9_-]{12,}|(?:api[_-]?key|authorization|bearer)[=: ]+[A-Za-z0-9_./+-]{12,}|gh[opusr]_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16})\b/gi, "[credential withheld]");
}

export function assessLifecycleResult(result) {
  if (!result?.ok || result.verification?.exit_code !== 0 || result.adoption?.exit_code !== 0) throw new Error("root campaign was not adopted and independently accepted");
  if (!Array.isArray(result.followups) || result.followups.length !== FOLLOWUPS.length) throw new Error("required follow-up lineage is incomplete");
  let parent = result.campaign_id;
  for (const followup of result.followups) {
    if (followup.parent_campaign_id !== parent || !followup.campaign_id || followup.baseline?.exit_code === 0 || followup.adoption?.exit_code !== 0 || followup.verification?.exit_code !== 0) throw new Error("follow-up lineage evidence is incomplete");
    parent = followup.campaign_id;
  }
  return { root_campaign_id: result.campaign_id, terminal_campaign_id: parent, campaign_count: 1 + result.followups.length };
}

function setupWorkspace(workspace) {
  mkdirSync(dirname(workspace), { recursive: true });
  mustRun("git", ["clone", "-q", UPSTREAM, workspace]);
  git(workspace, ["checkout", "-q", UPSTREAM_REVISION]);
  git(workspace, ["config", "user.email", "evidence@revoy.dev"]);
  git(workspace, ["config", "user.name", "Revoy Evidence"]);
  mkdirSync(join(workspace, "tests"), { recursive: true });
  writeFileSync(join(workspace, "tests", "revoy_u40.rs"), INITIAL_TEST);
  git(workspace, ["add", "tests/revoy_u40.rs"]);
  git(workspace, ["commit", "-qm", "test: require five-byte unsigned ByteOrder API"]);
  const parent = git(workspace, ["rev-parse", "HEAD^"]);
  if (parent !== UPSTREAM_REVISION) throw new Error("requirement commit is not based on the pinned upstream revision");
  const baseline = run(...[VERIFY[0], VERIFY.slice(1)], { cwd: workspace });
  if (baseline.exit_code === 0) throw new Error("operator-owned initial requirement must fail before the campaign");
  return { requirement_revision: git(workspace, ["rev-parse", "HEAD"]), baseline };
}

function capturePane(session, workspace) {
  const captured = run("tmux", ["capture-pane", "-p", "-t", session, "-S", "-220"]);
  return captured.exit_code === 0 ? sanitize(captured.stdout, workspace).trimEnd() : null;
}

function renderFrames(frames, output, durationMs) {
  const frameDir = join(dirname(output), ".frames");
  mkdirSync(frameDir, { recursive: true });
  frames.forEach((frame, index) => {
    const lines = frame.text.split("\n"), split = Math.max(10, Math.floor(lines.length * 0.6));
    writeFileSync(join(frameDir, `frame-${String(index).padStart(6, "0")}.svg`), renderTmuxFrame({ at_ms: frame.at_ms, left: lines.slice(0, split).join("\n"), right: ["UPSTREAM  BurntSushi/byteorder", "REVISION  pinned", "PROVIDER  Codex", "TIER      governed", `ELAPSED   ${(frame.at_ms / 1000).toFixed(0)}s`, "", ...lines.slice(split)].join("\n") }, { run_id: "byteorder-upstream-lifecycle", duration_ms: durationMs }));
  });
  mustRun("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-framerate", "1", "-i", join(frameDir, "frame-%06d.svg"), "-c:v", "libvpx-vp9", "-deadline", "realtime", "-cpu-used", "8", "-row-mt", "1", "-threads", "8", "-crf", "34", "-b:v", "0", "-pix_fmt", "yuv420p", "-r", "30", output]);
  rmSync(frameDir, { recursive: true, force: true });
}

async function main() {
  const value = (name, fallback) => { const index = process.argv.indexOf(name); return index < 0 ? fallback : process.argv[index + 1]; };
  const runId = value("--run-id", `byteorder-codex-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-a`);
  const outputRoot = resolve(value("--output-root", "/mnt/sda2/revoy2/exemplars/upstream-lifecycle"));
  const generatorWorktree = resolve(value("--generator-worktree", ROOT));
  const sourceRevision = value("--source-revision", git(ROOT, ["rev-parse", "HEAD"]));
  const packageRoot = join(outputRoot, runId), privateRoot = join(packageRoot, "private"), publicRoot = join(packageRoot, "public");
  const workspace = join(privateRoot, "workspace"), persistence = join(workspace, ".arbor-evidence"), resultPath = join(privateRoot, "campaign-result.json"), operator = join(privateRoot, "operator-input");
  if (existsSync(packageRoot) && !process.argv.includes("--resume-setup")) throw new Error(`refusing to overwrite ${packageRoot}`);
  mkdirSync(privateRoot, { recursive: true, mode: 0o700 });
  mkdirSync(publicRoot, { recursive: true, mode: 0o700 });
  writeFileSync(join(packageRoot, ".incomplete"), "upstream lifecycle proof incomplete\n", { flag: "wx", mode: 0o600 });
  const setup = existsSync(workspace) ? { requirement_revision: git(workspace, ["rev-parse", "HEAD"]), baseline: run(VERIFY[0], VERIFY.slice(1), { cwd: workspace }) } : setupWorkspace(workspace);
  if (existsSync(resultPath)) throw new Error("campaign result already exists; use a new immutable run id");
  const command = ["bun", DRIVER, "--cwd", workspace, "--result", resultPath, "--persistence", persistence, "--language", "Rust", "--task", INITIAL_TASK, "--verify-json", JSON.stringify(VERIFY), "--integration", "codex", "--interactive-input", "--scratch", operator, "--followups-json", JSON.stringify(FOLLOWUPS)].map(quote).join(" ");
  const session = `revoy-upstream-life-${process.pid}`.slice(0, 60);
  mustRun("tmux", ["new-session", "-d", "-s", session, "-x", "240", "-y", "60", `${command}; status=$?; sleep 3; exit $status`]);
  const frames = [], inputs = [], started = Date.now();
  let sequence = 1;
  while (true) {
    const text = capturePane(session, workspace);
    if (text === null) break;
    frames.push({ at_ms: Date.now() - started, text });
    const requestPath = join(operator, `interview-request-${String(sequence).padStart(2, "0")}.json`);
    if (existsSync(requestPath)) {
      const request = JSON.parse(readFileSync(requestPath, "utf8"));
      const answer = String(request.purpose).endsWith("_confirmation") ? "yes" : "Use the committed operator-owned tests and named Cargo commands as the contract; change only the authorized library source.";
      mustRun("tmux", ["send-keys", "-t", session, "-l", answer]);
      mustRun("tmux", ["send-keys", "-t", session, "Enter"]);
      inputs.push({ sequence: request.sequence, purpose: request.purpose, question: request.question, answer, at_ms: Date.now() - started, transport: "literal tmux send-keys" });
      sequence += 1;
    }
    if (Date.now() - started > 45 * 60_000) { run("tmux", ["kill-session", "-t", session]); throw new Error("campaign exceeded 45 minutes"); }
    await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
  }
  if (!existsSync(resultPath)) throw new Error("campaign produced no result");
  const result = JSON.parse(readFileSync(resultPath, "utf8")), assessment = assessLifecycleResult(result);
  const finalAcceptance = run(VERIFY[0], VERIFY.slice(1), { cwd: workspace });
  if (finalAcceptance.exit_code !== 0) throw new Error("final independent acceptance failed");
  const durationMs = frames.at(-1)?.at_ms ?? Date.now() - started;
  const capture = { schema_version: 1, interval_ms: 1_000, duration_ms: durationMs, operator_inputs: inputs, frames };
  const capturePath = join(publicRoot, "capture.json");
  assertSecretFree(JSON.stringify(capture), "upstream lifecycle capture");
  writeFileSync(capturePath, `${JSON.stringify(capture, null, 2)}\n`, { mode: 0o600 });
  const mediaPath = join(publicRoot, "upstream-lifecycle.webm");
  renderFrames(frames, mediaPath, durationMs);
  const publicResult = { schema_version: 1, ok: true, executor: result.executor, governance_tier: result.governance_tier, ...assessment, duration_ms: durationMs, operator_inputs: inputs, initial_baseline_exit_code: setup.baseline.exit_code, final_acceptance_exit_code: finalAcceptance.exit_code };
  const resultPublicPath = join(publicRoot, "result.json");
  writeFileSync(resultPublicPath, `${JSON.stringify(publicResult, null, 2)}\n`, { mode: 0o600 });
  const upstreamPath = join(publicRoot, "upstream.json");
  writeFileSync(upstreamPath, `${JSON.stringify({ repository: UPSTREAM, revision: UPSTREAM_REVISION, requirement_revision: setup.requirement_revision, license: "Unlicense OR MIT" }, null, 2)}\n`, { mode: 0o600 });
  const trees = publishLifecycleTrees({ result_path: resultPath, persistence_directory: persistence, source_revision: sourceRevision, generator_worktree: generatorWorktree, output_directory: join(publicRoot, "campaign-cognition") });
  const privacyPath = join(publicRoot, "privacy-report.json");
  writeFileSync(privacyPath, `${JSON.stringify({ schema_version: 1, raw_provider_content_published: false, raw_workspace_published: false, public_capture: "sanitized terminal projection", secret_scan: "passed", private_root: "excluded from public manifest" }, null, 2)}\n`);
  const assets = [capturePath, mediaPath, resultPublicPath, upstreamPath, privacyPath, trees.manifest, trees.checksums];
  const sealed = writeManifestAndChecksums(publicRoot, { schema_version: 1, product: "revoy2", artifact_kind: "provider_backed_pinned_upstream_lifecycle", run_id: runId, source_revision: sourceRevision, integration: "codex", ...assessment, upstream_revision: UPSTREAM_REVISION, requirement_revision: setup.requirement_revision, duration_ms: durationMs }, assets);
  mustRun("sha256sum", ["-c", relative(publicRoot, sealed.checksums_path)], { cwd: publicRoot });
  rmSync(join(packageRoot, ".incomplete"));
  process.stdout.write(`${JSON.stringify({ ok: true, package_root: packageRoot, public_root: publicRoot, manifest: sealed.manifest_path }, null, 2)}\n`);
}

if (import.meta.main) main().catch((error) => { console.error(error); process.exitCode = 1; });
