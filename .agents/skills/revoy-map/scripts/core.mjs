import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const TYPES = ["architecture", "workflow", "sequence", "dataflow", "lifecycle"];
const TYPE_SET = new Set(TYPES);
const ID = /^[A-Za-z][A-Za-z0-9_-]*$/;
const HERE = dirname(fileURLToPath(import.meta.url));
const SKILL = resolve(HERE, "..");
const ALLOWED_TOP = {
  architecture: new Set(["schema_version", "diagram_type", "meta", "components", "connections", "boundaries", "cards"]),
  workflow: new Set(["schema_version", "diagram_type", "meta", "nodes", "edges", "lanes", "phases", "groups", "mainPath", "cards"]),
  sequence: new Set(["schema_version", "diagram_type", "meta", "participants", "messages", "segments", "activations", "cards"]),
  dataflow: new Set(["schema_version", "diagram_type", "meta", "nodes", "flows", "stages", "cards"]),
  lifecycle: new Set(["schema_version", "diagram_type", "meta", "states", "transitions", "lanes", "cards"])
};

export function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

function safeJson(value) {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
}

export function collections(type, spec) {
  if (type === "architecture") return { nodes: spec.components, edges: spec.connections, nodesKey: "components", edgesKey: "connections" };
  if (type === "workflow") return { nodes: spec.nodes, edges: spec.edges, nodesKey: "nodes", edgesKey: "edges" };
  if (type === "sequence") return { nodes: spec.participants, edges: spec.messages, nodesKey: "participants", edgesKey: "messages" };
  if (type === "dataflow") return { nodes: spec.nodes, edges: spec.flows, nodesKey: "nodes", edgesKey: "flows" };
  return { nodes: spec.states, edges: spec.transitions, nodesKey: "states", edgesKey: "transitions" };
}

function issue(code, message, subject, supportedFixes = []) {
  return { code, message, subject, supportedFixes };
}

function membership(boundaries, componentId, type) {
  return boundaries.filter((boundary) => boundary.type === type && boundary.members.includes(componentId));
}

function validateDeploymentProfile(spec, diagnostics) {
  if (spec.meta?.engineering_profile !== "deployment-ownership") return;
  const boundaries = Array.isArray(spec.boundaries) ? spec.boundaries : [];
  const regions = boundaries.filter((item) => item.type === "region");
  const groups = boundaries.filter((item) => item.type === "security-group");
  if (!regions.length) diagnostics.push(issue("PROFILE_REGION_REQUIRED", "deployment-ownership requires a region boundary", "boundaries", ["add a region boundary"]));
  if (!groups.length) diagnostics.push(issue("PROFILE_SECURITY_GROUP_REQUIRED", "deployment-ownership requires a security-group boundary", "boundaries", ["add a security-group boundary"]));
  for (const component of spec.components || []) {
    if (component.type === "external") continue;
    if (typeof component.tag !== "string" || !component.tag.trim()) diagnostics.push(issue("PROFILE_OWNER_REQUIRED", "non-external components require an owner in tag", component.id, ["add tag with the owning team"]));
    const componentRegions = membership(boundaries, component.id, "region");
    if (componentRegions.length !== 1) diagnostics.push(issue("PROFILE_REGION_MEMBERSHIP", "component must belong to exactly one region", component.id, ["add it to one region boundary"]));
    if (component.type === "database" && membership(boundaries, component.id, "security-group").length !== 1) diagnostics.push(issue("PROFILE_DATABASE_SCOPE", "database must belong to exactly one security group", component.id, ["add it to one security-group boundary"]));
  }
  const componentById = new Map((spec.components || []).map((item) => [item.id, item]));
  for (const relation of spec.connections || []) {
    const from = relation.from ?? relation.source;
    const to = relation.to ?? relation.target;
    if (!componentById.has(from) || !componentById.has(to)) continue;
    const regionA = membership(boundaries, from, "region").map((item) => item.id).join(",");
    const regionB = membership(boundaries, to, "region").map((item) => item.id).join(",");
    const groupA = membership(boundaries, from, "security-group").map((item) => item.id).join(",");
    const groupB = membership(boundaries, to, "security-group").map((item) => item.id).join(",");
    if ((regionA !== regionB || groupA !== groupB) && (typeof relation.label !== "string" || !relation.label.trim())) diagnostics.push(issue("PROFILE_CROSSING_LABEL", "boundary crossing requires its mechanism in label", relation.id || from + "->" + to, ["name the protocol, gateway, tunnel, queue, or replication mechanism"]));
  }
}

