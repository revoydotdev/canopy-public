import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const cli = resolve(".agents/skills/revoy-map/scripts/revoy-map.mjs");

function run(args, cwd = process.cwd()) {
  return spawnSync(process.execPath, [cli, ...args], { cwd, encoding: "utf8" });
}

function nodes() {
  return [
    { id: "first", label: "<Ingress & user>", type: "frontend" },
    { id: "second", label: "Processor", type: "backend" },
    { id: "third", label: "Store", type: "database" }
  ];
}

function edges() {
  return [
    { id: "request", from: "first", to: "second", label: "HTTPS" },
    { id: "persist", from: "second", to: "third", label: "SQL" }
  ];
}

function fixture(type) {
  const meta = {
    title: "Independent " + type + " proof",
    animation: "trace",
    quality_profile: "showcase",
    views: [{ id: "primary", label: "Primary path", focus: ["first", "second", "third"] }]
  };
  if (type === "architecture") return { schema_version: 1, diagram_type: type, meta, components: nodes(), connections: edges(), boundaries: [], cards: [] };
  if (type === "workflow") return { schema_version: 1, diagram_type: type, meta, nodes: nodes(), edges: edges(), lanes: [], phases: [], groups: [], mainPath: ["first", "second", "third"], cards: [] };
  if (type === "sequence") return { schema_version: 1, diagram_type: type, meta, participants: nodes(), messages: edges(), segments: [], activations: [], cards: [] };
  if (type === "dataflow") return { schema_version: 1, diagram_type: type, meta, nodes: nodes(), flows: edges(), stages: [], cards: [] };
  return { schema_version: 1, diagram_type: type, meta, states: nodes(), transitions: edges(), lanes: [], cards: [] };
}

function writeFixture(type, dir, value = fixture(type)) {
  const path = join(dir, type + ".json");
  writeFileSync(path, JSON.stringify(value));
  return path;
}

