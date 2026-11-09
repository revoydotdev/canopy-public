#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { assertSecretFree } from "./lib/sizzle-redaction.mjs";
import { sha256Bytes, writeManifestAndChecksums } from "./lib/sizzle-manifest.mjs";

const RUN_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/;
const REVISION = /^[a-f0-9]{40}$/i;
const SHA256 = /^sha256:[a-f0-9]{64}$/i;
const OUTCOMES = new Set(["verified_adopted", "failure_backtracking", "controlled_fixture"]);
const TREE_EVENT_KINDS = new Set(["campaign_started", "branch_created", "selected", "gate_confirmed", "backtracked", "rejected", "interrupted"]);
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TREE_SOURCE_FILES = Object.freeze(["campaign-tree.mp4", "campaign-tree.webm", "campaign-tree-events.json", "manifest.json", "privacy-report.json", "SHA256SUMS"]);

function runJson(command, args, cwd, timeout = 40 * 60 * 1000) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", timeout, maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${basename(args[0] ?? command)} exited ${result.status}: ${(result.stderr || result.stdout).slice(-4000)}`);
  const output = result.stdout.trim();
  return JSON.parse(output.slice(output.lastIndexOf("\n{") + 1));
}

function safeRoot(path) {
  const root = resolve(path);
  if (root !== "/mnt/sda2" && !root.startsWith(`/mnt/sda2${sep}`)) throw new Error("commercial demo output must remain under /mnt/sda2");
  mkdirSync(root, { recursive: true });
  const actual = realpathSync(root);
  if (actual !== "/mnt/sda2" && !actual.startsWith(`/mnt/sda2${sep}`)) throw new Error("commercial demo output resolves outside /mnt/sda2");
  return actual;
}

function readJson(path) { return JSON.parse(readFileSync(path, "utf8")); }
function readJsonl(path) { return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)); }

