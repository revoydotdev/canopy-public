import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const value = (name) => { const at = args.indexOf(name); return at < 0 ? null : args[at + 1] ?? null; };
const cwd = resolve(value("--cwd") ?? ".");
const persistence = resolve(value("--persistence") ?? join(cwd, ".arbor-evidence"));
const repo = resolve(value("--repo") ?? process.cwd());
const marker = resolve(value("--marker") ?? join(cwd, ".specialist-dispatched"));
const resumeMarker = resolve(value("--resume-marker") ?? join(cwd, ".resume-enabled"));
const cli = join(repo, "packages/arbor-mcp/src/cli.ts");
const env = { ...process.env, ARBOR_PERSISTENCE_DIR: persistence };

function run(commandArgs, { echo = false } = {}) {
  const result = spawnSync("bun", [cli, ...commandArgs], { cwd, env, encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
  if (echo) { process.stdout.write(result.stdout ?? ""); process.stderr.write(result.stderr ?? ""); }
  return { exit_code: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function requireSuccess(label, result) {
  if (result.exit_code === 0) return;
  const diagnostic = [result.stderr, result.stdout].map((text) => text.trim()).filter(Boolean).join("\n");
  throw new Error(`${label} failed (exit ${result.exit_code})${diagnostic ? `:\n${diagnostic}` : ""}`);
}

process.on("uncaughtException", (error) => {
  process.stderr.write(`\nFLIGHT FAILED\n${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2_500);
  process.exit(1);
});

function findDraft(input) {
  if (Array.isArray(input)) { for (const item of input) { const found = findDraft(item); if (found) return found; } return null; }
  if (typeof input !== "object" || input === null) return null;
  if (typeof input.id === "string" && Number.isSafeInteger(input.revision) && ["proposed", "ready", "awaiting_answers"].includes(input.status)) return input;
  for (const item of Object.values(input)) { const found = findDraft(item); if (found) return found; }
  return null;
}

function parseJson(text) { try { return JSON.parse(text); } catch { return null; } }
function sleep(ms) { return new Promise((resolveWait) => setTimeout(resolveWait, ms)); }

process.stdout.write("REVOY2 / HARD-CRASH CONTINUATION FLIGHT\n\n");
process.stdout.write("1  PLAN        admit one bounded repository change\n");
const planned = run(["task", "Create result.txt containing exactly: recovered safely", "--tier", "governed", "--plan", "--json", "--progress"]);
requireSuccess("task planning", planned);
const draft = findDraft(parseJson(planned.stdout));
if (!draft) throw new Error("task planner returned no ready draft");
process.stdout.write(`   draft ${draft.id} admitted at revision ${draft.revision}\n`);

process.stdout.write("\n2  DISPATCH    start governed campaign in a separate process\n");
const child = spawn("bun", [cli, "task", "confirm", draft.id, String(draft.revision), "--wait", "--json", "--progress"], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
let childStdout = "";
child.stdout.on("data", (chunk) => { const text = String(chunk); childStdout += text; process.stdout.write(text); });
child.stderr.on("data", (chunk) => process.stderr.write(String(chunk)));
const deadline = Date.now() + 120_000;
while (!existsSync(marker) && Date.now() < deadline) await sleep(250);
if (!existsSync(marker)) { child.kill("SIGKILL"); throw new Error("specialist dispatch was not observed before timeout"); }

process.stdout.write("\n3  HARD CRASH  SIGKILL while provider operation is dispatched\n");
child.kill("SIGKILL");
await new Promise((resolveExit) => child.once("close", resolveExit));
await sleep(800);
const journal = join(persistence, "harness-sessions.ndjson");
if (!existsSync(journal) || !readFileSync(journal, "utf8").includes('"operation":"specialize"')) throw new Error("durable specialist checkpoint was not retained");
process.stdout.write("   process gone; durable tree, journal, replay capsule, and operation checkpoints remain\n");

process.stdout.write("\n4  PREVIEW     new process discovers orphan without mutation\n");
const preview = run(["resume", "--preview", "--json"]);
requireSuccess("resume preview", preview);
const previewJson = parseJson(preview.stdout);
if (previewJson?.status !== "preview") throw new Error(`unexpected preview status: ${previewJson?.status ?? "invalid"}`);
const requirements = Array.isArray(previewJson.required_dispositions) ? previewJson.required_dispositions : [];
process.stdout.write(`   checkpoint ${previewJson.candidate.checkpoint}; ${requirements.length} explicit effect decision(s) required\n`);

process.stdout.write("\n5  DECIDE      local endpoint confirms no external effect; operator authorizes retry\n");
const dispositions = requirements.flatMap((item) => typeof item?.operation_id === "string" ? ["--disposition", `${item.operation_id}=retry`] : []);
writeFileSync(resumeMarker, "resume\n");
const resumed = run(["resume", ...dispositions, "--reason", "local reference endpoint observed the killed request had no external effect", "--json"]);
requireSuccess("governed continuation", resumed);
const resumedJson = parseJson(resumed.stdout);
if (resumedJson?.status !== "continued") throw new Error(`unexpected continuation status: ${resumedJson?.status ?? "invalid"}`);

process.stdout.write("\n6  ADOPT       apply independently verified work through the result boundary\n");
const adopted = run(["adopt", "--campaign", resumedJson.candidate.campaign_id, "--apply", "--json"]);
requireSuccess("result adoption", adopted);
if (readFileSync(join(cwd, "result.txt"), "utf8").trim() !== "recovered safely") throw new Error("adopted result failed independent acceptance");
process.stdout.write("\nVERIFIED: hard crash -> durable reconciliation -> fresh authority -> continued session -> adopted result\n");
writeFileSync(join(cwd, "flight-result.json"), `${JSON.stringify({ schema_version: 1, ok: true, draft_id: draft.id, preview: previewJson, continuation: resumedJson, campaign_stdout_tail: childStdout.slice(-2_000), adopted: parseJson(adopted.stdout) }, null, 2)}\n`);