function brandCachePath(brand, root) {
  return resolve(root, ".revoy", "map-brands", brand.sha256 + ".json");
}

function validateBrand(brand, subject, diagnostics, root) {
  if (brand === undefined) return;
  if (!brand || typeof brand !== "object" || Array.isArray(brand) || typeof brand.url !== "string" || !/^https:\/\//.test(brand.url) || !/^[a-f0-9]{64}$/.test(brand.sha256 || "")) {
    diagnostics.push(issue("BRAND_PIN_INVALID", "brand must be a digest-pinned HTTPS capture", subject, ["run brands capture on an authorized official image URL"]));
    return;
  }
  const path = brandCachePath(brand, root);
  if (!existsSync(path)) {
    diagnostics.push(issue("BRAND_CACHE_MISSING", "digest-pinned brand bytes are absent from the local cache", subject, ["capture the URL on this machine", "remove brand"]));
    return;
  }
  try {
    const cached = JSON.parse(readFileSync(path, "utf8"));
    if (cached.url !== brand.url || cached.sha256 !== brand.sha256 || digest(Buffer.from(cached.base64, "base64")) !== brand.sha256) diagnostics.push(issue("BRAND_CACHE_CHANGED", "cached brand bytes or identity do not match the pin", subject, ["recapture and deliberately update the pin", "remove brand"]));
  } catch {
    diagnostics.push(issue("BRAND_CACHE_INVALID", "cached brand record is invalid", subject, ["recapture the authorized image"]));
  }
}

function normalizeRepositoryUrl(value) {
  return String(value || "").trim().replace(/^git@github\.com:/, "https://github.com/").replace(/\.git$/, "").replace(/\/$/, "").toLowerCase();
}

function git(root, args) {
  return spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
}

function validateRepositoryEvidence(spec, nodes, diagnostics, root) {
  const repository = spec.meta?.repository;
  const withSources = (nodes || []).filter((node) => node.sources !== undefined);
  if (!repository) {
    for (const node of withSources) diagnostics.push(issue("SOURCE_REPOSITORY_REQUIRED", "component sources require meta.repository", node.id, ["add a pinned repository", "remove sources"]));
    return;
  }
  if (spec.diagram_type !== "architecture") diagnostics.push(issue("SOURCE_ARCHITECTURE_ONLY", "repository evidence is supported only for architecture", "meta.repository", ["remove repository evidence"]));
  if (!/^https:\/\/github\.com\/[^/]+\/[^/]+(?:\.git)?$/.test(repository.url || "") || !/^[a-f0-9]{40}$/.test(repository.revision || "")) {
    diagnostics.push(issue("SOURCE_REPOSITORY_INVALID", "meta.repository requires a public GitHub URL and full commit SHA", "meta.repository", ["pin the canonical URL and 40-character revision"]));
    return;
  }
  const origin = git(root, ["remote", "get-url", "origin"]);
  if (origin.status !== 0 || normalizeRepositoryUrl(origin.stdout) !== normalizeRepositoryUrl(repository.url)) diagnostics.push(issue("SOURCE_ORIGIN_MISMATCH", "local Git origin does not match meta.repository", "meta.repository.url", ["use the matching checkout", "repair the canonical URL"]));
  if (git(root, ["cat-file", "-e", repository.revision + "^{commit}"]).status !== 0) diagnostics.push(issue("SOURCE_REVISION_MISSING", "pinned revision is unavailable locally", "meta.repository.revision", ["fetch the pinned revision"]));
  for (const node of withSources) {
    if (!Array.isArray(node.sources) || node.sources.length < 1 || node.sources.length > 3) {
      diagnostics.push(issue("SOURCE_LIST_INVALID", "sources must contain one to three entries", node.id, ["add one to three source records"]));
      continue;
    }
    for (const [index, source] of node.sources.entries()) {
      const subject = node.id + ".sources[" + index + "]";
      if (typeof source?.path !== "string" || !source.path || source.path.startsWith("/") || source.path.split("/").includes("..") || source.path.includes("\\")) {
        diagnostics.push(issue("SOURCE_PATH_INVALID", "source path must be a safe repository-relative POSIX path", subject, ["repair path"]));
        continue;
      }
      const blob = git(root, ["show", repository.revision + ":" + source.path]);
      if (blob.status !== 0) {
        diagnostics.push(issue("SOURCE_BLOB_MISSING", "Git cannot prove the source blob at the pinned revision", subject, ["repair the path or revision"]));
        continue;
      }
      const lineCount = blob.stdout.split("\n").length;
      if (source.start_line !== undefined && (!Number.isInteger(source.start_line) || source.start_line < 1 || source.start_line > lineCount)) diagnostics.push(issue("SOURCE_LINE_INVALID", "start_line is outside the pinned blob", subject, ["repair the line range"]));
      if (source.end_line !== undefined && (!Number.isInteger(source.end_line) || source.end_line < (source.start_line || 1) || source.end_line > lineCount)) diagnostics.push(issue("SOURCE_LINE_INVALID", "end_line is outside the pinned blob", subject, ["repair the line range"]));
    }
  }
}