function assertRegularFile(path, label = path) {
  if (!existsSync(path)) throw new Error(`${label} is required`);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular, non-symlink file`);
  return stat;
}

function validSha256(value, label) {
  if (typeof value !== "string" || !SHA256.test(value)) throw new Error(`${label} must be a SHA-256 hash`);
  return value.toLowerCase();
}

function validRevision(value, label, required = false) {
  if (value === undefined || value === null) {
    if (required) throw new Error(`${label} is required`);
    return null;
  }
  if (typeof value !== "string" || !REVISION.test(value)) throw new Error(`${label} must be a 40-character git revision`);
  return value.toLowerCase();
}

function parseChecksumLedger(path) {
  const lines = readFileSync(path, "utf8").trim().split("\n").filter(Boolean);
  if (!lines.length) throw new Error("campaign-tree SHA256SUMS is empty");
  const entries = new Map();
  for (const line of lines) {
    const match = /^([a-f0-9]{64})  ([^/][^\0]*)$/i.exec(line);
    if (!match || match[2].includes("\\")) throw new Error("campaign-tree SHA256SUMS contains an invalid entry");
    if (entries.has(match[2])) throw new Error(`campaign-tree SHA256SUMS duplicates ${match[2]}`);
    entries.set(match[2], `sha256:${match[1].toLowerCase()}`);
  }
  return entries;
}

function publicTreeEvents(fixture) {
  if (!fixture || typeof fixture !== "object" || typeof fixture.campaign_id !== "string" || !SAFE_ID.test(fixture.campaign_id) || !Array.isArray(fixture.events) || fixture.events.length === 0 || fixture.events.length > 512) throw new Error("campaign-tree event projection is invalid or exceeds its public bound");
  return fixture.events.map((event, index) => {
    if (!event || typeof event !== "object" || !TREE_EVENT_KINDS.has(event.kind) || typeof event.at !== "string" || !Number.isFinite(Date.parse(event.at)) || typeof event.node_id !== "string" || !SAFE_ID.test(event.node_id)) throw new Error(`campaign-tree event ${index + 1} is not a bounded public event`);
    return Object.freeze({ at: event.at, kind: event.kind, node_id: event.node_id, ...(typeof event.final_state === "string" ? { final_state: event.final_state } : {}) });
  });
}

function outcomeLabel(outcome) {
  return ({ verified_adopted: "Verified adoption", failure_backtracking: "Observed failure and backtracking", controlled_fixture: "Controlled fixture" })[outcome];
}

function assertOutcomeEvidence(outcome, manifest, events) {
  if (!OUTCOMES.has(outcome)) throw new Error("campaign-tree outcome must be one of verified_adopted, failure_backtracking, controlled_fixture");
  if (outcome === "verified_adopted" && !(manifest.adoption?.applied === true && typeof manifest.adoption.receipt_id === "string" && manifest.adoption.receipt_id.length > 0)) throw new Error("verified_adopted campaign-tree outcome requires sealed adoption evidence");
  if (outcome === "failure_backtracking" && !(events.some((event) => event.kind === "backtracked") && events.some((event) => event.kind === "rejected"))) throw new Error("failure_backtracking campaign-tree outcome requires recorded rejection and backtracking");
  if (outcome === "controlled_fixture" && manifest.controlled_fixture !== true) throw new Error("controlled_fixture campaign-tree outcome requires sealed fixture evidence");
}

export function publicTreeCaptions(events, outcome) {
  const start = Date.parse(events[0].at);
  const cueTime = (milliseconds) => new Date(Math.max(0, milliseconds)).toISOString().slice(11, 23).replace(".", ",");
  const lines = ["WEBVTT", "", "1", `00:00:00,000 --> 00:00:02,500`, outcomeLabel(outcome), ""];
  const transcript = [`Campaign tree: ${outcomeLabel(outcome)}.`];
  for (const [index, event] of events.entries()) {
    const eventStart = Math.max(0, Date.parse(event.at) - start);
    const next = events[index + 1] ? Math.max(eventStart + 500, Date.parse(events[index + 1].at) - start) : eventStart + 2_500;
    const eventEnd = Math.min(eventStart + 4_000, next);
    const text = `${event.kind.replaceAll("_", " ")}: ${event.node_id}${event.final_state ? ` (${event.final_state})` : ""}`;
    lines.push(String(index + 2), `${cueTime(eventStart)} --> ${cueTime(eventEnd)}`, text, "");
    transcript.push(text);
  }
  const vtt = `${lines.join("\n")}\n`;
  const text = `${transcript.join("\n")}\n`;
  assertSecretFree(vtt, "campaign-tree public captions");
  assertSecretFree(text, "campaign-tree public transcript");
  return Object.freeze({ vtt, transcript: text });
}

export function ingestSealedCampaignTreeArtifact(sourceDirectory, targetDirectory, outcome) {
  const source = realpathSync(resolve(sourceDirectory));
  const sourcePaths = Object.fromEntries(TREE_SOURCE_FILES.map((name) => [name, join(source, name)]));
  for (const [name, path] of Object.entries(sourcePaths)) assertRegularFile(path, `campaign-tree ${name}`);
  const manifest = readJson(sourcePaths["manifest.json"]);
  const privacy = readJson(sourcePaths["privacy-report.json"]);
  const fixture = readJson(sourcePaths["campaign-tree-events.json"]);
  if (manifest?.artifact_kind !== "campaign_tree_publication" || !Array.isArray(manifest.assets)) throw new Error("campaign-tree manifest is not a sealed publication artifact");
  if (privacy?.kind !== "campaign_tree_publication" || privacy.source_records_published !== false) throw new Error("campaign-tree privacy sidecar does not attest to a public projection");
  const sourceRevision = validRevision(manifest.source_revision, "campaign-tree source_revision", true);
  const generatorRevision = validRevision(manifest.generator_revision, "campaign-tree generator_revision");
  const events = publicTreeEvents(fixture);
  if (fixture.campaign_id !== manifest.campaign_id || validRevision(fixture.source_revision, "campaign-tree fixture source_revision", true) !== sourceRevision) throw new Error("campaign-tree fixture provenance does not match its manifest");
  const fixtureGenerator = validRevision(fixture.generator_revision, "campaign-tree fixture generator_revision");
  if (fixtureGenerator !== generatorRevision) throw new Error("campaign-tree fixture generator revision does not match its manifest");
  const fixtureSource = fixture.source && typeof fixture.source === "object" ? fixture.source : {};
  const auditTip = {
    file_sha256: fixtureSource.audit_tip_file_sha256 ?? manifest.audit_tip_file_sha256 ?? null,
    tip_hash: fixtureSource.audit_tip_hash ?? manifest.audit_tip_hash ?? null,
    content_hash: fixtureSource.audit_tip_content_hash ?? manifest.audit_tip_content_hash ?? null,
  };
  for (const [field, value] of Object.entries(auditTip)) if (value !== null) validSha256(value, `campaign-tree audit tip ${field}`);
  const assetRecords = new Map(manifest.assets.map((asset) => [asset?.path, asset]));
  const ledger = parseChecksumLedger(sourcePaths.SHA256SUMS);
  const expectedEntries = new Set(["manifest.json", "campaign-tree.mp4", "campaign-tree.webm", "campaign-tree-events.json", "privacy-report.json"]);
  for (const name of expectedEntries) {
    const manifestAsset = name === "manifest.json" ? null : assetRecords.get(name);
    const expected = name === "manifest.json" ? ledger.get(name) : validSha256(manifestAsset?.sha256, `campaign-tree manifest asset ${name}`);
    const actual = sha256Bytes(readFileSync(sourcePaths[name]));
    if (expected !== actual || ledger.get(name) !== actual) throw new Error(`campaign-tree checksum verification failed for ${name}`);
  }
  if (ledger.size !== expectedEntries.size || [...ledger.keys()].some((name) => !expectedEntries.has(name))) throw new Error("campaign-tree SHA256SUMS does not exactly cover its sealed public files");
  assertOutcomeEvidence(outcome, manifest, events);
  mkdirSync(targetDirectory, { recursive: false });
  for (const name of TREE_SOURCE_FILES) copyFileSync(sourcePaths[name], join(targetDirectory, name));
  const captions = publicTreeCaptions(events, outcome);
  writeFileSync(join(targetDirectory, "campaign-tree-captions.vtt"), captions.vtt, { encoding: "utf8", flag: "wx" });
  writeFileSync(join(targetDirectory, "campaign-tree-transcript.txt"), captions.transcript, { encoding: "utf8", flag: "wx" });
  const missingProvenance = [generatorRevision === null ? "generator_revision" : null, auditTip.file_sha256 === null ? "audit_tip_file_sha256" : null, auditTip.tip_hash === null ? "audit_tip_hash" : null, auditTip.content_hash === null ? "audit_tip_content_hash" : null].filter(Boolean);
  return Object.freeze({ fixture: { ...fixture, events }, outcome, outcome_label: outcomeLabel(outcome), source_revision: sourceRevision, generator_revision: generatorRevision, audit_tip: auditTip, missing_provenance: missingProvenance });
}

export function sealShippedPackage(directory, sourceManifest, assetPaths) {
  const { assets: _sourceAssets, ...projectedManifest } = sourceManifest;
  const sealed = writeManifestAndChecksums(directory, projectedManifest, assetPaths);
  const checksumPath = join(directory, "package-SHA256SUMS");
  renameSync(sealed.checksums_path, checksumPath);
  return Object.freeze({ ...sealed, checksums_path: checksumPath });
}

export function buildProofMatrix(input) {
  const flightKinds = new Set(input.flight_events.map((event) => event.kind));
  const heroKinds = new Set(input.hero.events.map((event) => event.kind));
  const treeTitle = input.hero.outcome === "verified_adopted" ? "The published campaign records verified adoption after governed review" : input.hero.outcome === "controlled_fixture" ? "The controlled tree fixture records governed branching and recovery" : "The published campaign records branching, rejection, and backtracking";
  const cockpit = input.cockpit.empirical_checks ?? input.cockpit.checks;
  const recoveryResolved = flightKinds.has("lease.recovered") || flightKinds.has("lease.quarantined");
  const claims = [
    { id: "operator-cockpit-live", title: "The operator cockpit is a real tmux session", pass: cockpit.tmux_session_captured && cockpit.live_pane_changed && cockpit.devtools_stream_observed, evidence: ["operator-cockpit/manifest.json", "operator-cockpit/evidence.json"] },
    { id: "proposal-review-separation", title: "Separate specialist and critic phases are observed; the node reaches a real terminal outcome (claimed or verified)", pass: cockpit.specialist_dispatch_observed && cockpit.critic_dispatch_observed && cockpit.successful_node_observed, evidence: ["operator-cockpit/evidence.json"] },
    { id: "bidirectional-a2a", title: "The controlled fixture records orchestrator/worker round-trips and relayed peer query/reply", pass: ["message.sent", "message.acknowledged", "peer.query", "peer.reply"].every((kind) => flightKinds.has(kind)), evidence: ["flight-control/source/flight-events.jsonl"] },
    { id: "cross-repository-control", title: "Two real repositories host concurrent workers with controlled cross-repository receipts", pass: flightKinds.has("cross_repo.sent") && flightKinds.has("cross_repo.received"), evidence: ["flight-control/source/flight-events.jsonl"] },
    { id: "collision-and-scope-safety", title: "The fixture records one lease winner, collision denial, and protected-scope refusal", pass: flightKinds.has("lease.acquired") && flightKinds.has("lease.denied") && flightKinds.has("scope.write_denied"), evidence: ["flight-control/source/flight-events.jsonl", "evidence/flight-control-proof.json"] },
    { id: "crash-recovery", title: "The controlled drill records worker exit, stale-lease resolution, and bounded retry", pass: recoveryResolved && ["session.crashed", "lease.stale_detected", "retry.succeeded"].every((kind) => flightKinds.has(kind)), evidence: ["flight-control/source/flight-events.jsonl", "evidence/flight-control-proof.json"] },
    { id: "terminal-integrity", title: "Both fixture repositories and the publication ledger finish clean", pass: input.flight_report.ok === true && flightKinds.has("integrity.repo_clean") && flightKinds.has("integrity.ledger_verified"), evidence: ["evidence/flight-control-proof.json"] },
    { id: "tree-search-cognition", title: treeTitle, pass: ["branch_created", "selected", "backtracked"].every((kind) => heroKinds.has(kind)) && (heroKinds.has("gate_confirmed") || heroKinds.has("rejected")), evidence: ["campaign-cognition/campaign-tree-events.json", "campaign-cognition/campaign-tree.webm", "campaign-cognition/campaign-tree.mp4", "campaign-cognition/manifest.json", "campaign-cognition/privacy-report.json", "campaign-cognition/SHA256SUMS", "campaign-cognition/campaign-tree-captions.vtt", "campaign-cognition/campaign-tree-transcript.txt"] },
  ];
  const failed = claims.filter((claim) => !claim.pass);
  if (failed.length) throw new Error(`commercial proof matrix incomplete: ${failed.map((claim) => claim.id).join(", ")}`);
  const limitations = [
    "The flight-control chapter is a deterministic safety fixture, not a model-backed autonomous coding campaign.",
    "Its repository-rooted workers are real Bun processes, but peer traffic is orchestrator-relayed rather than a public direct-agent network endpoint.",
    "The fixture controller performs the demonstrated cancellation cleanup and stale-lease resolution; it does not prove automatic recovery from an unplanned production incident.",
  ];
  return { schema_version: 1, product: "revoy2", kind: "commercial-proof-matrix", claims, limitations, campaign_cognition: { outcome: input.hero.outcome, outcome_label: input.hero.outcome_label, source_revision: input.hero.source_revision, generator_revision: input.hero.generator_revision, audit_tip: input.hero.audit_tip, missing_provenance: input.hero.missing_provenance } };
}

function staticCaptions(label, description) {
  const vtt = `WEBVTT\n\n1\n00:00:00,000 --> 00:00:12,000\n${label}: ${description}\n`;
  const transcript = `${label}\n${description}\n`;
  assertSecretFree(vtt, `${label} public captions`); assertSecretFree(transcript, `${label} public transcript`);
  return { vtt, transcript };
}

function writeChapterCaptions(directory, label, description) {
  const captions = staticCaptions(label, description);
  writeFileSync(join(directory, "captions.vtt"), captions.vtt, { encoding: "utf8", flag: "wx" });
  writeFileSync(join(directory, "transcript.txt"), captions.transcript, { encoding: "utf8", flag: "wx" });
}

export function gallery(runId, matrix) {
  const cards = matrix.claims.map((claim, index) => `<article><span>${String(index + 1).padStart(2, "0")}</span><h3>${claim.title}</h3><p>PASS · ${claim.id}</p></article>`).join("");
  const limitations = matrix.limitations.map((item) => `<li>${item}</li>`).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>revoy2 empirical demo suite</title><style>:root{--ink:#e8f2ee;--muted:#7f9790;--mint:#77d7b5;--amber:#e8bc72;--panel:#07100e}*{box-sizing:border-box}body{margin:0;background:#030605;color:var(--ink);font-family:"IBM Plex Sans",sans-serif}header{min-height:76vh;padding:8vh 7vw;display:grid;align-content:center;background:radial-gradient(circle at 62% 45%,#173a35 0,transparent 48%),linear-gradient(120deg,#030605,#07100e)}.eyebrow{font:12px monospace;letter-spacing:.25em;color:var(--mint)}h1{font:clamp(54px,9vw,148px)/.88 Georgia,serif;max-width:1100px;margin:.25em 0}.lede{max-width:720px;color:#a9bbb5;font-size:20px;line-height:1.5}.rail{display:flex;gap:12px;margin-top:34px}.rail a{color:var(--ink);border:1px solid #34564d;padding:12px 18px;text-decoration:none}main{padding:7vw}.feature{display:grid;grid-template-columns:1.5fr .5fr;gap:34px;margin-bottom:10vh}.feature:nth-child(even){grid-template-columns:.5fr 1.5fr}.feature:nth-child(even) video{grid-column:2}.feature video{width:100%;background:#000;border:1px solid #25483f;box-shadow:0 28px 90px #000}.feature h2{font:42px Georgia,serif;margin:0 0 12px}.feature p{color:var(--muted);line-height:1.6}.proofs{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px}.proofs article{background:var(--panel);border:1px solid #18322c;padding:24px;min-height:160px}.proofs span,.proofs p{font:12px monospace;color:var(--mint)}.limits{margin-top:7vh;padding:28px;border-left:2px solid var(--amber);background:#100d08}.limits li{margin:12px 0;color:#c6b99f;line-height:1.5}footer{padding:6vw;color:var(--muted);border-top:1px solid #18322c}@media(max-width:800px){.feature,.feature:nth-child(even){grid-template-columns:1fr}.feature:nth-child(even) video{grid-column:auto}}</style></head><body><header><div class="eyebrow">EMPIRICAL PRODUCT DOSSIER · ${runId}</div><h1>Autonomy you can inspect.</h1><p class="lede">Four evidence-linked demonstrations: live operator control, a controlled distributed-safety exercise, recorded campaign cognition, and a cryptographically identified proof dossier.</p><div class="rail"><a href="#cockpit">Operator cockpit</a><a href="#flight">Flight control</a><a href="#tree">Campaign tree</a><a href="proof-matrix.json">Proof matrix</a></div></header><main><section id="cockpit" class="feature"><video autoplay loop muted playsinline controls><source src="operator-cockpit/revoy2-operator-cockpit.webm" type="video/webm"><source src="operator-cockpit/revoy2-operator-cockpit.mp4" type="video/mp4"><track kind="captions" src="operator-cockpit/captions.vtt" srclang="en" label="English" default></video><div><h2>Live control surface</h2><p>Actual tmux panes capture the TUI and durable DevTools stream. Frames are text-derived, secret-scanned, and sealed with media probes and hashes.</p><p><a href="operator-cockpit/transcript.txt">Transcript</a></p></div></section><section id="flight" class="feature"><div><h2>Two repos. One governed flight.</h2><p>A deterministic safety exercise uses real repository-rooted Bun workers to record bounded messaging, relayed peer queries, collision and scope refusal, controlled cancellation cleanup, stale-lease resolution, retry, and final integrity.</p><p><a href="flight-control/transcript.txt">Transcript</a></p></div><video autoplay loop muted playsinline controls><source src="flight-control/revoy2-flight-control.webm" type="video/webm"><source src="flight-control/revoy2-flight-control.mp4" type="video/mp4"><track kind="captions" src="flight-control/captions.vtt" srclang="en" label="English" default></video></section><section id="tree" class="feature"><video autoplay loop muted playsinline controls><source src="campaign-cognition/campaign-tree.webm" type="video/webm"><source src="campaign-cognition/campaign-tree.mp4" type="video/mp4"><track kind="captions" src="campaign-cognition/campaign-tree-captions.vtt" srclang="en" label="English" default></video><div><div class="eyebrow">${matrix.campaign_cognition.outcome_label}</div><h2>Cognition with a memory</h2><p>The animation follows sealed, reduced campaign topology and timing. Its label describes the recorded outcome; it does not imply success where the campaign demonstrates rejection or recovery.</p><p><a href="campaign-cognition/campaign-tree-transcript.txt">Transcript</a></p></div></section><section><div class="eyebrow">MACHINE-CHECKABLE CLAIMS</div><h2 style="font:54px Georgia,serif">Every headline has a receipt.</h2><div class="proofs">${cards}</div><aside class="limits"><div class="eyebrow">DEMONSTRATED BOUNDARY</div><ul>${limitations}</ul></aside></section></main><footer>revoy2 · publication-safe demo suite · checksums and source evidence included</footer></body></html>`;
}

