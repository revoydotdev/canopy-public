import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { assertSecretFree } from "./lib/sizzle-redaction.mjs";
import { sha256Bytes, writeManifestAndChecksums } from "./lib/sizzle-manifest.mjs";

const RUN_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/;
const HASH = /^sha256:[a-f0-9]{64}$/;
const REQUIRED = Object.freeze([
  Object.freeze({ id: "flight-control", kind: "commercial_empirical_demo_suite", title: "Flight control under pressure", eyebrow: "A2A SAFETY", description: "Concurrent agents communicate across repositories, collide safely, recover stale leases, and leave an auditable trail.", media: "flight-control/revoy2-flight-control.webm", matrix: "proof-matrix.json" }),
  Object.freeze({ id: "self-host", kind: "real_time_self_hosted_governed_campaign", title: "Six minutes of governed self-hosting", eyebrow: "REAL CAMPAIGN", description: "A provider-backed campaign works on Revoy itself through planning, specialist execution, independent criticism, recovery, verification, and adoption.", media: "trailer.webm", matrix: "proof-matrix.json" }),
  Object.freeze({ id: "webui", kind: "real_time_governed_webui_campaign", title: "Governance an operator can see", eyebrow: "WEB COCKPIT", description: "A browser-entered task visibly grows through the live tree, specialist and critic phases, verified completion, and result review.", media: "trailer.webm", matrix: "proof-matrix.json" }),
  Object.freeze({ id: "generalist", kind: "provider_backed_cross_language_generalist_campaigns", title: "One harness, three languages", eyebrow: "GENERALIST FLIGHTS", description: "Fresh TypeScript, Python, and Go repositories move from failing baselines to governed adoption and independently green native test suites; Go includes critic rejection and corrective retry.", media: "lanes/go/go.webm", matrix: "verification.json" }),
]);

