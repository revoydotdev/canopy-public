/**
 * ADR-100 extracted the Messages-shaped wire body into a module shared by the
 * direct Anthropic, Bedrock, and Vertex adapters. Its happy path is covered by
 * each adapter's own suite; these are its refusal branches — the protocol
 * guards that decide whether a malformed tool or schema declaration reaches a
 * provider at all. A guard nothing exercises is a guard nobody knows works.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AnthropicWireError, anthropicToolWireName, buildAnthropicWireConfig, buildAnthropicWireRequestBody } from "../src/anthropic-messages-wire.js";

const base = { modelId: "m", maxOutputTokens: 256, maxResponseBytes: 4096, maxToolArgumentBytes: 1024 };
const tool = (over: Record<string, unknown> = {}) => ({
  name: "file.read", description: "read a file", parameters: { type: "object" }, risk: "low" as const, ...over,
});

function suffixOf(name: string): string {
  return createHash("sha256").update(name).digest("hex").slice(0, 16);
}

describe("anthropicToolWireName", () => {
  it("leaves a name that already satisfies the wire grammar unchanged", () => {
    expect(anthropicToolWireName("a-b_c9")).toBe("a-b_c9");
  });

  it("sanitizes an invalid name and appends a content-derived hash suffix, mirroring anthropic-messages.ts", () => {
    expect(anthropicToolWireName("file.read")).toBe(`file_read__${suffixOf("file.read")}`);
    expect(anthropicToolWireName("weird name/with:chars")).toBe(`weird_name_with_chars__${suffixOf("weird name/with:chars")}`);
  });

  it("caps the wire name within the provider's 128-char limit for a very long tool name", () => {
    const longName = `provider.integration.${"x".repeat(200)}.action`;
    const wireName = anthropicToolWireName(longName);
    expect(wireName.length).toBeLessThanOrEqual(128);
    expect(wireName).toMatch(/^[A-Za-z0-9_-]{1,128}$/);
    expect(wireName.endsWith(`__${suffixOf(longName)}`)).toBe(true);
  });

  it("disambiguates two distinct dotted names that sanitize to the same prefix, instead of colliding", () => {
    const a = anthropicToolWireName("file.read");
    const b = anthropicToolWireName("file/read");
    expect(a).not.toBe(b);
    expect(a.startsWith("file_read__")).toBe(true);
    expect(b.startsWith("file_read__")).toBe(true);
  });
});

describe("buildAnthropicWireConfig refusals", () => {
  it("accepts a well-formed declaration and indexes tools by both real and wire name", () => {
    const config = buildAnthropicWireConfig({ ...base, tools: [tool()] });
    expect(config.tools.get("file.read")).toBeDefined();
    expect(config.toolsByWireName.get(anthropicToolWireName("file.read"))).toBeDefined();
  });

  it("does not collide two distinct tool names that share a sanitized prefix — the hash suffix disambiguates them", () => {
    // `file.read` and `file/read` used to collapse to the identical wire name
    // "file_read" and hard-fail composition; the fixed anthropicToolWireName
    // (mirroring anthropic-messages.ts) suffixes each with a hash of its full
    // original name, so both compose and remain independently addressable.
    const config = buildAnthropicWireConfig({ ...base, tools: [tool(), tool({ name: "file/read" })] });
    expect(config.toolsByWireName.get(anthropicToolWireName("file.read"))?.name).toBe("file.read");
    expect(config.toolsByWireName.get(anthropicToolWireName("file/read"))?.name).toBe("file/read");
  });

  it("refuses a duplicate tool name outright", () => {
    expect(() => buildAnthropicWireConfig({ ...base, tools: [tool(), tool()] }))
      .toThrow(/duplicate tool name: file\.read/);
  });

  it("refuses an empty or whitespace-only tool name or description", () => {
    expect(() => buildAnthropicWireConfig({ ...base, tools: [tool({ name: "" })] })).toThrow(/tool name must be non-empty/);
    expect(() => buildAnthropicWireConfig({ ...base, tools: [tool({ name: "   " })] })).toThrow(/tool name must be non-empty/);
    expect(() => buildAnthropicWireConfig({ ...base, tools: [tool({ description: "" })] })).toThrow(/tool description must be non-empty/);
  });

  it("refuses a risk tier outside the closed set, since risk drives approval", () => {
    expect(() => buildAnthropicWireConfig({ ...base, tools: [tool({ risk: "medium" })] }))
      .toThrow(/tool risk must be low or high/);
    expect(() => buildAnthropicWireConfig({ ...base, tools: [tool({ risk: undefined })] }))
      .toThrow(/tool risk must be low or high/);
  });

  it("applies the same guards to structured schemas", () => {
    const schema = (over: Record<string, unknown> = {}) => ({ schema_id: "s1", name: "S", schema: {}, ...over });
    expect(buildAnthropicWireConfig({ ...base, structured_schemas: [schema()] }).schemas.get("s1")).toBeDefined();
    expect(() => buildAnthropicWireConfig({ ...base, structured_schemas: [schema(), schema()] }))
      .toThrow(/duplicate structured schema_id: s1/);
    expect(() => buildAnthropicWireConfig({ ...base, structured_schemas: [schema({ schema_id: "" })] }))
      .toThrow(/structured schema_id must be non-empty/);
    expect(() => buildAnthropicWireConfig({ ...base, structured_schemas: [schema({ name: " " })] }))
      .toThrow(/structured schema name must be non-empty/);
  });

  it("strips a root-level oneOf/anyOf/allOf combinator from a composed tool's input_schema, mirroring anthropic-messages.ts", () => {
    // Anthropic rejects any tool schema with a root-level combinator (verified
    // live in this audit: a root oneOf returns HTTP 400, the flattened form
    // returns 200). anthropic-messages.ts already strips this defensively;
    // this module passed `tool.parameters` straight through with no
    // stripping at all, so a root combinator anywhere in the shared tool
    // catalog would 400 every Bedrock/Vertex request that included it.
    const request: import("../src/native-worker.js").NativeModelRequest = {
      session_id: "s1", turn: 1, prompt: "do the thing", history: [],
      profile: null, governed_context: { instructions: [], artifacts: [] }, context: null, structured_output: null,
    };
    const config = buildAnthropicWireConfig({
      ...base,
      tools: [tool({
        name: "combinator_tool",
        parameters: {
          type: "object",
          oneOf: [
            { required: ["a"], properties: { a: { type: "string" } } },
            { required: ["a", "b"], properties: { a: { type: "string" }, b: { type: "string" } } },
          ],
        },
      })],
    });
    const body = buildAnthropicWireRequestBody(config, request) as { tools?: readonly { name: string; input_schema: Record<string, unknown> }[] };
    const composed = body.tools?.find((entry) => entry.name === "combinator_tool");
    expect(composed).toBeDefined();
    expect(composed!.input_schema.oneOf).toBeUndefined();
    expect(composed!.input_schema.anyOf).toBeUndefined();
    expect(composed!.input_schema.allOf).toBeUndefined();
    expect(composed!.input_schema.type).toBe("object");
    // Requirement shared by every branch ("a") is preserved; branch-specific
    // requirement ("b") is not silently promoted to universally required.
    expect(composed!.input_schema.required).toEqual(["a"]);
  });

  it("leaves an ordinary (non-combinator) input_schema untouched", () => {
    const request: import("../src/native-worker.js").NativeModelRequest = {
      session_id: "s1", turn: 1, prompt: "do the thing", history: [],
      profile: null, governed_context: { instructions: [], artifacts: [] }, context: null, structured_output: null,
    };
    const config = buildAnthropicWireConfig({ ...base, tools: [tool({ parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } })] });
    const body = buildAnthropicWireRequestBody(config, request) as { tools?: readonly { name: string; input_schema: Record<string, unknown> }[] };
    expect(body.tools?.[0]?.input_schema).toEqual({ type: "object", properties: { path: { type: "string" } }, required: ["path"] });
  });

  it("throws AnthropicWireError, not a bare Error, so callers can classify it", () => {
    try {
      buildAnthropicWireConfig({ ...base, tools: [tool({ name: "" })] });
      expect.unreachable("expected a refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(AnthropicWireError);
      expect((error as AnthropicWireError).kind).toBe("protocol");
    }
  });
});
