import { describe, expect, it } from "vitest";
import { BoundedToolSchemaManifestCache } from "../src/tool-schema-manifest.js";

const schema = (tool_name: string) => ({ tool_name, schema_id: `schema:${tool_name}`, schema: { type: "object", properties: { [tool_name]: { type: "string" } } } });

describe("bounded tool schema manifests", () => {
  it("caches by session, route, and revision while loading only eligible names", () => {
    const cache = new BoundedToolSchemaManifestCache({ max_entries: 8, max_schemas_per_manifest: 2 });
    const loads: string[][] = [];
    const load = (names: readonly string[]) => {
      loads.push([...names]);
      return names.map(schema);
    };

    const first = cache.resolve({ session_id: "s1", route: "tool_capable", revision: "r1", eligible_tool_names: ["repo.read", "repo.search"], load });
    const second = cache.resolve({ session_id: "s1", route: "tool_capable", revision: "r1", eligible_tool_names: ["repo.read", "repo.search"], load });
    expect(first.cache).toBe("miss");
    expect(second.cache).toBe("hit");
    expect(loads).toEqual([["repo.read", "repo.search"]]);

    const otherSession = cache.resolve({ session_id: "s2", route: "tool_capable", revision: "r1", eligible_tool_names: ["repo.read"], load });
    const otherRoute = cache.resolve({ session_id: "s1", route: "non_tool", revision: "r1", eligible_tool_names: [], load });
    const otherRevision = cache.resolve({ session_id: "s1", route: "tool_capable", revision: "r2", eligible_tool_names: ["repo.read"], load });
    expect(otherSession.cache).toBe("miss");
    expect(otherRoute.entries).toEqual([]);
    expect(otherRoute.cache).toBe("miss");
    expect(otherRevision.cache).toBe("miss");
  });

  it("filters cached entries to the current authority and never loads for a no-tool route", () => {
    const cache = new BoundedToolSchemaManifestCache();
    const loadedNames: string[][] = [];
    const load = (names: readonly string[]) => {
      loadedNames.push([...names]);
      return names.map(schema);
    };
    cache.resolve({ session_id: "s", route: "tool_capable", revision: "r", eligible_tool_names: ["read", "write"], load });
    const narrowed = cache.resolve({ session_id: "s", route: "tool_capable", revision: "r", eligible_tool_names: ["read"], load });
    expect(narrowed.entries.map((entry) => entry.tool_name)).toEqual(["read"]);
    expect(loadedNames).toEqual([["read", "write"]]);

    const noTool = cache.resolve({ session_id: "s", route: "non_tool", revision: "r", eligible_tool_names: [], load });
    expect(noTool.entries).toEqual([]);
    expect(loadedNames).toHaveLength(1);
    expect(() => cache.resolve({ session_id: "s", route: "non_tool", revision: "r", eligible_tool_names: ["read"], load })).toThrow(/non_tool route/);
  });

  it("bounds cached schemas and entries, evicts least recently used manifests, and invalidates by session", () => {
    const cache = new BoundedToolSchemaManifestCache({ max_entries: 2, max_schemas_per_manifest: 2 });
    const load = (names: readonly string[]) => names.map(schema);
    cache.resolve({ session_id: "a", route: "tool_capable", revision: "1", eligible_tool_names: ["a", "b", "c"], load });
    expect(cache.schema_count).toBe(2);
    cache.resolve({ session_id: "b", route: "tool_capable", revision: "1", eligible_tool_names: ["b"], load });
    cache.resolve({ session_id: "a", route: "tool_capable", revision: "1", eligible_tool_names: ["a"], load });
    cache.resolve({ session_id: "c", route: "tool_capable", revision: "1", eligible_tool_names: ["c"], load });
    expect(cache.size).toBe(2);
    expect(cache.schema_count).toBeLessThanOrEqual(cache.max_entries * 2);
    expect(cache.invalidateSession("a")).toBe(1);
    expect(cache.size).toBe(1);
    expect(cache.invalidateAll()).toBe(1);
    expect(cache.schema_count).toBe(0);
  });

  it("invalidates every route and revision for a session without clearing another session", () => {
    const cache = new BoundedToolSchemaManifestCache();
    const load = (names: readonly string[]) => names.map(schema);
    for (const [session_id, route, revision, eligible_tool_names] of [
      ["s1", "tool_capable", "r1", ["read"]],
      ["s1", "tool_capable", "r2", ["read"]],
      ["s1", "non_tool", "r1", []],
      ["s2", "tool_capable", "r1", ["read"]],
    ] as const) {
      cache.resolve({ session_id, route, revision, eligible_tool_names, load });
    }
    expect(cache.invalidateSession("s1")).toBe(3);
    expect(cache.size).toBe(1);
    expect(cache.resolve({ session_id: "s2", route: "tool_capable", revision: "r1", eligible_tool_names: ["read"], load }).cache).toBe("hit");
  });

  it("refuses a loader that returns a tool outside the caller's admitted set", () => {
    const cache = new BoundedToolSchemaManifestCache();
    expect(() => cache.resolve({
      session_id: "s", route: "tool_capable", revision: "r", eligible_tool_names: ["read"],
      load: () => [schema("write")],
    })).toThrow(/ineligible tool/);
    expect(cache.size).toBe(0);
  });

  it("snapshots schemas so mutation of loader-owned objects cannot alter cached definitions", () => {
    const cache = new BoundedToolSchemaManifestCache<{ nested: { type: string } }>();
    const source = { nested: { type: "string" } };
    const manifest = cache.resolve({ session_id: "s", route: "tool_capable", revision: "r", eligible_tool_names: ["read"], load: () => [{ tool_name: "read", schema_id: "read@r", schema: source }] });
    source.nested.type = "number";
    expect(manifest.entries[0]?.schema.nested.type).toBe("string");
    expect(Object.isFrozen(manifest.entries[0]?.schema.nested)).toBe(true);
  });
});
