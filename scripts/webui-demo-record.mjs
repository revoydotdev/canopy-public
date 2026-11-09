#!/usr/bin/env bun
// DEPRECATED-LANE SCRIPT (ADR-192). scripts/webui-demo-record.mjs records a provider-backed Claude Code integration
// run, so it exercises a deprecated connector lane rather than Canopy (revoy-native). It
// refuses unless the operator has set connectors.allow_deprecated: true and
// connectors.reason in an arbor.jsonc that resolves for the isolated clone (user scope
// ~/.arbor/arbor.jsonc, or a committed project arbor.jsonc). It never opts in for you.
import { spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { assertSecretFree, publicationSecretPatternCodes } from "./lib/sizzle-redaction.mjs";
import { assertDeprecatedLaneOptIn } from "./lib/deprecated-lane-optin.mjs";
import { sha256Bytes, writeManifestAndChecksums } from "./lib/sizzle-manifest.mjs";
import { assertPublicEventChain, digest, linkDependencyCache, projectEvents, publicationTextScanRequired } from "./self-hosted-demo.mjs";

const WIDTH = 1920;
const HEIGHT = 1080;
const HASH = /^sha256:[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const DEFAULT_TASK = [
  "Create scripts/lib/demo-timecode.mjs exporting formatDemoTimecode(milliseconds).",
  "It must reject non-finite or negative values and format elapsed time as HH:MM:SS.mmm.",
  "Add focused tests at scripts/tests/demo-timecode.test.mjs covering zero, sub-second, multi-hour, negative, and non-finite inputs.",
  "Only edit those two files.",
  "The acceptance command is bun vitest run scripts/tests/demo-timecode.test.mjs.",
].join(" ");
const DEFAULT_INTERVIEW_ANSWER = "Keep the implementation dependency-free, preserve the two-file scope, and use the exact authored acceptance command.";
const TERMINAL_CAMPAIGN_STATES = new Set(["completed", "failed", "halted", "cancelled", "interrupted", "converged"]);
const REQUIRED_CHAPTERS = ["workspace", "task-entry", "planning", "tree-search", "independent-review", "result-review", "evidence-seal"];

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: "utf8",
    timeout: options.timeout ?? 120_000,
    maxBuffer: 128 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && options.allow_failure !== true) throw new Error(`${command} exited ${result.status}: ${(result.stderr || result.stdout).slice(-4000)}`);
  return result;
}

function toolExists(command, args = ["--version"]) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 10_000 });
  return !result.error && result.status === 0;
}

function safePublicationRoot(path) {
  const requested = resolve(path);
  if (requested !== "/mnt/sda2" && !requested.startsWith(`/mnt/sda2${sep}`)) throw new Error("WebUI demo output must remain under /mnt/sda2");
  mkdirSync(requested, { recursive: true });
  const actual = realpathSync(requested);
  if (actual !== "/mnt/sda2" && !actual.startsWith(`/mnt/sda2${sep}`)) throw new Error("WebUI demo output resolves outside /mnt/sda2");
  return actual;
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("unable to allocate a local port"));
      const port = address.port;
      server.close((error) => error ? reject(error) : resolvePort(port));
    });
  });
}

function spawnLogged(command, args, options) {
  const stdout = openSync(options.stdout_path, "w", 0o600);
  const stderr = openSync(options.stderr_path, "w", 0o600);
  const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ["ignore", stdout, stderr] });
  child.once("exit", () => { closeSync(stdout); closeSync(stderr); });
  return child;
}

async function waitForHttp(url, child, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`process exited ${child.exitCode} before ${url} became ready`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch { /* retry */ }
    await delay(250);
  }
  throw new Error(`timed out waiting for ${url}`);
}

export function choosePageTarget(targets, targetId) {
  return targets.find((target) => target?.type === "page" && (targetId === undefined || target.id === targetId) && !String(target.url ?? "").startsWith("devtools://")) ?? null;
}