describe("revoy-map renderer and compatibility surface", () => {
  for (const type of ["architecture", "workflow", "sequence", "dataflow", "lifecycle"]) {
    it("validates and deterministically renders " + type, () => {
      const dir = mkdtempSync(join(tmpdir(), "revoy-map-"));
      const input = writeFixture(type, dir);
      const outputA = join(dir, "a.html");
      const outputB = join(dir, "b.html");
      const validation = run(["validate", type, input, "--quality", "showcase", "--json"]);
      expect(validation.status).toBe(0);
      const receipt = JSON.parse(validation.stdout);
      expect(receipt.ok).toBe(true);
      expect(receipt.checks).toHaveLength(9);
      expect(receipt.checks.every((check) => check.ok)).toBe(true);
      expect(run(["render", type, input, outputA, "--json"]).status).toBe(0);
      expect(run(["render", type, input, outputB, "--json"]).status).toBe(0);
      const first = readFileSync(outputA, "utf8");
      expect(readFileSync(outputB, "utf8")).toBe(first);
      expect((first.match(/<svg\b/g) || [])).toHaveLength(1);
      expect(first).not.toMatch(/NaN|Infinity|<Ingress & user>/);
      expect(first).toContain("&lt;Ingress &amp; user&gt;");
      for (const format of ["svg", "png", "jpeg", "webp", "webm", "share"]) expect(first).toContain('data-export="' + format + '"');
      expect(first).toContain("function applyHash");
      expect(first).toContain("function exportArtifact");
      expect(first).toContain("captureStream");
    });
  }

  it("fails closed on unknown fields, duplicate ids, and dangling endpoints", () => {
    const dir = mkdtempSync(join(tmpdir(), "revoy-map-"));
    const value = fixture("architecture");
    value.colour = "green";
    value.components[1].id = "first";
    value.connections[0].to = "missing";
    const input = writeFixture("architecture", dir, value);
    const result = run(["validate", "architecture", input, "--json"]);
    expect(result.status).toBe(1);
    const codes = JSON.parse(result.stdout).diagnostics.map((diagnostic) => diagnostic.code);
    expect(codes).toContain("TOP_LEVEL_UNKNOWN");
    expect(codes).toContain("ID_DUPLICATE");
    expect(codes).toContain("ENDPOINT_MISSING");
  });

  it("fails showcase validation on overlapping authored geometry", () => {
    const dir = mkdtempSync(join(tmpdir(), "revoy-map-"));
    const value = fixture("architecture");
    value.components[0] = { ...value.components[0], x: 100, y: 100 };
    value.components[1] = { ...value.components[1], x: 120, y: 120 };
    const input = writeFixture("architecture", dir, value);
    const result = run(["validate", "architecture", input, "--json"]);
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout).diagnostics.map((item) => item.code)).toContain("LAYOUT_NODE_OVERLAP");
  });

  it("enforces deployment ownership and boundary crossing facts", () => {
    const dir = mkdtempSync(join(tmpdir(), "revoy-map-"));
    const value = fixture("architecture");
    value.meta.engineering_profile = "deployment-ownership";
    let input = writeFixture("architecture", dir, value);
    const failed = run(["validate", "architecture", input, "--json"]);
    expect(failed.status).toBe(1);
    const codes = JSON.parse(failed.stdout).diagnostics.map((diagnostic) => diagnostic.code);
    expect(codes).toContain("PROFILE_REGION_REQUIRED");
    expect(codes).toContain("PROFILE_SECURITY_GROUP_REQUIRED");
    expect(codes).toContain("PROFILE_OWNER_REQUIRED");
    value.components.forEach((component) => { component.tag = component.id === "third" ? "data" : "platform"; });
    value.boundaries = [
      { id: "region_a", label: "Region A", type: "region", members: ["first", "second", "third"] },
      { id: "private_data", label: "Private data", type: "security-group", members: ["third"] }
    ];
    input = writeFixture("architecture", dir, value);
    const passed = run(["validate", "architecture", input, "--json"]);
    expect(passed.status).toBe(0);
    expect(JSON.parse(passed.stdout).ok).toBe(true);
  });

  it("validates digest-pinned locally cached marks and embeds exact bytes", () => {
    const dir = mkdtempSync(join(tmpdir(), "revoy-map-brand-"));
    const bytes = Buffer.from("<svg xmlns=\"http://www.w3.org/2000/svg\"><rect width=\"8\" height=\"8\"/></svg>");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const cache = join(dir, ".revoy", "map-brands", sha256 + ".json");
    mkdirSync(dirname(cache), { recursive: true });
    writeFileSync(cache, JSON.stringify({ url: "https://assets.example.test/mark.svg", sha256, mediaType: "image/svg+xml", base64: bytes.toString("base64") }));
    const value = fixture("architecture");
    value.components[0].brand = { url: "https://assets.example.test/mark.svg", sha256 };
    const input = writeFixture("architecture", dir, value);
    const output = join(dir, "brand.html");
    expect(run(["render", "architecture", input, output, "--repo-root", dir, "--json"]).status).toBe(0);
    expect(readFileSync(output, "utf8")).toContain("data:image/svg+xml;base64,");
    value.components[0].brand.sha256 = "0".repeat(64);
    writeFileSync(input, JSON.stringify(value));
    const missing = run(["validate", "architecture", input, "--repo-root", dir, "--json"]);
    expect(missing.status).toBe(1);
    expect(JSON.parse(missing.stdout).diagnostics[0].code).toBe("BRAND_CACHE_MISSING");
  });

  it("localizes fixed viewer controls and resolves truthful legends", () => {
    const dir = mkdtempSync(join(tmpdir(), "revoy-map-i18n-"));
    const value = fixture("architecture");
    value.meta.locale = "zh-CN";
    value.meta.legend = { mode: "all", entries: { database: { label: "数据存储", visible: true } } };
    const input = writeFixture("architecture", dir, value);
    const output = join(dir, "localized.html");
    expect(run(["render", "architecture", input, output, "--json"]).status).toBe(0);
    const html = readFileSync(output, "utf8");
    expect(html).toContain('<html lang="zh-CN"');
    expect(html).toContain("查找…");
    expect(html).toContain("数据存储");
  });

  it("verifies repository origin, revision, blob, and line evidence before linking", () => {
    const dir = mkdtempSync(join(tmpdir(), "revoy-map-source-"));
    const git = (...args) => spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
    expect(git("init").status).toBe(0);
    expect(git("config", "user.email", "test@example.test").status).toBe(0);
    expect(git("config", "user.name", "Revoy Map Test").status).toBe(0);
    writeFileSync(join(dir, "service.ts"), "export function serve() {\n  return 'ok';\n}\n");
    expect(git("add", "service.ts").status).toBe(0);
    expect(git("commit", "-m", "fixture").status).toBe(0);
    expect(git("remote", "add", "origin", "https://github.com/revoy-test/source-proof.git").status).toBe(0);
    const revision = git("rev-parse", "HEAD").stdout.trim();
    const value = fixture("architecture");
    value.meta.repository = { url: "https://github.com/revoy-test/source-proof", revision };
    value.components[1].sources = [{ path: "service.ts", start_line: 1, end_line: 2, label: "service entry" }];
    const input = writeFixture("architecture", dir, value);
    const output = join(dir, "source.html");
    const result = run(["render", "architecture", input, output, "--repo-root", dir, "--json"], dir);
    expect(result.status).toBe(0);
    expect(readFileSync(output, "utf8")).toContain("/blob/" + revision + "/service.ts#L1-L2");
    value.components[1].sources[0].path = "missing.ts";
    writeFileSync(input, JSON.stringify(value));
    const missing = run(["validate", "architecture", input, "--repo-root", dir, "--json"], dir);
    expect(missing.status).toBe(1);
    expect(JSON.parse(missing.stdout).diagnostics.map((item) => item.code)).toContain("SOURCE_BLOB_MISSING");
  });

  it("rejects non-HTTPS mark acquisition before network access", () => {
    const result = run(["brands", "capture", "http://example.test/logo.svg", "--json"]);
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout).diagnostics[0].code).toBe("BRAND_URL_SCHEME");
  });

  it("delivers atomically with source and artifact receipts", () => {
    const dir = mkdtempSync(join(tmpdir(), "revoy-map-"));
    const input = writeFixture("architecture", dir);
    const output = join(dir, "map.html");
    const result = run(["deliver", "architecture", input, output, "--json"]);
    expect(result.status).toBe(0);
    const receipt = JSON.parse(result.stdout);
    expect(receipt.artifact.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(receipt.snapshot.path).toBe(join(dir, "map.source.json"));
    expect(readFileSync(output, "utf8")).toMatch(/^<!doctype html>/);
  });

  it("reports exact architecture delta categories", () => {
    const dir = mkdtempSync(join(tmpdir(), "revoy-map-"));
    const base = fixture("architecture");
    const head = structuredClone(base);
    head.components[1].label = "Changed processor";
    head.components[1].x = 410;
    head.components.push({ id: "fourth", label: "New sink", type: "external" });
    head.connections.push({ id: "new_route", from: "third", to: "fourth", label: "event" });
    const basePath = join(dir, "base.json");
    const headPath = join(dir, "head.json");
    const output = join(dir, "delta.html");
    writeFileSync(basePath, JSON.stringify(base));
    writeFileSync(headPath, JSON.stringify(head));
    const result = run(["compare", "architecture", basePath, headPath, output, "--json"]);
    expect(result.status).toBe(0);
    const delta = JSON.parse(result.stdout).delta;
    expect(delta.added).toEqual(["fourth"]);
    expect(delta.changed).toContain("second");
    expect(delta.moved).toContain("second");
  });

  it("rejects unsafe or non-HTML delivery targets", () => {
    const dir = mkdtempSync(join(tmpdir(), "revoy-map-"));
    const input = writeFixture("architecture", dir);
    const result = run(["deliver", "architecture", input, join(dir, "not-html.txt"), "--json"]);
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout).diagnostics[0].code).toBe("OUTPUT_EXTENSION");
  });
});
