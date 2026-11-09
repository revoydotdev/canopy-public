import { describe, expect, it } from "vitest";
import { CONFIG_JSON_SCHEMA, DEFAULT_CONFIG, loadConfigFromString, validateConfig, type ArborConfig } from "../src/index.js";

function withEgress(network_egress: unknown): ArborConfig {
  return { ...structuredClone(DEFAULT_CONFIG), verification: { network_egress: network_egress as never } };
}

describe("verification.network_egress", () => {
  it("is absent by default: no verifier command is granted host network unless the operator says so", () => {
    expect(DEFAULT_CONFIG.verification?.network_egress).toBeUndefined();
    expect(loadConfigFromString("").verification?.network_egress).toBeUndefined();
  });

  it("loads an explicit grant with its exact argv and reason", () => {
    const config = loadConfigFromString(JSON.stringify({
      verification: {
        acceptance_commands: [["cargo", "test", "--quiet"]],
        network_egress: [{ argv: ["cargo", "test", "--quiet"], reason: "no Cargo.lock; cargo must fetch crates from crates.io" }],
      },
    }));
    expect(config.verification?.network_egress).toEqual([{ argv: ["cargo", "test", "--quiet"], reason: "no Cargo.lock; cargo must fetch crates from crates.io" }]);
  });

  it.each([
    ["a non-array", { argv: ["npm", "test"], reason: "x" }, /must be an array/],
    ["a grant with no argv", [{ reason: "fetch" }], /argv must be a non-empty array/],
    ["an empty argv", [{ argv: [], reason: "fetch" }], /argv must be a non-empty array/],
    ["an empty argv element", [{ argv: ["npm", ""], reason: "fetch" }], /argv must be a non-empty array/],
    ["a missing reason", [{ argv: ["npm", "test"] }], /reason must be a non-empty single-line string/],
    ["a blank reason", [{ argv: ["npm", "test"], reason: "   " }], /reason must be a non-empty single-line string/],
    ["a multi-line reason", [{ argv: ["npm", "test"], reason: "line one\nline two" }], /reason must be a non-empty single-line string/],
    ["an over-long reason", [{ argv: ["npm", "test"], reason: "x".repeat(201) }], /at most 200 characters/],
    ["an unknown key", [{ argv: ["npm", "test"], reason: "fetch", network: "egress" }], /unknown keys: network/],
    ["a duplicate argv", [{ argv: ["npm", "test"], reason: "a" }, { argv: ["npm", "test"], reason: "b" }], /duplicates an earlier network_egress grant/],
  ])("rejects %s", (_label, value, message) => {
    const result = validateConfig(withEgress(value));
    expect(result.valid).toBe(false);
    expect(result.errors.join("\n")).toMatch(message);
  });

  it("refuses to load a project file carrying an invalid grant", () => {
    expect(() => loadConfigFromString(JSON.stringify({ verification: { network_egress: [{ argv: ["npm", "test"] }] } }))).toThrow(/network_egress\[0\]\.reason/);
  });

  it("publishes the grant shape in the JSON schema", () => {
    expect(CONFIG_JSON_SCHEMA.properties.verification.properties.network_egress).toMatchObject({ type: "array", items: { required: ["argv", "reason"], additionalProperties: false } });
  });
});
