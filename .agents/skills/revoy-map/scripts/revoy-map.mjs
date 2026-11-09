#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, watch, writeFileSync } from "node:fs";
import { basename, dirname, extname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  TYPES,
  artifactChecks,
  atomicWrite,
  buildReceipt,
  captureCachePath,
  collections,
  digest,
  layoutDiagnostics,
  readSpec,
  renderHtml,
  validate
} from "./core.mjs";

function parse(values) {
  const options = {};
  const positional = [];
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) {
      positional.push(value);
      continue;
    }
    const key = value.slice(2);
    if (["json", "open", "no-open"].includes(key)) options[key] = true;
    else options[key] = values[++index];
  }
  return { options, positional };
}

const { options, positional } = parse(process.argv.slice(2));
const jsonMode = options.json === true;
const CLI_DIR = dirname(fileURLToPath(import.meta.url));

function emit(value) {
  if (jsonMode) process.stdout.write(JSON.stringify(value) + "\n");
  else if (typeof value === "string") process.stdout.write(value + "\n");
  else if (Array.isArray(value)) process.stdout.write(value.join("\n") + "\n");
  else process.stdout.write(Object.entries(value).map(([key, item]) => key + ": " + (typeof item === "object" ? JSON.stringify(item) : item)).join("\n") + "\n");
}

function fail(code, message, subject = null, supportedFixes = [], exitCode = 1) {
  const value = { schemaVersion: 1, ok: false, diagnostics: [{ code, message, subject, supportedFixes }] };
  if (jsonMode) process.stdout.write(JSON.stringify(value) + "\n");
  else process.stderr.write(code + ": " + message + (subject ? " [" + subject + "]" : "") + "\n");
  process.exitCode = exitCode;
  return null;
}

function outputPath(path, fallback) {
  const resolved = resolve(path || fallback);
  if (extname(resolved).toLowerCase() !== ".html") return fail("OUTPUT_EXTENSION", "output must end in .html", resolved, ["choose an HTML file path"]);
  if (resolved === resolve("/") || resolved === resolve(process.cwd())) return fail("OUTPUT_UNSAFE", "refusing a broad output target", resolved, ["choose a file path"]);
  return resolved;
}

function compile(type, input) {
  const loaded = readSpec(input);
  if (loaded.error) return fail(loaded.error.code, loaded.error.message, loaded.error.subject, loaded.error.supportedFixes);
  if (options.quality) loaded.value.meta = { ...(loaded.value.meta || {}), quality_profile: options.quality };
  const diagnostics = validate(type, loaded.value, { repoRoot: options["repo-root"] || process.cwd() });
  if (diagnostics.length === 0 && loaded.value.meta?.quality_profile === "showcase") diagnostics.push(...layoutDiagnostics(type, loaded.value));
  if (diagnostics.length) {
    const value = { schemaVersion: 1, ok: false, command: "validate", type, input: resolve(input), diagnostics };
    if (jsonMode) process.stdout.write(JSON.stringify(value) + "\n");
    else diagnostics.forEach((diagnostic) => process.stderr.write(diagnostic.code + ": " + diagnostic.message + " [" + diagnostic.subject + "]\n"));
    process.exitCode = 1;
    return null;
  }
  const html = renderHtml(type, loaded.value, { repoRoot: options["repo-root"] || process.cwd() });
  return { ...loaded, html };
}

function chromium() {
  return [
    process.env.CHROME_PATH,
    "/opt/google/chrome-beta/chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser"
  ].filter(Boolean).find((path) => existsSync(path));
}

