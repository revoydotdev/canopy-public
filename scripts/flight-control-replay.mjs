#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { assertSecretFree, readSecretFreeTextFile } from "./lib/sizzle-redaction.mjs";

export const FLIGHT_STAGES = Object.freeze([
  ["topology", "FLIGHT CONTROL", "Two repositories. Two orchestrators. Named agents online."],
  ["parent_child", "COMMAND / ACK", "Orchestrator and agent exchange a durably acknowledged message."],
  ["sibling", "PEER QUERY", "One specialist queries another without bypassing the orchestrator's authority."],
  ["cross_repo", "CROSS-REPO LINK", "Concurrent revoy2 sessions route a request and reply across repository boundaries."],
  ["collision", "COLLISION DETECTED", "Simultaneous lease attempts produce exactly one winner and one explicit denial."],
  ["scope_denial", "BOUNDARY HELD", "An out-of-scope write is denied before repository mutation."],
  ["cancellation", "CANCEL / REAP", "Cancellation is acknowledged and the child process is terminated."],
  ["recovery", "CRASH RECOVERY", "Restart detects the stale lease and recovers or quarantines it explicitly."],
  ["retry", "SAFE RETRY", "A fresh, isolated retry succeeds exactly once."],
  ["integrity", "PROOF SEALED", "Repository hashes, clean status, and the causal ledger close the run."],
]);

const STAGE_INDEX = new Map(FLIGHT_STAGES.map(([id], index) => [id, index]));
const KIND_STAGE = Object.freeze({
  "topology.online": "topology",
  "message.sent": "parent_child",
  "message.acknowledged": "parent_child",
  "peer.query": "sibling",
  "peer.reply": "sibling",
  "cross_repo.sent": "cross_repo",
  "cross_repo.received": "cross_repo",
  "lease.attempt": "collision",
  "lease.acquired": "collision",
  "lease.denied": "collision",
  "scope.write_denied": "scope_denial",
  "agent.cancel_requested": "cancellation",
  "agent.terminated": "cancellation",
  "session.crashed": "recovery",
  "lease.stale_detected": "recovery",
  "lease.recovered": "recovery",
  "lease.quarantined": "recovery",
  "retry.started": "retry",
  "retry.succeeded": "retry",
  "integrity.repo_clean": "integrity",
  "integrity.ledger_verified": "integrity",
});
const EVENT_KEYS = new Set([
  "schema_version", "sequence", "event_id", "run_id", "timestamp", "stage", "kind", "status", "caption", "detail",
  "source_repo_id", "target_repo_id", "actor_id", "actor_role", "target_id", "target_role", "correlation_id", "resource_id",
  "previous_hash", "hash",
]);
const REQUIRED_KEYS = ["schema_version", "sequence", "event_id", "run_id", "timestamp", "stage", "kind", "status", "caption", "source_repo_id", "actor_id", "actor_role", "previous_hash", "hash"];
const ATOM = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,95}$/;
const HASH = /^sha256:[a-f0-9]{64}$/;
const STATUSES = new Set(["info", "working", "pass", "denied", "recovered", "quarantined", "failed"]);
const ROLES = new Set(["orchestrator", "agent", "system", "repository"]);
const REQUIRED_KIND_STATUS = Object.freeze({
  "topology.online": "pass",
  "lease.acquired": "pass",
  "lease.denied": "denied",
  "scope.write_denied": "denied",
  "agent.terminated": "pass",
  "session.crashed": "failed",
  "lease.recovered": "recovered",
  "lease.quarantined": "quarantined",
  "retry.succeeded": "pass",
  "integrity.repo_clean": "pass",
  "integrity.ledger_verified": "pass",
});

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}

export function computeFlightEventHash(event) {
  const { hash: _hash, ...unsigned } = event;
  return `sha256:${createHash("sha256").update(JSON.stringify(canonical(unsigned))).digest("hex")}`;
}