export function validate(type, spec, options = {}) {
  const diagnostics = [];
  const root = resolve(options.repoRoot || process.cwd());
  if (!TYPE_SET.has(type)) return [issue("TYPE_UNKNOWN", "unsupported diagram type", type, ["choose " + TYPES.join(", ")])];
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) return [issue("IR_OBJECT", "input must be a JSON object", null, ["write one top-level object"])];
  for (const key of Object.keys(spec)) if (!ALLOWED_TOP[type].has(key)) diagnostics.push(issue("TOP_LEVEL_UNKNOWN", "unknown top-level field", key, ["remove or correct the field"]));
  if (spec.schema_version !== 1) diagnostics.push(issue("SCHEMA_VERSION", "schema_version must equal 1", "schema_version", ["set schema_version to 1"]));
  if (spec.diagram_type !== type) diagnostics.push(issue("TYPE_MISMATCH", "diagram_type must match command type", "diagram_type", ["set diagram_type to " + type]));
  if (!spec.meta || typeof spec.meta.title !== "string" || !spec.meta.title.trim()) diagnostics.push(issue("TITLE_REQUIRED", "meta.title must be non-empty", "meta.title", ["add a concise title"]));
  if (spec.meta?.viewBox && (!Array.isArray(spec.meta.viewBox) || spec.meta.viewBox.length !== 2 || spec.meta.viewBox.some((value) => !Number.isFinite(value) || value <= 0))) diagnostics.push(issue("VIEWBOX_INVALID", "meta.viewBox must be two positive finite numbers", "meta.viewBox", ["use [width,height]"]));
  if (spec.meta?.quality_profile && !["standard", "showcase"].includes(spec.meta.quality_profile)) diagnostics.push(issue("QUALITY_PROFILE", "unsupported quality profile", "meta.quality_profile", ["use standard or showcase"]));
  if (spec.meta?.visual_preset && !["classic", "signal-flow", "blueprint", "editorial"].includes(spec.meta.visual_preset)) diagnostics.push(issue("VISUAL_PRESET", "unsupported visual preset", "meta.visual_preset", ["choose a supported preset"]));
  if (spec.meta?.locale && !["en", "zh-CN"].includes(spec.meta.locale)) diagnostics.push(issue("LOCALE_UNSUPPORTED", "locale must be en or zh-CN", "meta.locale", ["use en", "use zh-CN", "omit for English fallback"]));
  if (spec.meta?.legend && (!["auto", "all", "hidden"].includes(spec.meta.legend.mode || "auto") || (spec.meta.legend.entries !== undefined && (!spec.meta.legend.entries || typeof spec.meta.legend.entries !== "object" || Array.isArray(spec.meta.legend.entries))))) diagnostics.push(issue("LEGEND_INVALID", "legend requires mode auto|all|hidden and object entries", "meta.legend", ["repair or remove legend"]));
  const { nodes, edges, nodesKey, edgesKey } = collections(type, spec);
  if (!Array.isArray(nodes) || nodes.length === 0) diagnostics.push(issue("NODES_REQUIRED", nodesKey + " must be a non-empty array", nodesKey, ["add at least one node"]));
  if (!Array.isArray(edges)) diagnostics.push(issue("EDGES_REQUIRED", edgesKey + " must be an array", edgesKey, ["add an empty array"]));
  const ids = new Set();
  for (const [index, node] of (nodes || []).entries()) {
    const subject = node?.id || nodesKey + "[" + index + "]";
    if (!node || !ID.test(node.id || "")) diagnostics.push(issue("ID_INVALID", "node id must be letter-prefixed and stable", subject, ["repair id"]));
    else if (ids.has(node.id)) diagnostics.push(issue("ID_DUPLICATE", "node id must be unique", node.id, ["rename one node and its endpoints"]));
    else ids.add(node.id);
    if (typeof node?.label !== "string" || !node.label.trim()) diagnostics.push(issue("LABEL_REQUIRED", "node label must be non-empty", subject, ["add a concise label"]));
    for (const key of ["x", "y", "width", "height"]) if (node?.[key] !== undefined && !Number.isFinite(node[key])) diagnostics.push(issue("GEOMETRY_INVALID", key + " must be finite", subject, ["remove for automatic layout", "use a finite number"]));
    validateBrand(node?.brand, subject, diagnostics, root);
  }
  const relationIds = new Set();
  for (const [index, relation] of (edges || []).entries()) {
    const from = relation?.from ?? relation?.source;
    const to = relation?.to ?? relation?.target;
    const subject = relation?.id || edgesKey + "[" + index + "]";
    if (!ids.has(from)) diagnostics.push(issue("ENDPOINT_MISSING", "source endpoint does not exist", subject, ["use an existing node id"]));
    if (!ids.has(to)) diagnostics.push(issue("ENDPOINT_MISSING", "target endpoint does not exist", subject, ["use an existing node id"]));
    if (relation?.id !== undefined) {
      if (!ID.test(relation.id)) diagnostics.push(issue("RELATION_ID_INVALID", "relationship id must be letter-prefixed", subject, ["repair id"]));
      else if (relationIds.has(relation.id)) diagnostics.push(issue("RELATION_ID_DUPLICATE", "relationship id must be unique", relation.id, ["rename one relationship"]));
      relationIds.add(relation.id);
    }
  }
  const views = spec.meta?.views || [];
  if (!Array.isArray(views) || views.length > 5) diagnostics.push(issue("VIEWS_INVALID", "meta.views must contain at most five entries", "meta.views", ["remove excess views"]));
  const viewIds = new Set();
  for (const view of Array.isArray(views) ? views : []) {
    if (!ID.test(view?.id || "") || viewIds.has(view.id) || !Array.isArray(view.focus) || !view.focus.length || view.focus.some((id) => !ids.has(id))) diagnostics.push(issue("VIEW_INVALID", "view needs a unique id and existing focus ids", view?.id || "meta.views", ["repair id and focus"]));
    viewIds.add(view?.id);
  }
  if (type === "architecture") {
    const boundaryIds = new Set();
    for (const boundary of spec.boundaries || []) {
      if (!ID.test(boundary?.id || "") || boundaryIds.has(boundary.id) || !Array.isArray(boundary.members) || boundary.members.some((id) => !ids.has(id))) diagnostics.push(issue("BOUNDARY_INVALID", "boundary needs a unique id and existing members", boundary?.id || "boundaries", ["repair id and members"]));
      boundaryIds.add(boundary?.id);
    }
    validateDeploymentProfile(spec, diagnostics);
  }
  validateRepositoryEvidence(spec, nodes, diagnostics, root);
  return diagnostics;
}

