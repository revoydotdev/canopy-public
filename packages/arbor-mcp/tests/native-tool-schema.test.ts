import { describe, expect, it } from "vitest";
import { NATIVE_BUS_THREAD_MODEL_TOOLS, NATIVE_PLANNING_MODEL_TOOLS, NATIVE_REPOSITORY_MODEL_TOOLS } from "../src/cli.js";
import { NATIVE_IMAGE_TOOL_RISKS, NATIVE_REPOSITORY_TOOL_RISKS, NATIVE_SKILL_TOOL_RISKS, NATIVE_USERINPUT_TOOL_RISKS } from "../src/native-tool-host.js";
import { NATIVE_SUBAGENT_TOOL_RISKS } from "../src/native-agent-executor.js";
import { NATIVE_WEB_TOOL_RISKS } from "../src/native-web-tools.js";
import { NATIVE_BROWSER_TOOL_RISKS } from "../src/native-browser-tools.js";
import { NATIVE_TOOL_RISK_MANIFEST } from "../src/native-capability-manifest.js";

// WA-13 / J8-01: shell.execute and verification.run were implemented and
// sandboxed by the tool host but never appeared in any model-tool catalog,
// so the native model could never request them. This is a drift guard, not
// just a point fix: every tool the host risk-classifies (and therefore is
// prepared to execute) must be advertised to the model in at least one of
// the three catalogs, or be named here with a reason. Keep this set empty
// unless a tool is genuinely host-internal (never model-callable).
const EXCLUDED_FROM_MODEL_ADVERTISEMENT: readonly string[] = [];

describe("native model tool catalog parity with the repository tool host", () => {
  it("derives hosted and advertised tool risks from the MCP capability manifest", () => {
    const manifestRisks = Object.assign({}, ...Object.values(NATIVE_TOOL_RISK_MANIFEST)) as Record<string, string>;
    const advertised = [
      ...NATIVE_REPOSITORY_MODEL_TOOLS,
      ...NATIVE_PLANNING_MODEL_TOOLS,
      ...NATIVE_BUS_THREAD_MODEL_TOOLS,
    ];
    for (const tool of advertised) {
      expect(manifestRisks[tool.name], `${tool.name} risk is declared by the manifest`).toBe(tool.risk);
    }
    expect(NATIVE_REPOSITORY_TOOL_RISKS).toBe(NATIVE_TOOL_RISK_MANIFEST.repository);
    expect(NATIVE_SUBAGENT_TOOL_RISKS).toBe(NATIVE_TOOL_RISK_MANIFEST.subagent);
    expect(NATIVE_SKILL_TOOL_RISKS).toBe(NATIVE_TOOL_RISK_MANIFEST.skill);
    expect(NATIVE_USERINPUT_TOOL_RISKS).toBe(NATIVE_TOOL_RISK_MANIFEST.userinput);
    expect(NATIVE_WEB_TOOL_RISKS).toBe(NATIVE_TOOL_RISK_MANIFEST.web);
    expect(NATIVE_BROWSER_TOOL_RISKS).toBe(NATIVE_TOOL_RISK_MANIFEST.browser);
    expect(NATIVE_IMAGE_TOOL_RISKS).toBe(NATIVE_TOOL_RISK_MANIFEST.image);
  });

  it("advertises every NATIVE_REPOSITORY_TOOL_RISKS tool to the model across the three catalogs, minus only a named exclusion set", () => {
    const advertised = new Set([
      ...NATIVE_REPOSITORY_MODEL_TOOLS.map((tool) => tool.name),
      ...NATIVE_PLANNING_MODEL_TOOLS.map((tool) => tool.name),
      ...NATIVE_BUS_THREAD_MODEL_TOOLS.map((tool) => tool.name),
    ]);
    const hostToolNames = Object.keys(NATIVE_REPOSITORY_TOOL_RISKS);
    const expected = hostToolNames.filter((name) => !EXCLUDED_FROM_MODEL_ADVERTISEMENT.includes(name)).sort();
    // Scoped to host-risk-classified names: NATIVE_BUS_THREAD_MODEL_TOOLS
    // also advertises bus-port tools (bus.thread.send, etc.) that are not
    // repository-tool-host ports at all, so a raw set-equality over the
    // full union would fail for an unrelated reason.
    const advertisedHostTools = hostToolNames.filter((name) => advertised.has(name)).sort();
    expect(advertisedHostTools).toEqual(expected);
    const advertisedByName = new Map([...NATIVE_REPOSITORY_MODEL_TOOLS, ...NATIVE_PLANNING_MODEL_TOOLS, ...NATIVE_BUS_THREAD_MODEL_TOOLS].map((tool) => [tool.name, tool.risk]));
    for (const name of hostToolNames) expect(advertisedByName.get(name), `${name} risk matches its hosted classification`).toBe(NATIVE_REPOSITORY_TOOL_RISKS[name as keyof typeof NATIVE_REPOSITORY_TOOL_RISKS]);
  });

  // Parity gaps #1 (subagent.execute), #3/#4 (skill.load/skill.list,
  // ADR-087), #6 (userinput.ask, 2026-08-24 audit), the web tools
  // (web.fetch/web.search, ADR-087 web-tools follow-up), and the
  // mid-session governed image tools (image.attach/image.list, the last
  // native tool-surface parity gap): each tool is hosted outside
  // `NativeRepositoryToolHost` (bound instead by
  // `NATIVE_SUBAGENT_TOOL_RISKS`/`NATIVE_SKILL_TOOL_RISKS`/
  // `NATIVE_USERINPUT_TOOL_RISKS`/`NATIVE_WEB_TOOL_RISKS`/
  // `NATIVE_IMAGE_TOOL_RISKS`, the "bus-port equivalent" of
  // `NATIVE_REPOSITORY_TOOL_RISKS`), so this is a separate binding from the
  // host-tool parity check above. It fails if any tool is advertised without
  // a matching host risk classification, hosted without being advertised,
  // or advertised at a different risk than the host classifies it.
  it("binds subagent.execute, skill.load/skill.list, userinput.ask, web.fetch/web.search, and image.attach/image.list advertisement to their own typed risk classification", () => {
    const hostRisks: Record<string, string> = { ...NATIVE_SUBAGENT_TOOL_RISKS, ...NATIVE_SKILL_TOOL_RISKS, ...NATIVE_USERINPUT_TOOL_RISKS, ...NATIVE_WEB_TOOL_RISKS, ...NATIVE_IMAGE_TOOL_RISKS };
    const advertisedByName = new Map(NATIVE_BUS_THREAD_MODEL_TOOLS.map((tool) => [tool.name, tool.risk]));
    for (const [name, risk] of Object.entries(hostRisks)) {
      expect(advertisedByName.get(name), `${name} must be advertised`).toBe(risk);
    }
    expect(Object.keys(hostRisks).sort()).toEqual(["image.attach", "image.list", "skill.list", "skill.load", "subagent.execute", "userinput.ask", "web.fetch", "web.search"].sort());
  });
});