async function createPageTarget(debugPort, url) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/new?${encodeURIComponent(url)}`, { method: "PUT" });
      if (response.ok) {
        const target = await response.json();
        if (target?.id && target?.webSocketDebuggerUrl) return target;
      }
    } catch { /* retry while the browser starts */ }
    await delay(200);
  }
  throw new Error("Vivaldi did not create a dedicated WebUI page target");
}

class CdpClient {
  constructor(socket) {
    this.socket = socket;
    this.sequence = 0;
    this.pending = new Map();
    this.dialogAnswer = DEFAULT_INTERVIEW_ANSWER;
    socket.onmessage = (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id && this.pending.has(message.id)) {
        const pending = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result);
      } else if (message.method === "Page.javascriptDialogOpening") {
        void this.call("Page.handleJavaScriptDialog", { accept: true, promptText: this.dialogAnswer });
      }
    };
    socket.onclose = () => {
      const error = new Error("CDP page target closed while a browser command was pending");
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
    };
  }

  static async connect(debugPort, targetId) {
    const deadline = Date.now() + 30_000;
    let target = null;
    while (Date.now() < deadline && !target) {
      try {
        const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
        if (response.ok) target = choosePageTarget(await response.json(), targetId);
      } catch { /* retry */ }
      if (!target) await delay(200);
    }
    if (!target?.webSocketDebuggerUrl) throw new Error("Vivaldi did not expose a page CDP target");
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolveSocket, reject) => { socket.onopen = resolveSocket; socket.onerror = reject; });
    return new CdpClient(socket);
  }

  call(method, params = {}) {
    return new Promise((resolveCall, reject) => {
      if (this.socket.readyState !== WebSocket.OPEN) return reject(new Error("CDP page target is not open"));
      const id = ++this.sequence;
      this.pending.set(id, { resolve: resolveCall, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const result = await this.call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text ?? "browser evaluation failed");
    return result.result?.value;
  }

  async click(selector) {
    const point = await this.evaluate(`(() => { const element=document.querySelector(${JSON.stringify(selector)}); if(!element) return null; element.scrollIntoView({block:'center'}); const r=element.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2}; })()`);
    if (!point) return false;
    await this.call("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
    await this.call("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1 });
    await this.call("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1 });
    return true;
  }

  async type(selector, text) {
    const focused = await this.evaluate(`(() => { const element=document.querySelector(${JSON.stringify(selector)}); if(!element) return false; element.scrollIntoView({block:'center'}); element.focus(); element.value=''; return true; })()`);
    if (!focused) throw new Error(`browser input not found: ${selector}`);
    await this.call("Input.insertText", { text });
    await this.evaluate(`document.querySelector(${JSON.stringify(selector)}).dispatchEvent(new Event('input',{bubbles:true}))`);
  }

  async focus(selector) {
    return this.evaluate(`(() => { const element=document.querySelector(${JSON.stringify(selector)}); if(!element) return false; element.scrollIntoView({block:'start'}); return true; })()`);
  }

  close() {
    this.socket.close();
  }
}

async function runtimeQuery(baseUrl, kind, params = {}) {
  const response = await fetch(`${baseUrl}/api/runtime/query`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind, ...params }) });
  if (!response.ok) throw new Error(`runtime query ${kind} returned ${response.status}`);
  const body = await response.json();
  if (body.ok !== true) throw new Error(body.error?.summary ?? `runtime query ${kind} failed`);
  return body.value;
}

async function campaignList(baseUrl) {
  const response = await fetch(`${baseUrl}/api/campaigns`);
  if (!response.ok) throw new Error(`campaign list returned ${response.status}`);
  const value = await response.json();
  return Array.isArray(value) ? value : [];
}

function campaignIdOf(campaign) {
  return campaign?.id ?? campaign?.campaign_id ?? campaign?.campaignId ?? null;
}

function campaignTerminal(campaign) {
  const state = String(campaign?.state ?? campaign?.status ?? "").toLowerCase();
  return TERMINAL_CAMPAIGN_STATES.has(state) || typeof campaign?.halt_reason === "string" || campaign?.halted === true;
}

function event(path, captureStartedMs, eventKind, fields = {}) {
  const atUnixMs = Date.now();
  const record = { schema_version: 1, at_unix_ms: atUnixMs, at_ms: Math.max(0, atUnixMs - captureStartedMs), event_kind: eventKind, ...fields };
  appendFileSync(path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  return record;
}

function walkFiles(root, predicate, out = []) {
  if (!existsSync(root)) return out;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) walkFiles(path, predicate, out);
    else if (entry.isFile() && predicate(path)) out.push(path);
  }
  return out;
}

export function extractVerifiedCheck(value, campaignId) {
  const candidates = [];
  const stack = [{ item: value, campaign_match: false, verified: false }];
  while (stack.length) {
    const { item, campaign_match: inheritedCampaign, verified: inheritedVerified } = stack.pop();
    if (Array.isArray(item)) {
      for (const child of item) stack.push({ item: child, campaign_match: inheritedCampaign, verified: inheritedVerified });
      continue;
    }
    if (!item || typeof item !== "object") continue;
    const itemCampaign = item.campaign_id ?? item.campaignId;
    const campaignMatch = itemCampaign === undefined ? inheritedCampaign : itemCampaign === campaignId;
    const provenance = typeof item.provenance === "string" ? item.provenance : item.provenance?.tag;
    const verified = inheritedVerified || item.confidence === "verified" || item.verified === true || provenance === "verified";
    const exitCode = item.exit_code ?? item.exit_status;
    const command = typeof item.command === "string" ? item.command
      : Array.isArray(item.command) ? item.command.join(" ")
      : Array.isArray(item.command_argv) ? item.command_argv.join(" ")
      : Array.isArray(item.command?.argv) ? item.command.argv.join(" ")
      : null;
    if (verified && exitCode === 0 && command) candidates.push({ campaign_match: campaignMatch, provenance: "verified", command, exit_code: 0, output_sha256: digest(JSON.stringify(item)) });
    for (const child of Object.values(item)) stack.push({ item: child, campaign_match: campaignMatch, verified });
  }
  const selected = candidates.find((candidate) => candidate.campaign_match) ?? candidates[0] ?? null;
  if (!selected) return null;
  const { campaign_match: _campaignMatch, ...record } = selected;
  return record;
}

function findVerifiedCheck(persistence, campaignId) {
  for (const path of walkFiles(persistence, (candidate) => candidate.endsWith(".json") || candidate.endsWith(".jsonl"))) {
    if (!/verif|evidence|capture/i.test(path)) continue;
    const bodies = path.endsWith(".jsonl") ? readFileSync(path, "utf8").split("\n").filter(Boolean) : [readFileSync(path, "utf8")];
    for (const body of bodies) {
      try {
        const record = extractVerifiedCheck(JSON.parse(body), campaignId);
        if (record) return record;
      } catch { /* unrelated runtime record */ }
    }
  }
  return null;
}

export function frameConcat(frames) {
  if (!Array.isArray(frames) || frames.length < 2) throw new Error("at least two timestamped frames are required");
  const lines = ["ffconcat version 1.0"];
  for (let index = 0; index < frames.length - 1; index += 1) {
    const duration = Math.max(0.04, (frames[index + 1].at_ms - frames[index].at_ms) / 1000);
    lines.push(`file '${frames[index].path.replaceAll("'", "'\\''")}'`, `duration ${duration.toFixed(6)}`);
  }
  lines.push(`file '${frames.at(-1).path.replaceAll("'", "'\\''")}'`, `duration 1.000000`, `file '${frames.at(-1).path.replaceAll("'", "'\\''")}'`);
  return `${lines.join("\n")}\n`;
}

export function contactSheetGrid(sampleCount) {
  if (!Number.isSafeInteger(sampleCount) || sampleCount < 1) throw new Error("contact-sheet sample count must be a positive integer");
  const candidates = [];
  for (let columns = 1; columns <= Math.min(4, sampleCount); columns += 1) {
    const rows = Math.ceil(sampleCount / columns);
    const blanks = columns * rows - sampleCount;
    const aspectDistance = Math.abs(columns / rows - 16 / 9);
    candidates.push({ columns, rows, score: aspectDistance + blanks / sampleCount });
  }
  candidates.sort((left, right) => left.score - right.score || right.columns - left.columns);
  return { columns: candidates[0].columns, rows: candidates[0].rows };
}

export function assertWebUiDemoContract(pkg) {
  if (pkg?.artifact_kind !== "real_time_governed_webui_campaign") throw new Error("WebUI artifact kind is required");
  if (pkg?.duration_ms < 120_000) throw new Error("WebUI proof must be minutes long");
  if (pkg?.executor?.kind !== "provider_backed" || pkg.executor.integration !== "claude-code") throw new Error("provider-backed Claude Code disclosure is required");
  if (!Array.isArray(pkg.chapters) || pkg.chapters.map((chapter) => chapter.id).join("|") !== REQUIRED_CHAPTERS.join("|")) throw new Error("all ordered WebUI chapters are required");
  if (pkg.chapters.some((chapter) => chapter.timing !== "real_time" || chapter.capture_ms !== chapter.rendered_ms || !chapter.evidence_hashes?.every((hash) => HASH.test(hash)))) throw new Error("chapters must preserve real timing and cite public evidence");
  if (pkg.chapters.some((chapter) => chapter.capture_ms < 0 || chapter.capture_ms > pkg.duration_ms)) throw new Error("chapter timing must remain inside the captured duration");
  const required = ["task_typed_through_browser", "task_submitted_through_browser", "campaign_rendered", "tree_rendered", "specialist_dispatched", "critic_dispatched", "verified_result", "result_review_rendered"];
  if (required.some((claim) => pkg.empirical_checks?.[claim] !== true)) throw new Error("browser, campaign, review, and verification proof is incomplete");
  if (!pkg.privacy?.page_pixels_only || !pkg.privacy?.ocr_all_frames_passed || pkg.privacy?.findings !== 0 || !pkg.privacy?.visual_review_attested || !pkg.privacy?.visual_review_hashes?.every((hash) => HASH.test(hash))) throw new Error("page-pixel privacy review is incomplete");
  if (!HASH.test(pkg.ledger_tip) || !pkg.verification || pkg.verification.provenance !== "verified" || pkg.verification.exit_code !== 0) throw new Error("hash-chain and command verification evidence are required");
  return pkg;
}

function eventFor(events, kinds, predicate = () => true) {
  return events.find((item) => kinds.includes(item.event_kind) && predicate(item));
}

function chapter(id, source, fallbackMs = 0) {
  if (!source?.event_hash) throw new Error(`chapter ${id} has no public evidence`);
  const captureMs = Number.isFinite(source.at_ms) ? source.at_ms : fallbackMs;
  return { id, capture_ms: captureMs, rendered_ms: captureMs, timing: "real_time", evidence_hashes: [source.event_hash] };
}

function proofGallery(runId, matrix) {
  const claims = Object.entries(matrix.empirical_checks).map(([name, pass]) => `<li><strong>${pass ? "PASS" : "FAIL"}</strong>${name.replaceAll("_", " ")}</li>`).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Revoy2 governed WebUI campaign</title><style>:root{--bg:#050b0d;--panel:#0b1719;--ink:#e8f3f2;--aqua:#55c3cd;--mint:#79d6b3;--muted:#94a9a8;--line:#244044}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 74% 12%,#12343a 0,transparent 32%),linear-gradient(145deg,#030708,var(--bg));color:var(--ink);font:16px/1.55 Georgia,serif}main{width:min(1440px,92vw);margin:auto;padding:7vh 0}.eyebrow,strong{font:12px/1.2 monospace;letter-spacing:.16em;color:var(--mint)}h1{font-size:clamp(48px,7vw,112px);line-height:.92;max-width:1100px;margin:.25em 0}p{max-width:850px;color:var(--muted);font-size:20px}video{display:block;width:100%;margin:6vh 0 3vh;border:1px solid var(--line);background:#000;box-shadow:0 35px 100px #000}.grid{display:grid;grid-template-columns:1.2fr .8fr;gap:28px}.card{padding:28px;background:color-mix(in srgb,var(--panel) 92%,transparent);border:1px solid var(--line)}li{margin:.8em 0;color:var(--muted)}strong{display:inline-block;min-width:64px;margin-right:12px}a{color:var(--aqua)}img{width:100%;border:1px solid var(--line)}@media(max-width:780px){.grid{grid-template-columns:1fr}}</style></head><body><main><div class="eyebrow">EMPIRICAL WEBUI DOSSIER / ${runId}</div><h1>The governed campaign, in the browser.</h1><p>Real page pixels from a provider-backed campaign: task entry, planning, live tree search, independent review, verified result capture, and operator inspection. Every headline resolves to timestamped runtime evidence.</p><video controls preload="metadata" poster="visual-review-contact-sheet.jpg" src="proof.webm"></video><div class="grid"><div class="card"><h2>Proof claims</h2><ul>${claims}</ul></div><div class="card"><h2>Inspect</h2><p><a href="trailer.webm">75-second trailer</a><br><a href="proof-matrix.json">Proof matrix</a><br><a href="timeline.json">Timeline</a><br><a href="source/public-events.jsonl">Public event chain</a><br><a href="privacy-report.json">Privacy report</a><br><a href="manifest.json">Manifest</a><br><a href="SHA256SUMS">Checksums</a></p><img src="visual-review-contact-sheet.jpg" alt="Visual review contact sheet"></div></div></main></body></html>`;
}