function fail(message, sequence = null) {
  throw new Error(`${sequence === null ? "flight event" : `flight event ${sequence}`}: ${message}`);
}

function assertAtom(value, field, sequence, optional = false) {
  if (optional && value === undefined) return;
  if (typeof value !== "string" || !ATOM.test(value)) fail(`${field} must be a bounded public identifier`, sequence);
}

function count(events, kind) { return events.filter((event) => event.kind === kind).length; }
function paired(events, first, second, predicate) {
  const left = events.filter((event) => event.kind === first && event.correlation_id);
  return left.some((event) => events.some((candidate) => candidate.kind === second && candidate.correlation_id === event.correlation_id && predicate(event, candidate)));
}

function oppositeActors(left, right) {
  return Boolean(left.target_id && right.target_id && left.actor_id === right.target_id && left.target_id === right.actor_id);
}

export function assertCompleteFlightProof(events) {
  for (const [stage] of FLIGHT_STAGES) if (!events.some((event) => event.stage === stage)) fail(`complete proof is missing stage ${stage}`);
  const repositories = new Set(events.filter((event) => event.kind === "topology.online").map((event) => event.source_repo_id));
  const orchestrators = new Set(events.filter((event) => event.kind === "topology.online" && event.actor_role === "orchestrator").map((event) => event.actor_id));
  if (repositories.size < 2 || orchestrators.size < 2) fail("topology must prove at least two repositories and two orchestrators");
  if (!paired(events, "message.sent", "message.acknowledged", (sent, ack) => oppositeActors(sent, ack)
    && sent.source_repo_id === ack.source_repo_id)) fail("parent/child acknowledgement must share a correlation_id and reverse its actor endpoints");
  if (!paired(events, "peer.query", "peer.reply", (query, reply) => oppositeActors(query, reply))) fail("peer query/reply must share a correlation_id and reverse its actor endpoints");
  if (!paired(events, "cross_repo.sent", "cross_repo.received", (sent, received) => oppositeActors(sent, received)
    && Boolean(sent.target_repo_id && received.target_repo_id)
    && sent.source_repo_id !== sent.target_repo_id
    && sent.source_repo_id === received.target_repo_id
    && sent.target_repo_id === received.source_repo_id)) fail("cross-repo request/reply must share a correlation_id and reverse distinct repository and actor endpoints");
  if (!paired(events, "agent.cancel_requested", "agent.terminated", (request, terminated) => Boolean(request.target_id)
    && request.target_id === (terminated.target_id ?? terminated.actor_id)
    && request.source_repo_id === terminated.source_repo_id)) fail("cancellation and termination must share a correlation_id and identify the same agent endpoint");
  const collision = events.filter((event) => event.stage === "collision" && event.resource_id);
  const resources = new Set(collision.map((event) => event.resource_id));
  if (![...resources].some((resource) => count(collision.filter((event) => event.resource_id === resource), "lease.acquired") === 1 && count(collision.filter((event) => event.resource_id === resource), "lease.denied") >= 1)) fail("collision must show exactly one acquisition and at least one denial for one resource");
  if (count(events, "scope.write_denied") < 1) fail("scope denial is missing");
  if (count(events, "session.crashed") < 1 || count(events, "lease.stale_detected") < 1 || count(events, "lease.recovered") + count(events, "lease.quarantined") < 1) fail("crash recovery evidence is incomplete");
  if (count(events, "retry.succeeded") !== 1) fail("proof must contain exactly one successful retry");
  const cleanRepos = new Set(events.filter((event) => event.kind === "integrity.repo_clean" && event.status === "pass").map((event) => event.source_repo_id));
  if (cleanRepos.size < 2 || count(events, "integrity.ledger_verified") < 1) fail("final integrity must prove two clean repositories and one verified ledger");
}