describe("native repository model tool schemas", () => {
  it("guides file.write callers through mutually exclusive create and hash-guarded update modes", () => {
    const read = NATIVE_REPOSITORY_MODEL_TOOLS.find((tool) => tool.name === "file.read");
    const write = NATIVE_REPOSITORY_MODEL_TOOLS.find((tool) => tool.name === "file.write");
    expect(read?.description).toContain("content_sha256");
    expect(read?.description).toContain("truncated=false");
    expect(write?.description).toContain("create:true");
    expect(write?.description).toContain("content_sha256");
    // The create-XOR-update precondition is described in prose, not encoded
    // as a schema oneOf/allOf/anyOf: Anthropic's tool input_schema rejects a
    // root-level combinator (confirmed live against
    // anthropic/claude-haiku-4.5 -- see scripts/live/a01-adoption-journey.mjs
    // and the tool-schema-anthropic-compat guard test). The precondition
    // itself is enforced at runtime regardless of schema shape --
    // native-tool-host.ts's write() (see native-tool-host.test.ts for
    // write_mode_invalid/expected_sha256_required/file_exists/stale_write).
    expect(write?.parameters).toMatchObject({
      properties: { expected_sha256: { pattern: "^sha256:[a-f0-9]{64}$", minLength: 71, maxLength: 71 } },
      required: ["path", "content"],
      additionalProperties: false,
    });
    expect(write?.parameters).not.toHaveProperty("oneOf");
    expect(write?.parameters).not.toHaveProperty("allOf");
    expect(write?.parameters).not.toHaveProperty("anyOf");
  });
});
