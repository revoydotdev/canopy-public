import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const REPO = resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const arg = (name, fallback) => { const at = args.indexOf(name); return at < 0 ? fallback : args[at + 1] ?? fallback; };
const runId = arg("--run-id", `restart-resume-${new Date().toISOString().replaceAll(/[-:.TZ]/g, "").slice(0, 14)}`);
const outputRoot = resolve(arg("--output-root", "/mnt/sda2/revoy2/exemplars/restart-resume"));
const packageRoot = join(outputRoot, runId);
if (existsSync(packageRoot)) throw new Error(`refusing to overwrite ${packageRoot}`);
const workspace = join(packageRoot, "workspace"); const persistence = join(workspace, ".arbor-evidence");
const marker = join(workspace, ".specialist-dispatched"); const resumeMarker = join(workspace, ".resume-enabled");
mkdirSync(workspace, { recursive: true });

function command(bin, commandArgs, cwd = REPO) {
  const result = spawnSync(bin, commandArgs, { cwd, encoding: "utf8", maxBuffer: 30 * 1024 * 1024 });
  if ((result.status ?? 1) !== 0) throw new Error(`${bin} ${commandArgs.join(" ")} failed:\n${result.stdout}\n${result.stderr}`);
  return result.stdout ?? "";
}
function quote(value) { return `'${String(value).replaceAll("'", `'\\''`)}'`; }
function escapeXml(value) { return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;"); }
function sha(path) { return createHash("sha256").update(readFileSync(path)).digest("hex"); }
function sse(res, content) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  res.end(`data: ${JSON.stringify({ model: "revoy-reference-model", system_fingerprint: "revoy-reference-v1", choices: [{ delta: content } ] })}\n\ndata: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 80, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 0 } } })}\n\ndata: [DONE]\n\n`);
}
const action = { description: "Create result.txt containing exactly: recovered safely", estimated_gain: 8, estimated_cost: 2, category: "code", delegate_to: "seed", constraints: ["write only result.txt"], execution_role: null, skill_id: null, skill_version: null, high_risk_tool_scope: { write_paths: ["result.txt"], command_argv: [] }, decomposition_depth: null };
const plan = { summary: "Create one bounded recovery proof artifact", assumptions: [], questions: [], root_action: action, actions: [action], acceptance_checks: ["result.txt contains exactly recovered safely"], risk_notes: ["process interruption is intentional"] };
const checks = ["root_cause", "measurement_validation", "guardrail_enforcement", "introspection", "stability_monitoring"].map((name) => ({ name, passed: true, detail: "independent bounded evidence passed" }));
const verdict = { approved: true, rationale: "The isolated result matches the authored scope and machine verification.", root_cause: null, measurement_validated: true, guardrails_enforced: true, introspection_passed: true, stability_ok: true, checks, confidence: 0.99 };

let specialistCallsAfterResume = 0;
const server = createServer(async (req, res) => {
  let raw = ""; for await (const chunk of req) raw += String(chunk);
  let body = {}; try { body = JSON.parse(raw); } catch {}
  const schema = body?.response_format?.json_schema?.name;
  if (schema === "revoy_native_task_plan") return sse(res, { content: JSON.stringify(plan) });
  if (schema === "revoy_native_critic_verdict") return sse(res, { content: JSON.stringify(verdict) });
  if (!existsSync(resumeMarker)) {
    writeFileSync(marker, "provider operation dispatched\n");
    req.once("close", () => { if (!res.writableEnded) res.destroy(); });
    return;
  }
  specialistCallsAfterResume += 1;
  if (specialistCallsAfterResume === 1) return sse(res, { tool_calls: [{ index: 0, id: "write-result", function: { name: "file.write", arguments: JSON.stringify({ path: "result.txt", content: "recovered safely\n", create: true }) } }] });
  return sse(res, { content: "Implemented the bounded result and retained the crash-continuation lineage." });
});
await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
const address = server.address(); if (typeof address !== "object" || address === null) throw new Error("reference endpoint failed to bind");

writeFileSync(join(workspace, "README.md"), "# Restart-resume flight fixture\n\nThis repository intentionally loses its worker process during a governed file write campaign.\n");
writeFileSync(join(workspace, ".gitignore"), ".arbor/\n.arbor-evidence/\n.specialist-dispatched\n.resume-enabled\nflight-result.json\n");
writeFileSync(join(workspace, "arbor.jsonc"), `${JSON.stringify({ schema_version: 1, native: { mode: "native", adapter_id: "openai-compatible", provider_id: "revoy-reference", base_url: `http://127.0.0.1:${address.port}`, model: "revoy-reference-model", revision: "revoy-reference-v1" }, kb: { backend: "jsonl" } }, null, 2)}\n`);
command("git", ["init", "-q"], workspace); command("git", ["config", "user.email", "evidence@revoy.dev"], workspace); command("git", ["config", "user.name", "Revoy Evidence"], workspace); command("git", ["add", "."], workspace); command("git", ["commit", "-qm", "fixture: restart-resume baseline"], workspace);

const session = `revoy-restart-${process.pid}`;
const worker = join(REPO, "scripts/restart-resume-flight-worker.mjs");
const shell = `env ARBOR_NATIVE_API_KEY=reference-only ARBOR_PERSISTENCE_DIR=${quote(persistence)} bun ${quote(worker)} --cwd ${quote(workspace)} --persistence ${quote(persistence)} --repo ${quote(REPO)} --marker ${quote(marker)} --resume-marker ${quote(resumeMarker)}; status=$?; sleep 3; exit $status`;
command("tmux", ["new-session", "-d", "-s", session, "-x", "220", "-y", "58", shell]);
const frames = []; const started = Date.now(); let workerExit = 0;
while (true) {
  const capture = spawnSync("tmux", ["capture-pane", "-p", "-t", session, "-S", "-200"], { encoding: "utf8" });
  if (capture.status !== 0) { workerExit = Number(spawnSync("tmux", ["has-session", "-t", session]).status ?? 1); break; }
  frames.push({ at_ms: Date.now() - started, text: String(capture.stdout).replaceAll(/\x1b\[[0-9;?]*[A-Za-z]/g, "").trimEnd() });
  if (Date.now() - started > 15 * 60_000) { spawnSync("tmux", ["kill-session", "-t", session]); throw new Error("restart-resume flight exceeded 15 minutes"); }
  await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
}
await new Promise((resolveClose) => server.close(resolveClose));
if (!existsSync(join(workspace, "flight-result.json")) || !existsSync(join(workspace, "result.txt"))) {
  writeFileSync(join(packageRoot, "failed-capture.json"), `${JSON.stringify({ schema_version: 1, worker_exit: workerExit, duration_ms: frames.at(-1)?.at_ms ?? 0, frames }, null, 2)}\n`);
  throw new Error(`restart-resume worker failed (${workerExit}); retained ${join(packageRoot, "failed-capture.json")}`);
}

const frameDir = mkdtempSync(join(tmpdir(), "revoy-restart-frames-"));
try {
  frames.forEach((frame, index) => {
    const lines = frame.text.split("\n").slice(-44).map((line) => line.slice(0, 154));
    const text = lines.map((line, row) => `<text x="86" y="${154 + row * 19}" fill="${line.startsWith("VERIFIED") ? "#b7f397" : line.match(/^\d  /) ? "#72d6bd" : "#d8e8e1"}" font-family="monospace" font-size="14">${escapeXml(line)}</text>`).join("");
    const progress = Math.max(1, Math.round(1748 * frame.at_ms / Math.max(1, frames.at(-1)?.at_ms ?? 1)));
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080"><defs><radialGradient id="g"><stop stop-color="#173a33"/><stop offset="1" stop-color="#030706"/></radialGradient><filter id="glow"><feGaussianBlur stdDeviation="7"/></filter></defs><rect width="1920" height="1080" fill="#030706"/><ellipse cx="1450" cy="90" rx="800" ry="500" fill="url(#g)" opacity=".7"/><text x="86" y="70" fill="#eef7f2" font-family="Georgia" font-size="34" letter-spacing="7">REVOY2</text><text x="86" y="105" fill="#72d6bd" font-family="monospace" font-size="13" letter-spacing="3">HARD-CRASH CONTINUATION / REAL PROCESS BOUNDARY</text><line x1="86" y1="126" x2="1834" y2="126" stroke="#24463d"/>${text}<rect x="86" y="1034" width="1748" height="2" fill="#173129"/><rect x="86" y="1034" width="${progress}" height="2" fill="#72d6bd"/></svg>`;
    writeFileSync(join(frameDir, `frame-${String(index).padStart(6, "0")}.svg`), svg);
  });
  const media = join(packageRoot, "restart-resume.webm");
  command("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-framerate", "1", "-i", join(frameDir, "frame-%06d.svg"), "-c:v", "libvpx-vp9", "-deadline", "realtime", "-cpu-used", "8", "-row-mt", "1", "-threads", "8", "-crf", "32", "-b:v", "0", "-pix_fmt", "yuv420p", "-r", "30", media]);
} finally { rmSync(frameDir, { recursive: true, force: true }); }