export async function buildCommercialDemoSuite(options = {}) {
  const runId = options.run_id ?? `revoy2-commercial-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  if (!RUN_ID.test(runId)) throw new Error("run_id must be publication safe");
  const repoRoot = realpathSync(resolve(options.repo_root ?? new URL("..", import.meta.url).pathname));
  const root = safeRoot(options.output_root ?? "/mnt/sda2/revoy2/exemplars");
  const suite = join(root, runId);
  mkdirSync(suite, { recursive: false });
  writeFileSync(join(suite, ".incomplete"), "suite incomplete\n", { flag: "wx" });
  const scratch = mkdtempSync(join(tmpdir(), "revoy2-commercial-suite-"));
  try {
    const reportPath = join(scratch, "flight-report.json");
    const eventsPath = join(scratch, "flight-events.jsonl");
    const flightId = `${runId}-flight`;
    runJson(process.execPath, [join(repoRoot, "scripts", "run-flight-control-stress.mjs"), "--run-id", flightId, "--report", reportPath, "--publication", eventsPath], repoRoot);
    const flightRoot = join(suite, "flight-build"); mkdirSync(flightRoot);
    const flightResult = runJson(process.execPath, [join(repoRoot, "scripts", "sizzle-record.mjs"), "--events", eventsPath, "--run-id", flightId, "--title", "TWO REPOS / ONE GOVERNED FLIGHT", "--output-root", flightRoot], repoRoot);
    const flightDir = join(suite, "flight-control"); mkdirSync(flightDir);
    for (const [source, target] of [[flightResult.mp4, "revoy2-flight-control.mp4"], [flightResult.webm, "revoy2-flight-control.webm"], [join(flightResult.run_directory, "privacy-report.json"), "privacy-report.json"]]) copyFileSync(source, join(flightDir, target));
    const sourceDir = join(flightDir, "source"); mkdirSync(sourceDir); copyFileSync(eventsPath, join(sourceDir, "flight-events.jsonl"));
    sealShippedPackage(flightDir, readJson(flightResult.manifest), ["revoy2-flight-control.mp4", "revoy2-flight-control.webm", "privacy-report.json", "source/flight-events.jsonl"].map((path) => join(flightDir, path)));
    writeChapterCaptions(flightDir, "Flight-control fixture", "Controlled safety fixture with bounded, public event evidence. See the proof matrix for demonstrated limits.");
    const evidenceDir = join(suite, "evidence"); mkdirSync(evidenceDir);
    const cockpitRoot = join(suite, "cockpit-build"); mkdirSync(cockpitRoot);
    const cockpitId = `${runId}-cockpit`;
    const cockpitResult = runJson(process.execPath, [join(repoRoot, "scripts", "tmux-demo-record.mjs"), "--run-id", cockpitId, "--output-root", cockpitRoot, "--duration", String(options.cockpit_duration ?? 16)], repoRoot);
    const cockpitDir = join(suite, "operator-cockpit"); mkdirSync(cockpitDir);
    for (const [source, target] of [[cockpitResult.mp4, "revoy2-operator-cockpit.mp4"], [cockpitResult.webm, "revoy2-operator-cockpit.webm"], [cockpitResult.evidence, "evidence.json"], [join(cockpitResult.run_directory, "privacy-report.json"), "privacy-report.json"], [join(cockpitResult.run_directory, "tmux-capture.json"), "tmux-capture.json"]]) copyFileSync(source, join(cockpitDir, target));
    sealShippedPackage(cockpitDir, readJson(cockpitResult.manifest), ["revoy2-operator-cockpit.mp4", "revoy2-operator-cockpit.webm", "evidence.json", "privacy-report.json", "tmux-capture.json"].map((path) => join(cockpitDir, path)));
    writeChapterCaptions(cockpitDir, "Operator cockpit", "Live governed operator-control recording. The transcript intentionally excludes terminal and provider text; inspect its sealed evidence sidecars for machine-checkable claims.");
    if (!options.campaign_tree_package || !options.campaign_tree_outcome) throw new Error("commercial demo suite requires --campaign-tree-package and --campaign-tree-outcome");
    const cognitionDir = join(suite, "campaign-cognition");
    const hero = ingestSealedCampaignTreeArtifact(options.campaign_tree_package, cognitionDir, options.campaign_tree_outcome);
    const flightReport = readJson(reportPath); const flightEvents = readJsonl(eventsPath); const cockpitManifest = readJson(join(cockpitDir, "manifest.json"));
    const flightProofPath = join(evidenceDir, "flight-control-proof.json");
    const flightProofText = `${JSON.stringify({ schema_version: 1, scenario_id: flightReport.scenario_id, ok: flightReport.ok, checks: flightReport.checks.map((check) => ({ id: check.id, ok: check.ok })), gaps: flightReport.gaps }, null, 2)}\n`;
    assertSecretFree(flightProofText, "flight-control proof projection"); writeFileSync(flightProofPath, flightProofText, { flag: "wx" });
    const matrix = buildProofMatrix({ flight_report: flightReport, flight_events: flightEvents, cockpit: cockpitManifest, hero });
    const matrixPath = join(suite, "proof-matrix.json"); const indexPath = join(suite, "index.html");
    const matrixText = `${JSON.stringify({ ...matrix, run_id: runId, generated_at: new Date().toISOString() }, null, 2)}\n`; const html = gallery(runId, matrix);
    assertSecretFree(matrixText, "commercial proof matrix"); assertSecretFree(html, "commercial gallery"); writeFileSync(matrixPath, matrixText, { flag: "wx" }); writeFileSync(indexPath, html, { flag: "wx" });
    rmSync(flightRoot, { recursive: true, force: true }); rmSync(cockpitRoot, { recursive: true, force: true });
    const assets = [indexPath, matrixPath, flightProofPath, ...["revoy2-flight-control.mp4", "revoy2-flight-control.webm", "manifest.json", "privacy-report.json", "package-SHA256SUMS", "source/flight-events.jsonl", "captions.vtt", "transcript.txt"].map((path) => join(flightDir, path)), ...["revoy2-operator-cockpit.mp4", "revoy2-operator-cockpit.webm", "manifest.json", "evidence.json", "privacy-report.json", "tmux-capture.json", "package-SHA256SUMS", "captions.vtt", "transcript.txt"].map((path) => join(cockpitDir, path)), ...TREE_SOURCE_FILES.map((path) => join(cognitionDir, path)), join(cognitionDir, "campaign-tree-captions.vtt"), join(cognitionDir, "campaign-tree-transcript.txt")];
    const manifest = { schema_version: 1, product: "revoy2", artifact_kind: "commercial_empirical_demo_suite", run_id: runId, generated_at: new Date().toISOString(), packages: [{ id: "operator-cockpit", claim_count: 2 }, { id: "flight-control", claim_count: 5 }, { id: "campaign-cognition", claim_count: 1, outcome: hero.outcome } , { id: "evidence-dossier", claim_count: matrix.claims.length }], campaign_cognition: { campaign_id: hero.fixture.campaign_id, outcome: hero.outcome, outcome_label: hero.outcome_label, source_revision: hero.source_revision, generator_revision: hero.generator_revision, audit_tip: hero.audit_tip, missing_provenance: hero.missing_provenance }, proof_matrix_sha256: sha256Bytes(Buffer.from(matrixText)), all_claims_pass: matrix.claims.every((claim) => claim.pass) };
    const sealed = writeManifestAndChecksums(suite, manifest, assets);
    rmSync(join(suite, ".incomplete"));
    return { run_directory: suite, gallery: indexPath, manifest: sealed.manifest_path, checksums: sealed.checksums_path, claims: matrix.claims.length };
  } catch (error) {
    writeFileSync(join(suite, "failure.txt"), "suite failed closed; inspect the invoking terminal\n", "utf8"); throw error;
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}

function args(argv) { const value = (name, fallback) => { const index = argv.indexOf(name); return index < 0 ? fallback : argv[index + 1]; }; return { run_id: value("--run-id"), output_root: value("--output-root"), cockpit_duration: Number(value("--cockpit-duration", "16")), campaign_tree_package: value("--campaign-tree-package"), campaign_tree_outcome: value("--campaign-tree-outcome") }; }
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) buildCommercialDemoSuite(args(process.argv.slice(2))).then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)).catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