function dimensions(type, spec, count) {
  if (spec.meta?.viewBox) return spec.meta.viewBox;
  if (type === "sequence") return [Math.max(760, count * 180 + 120), 700];
  const columns = Math.max(1, Math.ceil(Math.sqrt(count)));
  return [Math.max(860, columns * 230 + 120), Math.max(600, Math.ceil(count / columns) * 170 + 220)];
}

function positionNodes(type, spec) {
  const source = collections(type, spec).nodes;
  const [width] = dimensions(type, spec, source.length);
  if (type === "sequence") {
    const gap = (width - 180) / Math.max(1, source.length - 1);
    return source.map((node, index) => ({ ...node, x: Number.isFinite(node.x) ? node.x : 90 + index * gap, y: Number.isFinite(node.y) ? node.y : 90, width: node.width || 140, height: node.height || 58 }));
  }
  const columns = Math.max(1, Math.ceil(Math.sqrt(source.length)));
  return source.map((node, index) => ({ ...node, x: Number.isFinite(node.x) ? node.x : 70 + (index % columns) * 230, y: Number.isFinite(node.y) ? node.y : 110 + Math.floor(index / columns) * 170, width: node.width || 174, height: node.height || 76 }));
}

function center(node) {
  return [node.x + node.width / 2, node.y + node.height / 2];
}