async function readVisualAttestation(contactSheetPath, hash) {
  process.stdout.write(`\nVISUAL REVIEW REQUIRED\nInspect ${contactSheetPath}\nType ATTEST ${hash} to seal, or REJECT to fail closed.\n> `);
  return new Promise((resolveAttestation) => {
    let buffer = "";
    process.stdin.setEncoding("utf8");
    process.stdin.resume();
    const onData = (chunk) => {
      buffer += chunk;
      const newline = buffer.search(/[\r\n]/);
      if (newline < 0) return;
      process.stdin.off("data", onData);
      process.stdin.pause();
      resolveAttestation(buffer.slice(0, newline).trim() === `ATTEST ${hash}`);
    };
    process.stdin.on("data", onData);
  });
}

export async function recordWebUiDemo(options = {}) {
  const runId = options.run_id ?? `webui-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  if (!SAFE_ID.test(runId)) throw new Error("run_id must be publication safe");
  for (const [command, args] of [["bun", ["--version"]], ["git", ["--version"]], ["ffmpeg", ["-version"]], ["ffprobe", ["-version"]], ["vivaldi", ["--version"]], ["tesseract", ["--version"]], ["claude", ["--version"]]]) if (!toolExists(command, args)) throw new Error(`${command} is required`);
  const repo = realpathSync(resolve(options.repo_root ?? new URL("..", import.meta.url).pathname));
  if (run("git", ["status", "--porcelain"], { cwd: repo }).stdout.trim()) throw new Error("WebUI recording requires a clean source worktree");
  const auth = run("claude", ["auth", "status", "--json"], { cwd: repo, allow_failure: true });
  let authenticated = false;
  try { authenticated = JSON.parse(auth.stdout).loggedIn === true; } catch { authenticated = false; }
  if (!authenticated) throw new Error("Claude Code integration is not authenticated");

  const outputRoot = safePublicationRoot(options.output_root ?? "/mnt/sda2/revoy2/exemplars/webui");
  const output = join(outputRoot, runId);
  mkdirSync(output, { recursive: false });
  writeFileSync(join(output, ".incomplete"), "publication incomplete\n", { flag: "wx" });
  const scratch = mkdtempSync(join(tmpdir(), `revoy2-webui-${runId}-`));
  const source = join(scratch, "revoy2-source");
  const persistence = join(source, ".arbor", "publication-captures", runId);
  const framesDir = join(scratch, "frames");
  const driverEventsPath = join(scratch, "browser-actions.private.jsonl");
  const serverStdout = join(scratch, "webui.stdout.private");
  const serverStderr = join(scratch, "webui.stderr.private");
  const browserStdout = join(scratch, "vivaldi.stdout.private");
  const browserStderr = join(scratch, "vivaldi.stderr.private");
  mkdirSync(framesDir);
  let server = null;
  let browser = null;
  let cdp = null;
  try {
    run("git", ["clone", "--shared", "--no-hardlinks", repo, source], { timeout: 5 * 60_000 });
    run("git", ["switch", "-c", `demo/${runId}`], { cwd: source });
    linkDependencyCache(repo, source);
    const sourceRevision = run("git", ["rev-parse", "HEAD"], { cwd: source }).stdout.trim();
    const webPort = await freePort();
    const debugPort = await freePort();
    const baseUrl = `http://127.0.0.1:${webPort}`;
    const cli = join(repo, "packages", "arbor-mcp", "bin", "arbor-mcp.mjs");
    assertDeprecatedLaneOptIn(source, "claude-code", "scripts/webui-demo-record.mjs");
    const env = { ...process.env, ARBOR_HARNESS_INTEGRATION: "claude-code", ARBOR_PERSISTENCE_DIR: persistence, NO_COLOR: "1", FORCE_COLOR: "0" };
    server = spawnLogged("bun", [cli, "webui", String(webPort)], { cwd: source, env, stdout_path: serverStdout, stderr_path: serverStderr });
    await waitForHttp(`${baseUrl}/`, server);
    const profile = join(scratch, "vivaldi-profile");
    mkdirSync(profile);
    browser = spawnLogged("vivaldi", ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`, `--window-size=${WIDTH},${HEIGHT}`], { cwd: source, env, stdout_path: browserStdout, stderr_path: browserStderr });
    // Vivaldi's browser-shell extension performs one first-run tab reset even
    // in headless mode. Creating the evidence tab before that reset races it
    // and can close the CDP target between navigation and the first frame.
    // Let the shell settle, then create an independently-addressed page.
    await delay(4000);
    const pageTarget = await createPageTarget(debugPort, `${baseUrl}/`);
    await delay(1000);
    cdp = await CdpClient.connect(debugPort, pageTarget.id);
    await cdp.call("Page.enable");
    await cdp.call("Emulation.setDeviceMetricsOverride", { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false });
    await delay(1500);
    await cdp.evaluate("document.fonts.ready.then(()=>true)");
    const title = await cdp.evaluate("document.title");
    if (title !== "Arbor Dashboard") throw new Error(`unexpected WebUI title: ${title}`);

    const captureStartedMs = Date.now();
    const driverEvents = [];
    driverEvents.push(event(driverEventsPath, captureStartedMs, "demo.webui_ready", { executor: "claude-code", page_pixels_only: true }));
    const frames = [];
    const captureFrame = async (focus) => {
      const identity = await cdp.evaluate("({title:document.title,url:location.href})");
      if (identity?.title !== "Arbor Dashboard" || identity?.url !== `${baseUrl}/`) throw new Error(`WebUI page target drifted to ${identity?.url ?? "unknown"}`);
      if (focus) await cdp.focus(focus);
      await delay(120);
      const atMs = Date.now() - captureStartedMs;
      const path = join(framesDir, `frame-${String(frames.length).padStart(5, "0")}.png`);
      const shot = await cdp.call("Page.captureScreenshot", { format: "png", captureBeyondViewport: false, fromSurface: true });
      const bytes = Buffer.from(shot.data, "base64");
      writeFileSync(path, bytes, { mode: 0o600 });
      const state = await cdp.evaluate("({scroll_y:Math.round(scrollY),snapshot_cursor:document.getElementById('ts')?.textContent||'',tree_title:document.getElementById('tree-hero-title')?.textContent||'',result_review:!document.getElementById('result-detail')?.classList.contains('hidden')})");
      frames.push({ sequence: frames.length + 1, at_ms: atMs, path, focus, screenshot_sha256: sha256Bytes(bytes), ...state });
    };

    await captureFrame("#workspace");
    const governedTierSelected = await cdp.evaluate("(() => { const select=document.getElementById('task-composer-tier'); if(!select) return false; select.value='governed'; select.dispatchEvent(new Event('change',{bubbles:true})); return select.value==='governed'; })()");
    if (!governedTierSelected) throw new Error("WebUI governance-tier control was unavailable");
    driverEvents.push(event(driverEventsPath, captureStartedMs, "demo.webui_governed_tier_selected", { governance_tier: "governed" }));
    await cdp.type("#task-composer-input", options.task ?? DEFAULT_TASK);
    driverEvents.push(event(driverEventsPath, captureStartedMs, "demo.webui_task_typed"));
    await captureFrame("#task-composer");
    if (!await cdp.click("#task-composer-submit")) throw new Error("WebUI task submit control was unavailable");
    driverEvents.push(event(driverEventsPath, captureStartedMs, "demo.webui_task_submitted"));
    const draftAdmissionDeadline = Date.now() + 30_000;

    const deadline = captureStartedMs + Number(options.max_seconds ?? 900) * 1000;
    let campaignId = null;
    let terminalAt = null;
    let campaignOpened = false;
    let resultReviewOpened = false;
    let lastDraftSignature = "";
    while (Date.now() < deadline) {
      let drafts = [];
      try { drafts = (await runtimeQuery(baseUrl, "taskcomposer.list", { limit: 20 }))?.items ?? []; } catch { drafts = []; }
      const draft = drafts[0] ?? null;
      if (!draft && Date.now() > draftAdmissionDeadline) throw new Error("WebUI browser submission produced no canonical task draft within 30 seconds");
      const signature = draft ? `${draft.id}:${draft.revision}:${draft.status}` : "";
      if (signature && signature !== lastDraftSignature) {
        lastDraftSignature = signature;
        driverEvents.push(event(driverEventsPath, captureStartedMs, "demo.webui_draft_changed", { draft_status: String(draft.status), draft_revision: Number(draft.revision) }));
      }
      const question = draft?.proposal?.questions?.find((item) => item?.answer === null);
      if (question) {
        cdp.dialogAnswer = options.interview_answer ?? DEFAULT_INTERVIEW_ANSWER;
        if (await cdp.click('button[onclick*="answerTaskComposerQuestion"]')) driverEvents.push(event(driverEventsPath, captureStartedMs, "demo.webui_interview_answered"));
      } else if (draft?.status === "proposed") {
        if (await cdp.click('button[onclick*="confirmTaskComposerDraft"]')) driverEvents.push(event(driverEventsPath, captureStartedMs, "demo.webui_proposal_confirmed"));
      }

      const campaigns = await campaignList(baseUrl);
      const campaign = campaignId ? campaigns.find((item) => campaignIdOf(item) === campaignId) : campaigns[0];
      if (campaign && !campaignId) {
        campaignId = campaignIdOf(campaign);
        driverEvents.push(event(driverEventsPath, captureStartedMs, "demo.webui_campaign_observed", { campaign_id: campaignId }));
      }
      if (campaignId && !campaignOpened && await cdp.click("button.campaign-card")) {
        campaignOpened = true;
        driverEvents.push(event(driverEventsPath, captureStartedMs, "demo.webui_campaign_opened", { campaign_id: campaignId }));
      }
      if (campaign && campaignTerminal(campaign) && terminalAt === null) {
        terminalAt = Date.now();
        driverEvents.push(event(driverEventsPath, captureStartedMs, "demo.webui_campaign_terminal", { campaign_id: campaignId, campaign_state: String(campaign.state ?? campaign.status ?? "halted") }));
      }
      if (terminalAt !== null && !resultReviewOpened) {
        const opened = await cdp.click('button[onclick*="showResultInspection"]');
        if (opened) {
          resultReviewOpened = true;
          driverEvents.push(event(driverEventsPath, captureStartedMs, "demo.webui_result_review_opened", { campaign_id: campaignId }));
        }
      }

      const elapsed = Date.now() - captureStartedMs;
      let focus = "#task-composer";
      if (campaignId) focus = elapsed % 30_000 < 20_000 ? "#detail" : "#campaigns";
      if (resultReviewOpened) focus = elapsed % 24_000 < 16_000 ? "#result-detail" : "#results-workspace";
      await captureFrame(focus);
      if (terminalAt !== null && resultReviewOpened && elapsed >= 125_000 && Date.now() - terminalAt >= 15_000) break;
      await delay(Math.max(0, 1000 - (Date.now() - captureStartedMs - elapsed)));
    }
    let durationMs = frames.at(-1)?.at_ms ?? 0;
    if (!campaignId) throw new Error("WebUI campaign was never admitted");
    if (terminalAt === null) throw new Error("WebUI campaign did not reach a terminal state before the deadline");
    if (!resultReviewOpened) throw new Error("WebUI never rendered an inspectable result capture");
    if (durationMs < 120_000) throw new Error(`WebUI campaign lasted ${(durationMs / 1000).toFixed(1)}s; refusing to label it minutes-long`);
    driverEvents.push(event(driverEventsPath, captureStartedMs, "demo.webui_capture_completed", { campaign_id: campaignId, frame_count: frames.length }));
    await captureFrame("#result-detail");
    durationMs = frames.at(-1)?.at_ms ?? durationMs;

    cdp.close(); cdp = null;
    browser.kill("SIGTERM");
    server.kill("SIGTERM");
    await delay(1000);

    const devtoolsPath = join(persistence, "devtools", "devtools.log");
    if (!existsSync(devtoolsPath)) throw new Error("WebUI run produced no durable DevTools event stream");
    const devtoolsEvents = readFileSync(devtoolsPath, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
    const publicEvents = projectEvents({ driver_events: driverEvents, devtools_events: devtoolsEvents, safety_events: [], capture_started_ms: captureStartedMs, campaign_id: campaignId });
    assertPublicEventChain(publicEvents);
    const selected = publicEvents.filter((item) => item.campaign_id === campaignId);
    const specialist = eventFor(selected, ["loop.specialist_dispatched"]) ?? eventFor(selected, ["tree.node_changed"], (item) => item.state === "expanding");
    const critic = eventFor(selected, ["loop.critic_dispatched"]) ?? eventFor(selected, ["tree.node_changed"], (item) => item.state === "awaiting_review");
    const verified = eventFor(selected, ["loop.node_verified"]) ?? eventFor(selected, ["tree.node_changed"], (item) => item.state === "verified");
    const verification = findVerifiedCheck(persistence, campaignId);
    if (!verification) throw new Error("WebUI campaign produced no command-evidenced verified result");

    const concatPath = join(scratch, "frames.ffconcat");
    writeFileSync(concatPath, frameConcat(frames));
    const proofMp4 = join(output, "proof.mp4");
    const proofWebm = join(output, "proof.webm");
    const trailerMp4 = join(output, "trailer.mp4");
    const trailerWebm = join(output, "trailer.webm");
    const proofMp4Run = run("ffmpeg", ["-hide_banner", "-y", "-f", "concat", "-safe", "0", "-i", concatPath, "-vf", "fps=30,format=yuv420p", "-an", "-c:v", "libx264", "-preset", "slow", "-crf", "18", "-movflags", "+faststart", "-map_metadata", "-1", proofMp4], { timeout: 60 * 60_000 });
    const proofWebmRun = run("ffmpeg", ["-hide_banner", "-y", "-f", "concat", "-safe", "0", "-i", concatPath, "-vf", "fps=30,format=yuv420p", "-an", "-c:v", "libvpx-vp9", "-crf", "30", "-b:v", "0", "-row-mt", "1", "-cpu-used", "3", "-map_metadata", "-1", proofWebm], { timeout: 60 * 60_000 });
    const speed = Math.max(1, durationMs / 75_000);
    const filter = `setpts=PTS/${speed.toFixed(6)},fps=30,format=yuv420p`;
    const trailerMp4Run = run("ffmpeg", ["-hide_banner", "-y", "-i", proofMp4, "-vf", filter, "-an", "-c:v", "libx264", "-preset", "slow", "-crf", "19", "-movflags", "+faststart", "-map_metadata", "-1", trailerMp4], { timeout: 30 * 60_000 });
    const trailerWebmRun = run("ffmpeg", ["-hide_banner", "-y", "-i", proofWebm, "-vf", filter, "-an", "-c:v", "libvpx-vp9", "-crf", "31", "-b:v", "0", "-row-mt", "1", "-cpu-used", "3", "-map_metadata", "-1", trailerWebm], { timeout: 30 * 60_000 });
    assertSecretFree([proofMp4Run, proofWebmRun, trailerMp4Run, trailerWebmRun].map((result) => `${result.stdout}${result.stderr}`).join("\n"), "WebUI encoder diagnostics");
    const media = {};
    for (const [name, path, codec] of [["proof_mp4", proofMp4, "h264"], ["proof_webm", proofWebm, "vp9"], ["trailer_mp4", trailerMp4, "h264"], ["trailer_webm", trailerWebm, "vp9"]]) {
      const probe = JSON.parse(run("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_name,codec_type,width,height", "-of", "json", path]).stdout);
      const video = probe.streams?.find((stream) => stream.codec_type === "video");
      if (!video || video.codec_name !== codec || video.width !== WIDTH || video.height !== HEIGHT) throw new Error(`${basename(path)} failed media verification`);
      media[name] = probe;
    }

    let ocrText = "";
    for (const frame of frames) {
      const result = run("tesseract", [frame.path, "stdout", "--psm", "6"], { timeout: 30_000, allow_failure: true });
      if (result.status !== 0) throw new Error(`OCR failed for frame ${frame.sequence}`);
      ocrText += `${result.stdout}\n`;
    }
    assertSecretFree(ocrText, "OCR text from every WebUI frame");
    const contactSheet = join(output, "visual-review-contact-sheet.jpg");
    const contactSheetSamples = Math.max(1, Math.floor(durationMs / 30_000) + 1);
    const contactGrid = contactSheetGrid(contactSheetSamples);
    run("ffmpeg", ["-hide_banner", "-y", "-i", proofMp4, "-vf", `fps=1/30,scale=480:-1,tile=${contactGrid.columns}x${contactGrid.rows}:padding=4:margin=4`, "-frames:v", "1", "-q:v", "2", "-map_metadata", "-1", contactSheet], { timeout: 10 * 60_000 });
    const visualHash = digest(readFileSync(contactSheet));
    const attested = options.review_attestor ? await options.review_attestor(contactSheet, visualHash) : await readVisualAttestation(contactSheet, visualHash);
    if (!attested) throw new Error("operator rejected or did not attest the WebUI visual review contact sheet");

    const sourceDir = join(output, "source");
    const captureDir = join(output, "capture");
    const logsDir = join(output, "logs");
    mkdirSync(sourceDir); mkdirSync(captureDir); mkdirSync(logsDir);
    const publicEventsPath = join(sourceDir, "public-events.jsonl");
    const verificationPath = join(sourceDir, "verification-summary.json");
    const runtimePath = join(sourceDir, "runtime-projection.json");
    const browserActionsPath = join(sourceDir, "browser-actions.jsonl");
    const capturePath = join(captureDir, "browser-capture-index.json");
    const privacyPath = join(output, "privacy-report.json");
    const reviewPath = join(output, "visual-review-attestation.json");
    const timelinePath = join(output, "timeline.json");
    const chaptersPath = join(output, "chapters.json");
    writeFileSync(publicEventsPath, `${publicEvents.map((item) => JSON.stringify(item)).join("\n")}\n`);
    writeFileSync(verificationPath, `${JSON.stringify(verification, null, 2)}\n`);
    writeFileSync(runtimePath, `${JSON.stringify({ schema_version: 1, run_id: runId, campaign_id: campaignId, source_revision: sourceRevision, executor: { kind: "provider_backed", integration: "claude-code", disclosure: "Claude Code first-party subscription integration; account identity and provider content withheld" } }, null, 2)}\n`);
    writeFileSync(browserActionsPath, readFileSync(driverEventsPath));
    writeFileSync(capturePath, `${JSON.stringify({ schema_version: 1, width: WIDTH, height: HEIGHT, page_pixels_only: true, frames: frames.map(({ path: _path, ...frame }) => frame) }, null, 2)}\n`);
    const privacy = { schema_version: 1, page_pixels_only: true, arbitrary_desktop_pixels_captured: false, ocr_all_frames_passed: true, ocr_frames_scanned: frames.length, findings: 0, provider_content_published: false, visual_review_attested: true, visual_review_hashes: [visualHash], secret_pattern_codes: publicationSecretPatternCodes };
    writeFileSync(privacyPath, `${JSON.stringify(privacy, null, 2)}\n`);
    writeFileSync(reviewPath, `${JSON.stringify({ schema_version: 1, method: "operator stdin attestation after contact-sheet inspection", contact_sheet_sha256: visualHash, attested: true }, null, 2)}\n`);
    writeFileSync(timelinePath, `${JSON.stringify({ schema_version: 1, run_id: runId, duration_ms: durationMs, events: publicEvents.map((item) => ({ at_ms: item.at_ms, event_kind: item.event_kind, event_hash: item.event_hash })) }, null, 2)}\n`);

    const workspaceEvent = eventFor(publicEvents, ["demo.webui_ready"]);
    const taskEvent = eventFor(publicEvents, ["demo.webui_task_typed"]);
    const planningEvent = eventFor(publicEvents, ["demo.webui_draft_changed"]);
    const campaignEvent = eventFor(publicEvents, ["demo.webui_campaign_opened"]);
    const resultEvent = eventFor(publicEvents, ["demo.webui_result_review_opened"]);
    const sealEvent = eventFor(publicEvents, ["demo.webui_capture_completed"]);
    const chapters = [chapter("workspace", workspaceEvent), chapter("task-entry", taskEvent), chapter("planning", planningEvent), chapter("tree-search", specialist ?? campaignEvent), chapter("independent-review", critic), chapter("result-review", resultEvent), chapter("evidence-seal", sealEvent)];
    for (let index = 1; index < chapters.length; index += 1) if (chapters[index].capture_ms < chapters[index - 1].capture_ms) chapters[index].capture_ms = chapters[index].rendered_ms = chapters[index - 1].capture_ms;
    writeFileSync(chaptersPath, `${JSON.stringify({ schema_version: 1, run_id: runId, chapters }, null, 2)}\n`);
    const empiricalChecks = {
      task_typed_through_browser: taskEvent !== undefined,
      task_submitted_through_browser: eventFor(publicEvents, ["demo.webui_task_submitted"]) !== undefined,
      campaign_rendered: campaignEvent !== undefined,
      tree_rendered: specialist !== undefined,
      specialist_dispatched: specialist !== undefined,
      critic_dispatched: critic !== undefined,
      verified_result: verified !== undefined && verification.provenance === "verified",
      result_review_rendered: resultEvent !== undefined,
    };
    const matrix = { schema_version: 1, artifact_kind: "real_time_governed_webui_campaign", run_id: runId, campaign_id: campaignId, source_revision: sourceRevision, duration_ms: durationMs, executor: { kind: "provider_backed", integration: "claude-code", disclosure: "Claude Code first-party subscription integration; account identity and provider content withheld" }, chapters, empirical_checks: empiricalChecks, verification, privacy, ledger_tip: publicEvents.at(-1)?.event_hash };
    assertWebUiDemoContract(matrix);
    const matrixPath = join(output, "proof-matrix.json");
    const galleryPath = join(output, "index.html");
    writeFileSync(matrixPath, `${JSON.stringify(matrix, null, 2)}\n`);
    writeFileSync(galleryPath, proofGallery(runId, matrix));
    writeFileSync(join(logsDir, "encoder-proof.log"), `${proofMp4Run.stderr}\n${proofWebmRun.stderr}`);
    writeFileSync(join(logsDir, "encoder-trailer.log"), `${trailerMp4Run.stderr}\n${trailerWebmRun.stderr}`);
    const publicFiles = [proofMp4, proofWebm, trailerMp4, trailerWebm, contactSheet, galleryPath, matrixPath, privacyPath, reviewPath, timelinePath, chaptersPath, publicEventsPath, verificationPath, runtimePath, browserActionsPath, capturePath, join(logsDir, "encoder-proof.log"), join(logsDir, "encoder-trailer.log")];
    for (const path of publicFiles.filter(publicationTextScanRequired)) assertSecretFree(readFileSync(path, "utf8"), relative(output, path));
    const sealed = writeManifestAndChecksums(output, { schema_version: 1, product: "revoy2", artifact_kind: matrix.artifact_kind, run_id: runId, generated_at: new Date().toISOString(), source_revision: sourceRevision, campaign_id: campaignId, duration_ms: durationMs, executor: matrix.executor, empirical_checks: empiricalChecks, privacy, ledger_tip: matrix.ledger_tip, media }, publicFiles);
    rmSync(join(output, ".incomplete"));
    return { run_directory: output, proof_webm: proofWebm, proof_mp4: proofMp4, trailer_webm: trailerWebm, trailer_mp4: trailerMp4, gallery: galleryPath, contact_sheet: contactSheet, manifest: sealed.manifest_path, checksums: sealed.checksums_path, duration_ms: durationMs, campaign_id: campaignId };
  } catch (error) {
    writeFileSync(join(output, "failure.txt"), "WebUI publication failed closed; private diagnostics remain outside the publication directory.\n");
    throw error;
  } finally {
    try { cdp?.close(); } catch { /* already closed */ }
    if (browser && browser.exitCode === null) browser.kill("SIGTERM");
    if (server && server.exitCode === null) server.kill("SIGTERM");
    if (options.keep_private_scratch !== true) rmSync(scratch, { recursive: true, force: true });
  }
}

function parseArgs(argv) {
  const value = (name, fallback) => { const index = argv.indexOf(name); return index < 0 ? fallback : argv[index + 1]; };
  return { run_id: value("--run-id"), output_root: value("--output-root"), repo_root: value("--repo-root"), task: value("--task"), interview_answer: value("--interview-answer"), max_seconds: Number(value("--max-seconds", "900")), keep_private_scratch: argv.includes("--keep-private-scratch") };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  recordWebUiDemo(parseArgs(process.argv.slice(2))).then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)).catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
}