export function validateFlightEvents(events, options = {}) {
  if (!Array.isArray(events) || events.length === 0) fail("ledger must contain events");
  if (events.length > 500) fail("ledger exceeds the 500-event publication bound");
  const ids = new Set();
  let priorHash = null;
  let priorTime = -Infinity;
  let priorStage = -1;
  let runId = null;
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    const sequence = index + 1;
    if (event === null || Array.isArray(event) || typeof event !== "object") fail("record must be an object", sequence);
    for (const key of Object.keys(event)) if (!EVENT_KEYS.has(key)) fail(`unknown field ${key}`, sequence);
    for (const key of REQUIRED_KEYS) if (!(key in event)) fail(`missing field ${key}`, sequence);
    if (event.schema_version !== 1 || event.sequence !== sequence) fail("schema_version must be 1 and sequence must be contiguous from 1", sequence);
    assertAtom(event.event_id, "event_id", sequence);
    assertAtom(event.run_id, "run_id", sequence);
    assertAtom(event.source_repo_id, "source_repo_id", sequence);
    assertAtom(event.target_repo_id, "target_repo_id", sequence, true);
    assertAtom(event.actor_id, "actor_id", sequence);
    assertAtom(event.target_id, "target_id", sequence, true);
    assertAtom(event.correlation_id, "correlation_id", sequence, true);
    assertAtom(event.resource_id, "resource_id", sequence, true);
    if (ids.has(event.event_id)) fail("event_id must be unique", sequence);
    ids.add(event.event_id);
    runId ??= event.run_id;
    if (event.run_id !== runId) fail("all events must share run_id", sequence);
    if (!ROLES.has(event.actor_role) || (event.target_role !== undefined && !ROLES.has(event.target_role))) fail("actor_role/target_role is not allowlisted", sequence);
    if (!STATUSES.has(event.status)) fail("status is not allowlisted", sequence);
    if (REQUIRED_KIND_STATUS[event.kind] !== undefined && event.status !== REQUIRED_KIND_STATUS[event.kind]) fail(`${event.kind} requires status ${REQUIRED_KIND_STATUS[event.kind]}`, sequence);
    if (typeof event.caption !== "string" || event.caption.length < 1 || event.caption.length > 180) fail("caption must contain 1..180 characters", sequence);
    if (event.detail !== undefined && (typeof event.detail !== "string" || event.detail.length > 280)) fail("detail must contain at most 280 characters", sequence);
    assertSecretFree(`${event.caption}\n${event.detail ?? ""}`, `event ${sequence} display text`, { reject_control_characters: true });
    const timestamp = Date.parse(event.timestamp);
    if (!Number.isFinite(timestamp) || timestamp < priorTime) fail("timestamp must be valid and monotonic", sequence);
    priorTime = timestamp;
    if (!(event.kind in KIND_STAGE) || KIND_STAGE[event.kind] !== event.stage) fail("kind/stage combination is not allowlisted", sequence);
    const stageIndex = STAGE_INDEX.get(event.stage);
    if (stageIndex < priorStage) fail("stages must not move backward", sequence);
    priorStage = stageIndex;
    if (event.previous_hash !== priorHash) fail("previous_hash does not match the prior record", sequence);
    if (!HASH.test(event.hash) || computeFlightEventHash(event) !== event.hash) fail("hash is invalid", sequence);
    priorHash = event.hash;
  }
  if (options.require_complete !== false) assertCompleteFlightProof(events);
  return Object.freeze(events.map((event) => Object.freeze({ ...event })));
}

export function parseFlightEventText(text, options = {}) {
  assertSecretFree(text, options.label ?? "flight-events.jsonl", { reject_control_characters: true });
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const events = lines.map((line, index) => {
    try { return JSON.parse(line); } catch { fail("line is not valid JSON", index + 1); }
  });
  return validateFlightEvents(events, options);
}

export function loadFlightEvents(path, options = {}) {
  const source = readSecretFreeTextFile(path, { label: "flight-events.jsonl", reject_control_characters: true });
  return Object.freeze({ events: parseFlightEventText(source.text, options), source_text: source.text, scan_report: source.report });
}