function route(a, b, sequence, index) {
  const spread = ((index % 5) - 2) * 5;
  const [rawAx, ay] = center(a);
  const [rawBx, by] = center(b);
  const ax = rawAx + spread;
  const bx = rawBx + spread;
  if (sequence) {
    const y = 200 + index * 58;
    return { d: "M " + ax + " " + y + " L " + bx + " " + y, labelX: (ax + bx) / 2, labelY: y - 10, points: [[ax, y], [bx, y]] };
  }
  if (Math.abs(by - ay) < 12 && bx < ax) {
    const startX = a.x;
    const endX = b.x + b.width;
    const trackY = Math.max(18, Math.min(a.y, b.y) - 30 - (index % 3) * 10);
    return { d: "M " + startX + " " + ay + " L " + startX + " " + trackY + " L " + endX + " " + trackY + " L " + endX + " " + by, labelX: (startX + endX) / 2, labelY: trackY - 8, points: [[startX, ay], [startX, trackY], [endX, trackY], [endX, by]] };
  }
  if (Math.abs(by - ay) > Math.abs(bx - ax)) {
    const startY = ay <= by ? a.y + a.height : a.y;
    const endY = ay <= by ? b.y : b.y + b.height;
    const midY = (startY + endY) / 2;
    return { d: "M " + ax + " " + startY + " L " + ax + " " + midY + " L " + bx + " " + midY + " L " + bx + " " + endY, labelX: (ax + bx) / 2, labelY: midY - 9, points: [[ax, startY], [ax, midY], [bx, midY], [bx, endY]] };
  }
  const startX = ax <= bx ? a.x + a.width : a.x;
  const endX = ax <= bx ? b.x : b.x + b.width;
  const midX = (startX + endX) / 2;
  return { d: "M " + startX + " " + ay + " L " + midX + " " + ay + " L " + midX + " " + by + " L " + endX + " " + by, labelX: midX, labelY: (ay + by) / 2 - 9, points: [[startX, ay], [midX, ay], [midX, by], [endX, by]] };
}

function loadBrand(brand, root) {
  if (!brand) return null;
  const cached = JSON.parse(readFileSync(brandCachePath(brand, root), "utf8"));
  return "data:" + cached.mediaType + ";base64," + cached.base64;
}

function segmentHitsRect(a, b, rect, padding = 3) {
  const left = rect.x - padding;
  const right = rect.x + rect.width + padding;
  const top = rect.y - padding;
  const bottom = rect.y + rect.height + padding;
  if (a[1] === b[1]) return a[1] > top && a[1] < bottom && Math.max(a[0], b[0]) > left && Math.min(a[0], b[0]) < right;
  if (a[0] === b[0]) return a[0] > left && a[0] < right && Math.max(a[1], b[1]) > top && Math.min(a[1], b[1]) < bottom;
  return false;
}

function properCrossing(a1, a2, b1, b2) {
  const aHorizontal = a1[1] === a2[1];
  const bHorizontal = b1[1] === b2[1];
  if (aHorizontal === bHorizontal) return false;
  const horizontal = aHorizontal ? [a1, a2] : [b1, b2];
  const vertical = aHorizontal ? [b1, b2] : [a1, a2];
  const x = vertical[0][0];
  const y = horizontal[0][1];
  return x > Math.min(horizontal[0][0], horizontal[1][0]) && x < Math.max(horizontal[0][0], horizontal[1][0]) && y > Math.min(vertical[0][1], vertical[1][1]) && y < Math.max(vertical[0][1], vertical[1][1]);
}