async function captureBrand(url) {
  let parsed;
  try { parsed = new URL(url); } catch { return fail("BRAND_URL_INVALID", "brand capture requires an absolute URL", url); }
  if (parsed.protocol !== "https:") return fail("BRAND_URL_SCHEME", "brand capture requires HTTPS", url, ["use the official HTTPS direct image URL"]);
  let response;
  try { response = await fetch(parsed, { redirect: "follow", signal: AbortSignal.timeout(15000) }); } catch (error) { return fail("BRAND_FETCH", error.message, url); }
  if (!response.ok) return fail("BRAND_FETCH_STATUS", "brand image request returned HTTP " + response.status, url);
  const mediaType = (response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  const allowed = new Set(["image/svg+xml", "image/png", "image/jpeg", "image/webp"]);
  if (!allowed.has(mediaType)) return fail("BRAND_MEDIA_TYPE", "unsupported brand image media type", mediaType, ["use SVG, PNG, JPEG, or WebP"]);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length || bytes.length > 262144) return fail("BRAND_SIZE", "brand image must be between 1 byte and 256 KiB", String(bytes.length), ["use a smaller official mark"]);
  if (mediaType === "image/svg+xml") {
    const source = bytes.toString("utf8");
    if (/<script\b|on[a-z]+\s*=|<foreignObject\b|(?:href|src)\s*=\s*["'](?:https?:|data:)/i.test(source)) return fail("BRAND_SVG_UNSAFE", "SVG contains executable or external content", url, ["use a self-contained inert official SVG", "use PNG"]);
  }
  const sha256 = digest(bytes);
  const path = captureCachePath(sha256, options["repo-root"] || process.cwd());
  mkdirSync(dirname(path), { recursive: true });
  const record = { schemaVersion: 1, url: response.url, requestedUrl: url, sha256, mediaType, bytes: bytes.length, capturedAt: new Date().toISOString(), base64: bytes.toString("base64") };
  atomicWrite(path, JSON.stringify(record, null, 2) + "\n");
  emit({ ok: true, command: "brands capture", brand: { url: response.url, sha256 }, mediaType, bytes: bytes.length, cache: path });
}

function architectureDelta(base, head) {
  const index = (items) => new Map(items.map((item) => [item.id, item]));
  const a = index(base.components);
  const b = index(head.components);
  const added = [...b.keys()].filter((id) => !a.has(id));
  const removed = [...a.keys()].filter((id) => !b.has(id));
  const withoutPosition = (item) => {
    const copy = { ...item };
    delete copy.x;
    delete copy.y;
    return copy;
  };
  const changed = [...b.keys()].filter((id) => a.has(id) && JSON.stringify(withoutPosition(a.get(id))) !== JSON.stringify(withoutPosition(b.get(id))));
  const moved = [...b.keys()].filter((id) => a.has(id) && (a.get(id).x !== b.get(id).x || a.get(id).y !== b.get(id).y));
  const relationId = (item) => item.id || (item.from ?? item.source) + "->" + (item.to ?? item.target);
  const ae = index(base.connections.map((item) => ({ ...item, id: relationId(item) })));
  const be = index(head.connections.map((item) => ({ ...item, id: relationId(item) })));
  const rerouted = [...be.keys()].filter((id) => ae.has(id) && ((ae.get(id).from ?? ae.get(id).source) !== (be.get(id).from ?? be.get(id).source) || (ae.get(id).to ?? ae.get(id).target) !== (be.get(id).to ?? be.get(id).target)));
  return { added, removed, changed, moved, rerouted };
}

async function run() {
  const command = positional[0];
  if (!command || command === "help") {
    emit([
      "Revoy Map",
      "render|validate|deliver|inspect|check|compare|preview|visual-check|guide|brands|examples|doctor|demo",
      "types: " + TYPES.join(", ")
    ]);
    return;
  }
  if (command === "doctor") {
    const browser = chromium();
    emit({ ok: true, runtime: process.version, renderer: "ready", dependencies: 0, browser: browser || "unavailable", types: TYPES });
    return;
  }
  if (command === "guide") {
    const query = positional.slice(1).join(" ").toLowerCase();
    const type = /state|lifecycle|retry|terminal|cancel/.test(query) ? "lifecycle" : /sequence|request|call|cache|latency/.test(query) ? "sequence" : /data|etl|pipeline|lineage|stream/.test(query) ? "dataflow" : /workflow|ci|approval|runbook|process/.test(query) ? "workflow" : "architecture";
    emit({ ok: true, mode: "recommendation", query, confidence: query ? "high" : "low", recommendation: { type, question: type === "sequence" ? "Who calls whom, in what order, and what returns?" : "Which authored facts and relationships must the map explain?" } });
    return;
  }
  if (command === "examples") {
    emit(TYPES.map((type) => type + ": schema_version, diagram_type, meta.title, semantic nodes, relationships"));
    return;
  }
  if (command === "brands") {
    if (positional[1] === "capture") {
      if (!positional[2]) return fail("BRAND_URL_REQUIRED", "brands capture requires an official direct image URL", "brands capture");
      await captureBrand(positional[2]);
      return;
    }
    const query = (positional.slice(1).join(" ") || "").toLowerCase();
    const dir = resolve(options["repo-root"] || process.cwd(), ".revoy", "map-brands");
    const matches = [];
    if (existsSync(dir)) {
      const { readdirSync } = await import("node:fs");
      for (const filename of readdirSync(dir).filter((name) => name.endsWith(".json"))) {
        try {
          const record = JSON.parse(readFileSync(resolve(dir, filename), "utf8"));
          if (!query || record.url.toLowerCase().includes(query)) matches.push({ url: record.url, sha256: record.sha256, mediaType: record.mediaType });
        } catch {}
      }
    }
    emit({ ok: true, query, matches });
    return;
  }
  if (command === "demo") {
    const dir = resolve(positional[1] || "revoy-map-demo");
    mkdirSync(dir, { recursive: true });
    const spec = { schema_version: 1, diagram_type: "architecture", meta: { title: "Revoy Map Demo", animation: "trace", quality_profile: "showcase" }, components: [{ id: "client", label: "Client", type: "frontend" }, { id: "service", label: "Service", type: "backend" }, { id: "store", label: "Store", type: "database" }], connections: [{ id: "request", from: "client", to: "service", label: "HTTPS" }, { id: "persist", from: "service", to: "store", label: "SQL" }] };
    const input = resolve(dir, "demo.architecture.json");
    const output = resolve(dir, "demo.html");
    atomicWrite(input, JSON.stringify(spec, null, 2) + "\n");
    atomicWrite(output, renderHtml("architecture", spec));
    emit({ ok: true, input, output });
    return;
  }
  if (command === "check") {
    const path = resolve(positional[1] || "");
    if (!existsSync(path)) return fail("ARTIFACT_READ", "HTML artifact does not exist", path);
    const html = readFileSync(path, "utf8");
    const checks = artifactChecks(html);
    const ok = checks.every((check) => check.ok);
    emit({ ok, command, path, checks });
    if (!ok) process.exitCode = 1;
    return;
  }
  if (command === "visual-check") {
    const input = resolve(positional[1] || "");
    if (!existsSync(input)) return fail("ARTIFACT_READ", "HTML artifact does not exist", input);
    const sourceHtml = readFileSync(input, "utf8");
    const modelText = sourceHtml.match(/const MODEL=(.*?);<\/script>/s)?.[1];
    let firstEdge = null;
    try { firstEdge = JSON.parse(modelText).edges[0] || null; } catch {}
    const browser = chromium();
    if (!browser) return fail("BROWSER_UNAVAILABLE", "Chrome or Chromium is unavailable", input, ["set CHROME_PATH"], 2);
    const captures = [];
    for (const [width, height] of [[1440, 900], [1600, 1000], [1920, 1080], [2048, 1320]]) {
      const screenshot = input.replace(/\.html$/i, ".visual-" + width + "x" + height + ".png");
      const common = ["--headless", "--no-sandbox", "--disable-gpu", "--hide-scrollbars", "--window-size=" + width + "," + height, "--virtual-time-budget=1500"];
      const shot = spawnSync(browser, common.concat(["--screenshot=" + screenshot, pathToFileURL(input).href]), { encoding: "utf8" });
      const dom = spawnSync(browser, common.concat(["--dump-dom", pathToFileURL(input).href]), { encoding: "utf8" });
      const contained = /data-contained="true"/.test(dom.stdout);
      const runtimeReady = /data-runtime-ready="true"/.test(dom.stdout);
      const mediaRecorder = /data-media-recorder="true"/.test(dom.stdout);
      let routeRestored = null;
      if (firstEdge && width === 1440) {
        const routeUrl = pathToFileURL(input).href + "#route=" + encodeURIComponent(firstEdge.from + "~" + firstEdge.to);
        const routedDom = spawnSync(browser, common.concat(["--dump-dom", routeUrl]), { encoding: "utf8" }).stdout;
        const escapedId = firstEdge.from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        routeRestored = new RegExp('class="[^"]*active[^"]*" data-id="' + escapedId + '"').test(routedDom);
      }
      captures.push({ width, height, screenshot, captured: shot.status === 0 && existsSync(screenshot), contained, runtimeReady, mediaRecorder, routeRestored, scrollWidth: Number(dom.stdout.match(/data-scroll-width="(\d+)"/)?.[1] || 0), scrollHeight: Number(dom.stdout.match(/data-scroll-height="(\d+)"/)?.[1] || 0) });
    }
    const smokeRun = spawnSync(process.execPath, [resolve(CLI_DIR, "browser-smoke.mjs"), browser, input], { encoding: "utf8" });
    let exportSmoke = { ok: false, error: smokeRun.stderr || "invalid browser smoke receipt" };
    try { exportSmoke = JSON.parse(smokeRun.stdout); } catch {}
    const ok = captures.every((item) => item.captured && item.contained && item.runtimeReady && item.mediaRecorder && item.routeRestored !== false) && smokeRun.status === 0 && exportSmoke.ok === true;
    emit({ ok, command, status: ok ? "captured-contained-and-exported" : "failed", browser, captures, exportSmoke, visualReview: "pending" });
    if (!ok) process.exitCode = 1;
    return;
  }
  if (command === "compare") {
    if (positional[1] !== "architecture") return fail("COMPARE_TYPE", "compare currently requires architecture", positional[1], ["use compare architecture"]);
    const basePath = positional[2];
    const headPath = positional[3];
    const output = outputPath(positional[4], "architecture-delta.html");
    if (!basePath || !headPath || !output) return fail("COMPARE_INPUT", "compare requires base, head, and optional output paths", "compare");
    const base = readSpec(basePath);
    const head = readSpec(headPath);
    if (base.error || head.error) return fail("COMPARE_PARSE", "base and head must be valid JSON", base.error ? basePath : headPath);
    const diagnostics = validate("architecture", base.value).concat(validate("architecture", head.value));
    if (diagnostics.length) return fail("COMPARE_INVALID", "base or head failed validation", diagnostics[0].subject, diagnostics[0].supportedFixes);
    const delta = architectureDelta(base.value, head.value);
    const spec = { ...head.value, meta: { ...head.value.meta, title: head.value.meta.title + " — Delta" }, cards: [{ title: "Added", body: delta.added.join(", ") || "None" }, { title: "Removed", body: delta.removed.join(", ") || "None" }, { title: "Changed", body: delta.changed.join(", ") || "None" }, { title: "Moved / rerouted", body: (delta.moved.join(", ") || "none") + " · " + (delta.rerouted.join(", ") || "none") }] };
    const html = renderHtml("architecture", spec);
    atomicWrite(output, html);
    emit({ ok: true, command, type: "architecture", output, delta, artifact: { sha256: digest(Buffer.from(html)), bytes: Buffer.byteLength(html) } });
    return;
  }
  const type = positional[1];
  const input = positional[2];
  if (!TYPES.includes(type)) return fail("TYPE_UNKNOWN", "unsupported diagram type", type, ["choose " + TYPES.join(", ")]);
  if (!input) return fail("INPUT_REQUIRED", "input JSON path is required", command);
  const built = compile(type, input);
  if (!built) return;
  if (command === "validate") {
    emit(buildReceipt(command, type, input, built.value, built.html));
    return;
  }
  if (command === "inspect") {
    const graph = collections(type, built.value);
    emit({ ok: true, command, type, title: built.value.meta.title, nodes: graph.nodes.length, relationships: graph.edges.length, views: built.value.meta.views?.length || 0, engineeringProfile: built.value.meta.engineering_profile || null });
    return;
  }
  const fallback = resolve(dirname(input), basename(input, extname(input)) + ".html");
  const output = outputPath(positional[3] || built.value.meta?.output, fallback);
  if (!output) return;
  if (command === "render") {
    atomicWrite(output, built.html);
    emit(buildReceipt(command, type, input, built.value, built.html, output));
    return;
  }
  if (command === "deliver") {
    const normalized = JSON.stringify(built.value, null, 2) + "\n";
    const snapshot = output.replace(/\.html$/i, ".source.json");
    atomicWrite(snapshot, normalized);
    atomicWrite(output, built.html);
    const receipt = buildReceipt(command, type, input, built.value, built.html, output);
    receipt.snapshot = { path: snapshot, sha256: digest(Buffer.from(normalized)), bytes: Buffer.byteLength(normalized) };
    emit(receipt);
    return;
  }
  if (command === "preview") {
    atomicWrite(output, built.html);
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      response.end(readFileSync(output));
    });
    server.listen(0, "127.0.0.1", () => emit({ ok: true, command, url: "http://127.0.0.1:" + server.address().port + "/", input: resolve(input), output }));
    watch(resolve(input), { persistent: true }, () => {
      const next = compile(type, input);
      if (next) atomicWrite(output, next.html);
    });
    return;
  }
  return fail("COMMAND_UNKNOWN", "unsupported command", command, ["run without arguments for help"]);
}

await run();