function esc(value) { return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;"); }
function truncate(value, length) { return value.length <= length ? value : `${value.slice(0, length - 1)}…`; }
function wrap(value, width, maxLines = 2) {
  const words = value.trim().split(/\s+/);
  const lines = [];
  let line = "";
  for (const word of words) {
    if (`${line} ${word}`.trim().length <= width) { line = `${line} ${word}`.trim(); continue; }
    if (line) lines.push(line);
    line = word;
    if (lines.length === maxLines) break;
  }
  if (lines.length < maxLines && line) lines.push(line);
  if (lines.length === maxLines && words.join(" ").length > lines.join(" ").length) lines[maxLines - 1] = truncate(lines[maxLines - 1], Math.max(2, width - 1));
  return lines;
}
function statusColor(status) {
  return ({ pass: "#f3c76b", recovered: "#7de0c3", denied: "#dc8d66", quarantined: "#dc8d66", failed: "#cc735d", working: "#63c5da", info: "#90a7ad" })[status] ?? "#90a7ad";
}
function laneKey(repo, id) { return `${repo}::${id}`; }
function entityLanes(events) {
  const map = new Map();
  const add = (repo, id, role) => {
    if (!repo || !id) return;
    const key = laneKey(repo, id);
    if (!map.has(key)) map.set(key, { key, repo, id, role });
  };
  for (const event of events) {
    add(event.source_repo_id, event.actor_id, event.actor_role);
    add(event.target_repo_id ?? event.source_repo_id, event.target_id, event.target_role);
  }
  const roleOrder = { repository: 0, orchestrator: 1, agent: 2, system: 3 };
  return [...map.values()].sort((a, b) => a.repo.localeCompare(b.repo, "en") || roleOrder[a.role] - roleOrder[b.role] || a.id.localeCompare(b.id, "en")).slice(0, 10);
}

function renderSvg(events, index, options) {
  const event = events[index];
  const stageIndex = STAGE_INDEX.get(event.stage);
  const [, heading, stageCaption] = FLIGHT_STAGES[stageIndex];
  const lanes = entityLanes(events);
  const actorKey = laneKey(event.source_repo_id, event.actor_id);
  const targetKey = event.target_id ? laneKey(event.target_repo_id ?? event.source_repo_id, event.target_id) : null;
  const laneTop = 220;
  const laneGap = Math.min(68, Math.floor(540 / Math.max(1, lanes.length)));
  const laneY = new Map(lanes.map((lane, laneIndex) => [lane.key, laneTop + laneIndex * laneGap]));
  const recent = events.slice(Math.max(0, index - 4), index + 1);
  const stageRows = FLIGHT_STAGES.map(([id, label], row) => {
    const y = 160 + row * 67;
    const done = row < stageIndex;
    const active = row === stageIndex;
    const color = active ? "#f3c76b" : done ? "#7de0c3" : "#52666b";
    return `<circle cx="88" cy="${y}" r="${active ? 10 : 7}" fill="${color}"/><line x1="88" y1="${y + 11}" x2="88" y2="${y + 55}" stroke="#31464c" stroke-width="2"/><text x="116" y="${y + 6}" class="stage ${active ? "active" : ""}" fill="${color}">${String(row + 1).padStart(2, "0")}  ${esc(label)}</text>`;
  }).join("");
  const laneRows = lanes.map((lane) => {
    const y = laneY.get(lane.key);
    const active = lane.key === actorKey || lane.key === targetKey;
    const color = lane.key === actorKey ? statusColor(event.status) : lane.key === targetKey ? "#63c5da" : "#536c72";
    return `<line x1="620" y1="${y}" x2="1800" y2="${y}" stroke="${active ? color : "#263c42"}" stroke-width="${active ? 3 : 1}"/><circle cx="620" cy="${y}" r="8" fill="${color}"/><text x="642" y="${y - 8}" class="repo">${esc(lane.repo)}</text><text x="642" y="${y + 17}" class="lane" fill="${active ? "#eef5f1" : "#91a5a7"}">${esc(lane.id)} · ${esc(lane.role)}</text>`;
  }).join("");
  const ay = laneY.get(actorKey) ?? laneTop;
  const ty = targetKey ? laneY.get(targetKey) ?? ay : ay;
  const connection = targetKey ? `<path d="M 1040 ${ay} C 1260 ${ay}, 1420 ${ty}, 1650 ${ty}" fill="none" stroke="${statusColor(event.status)}" stroke-width="4" marker-end="url(#arrow)"/><circle cx="1040" cy="${ay}" r="9" fill="${statusColor(event.status)}"/>` : `<circle cx="1220" cy="${ay}" r="12" fill="${statusColor(event.status)}"/>`;
  const captionLines = wrap(event.caption, 92, 2).map((line, lineIndex) => `<text x="580" y="${875 + lineIndex * 38}" class="caption">${esc(line)}</text>`).join("");
  const detailLines = event.detail ? wrap(event.detail, 118, 2).map((line, lineIndex) => `<text x="580" y="${950 + lineIndex * 28}" class="detail">${esc(line)}</text>`).join("") : "";
  const recentRows = recent.map((item, row) => `<text x="1510" y="${690 + row * 28}" class="recent" fill="${item.event_id === event.event_id ? statusColor(item.status) : "#71878a"}">${esc(String(item.sequence).padStart(3, "0"))} ${esc(truncate(item.kind, 24))}</text>`).join("");
  const progress = Math.round(((index + 1) / events.length) * 100);
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080" viewBox="0 0 1920 1080">
<defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#071317"/><stop offset="0.55" stop-color="#0b2023"/><stop offset="1" stop-color="#132b29"/></linearGradient><radialGradient id="glow"><stop offset="0" stop-color="#2a6662" stop-opacity=".45"/><stop offset="1" stop-color="#071317" stop-opacity="0"/></radialGradient><marker id="arrow" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto"><path d="M0,0 L0,6 L9,3 z" fill="${statusColor(event.status)}"/></marker><style>text{font-family:'Noto Sans Mono',monospace}.brand{font-size:34px;font-weight:700;letter-spacing:4px}.eyebrow{font-size:14px;letter-spacing:3px}.stage{font-size:17px;letter-spacing:1px}.stage.active{font-weight:700}.heading{font-size:32px;font-weight:700;letter-spacing:2px}.subheading{font-size:17px}.repo{font-size:13px;fill:#6f9495;letter-spacing:2px}.lane{font-size:17px}.caption{font-size:27px;font-weight:600;fill:#eef5f1}.detail{font-size:16px;fill:#8fa7a7}.recent{font-size:14px}.meta{font-size:14px;fill:#668083}</style></defs>
<rect width="1920" height="1080" fill="url(#bg)"/><circle cx="1460" cy="280" r="560" fill="url(#glow)"/><path d="M0 1010 C500 960 1000 1060 1920 980 L1920 1080 L0 1080Z" fill="#152d28" opacity=".8"/>
<rect x="42" y="42" width="390" height="930" rx="24" fill="#09191d" stroke="#294146"/><text x="76" y="96" class="brand" fill="#f3c76b">REVOY2</text><text x="77" y="126" class="eyebrow" fill="#779497">FLIGHT CONTROL PROOF</text>${stageRows}
<text x="520" y="84" class="eyebrow" fill="#63c5da">${esc(options.title)}</text><text x="520" y="132" class="heading" fill="#eef5f1">${esc(heading)}</text><text x="520" y="166" class="subheading" fill="#839c9e">${esc(stageCaption)}</text>
<rect x="510" y="196" width="1360" height="594" rx="22" fill="#09191d" fill-opacity=".72" stroke="#284248"/>${laneRows}${connection}<text x="1510" y="655" class="eyebrow" fill="#758f91">CAUSAL TAIL</text>${recentRows}
<rect x="510" y="816" width="1360" height="194" rx="22" fill="#0a181a" stroke="${statusColor(event.status)}" stroke-width="2"/><text x="548" y="853" class="eyebrow" fill="${statusColor(event.status)}">${esc(event.status.toUpperCase())} · ${esc(event.kind)} · ${esc(event.event_id)}</text>${captionLines}${detailLines}
<rect x="510" y="1033" width="1360" height="5" rx="2" fill="#223a3d"/><rect x="510" y="1033" width="${Math.round(13.6 * progress)}" height="5" rx="2" fill="#f3c76b"/><text x="510" y="1065" class="meta">${esc(event.run_id)} · ${String(event.sequence).padStart(3, "0")}/${events.length} · chain ${esc(event.hash.slice(7, 19))}</text><text x="1772" y="1065" class="meta">${progress}%</text></svg>`;
}

export function renderFlightFrames(events, outputDirectory, options = {}) {
  const checked = validateFlightEvents(events, { require_complete: options.require_complete !== false });
  mkdirSync(outputDirectory, { recursive: true });
  const title = options.title ?? "CONCURRENT GOVERNED AGENTS";
  assertSecretFree(title, "reel title", { reject_control_characters: true });
  const secondsPerEvent = options.seconds_per_event ?? 1.45;
  if (!Number.isFinite(secondsPerEvent) || secondsPerEvent < 0.25 || secondsPerEvent > 8) throw new Error("seconds_per_event must be between 0.25 and 8");
  const framePaths = [];
  const concatLines = [];
  for (let index = 0; index < checked.length; index += 1) {
    const path = resolve(outputDirectory, `frame-${String(index + 1).padStart(4, "0")}.svg`);
    const svg = renderSvg(checked, index, { title });
    assertSecretFree(svg, `rendered frame ${index + 1}`);
    writeFileSync(path, svg, { encoding: "utf8", flag: "wx" });
    framePaths.push(path);
    const stageChanged = index === 0 || checked[index - 1].stage !== checked[index].stage;
    const duration = index === checked.length - 1 ? Math.max(3, secondsPerEvent) : secondsPerEvent + (stageChanged ? 0.55 : 0);
    concatLines.push(`file '${path.replaceAll("'", "'\\''")}'`, `duration ${duration.toFixed(3)}`);
  }
  concatLines.push(`file '${framePaths.at(-1).replaceAll("'", "'\\''")}'`);
  const concatPath = resolve(outputDirectory, "frames.concat.txt");
  writeFileSync(concatPath, `${concatLines.join("\n")}\n`, { encoding: "utf8", flag: "wx" });
  const plan = Object.freeze({ width: 1920, height: 1080, frames: framePaths.length, seconds_per_event: secondsPerEvent, run_id: checked[0].run_id, ledger_tip: checked.at(-1).hash, concat_path: concatPath, frame_paths: Object.freeze(framePaths) });
  writeFileSync(resolve(outputDirectory, "render-plan.json"), `${JSON.stringify(plan, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  return plan;
}

function cliArgs(argv) {
  const input = argv[0];
  if (!input) throw new Error("usage: bun scripts/flight-control-replay.mjs <flight-events.jsonl> --frames <directory> [--title <title>] [--seconds-per-event 1.45]");
  const value = (name, fallback) => { const index = argv.indexOf(name); return index < 0 ? fallback : argv[index + 1]; };
  const frames = value("--frames", null);
  if (!frames) throw new Error("--frames is required");
  return { input, frames, title: value("--title", "CONCURRENT GOVERNED AGENTS"), seconds: Number(value("--seconds-per-event", "1.45")) };
}

async function main() {
  const args = cliArgs(process.argv.slice(2));
  const loaded = loadFlightEvents(args.input);
  const result = renderFlightFrames(loaded.events, args.frames, { title: args.title, seconds_per_event: args.seconds });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