export function layoutDiagnostics(type, spec) {
  const diagnostics = [];
  const nodes = positionNodes(type, spec);
  const edges = collections(type, spec).edges;
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  for (let left = 0; left < nodes.length; left += 1) {
    for (let right = left + 1; right < nodes.length; right += 1) {
      const a = nodes[left];
      const b = nodes[right];
      if (a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y) diagnostics.push(issue("LAYOUT_NODE_OVERLAP", "node rectangles overlap", a.id + "/" + b.id, ["move one node", "remove explicit coordinates"]));
    }
  }
  const routed = edges.map((edge, index) => {
    const from = edge.from ?? edge.source;
    const to = edge.to ?? edge.target;
    return { edge, from, to, geometry: route(nodeById.get(from), nodeById.get(to), type === "sequence", index) };
  });
  for (const item of routed) {
    for (let index = 1; index < item.geometry.points.length; index += 1) {
      const a = item.geometry.points[index - 1];
      const b = item.geometry.points[index];
      for (const node of nodes) if (node.id !== item.from && node.id !== item.to && segmentHitsRect(a, b, node)) diagnostics.push(issue("LAYOUT_ROUTE_NODE", "relationship route intersects an unrelated node", (item.edge.id || item.from + "->" + item.to) + "/" + node.id, ["move the node", "simplify the relationship set"]));
    }
  }
  for (let left = 0; left < routed.length; left += 1) {
    for (let right = left + 1; right < routed.length; right += 1) {
      const a = routed[left];
      const b = routed[right];
      if ([a.from, a.to].some((id) => id === b.from || id === b.to)) continue;
      let crossed = false;
      for (let ai = 1; ai < a.geometry.points.length && !crossed; ai += 1) for (let bi = 1; bi < b.geometry.points.length; bi += 1) if (properCrossing(a.geometry.points[ai - 1], a.geometry.points[ai], b.geometry.points[bi - 1], b.geometry.points[bi])) { crossed = true; break; }
      if (crossed) diagnostics.push(issue("LAYOUT_RELATION_CROSSING", "unrelated relationships cross", (a.edge.id || left) + "/" + (b.edge.id || right), ["reorder or move nodes", "remove a low-value relationship"]));
    }
  }
  return diagnostics;
}

function boundaryMarkup(spec, nodeById) {
  return (spec.boundaries || []).map((boundary) => {
    const members = boundary.members.map((id) => nodeById.get(id)).filter(Boolean);
    if (!members.length) return "";
    const padding = 26;
    const left = Math.min(...members.map((node) => node.x)) - padding;
    const top = Math.min(...members.map((node) => node.y)) - padding;
    const right = Math.max(...members.map((node) => node.x + node.width)) + padding;
    const bottom = Math.max(...members.map((node) => node.y + node.height)) + padding;
    return '<g class="boundary boundary-' + escapeHtml(boundary.type || "default") + '" data-id="' + escapeHtml(boundary.id) + '"><rect x="' + left + '" y="' + top + '" width="' + (right - left) + '" height="' + (bottom - top) + '" rx="20"/><text x="' + (left + 12) + '" y="' + (top + 19) + '">' + escapeHtml(boundary.label) + "</text></g>";
  }).join("");
}

export function renderSvg(type, spec, options = {}) {
  const root = resolve(options.repoRoot || process.cwd());
  const nodes = positionNodes(type, spec);
  const edges = collections(type, spec).edges;
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const [width, height] = dimensions(type, spec, nodes.length);
  const relationships = edges.map((edge, index) => {
    const from = edge.from ?? edge.source;
    const to = edge.to ?? edge.target;
    const geometry = route(nodeById.get(from), nodeById.get(to), type === "sequence", index);
    const id = edge.id || "rel_" + index;
    return '<g class="relation relation-' + escapeHtml(edge.variant || "default") + '" data-id="' + escapeHtml(id) + '" data-from="' + escapeHtml(from) + '" data-to="' + escapeHtml(to) + '"><path d="' + geometry.d + '" marker-end="url(#arrow)"/>' + (edge.label ? '<text x="' + geometry.labelX + '" y="' + geometry.labelY + '" class="edge-label">' + escapeHtml(edge.label) + "</text>" : "") + "</g>";
  }).join("");
  const nodeMarkup = nodes.map((node) => {
    const brand = loadBrand(node.brand, root);
    const brandImage = brand ? '<image href="' + brand + '" x="' + (node.x + 12) + '" y="' + (node.y + 12) + '" width="24" height="24" preserveAspectRatio="xMidYMid meet"/>' : "";
    const textX = node.x + (brand ? 46 : 12);
    return '<g class="node node-' + escapeHtml(node.type || "default") + '" data-id="' + escapeHtml(node.id) + '" data-kind="' + escapeHtml(node.type || "default") + '" tabindex="0"><rect x="' + node.x + '" y="' + node.y + '" width="' + node.width + '" height="' + node.height + '" rx="14"/>' + brandImage + '<text x="' + textX + '" y="' + (node.y + 30) + '" class="node-label">' + escapeHtml(node.label) + "</text>" + (node.description ? '<text x="' + (node.x + 12) + '" y="' + (node.y + 54) + '" class="node-detail">' + escapeHtml(node.description).slice(0, 62) + "</text>" : "") + "</g>";
  }).join("");
  const lifelines = type === "sequence" ? nodes.map((node) => '<line class="lifeline" x1="' + center(node)[0] + '" y1="' + (node.y + node.height) + '" x2="' + center(node)[0] + '" y2="' + (height - 70) + '"/>').join("") : "";
  return '<svg id="revoy-map" xmlns="http://www.w3.org/2000/svg" role="img" aria-labelledby="map-title map-desc" viewBox="0 0 ' + width + " " + height + '"><title id="map-title">' + escapeHtml(spec.meta.title) + '</title><desc id="map-desc">Verified ' + escapeHtml(type) + ' system map</desc><defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z"/></marker></defs>' + boundaryMarkup(spec, nodeById) + relationships + lifelines + nodeMarkup + "</svg>";
}