const durationMs = frames.at(-1)?.at_ms ?? 0;
const result = JSON.parse(readFileSync(join(workspace, "flight-result.json"), "utf8"));
const manifest = { schema_version: 1, run_id: runId, kind: "real_process_restart_resume", disclosure: "Deterministic local OpenAI-compatible reference endpoint; this proves harness lifecycle semantics, not hosted-provider quality.", duration_ms: durationMs, source_revision: command("git", ["rev-parse", "HEAD"], REPO).trim(), campaign_id: result.continuation.candidate.campaign_id, source_session_id: result.continuation.candidate.session_id, continuation_session_id: result.continuation.continuation_session_id, hard_crash: "SIGKILL during dispatched provider operation", reconciliation: "operator-triggered durable interruption", explicit_dispositions: result.preview.required_dispositions, final_acceptance: "result.txt exact-content check passed", media: "restart-resume.webm" };
writeFileSync(join(packageRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
writeFileSync(join(packageRoot, "capture.json"), `${JSON.stringify({ schema_version: 1, interval_ms: 1000, duration_ms: durationMs, frames }, null, 2)}\n`);
writeFileSync(join(packageRoot, "index.html"), `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Revoy2 restart flight</title><style>:root{--ink:#030706;--paper:#eaf3ee;--mint:#72d6bd;--line:#24463d}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 80% 0,#173a33,transparent 42%),var(--ink);color:var(--paper);font:17px/1.55 Georgia,serif}main{width:min(1200px,90vw);margin:auto;padding:8vh 0}.k{color:var(--mint);font:700 12px monospace;letter-spacing:.2em}h1{font-size:clamp(48px,8vw,100px);line-height:.9;max-width:10ch;margin:.25em 0}p{max-width:65ch;color:#aac0b7}video{width:100%;margin:3rem 0 1rem;border:1px solid var(--line);background:#000}dl{display:grid;grid-template-columns:14rem 1fr;border-top:1px solid var(--line)}dt,dd{padding:.8rem 0;border-bottom:1px solid var(--line);margin:0}dt{color:var(--mint);font:12px monospace;letter-spacing:.12em}dd{overflow-wrap:anywhere}@media(max-width:650px){dl{grid-template-columns:1fr}dd{padding-top:0}}</style></head><body><main><div class="k">EMPIRICAL LIFECYCLE PROOF</div><h1>Work survives the worker.</h1><p>A real campaign process is killed during provider dispatch. A new process discovers the durable checkpoint, refuses to guess about an indeterminate effect, records the operator decision, recomposes authority, continues under a new session identity, verifies, and adopts the result.</p><video controls preload="metadata" src="restart-resume.webm"></video><dl><dt>PROCESS BOUNDARY</dt><dd>SIGKILL</dd><dt>SOURCE SESSION</dt><dd>${manifest.source_session_id}</dd><dt>CONTINUATION</dt><dd>${manifest.continuation_session_id}</dd><dt>OUTCOME</dt><dd>independently accepted and adopted</dd><dt>DISCLOSURE</dt><dd>${manifest.disclosure}</dd></dl></main></body></html>`);
const assets = ["capture.json", "index.html", "manifest.json", "restart-resume.webm"].map((name) => join(packageRoot, name));
writeFileSync(join(packageRoot, "SHA256SUMS"), `${assets.map((path) => `${sha(path)}  ${relative(packageRoot, path)}`).join("\n")}\n`);
process.stdout.write(`${JSON.stringify({ ok: true, package_root: packageRoot, duration_ms: durationMs, frames: frames.length, manifest }, null, 2)}\n`);
