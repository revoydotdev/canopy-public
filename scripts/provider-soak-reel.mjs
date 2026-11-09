#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const esc = (value) => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const sha = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const arg = (name, fallback = null) => { const at = process.argv.indexOf(name); return at < 0 ? fallback : process.argv[at + 1]; };

export function parseHeartbeat(text) {
  return text.split("\n").flatMap((line) => {
    const match = line.match(/live-provider-soak:\s+(\d+)s\s+·\s+identities\s+(\d+)\s+·\s+provider tokens\s+(\d+)/);
    return match ? [{ at_ms: Number(match[1]) * 1000, identities: Number(match[2]), provider_tokens: Number(match[3]) }] : [];
  });
}
export function validateProviderSoakReelInput(result, heartbeats) {
  if (result?.status !== "passed" || result?.termination !== "proof_threshold" || result?.evidence?.proven !== true) throw new Error("provider reel requires a passed proof-threshold result");
  if (!Array.isArray(result.evidence.model_identities) || result.evidence.model_identities.length === 0) throw new Error("provider reel requires a concrete model identity");
  const usage = result.evidence.provider_usage;
  if (usage?.counter_source !== "provider_counter" || !Number.isSafeInteger(usage.input_tokens) || !Number.isSafeInteger(usage.output_tokens) || usage.input_tokens + usage.output_tokens <= 0) throw new Error("provider reel requires positive provider-counter usage");
  if (heartbeats.length === 0 || heartbeats.some((item, index) => !Number.isSafeInteger(item.at_ms) || item.at_ms < 0 || (index > 0 && item.at_ms <= heartbeats[index - 1].at_ms))) throw new Error("provider reel requires an ordered real-time heartbeat timeline");
  return { duration_ms: Math.max(result.elapsed_ms, heartbeats.at(-1).at_ms + 1500) };
}
function frameSvg(second, durationSeconds, result, heartbeats) {
  const current = [...heartbeats].reverse().find((item) => item.at_ms <= second * 1000) ?? { identities: 0, provider_tokens: 0 };
  const proven = second * 1000 >= result.elapsed_ms;
  const model = result.evidence.model_identities[0];
  const progress = Math.min(1, second / Math.max(1, durationSeconds));
  const line = (x1, y1, x2, y2, start, end, color) => {
    const p = Math.max(0, Math.min(1, (progress - start) / (end - start)));
    const x = x1 + (x2 - x1) * p, y = y1 + (y2 - y1) * p;
    return `<path d="M${x1} ${y1} L${x} ${y}" stroke="${color}" stroke-width="3" fill="none" filter="url(#glow)"/>`;
  };
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900" viewBox="0 0 1600 900">
  <defs><filter id="glow"><feGaussianBlur stdDeviation="5" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter><linearGradient id="wash" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#07120f"/><stop offset=".55" stop-color="#030706"/><stop offset="1" stop-color="#0b1714"/></linearGradient></defs>
  <rect width="1600" height="900" fill="url(#wash)"/><path d="M0 710 C380 630 670 790 1030 690 S1400 620 1600 700" stroke="#18352d" fill="none"/><g opacity=".22">${Array.from({length:18},(_,i)=>`<circle cx="${80+i*91}" cy="${110+(i%4)*167}" r="1.5" fill="#9cb9af"/>`).join("")}</g>
  <text x="100" y="96" fill="#9adfba" font-family="ui-monospace,monospace" font-size="18" letter-spacing="5">REVOY2 / LIVE PROVIDER EVIDENCE</text>
  <text x="100" y="170" fill="#f2f4ed" font-family="Georgia,serif" font-size="55">Proof, not a process exit.</text>
  <text x="100" y="215" fill="#91a49d" font-family="ui-monospace,monospace" font-size="18">SERVER TRANSPORT · REAL-TIME · REV ${esc(String(result.source_revision).slice(0,12))}</text>
  <g>${line(165,450,470,450,0,.28,"#7ba993")}${line(470,450,770,330,.28,.62,current.identities?"#c1ef9f":"#496459")}${line(470,450,770,570,.28,.78,current.provider_tokens?"#e4bb73":"#496459")}${line(770,330,1110,450,.62,.96,proven?"#9fe6bf":"#5d8372")}${line(770,570,1110,450,.78,.96,proven?"#9fe6bf":"#5d8372")}</g>
  <g font-family="ui-monospace,monospace"><circle cx="165" cy="450" r="10" fill="#d9efe5" filter="url(#glow)"/><text x="135" y="493" fill="#8fa49b" font-size="15">START</text>
  <circle cx="470" cy="450" r="11" fill="${progress>.28?'#9adfba':'#31483f'}"/><text x="417" y="493" fill="#8fa49b" font-size="15">CAMPAIGN</text>
  <circle cx="770" cy="330" r="11" fill="${current.identities?'#c1ef9f':'#31483f'}"/><text x="808" y="326" fill="#d9e6df" font-size="17">MODEL IDENTITY</text><text x="808" y="354" fill="#82988f" font-size="14">${current.identities?esc(model):'awaiting durable record'}</text>
  <circle cx="770" cy="570" r="11" fill="${current.provider_tokens?'#e4bb73':'#31483f'}"/><text x="808" y="566" fill="#d9e6df" font-size="17">PROVIDER COUNTER</text><text x="808" y="594" fill="#82988f" font-size="14">${current.provider_tokens.toLocaleString()} attributed tokens</text>
  <circle cx="1110" cy="450" r="15" fill="${proven?'#d7ffb5':'#31483f'}" filter="url(#glow)"/><text x="1150" y="445" fill="#f2f4ed" font-size="22">${proven?'PROVEN':'CORRELATING'}</text><text x="1150" y="476" fill="#82988f" font-size="14">same campaign · checksummed stores</text></g>
  <g transform="translate(100 742)" font-family="ui-monospace,monospace"><rect width="1400" height="82" rx="8" fill="#0b1714" stroke="#24443a"/><text x="28" y="34" fill="#82988f" font-size="14">ELAPSED</text><text x="28" y="62" fill="#f2f4ed" font-size="22">${String(second).padStart(2,'0')}s</text><text x="210" y="34" fill="#82988f" font-size="14">TRANSPORT</text><text x="210" y="62" fill="#f2f4ed" font-size="22">SERVER</text><text x="430" y="34" fill="#82988f" font-size="14">INPUT / OUTPUT</text><text x="430" y="62" fill="#f2f4ed" font-size="22">${proven?`${result.evidence.provider_usage.input_tokens} / ${result.evidence.provider_usage.output_tokens}`:'— / —'}</text><text x="720" y="34" fill="#82988f" font-size="14">TERMINATION</text><text x="720" y="62" fill="${proven?'#c1ef9f':'#f2f4ed'}" font-size="22">${proven?'PROOF THRESHOLD':'RUNNING'}</text><text x="1120" y="34" fill="#82988f" font-size="14">STATUS</text><text x="1120" y="62" fill="${proven?'#c1ef9f':'#e4bb73'}" font-size="22">${proven?'PASS':'LIVE'}</text></g>
  </svg>`;
}
export function renderProviderSoakReel({ resultPath, heartbeatPath, outputDir }) {
  const result = JSON.parse(readFileSync(resultPath, "utf8"));
  const heartbeats = parseHeartbeat(readFileSync(heartbeatPath, "utf8"));
  const { duration_ms } = validateProviderSoakReelInput(result, heartbeats);
  mkdirSync(outputDir, { recursive: true }); const frames = join(outputDir, ".frames"); rmSync(frames,{recursive:true,force:true}); mkdirSync(frames);
  const durationSeconds = Math.max(1, Math.ceil(duration_ms/1000));
  for(let second=0;second<=durationSeconds;second++) writeFileSync(join(frames,`frame-${String(second).padStart(6,"0")}.svg`),frameSvg(second,durationSeconds,result,heartbeats));
  const media=join(outputDir,"provider-proof.webm"); const ff=spawnSync("ffmpeg",["-hide_banner","-loglevel","error","-y","-framerate","1","-i",join(frames,"frame-%06d.svg"),"-c:v","libvpx-vp9","-deadline","good","-cpu-used","4","-crf","30","-b:v","0","-pix_fmt","yuv420p","-r","30",media],{encoding:"utf8"}); rmSync(frames,{recursive:true,force:true}); if(ff.status!==0) throw new Error(ff.stderr||"ffmpeg failed");
  const manifest={schema_version:1,kind:"live_provider_evidence_reel",source_revision:result.source_revision,duration_ms,source_result:basename(resultPath),source_heartbeat:basename(heartbeatPath),campaign_ids:result.evidence.campaign_ids,model_identities:result.evidence.model_identities,provider_usage:result.evidence.provider_usage,termination:result.termination,media:basename(media)};
  writeFileSync(join(outputDir,"reel-manifest.json"),`${JSON.stringify(manifest,null,2)}\n`);
  writeFileSync(join(outputDir,"index.html"),`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Revoy2 live provider proof</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#030706;color:#edf3ed;font:16px Georgia,serif}main{width:min(1100px,94vw)}video{width:100%;border:1px solid #24443a;box-shadow:0 30px 100px #000}p{color:#91a49d;max-width:70ch}code{color:#bceaa4}</style></head><body><main><video controls autoplay muted loop src="provider-proof.webm"></video><h1>Live provider evidence</h1><p>A real-time replay derived from durable model-identity and provider-counter records. Process exit alone cannot produce this artifact.</p><code>${esc(result.source_revision)}</code></main></body></html>`);
  const assets=[media,join(outputDir,"reel-manifest.json"),join(outputDir,"index.html"),resultPath,heartbeatPath].filter(existsSync); writeFileSync(join(outputDir,"SHA256SUMS"),assets.map((path)=>`${sha(path)}  ${basename(path)}`).join("\n")+"\n"); return manifest;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){const resultPath=resolve(arg("--result")??"");const heartbeatPath=resolve(arg("--heartbeat")??"");const outputDir=resolve(arg("--output",dirname(resultPath)));if(!arg("--result")||!arg("--heartbeat"))throw new Error("--result and --heartbeat are required");console.log(JSON.stringify(renderProviderSoakReel({resultPath,heartbeatPath,outputDir}),null,2));}