export function renderHtml(type, spec, options = {}) {
  const css = readFileSync(resolve(SKILL, "assets", "viewer.css"), "utf8");
  const runtimeScript = readFileSync(resolve(SKILL, "assets", "viewer.mjs"), "utf8");
  const graph = collections(type, spec);
  const locale = spec.meta.locale || "en";
  const ui = locale === "zh-CN" ? { find: "查找…", upstream: "上游", downstream: "下游", route: "路径", views: "视图", lens: "语义", map: "概览", source: "源码", theme: "主题", style: "样式", present: "演示", export: "导出", select: "选择节点以检查已记录的可达关系。" } : { find: "Find…", upstream: "Upstream", downstream: "Downstream", route: "Route", views: "Views", lens: "Lens", map: "Map", source: "Source", theme: "Theme", style: "Style", present: "Present", export: "Export", select: "Select a node to inspect authored reach." };
  const repository = spec.meta.repository || null;
  const sourceUrl = (source) => repository ? repository.url.replace(/\.git$/, "") + "/blob/" + repository.revision + "/" + source.path + (source.start_line ? "#L" + source.start_line + (source.end_line ? "-L" + source.end_line : "") : "") : null;
  const model = {
    title: spec.meta.title,
    subtitle: spec.meta.subtitle || "",
    preset: spec.meta.visual_preset || "classic",
    animation: spec.meta.animation || "none",
    views: spec.meta.views || [],
    locale,
    ui,
    repository,
    nodes: graph.nodes.map((node) => ({ id: node.id, label: node.label, kind: node.type || "default", sources: (node.sources || []).map((source) => ({ ...source, url: sourceUrl(source) })) })),
    edges: graph.edges.map((edge, index) => ({ id: edge.id || "rel_" + index, from: edge.from ?? edge.source, to: edge.to ?? edge.target, label: edge.label || "" }))
  };
  const cards = (spec.cards || []).map((card) => '<article><h2>' + escapeHtml(card.title) + "</h2><p>" + escapeHtml(card.body || card.text || "") + "</p></article>").join("");
  const kinds = [...new Set(graph.nodes.map((node) => node.type || "default"))];
  const stableKinds = type === "lifecycle" ? ["start", "active", "waiting", "decision", "success", "failure", "neutral", "external"] : type === "sequence" ? ["default", "return", "security", "dashed", "emphasis"] : ["frontend", "backend", "database", "cloud", "security", "messagebus", "external", "default"];
  const legend = spec.meta.legend || { mode: "auto", entries: {} };
  const legendKinds = legend.mode === "hidden" ? [] : legend.mode === "all" ? stableKinds : kinds;
  const legendMarkup = legendKinds.filter((kind) => legend.entries?.[kind]?.visible !== false).map((kind) => '<span><i class="legend-swatch node-' + escapeHtml(kind) + '"></i>' + escapeHtml(legend.entries?.[kind]?.label || kind) + "</span>").join("");
  return '<!doctype html><html lang="' + escapeHtml(locale) + '" data-theme="dark" data-preset="' + escapeHtml(model.preset) + '"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + escapeHtml(spec.meta.title) + ' — Revoy Map</title><style>' + css + '</style></head><body' + (model.animation === "trace" ? ' class="trace"' : "") + '><header><h1>' + escapeHtml(spec.meta.title) + '</h1><input id="search" aria-label="' + escapeHtml(ui.find) + '" placeholder="' + escapeHtml(ui.find) + '"><button id="up">' + escapeHtml(ui.upstream) + '</button><button id="down">' + escapeHtml(ui.downstream) + '</button><button id="route">' + escapeHtml(ui.route) + '</button><select id="views"><option value="">' + escapeHtml(ui.views) + '</option></select><select id="lens"><option value="">' + escapeHtml(ui.lens) + '</option></select><button id="overview">' + escapeHtml(ui.map) + '</button><button id="source">' + escapeHtml(ui.source) + '</button><button id="theme">' + escapeHtml(ui.theme) + '</button><button id="preset">' + escapeHtml(ui.style) + '</button><button id="zoomIn">+</button><button id="zoomOut">−</button><button id="reset">0</button><button id="present">' + escapeHtml(ui.present) + '</button><details><summary>' + escapeHtml(ui.export) + '</summary><div class="export-menu"><button data-export="svg">SVG</button><button data-export="png">PNG</button><button data-export="jpeg">JPEG</button><button data-export="webp">WebP</button><button data-export="webm">WebM</button><button data-export="share">Share card</button></div></details></header><main><section class="stage">' + renderSvg(type, spec, options) + '</section>' + (legendMarkup ? '<aside class="legend">' + legendMarkup + "</aside>" : "") + '<div class="status" id="status">' + escapeHtml(ui.select) + '</div><section class="cards">' + cards + "</section></main><script>const MODEL=" + safeJson(model) + ";</script><script>" + runtimeScript + "</script></body></html>";
}