function json(path) { return JSON.parse(readFileSync(path, "utf8")); }
function digest(path) { return createHash("sha256").update(readFileSync(path)).digest("hex"); }
function safeRoot(path) {
  const requested = resolve(path);
  if (requested !== "/mnt/sda2" && !requested.startsWith(`/mnt/sda2${sep}`)) throw new Error("portfolio output must remain under /mnt/sda2");
  mkdirSync(requested, { recursive: true });
  const actual = realpathSync(requested);
  if (actual !== "/mnt/sda2" && !actual.startsWith(`/mnt/sda2${sep}`)) throw new Error("portfolio output resolves outside /mnt/sda2");
  return actual;
}
function relativeLink(from, target) { return relative(from, target).split(sep).join("/"); }
function escape(value) { return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;"); }

export function verifyPackage(directory) {
  const root = realpathSync(resolve(directory));
  const checksumPath = join(root, "SHA256SUMS");
  if (!existsSync(checksumPath) || existsSync(join(root, ".incomplete"))) throw new Error(`${basename(root)} is not a sealed package`);
  const lines = readFileSync(checksumPath, "utf8").trim().split("\n").filter(Boolean);
  if (!lines.length) throw new Error(`${basename(root)} has an empty checksum ledger`);
  const checked = new Map();
  for (const line of lines) {
    const match = /^([a-f0-9]{64})  (.+)$/.exec(line);
    if (!match) throw new Error(`${basename(root)} has a malformed checksum line`);
    const path = resolve(root, match[2]);
    if (path !== root && !path.startsWith(`${root}${sep}`)) throw new Error(`${basename(root)} checksum path escapes its package`);
    if (!existsSync(path) || digest(path) !== match[1]) throw new Error(`${basename(root)} checksum verification failed for ${match[2]}`);
    checked.set(match[2], `sha256:${match[1]}`);
  }
  const manifest = json(join(root, "manifest.json"));
  if (checked.get("manifest.json") !== `sha256:${digest(join(root, "manifest.json"))}`) throw new Error(`${basename(root)} manifest is not checksum-bound`);
  for (const asset of manifest.assets ?? []) if (!HASH.test(asset.sha256) || checked.get(asset.path) !== asset.sha256) throw new Error(`${basename(root)} asset ledger disagrees for ${asset.path}`);
  return Object.freeze({ root, manifest, manifest_sha256: `sha256:${digest(join(root, "manifest.json"))}` });
}

export function assertPortfolioContract(catalog) {
  if (catalog?.artifact_kind !== "commercial_exemplar_portfolio" || catalog?.all_packages_verified !== true) throw new Error("portfolio must be a verified commercial exemplar catalog");
  if (catalog.packages?.map((entry) => entry.id).join("|") !== REQUIRED.map((entry) => entry.id).join("|")) throw new Error("portfolio package sequence is incomplete");
  if (!Number.isSafeInteger(catalog.total_verified_claims) || catalog.total_verified_claims < 36) throw new Error("portfolio does not expose the complete verified claim set");
  for (const entry of catalog.packages) {
    if (!HASH.test(entry.source_manifest_sha256) || entry.claim_count < 1 || entry.verified !== true) throw new Error(`portfolio entry ${entry.id} is not evidence-bound`);
    if (!entry.href || entry.href.startsWith("/") || !entry.media || entry.media.startsWith("/")) throw new Error(`portfolio entry ${entry.id} must use portable relative links`);
  }
}

function claimCount(definition, source) {
  if (source.manifest.artifact_kind !== definition.kind) throw new Error(`${definition.id} has artifact kind ${source.manifest.artifact_kind}, expected ${definition.kind}`);
  const matrix = json(join(source.root, definition.matrix));
  if (definition.id === "flight-control") {
    if (source.manifest.all_claims_pass !== true || !matrix.claims?.length || matrix.claims.some((claim) => claim.pass !== true)) throw new Error("flight-control claims are not all proven");
    return matrix.claims.length;
  }
  if (definition.id === "generalist") {
    if (matrix.ok !== true || matrix.privacy_scan !== "passed" || matrix.lanes !== 3 || source.manifest.lanes?.length !== 3) throw new Error("generalist package verification is incomplete");
    for (const lane of source.manifest.lanes) if (!lane.campaign_id || lane.initial_acceptance_exit_code === 0 || lane.final_acceptance_exit_code !== 0 || lane.adoption_exit_code !== 0 || lane.governance_tier !== "governed") throw new Error(`generalist lane ${lane.id ?? "unknown"} is incomplete`);
    return source.manifest.lanes.length * 3;
  }
  const checks = source.manifest.empirical_checks;
  if (!checks || Object.keys(checks).length < 1 || Object.values(checks).some((value) => value !== true)) throw new Error(`${definition.id} empirical checks are incomplete`);
  if (matrix.chapters?.some((chapter) => chapter.capture_ms > source.manifest.duration_ms)) throw new Error(`${definition.id} chapter exceeds its recorded duration`);
  return Object.keys(checks).length;
}

function page(catalog) {
  const cards = catalog.packages.map((entry, index) => `<article class="card" style="--i:${index}"><div class="tag">${escape(entry.eyebrow)} <span>${entry.claim_count} VERIFIED CLAIMS</span></div><video muted loop playsinline controls preload="metadata" poster=""><source src="${escape(entry.media)}" type="video/webm"></video><div class="copy"><h2>${escape(entry.title)}</h2><p>${escape(entry.description)}</p><div class="facts"><b>${entry.duration_ms ? `${(entry.duration_ms / 60000).toFixed(1)} min` : "multi-scene"}</b><b>${escape(entry.executor)}</b><b>sealed evidence</b></div><a href="${escape(entry.href)}">Open the full evidence package <span>→</span></a></div></article>`).join("\n");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Revoy2 — empirical product evidence</title><style>
@import url('https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=Manrope:wght@400;600;700&display=swap');
:root{--ink:#eef4ed;--muted:#8f9e95;--line:#27332d;--green:#9ad7a5;--amber:#e0b878;--bg:#070a08}*{box-sizing:border-box}body{margin:0;background:radial-gradient(ellipse at 50% 0,#17231c 0,#090d0a 40%,var(--bg) 75%);color:var(--ink);font-family:Manrope,sans-serif;min-height:100vh}body:before{content:"";position:fixed;inset:0;pointer-events:none;opacity:.16;background-image:linear-gradient(#72827718 1px,transparent 1px),linear-gradient(90deg,#72827718 1px,transparent 1px);background-size:48px 48px}.shell{width:min(1420px,calc(100% - 40px));margin:auto;padding:72px 0 96px}.kicker,.tag,.facts{font-family:"DM Mono",monospace;text-transform:uppercase;letter-spacing:.12em}.hero{display:grid;grid-template-columns:1.3fr .7fr;gap:64px;align-items:end;border-bottom:1px solid var(--line);padding-bottom:42px}.kicker{color:var(--green);font-size:12px}.hero h1{font-size:clamp(48px,7vw,104px);line-height:.91;letter-spacing:-.065em;margin:22px 0 0;max-width:980px}.hero p{font-size:18px;line-height:1.65;color:var(--muted);margin:0}.metric{color:var(--amber);font:500 52px/1 "DM Mono";display:block;margin-bottom:8px}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px;margin-top:28px}.card{border:1px solid var(--line);background:#0d120f;overflow:hidden;animation:up .7s calc(var(--i)*.12s) both}.card video{display:block;width:100%;aspect-ratio:16/9;object-fit:cover;background:#030504;border-bottom:1px solid var(--line)}.tag{display:flex;justify-content:space-between;padding:14px 16px;color:var(--green);font-size:10px}.tag span{color:var(--muted)}.copy{padding:24px}.copy h2{font-size:25px;line-height:1.15;letter-spacing:-.03em;margin:0 0 13px}.copy p{color:var(--muted);line-height:1.55;min-height:100px;margin:0}.facts{display:flex;gap:14px;flex-wrap:wrap;margin:22px 0;font-size:9px;color:#a9b7ae}.facts b{font-weight:400;border:1px solid var(--line);padding:7px 8px}.copy a{display:flex;justify-content:space-between;color:var(--ink);text-decoration:none;border-top:1px solid var(--line);padding-top:18px;font-weight:600}.copy a span{color:var(--green)}footer{display:flex;justify-content:space-between;color:var(--muted);font:11px "DM Mono";margin-top:28px}@keyframes up{from{opacity:0;transform:translateY(20px)}to{opacity:1;transform:none}}@media(max-width:900px){.hero{grid-template-columns:1fr}.grid{grid-template-columns:1fr}.copy p{min-height:0}.shell{padding-top:42px}}
</style></head><body><main class="shell"><section class="hero"><div><div class="kicker">REVOY2 / COMMERCIAL EVIDENCE PORTFOLIO</div><h1>Watch governed agents earn trust.</h1></div><p><span class="metric">${catalog.total_verified_claims}</span>empirically checked claims across cross-language coding, live self-hosting, browser-visible orchestration, and controlled multi-agent failure drills.</p></section><section class="grid">${cards}</section><footer><span>CHECKSUM-BOUND SOURCE PACKAGES</span><span>NO SIMULATED PRODUCT UI</span></footer></main></body></html>`;
}

export function buildExemplarPortfolio(options) {
  const runId = options.run_id;
  if (!RUN_ID.test(runId ?? "")) throw new Error("--run-id must be a safe non-empty identifier");
  const outputRoot = safeRoot(options.output_root ?? "/mnt/sda2/revoy2/portfolio");
  const output = join(outputRoot, runId);
  if (existsSync(output)) throw new Error(`portfolio output already exists: ${output}`);
  mkdirSync(output);
  const incomplete = join(output, ".incomplete");
  writeFileSync(incomplete, "publication in progress\n", { flag: "wx" });
  try {
    const inputs = [options.commercial, options.selfhost, options.webui, options.generalist];
    if (inputs.some((value) => !value)) throw new Error("--commercial, --selfhost, --webui, and --generalist are required");
    const sources = inputs.map(verifyPackage);
    const packages = REQUIRED.map((definition, index) => {
      const source = sources[index];
      const count = claimCount(definition, source);
      const indexPath = join(source.root, "index.html");
      const mediaPath = join(source.root, definition.media);
      if (!existsSync(indexPath) || !existsSync(mediaPath)) throw new Error(`${definition.id} publication media is missing`);
      return Object.freeze({ id: definition.id, title: definition.title, eyebrow: definition.eyebrow, description: definition.description, href: relativeLink(output, indexPath), media: relativeLink(output, mediaPath), source_manifest_sha256: source.manifest_sha256, source_revision: source.manifest.source_revision ?? "fixture-disclosed", duration_ms: source.manifest.duration_ms ?? null, executor: source.manifest.executor?.integration ?? (definition.id === "flight-control" ? "controlled fixture" : "provider-backed"), claim_count: count, verified: true });
    });
    const catalog = { schema_version: 1, product: "revoy2", artifact_kind: "commercial_exemplar_portfolio", run_id: runId, generated_at: new Date().toISOString(), all_packages_verified: true, total_verified_claims: packages.reduce((sum, entry) => sum + entry.claim_count, 0), packages };
    assertPortfolioContract(catalog);
    const catalogText = `${JSON.stringify(catalog, null, 2)}\n`;
    const html = page(catalog);
    assertSecretFree(catalogText, "commercial portfolio catalog");
    assertSecretFree(html, "commercial portfolio gallery");
    const catalogPath = join(output, "catalog.json");
    const indexPath = join(output, "index.html");
    writeFileSync(catalogPath, catalogText, { flag: "wx" });
    writeFileSync(indexPath, html, { flag: "wx" });
    const manifest = { schema_version: 1, product: "revoy2", artifact_kind: "commercial_exemplar_portfolio", run_id: runId, generated_at: catalog.generated_at, all_packages_verified: true, total_verified_claims: catalog.total_verified_claims, catalog_sha256: sha256Bytes(Buffer.from(catalogText)), source_manifests: packages.map((entry) => ({ id: entry.id, sha256: entry.source_manifest_sha256 })) };
    const sealed = writeManifestAndChecksums(output, manifest, [indexPath, catalogPath]);
    rmSync(incomplete);
    return Object.freeze({ run_directory: output, gallery: indexPath, manifest: sealed.manifest_path, checksums: sealed.checksums_path, total_verified_claims: catalog.total_verified_claims });
  } catch (error) {
    writeFileSync(join(output, "failure.txt"), "portfolio publication failed closed; inspect the invoking terminal\n", "utf8");
    throw error;
  }
}

function args(argv) {
  const value = (name, fallback) => { const index = argv.indexOf(name); return index < 0 ? fallback : argv[index + 1]; };
  return { run_id: value("--run-id"), output_root: value("--output-root", "/mnt/sda2/revoy2/portfolio"), commercial: value("--commercial"), selfhost: value("--selfhost"), webui: value("--webui"), generalist: value("--generalist") };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { process.stdout.write(`${JSON.stringify(buildExemplarPortfolio(args(process.argv.slice(2))), null, 2)}\n`); }
  catch (error) { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; }
}