export function artifactChecks(html, diagnostics = []) {
  return [
    { name: "typed_ir", ok: diagnostics.length === 0 },
    { name: "single_svg", ok: (html.match(/<svg\b/g) || []).length === 1 },
    { name: "finite_svg", ok: !/NaN|Infinity/.test(html) },
    { name: "orthogonal_arrows", ok: !/<path[^>]+d="[^"]*[CQ]/.test(html) },
    { name: "label_safety", ok: !/<script>const MODEL=.*<\/script><script>.*<\/script><\/body>/s.test(html.replace(/\\u003c/g, "<")) || !/<\/script/i.test(JSON.stringify(html.match(/const MODEL=(.*?);<\/script>/s)?.[1] || "")) },
    { name: "referential_integrity", ok: diagnostics.length === 0 },
    { name: "viewer_runtime", ok: html.includes("data-export=\"webm\"") && html.includes("function applyHash") },
    { name: "canonical_export", ok: html.includes("function exportArtifact") },
    { name: "self_contained", ok: !/<script[^>]+src=|<link[^>]+href=/.test(html) }
  ];
}

export function buildReceipt(command, type, input, spec, html, output, diagnostics = []) {
  const checks = artifactChecks(html, diagnostics);
  return {
    schemaVersion: 1,
    ok: checks.every((check) => check.ok),
    command,
    type,
    input: resolve(input),
    output: output ? resolve(output) : undefined,
    checks,
    composition: { profile: spec.meta?.quality_profile || "standard", status: checks.every((check) => check.ok) ? "pass" : "fail", errors: checks.filter((check) => !check.ok).length },
    specification: { sha256: digest(Buffer.from(JSON.stringify(spec))), bytes: Buffer.byteLength(JSON.stringify(spec)) },
    artifact: { sha256: digest(Buffer.from(html)), bytes: Buffer.byteLength(html) },
    visualReview: "pending"
  };
}

export function atomicWrite(path, contents) {
  mkdirSync(dirname(path), { recursive: true });
  const temp = path + ".tmp-" + process.pid;
  writeFileSync(temp, contents, { flag: "wx" });
  renameSync(temp, path);
}

export function readSpec(path) {
  try {
    const bytes = readFileSync(path);
    return { value: JSON.parse(bytes.toString("utf8")), bytes };
  } catch (error) {
    return { error: issue("IR_PARSE", error.message, path, ["write valid UTF-8 JSON"]) };
  }
}

export function captureCachePath(sha256, root = process.cwd()) {
  return resolve(root, ".revoy", "map-brands", sha256 + ".json");
}
