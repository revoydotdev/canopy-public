import { describe, expect, it } from "vitest";
import type { NativeModelAdapterToolDefinition } from "@arbor/harness";
import { NATIVE_BUS_THREAD_MODEL_TOOLS, NATIVE_REPOSITORY_MODEL_TOOLS } from "../src/cli.js";

/**
 * S12: Anthropic's tool `input_schema` rejects a schema with `oneOf`,
 * `allOf`, or `anyOf` at the TOP LEVEL of `parameters` -- confirmed live
 * against anthropic/claude-haiku-4.5 ("tools.N.custom.input_schema: input
 * schema does not support oneOf, allOf, or anyOf at the top level"). This
 * bit `file.write` (root-level `oneOf` expressing the create-XOR-update
 * precondition) until the schema was flattened and the precondition moved
 * to the one place it was already genuinely enforced:
 * native-tool-host.ts's write() (see native-tool-host.test.ts).
 *
 * This is a forward guard, not a point fix: it fails the whole native tool
 * catalog -- every tool in NATIVE_REPOSITORY_MODEL_TOOLS and
 * NATIVE_BUS_THREAD_MODEL_TOOLS -- the moment any future tool schema
 * reintroduces a root-level combinator, so the next instance of this defect
 * class is caught by the suite instead of by a live campaign.
 *
 * A combinator NESTED inside a property schema (e.g. evidence.refresh's
 * `scope: { anyOf: [...] }`) is a different, permitted construct: Anthropic
 * only restricts the root of `input_schema` itself, not ordinary JSON
 * Schema inside `properties`. Only the root is asserted here.
 */
const ROOT_COMBINATOR_KEYS = ["oneOf", "allOf", "anyOf"] as const;

function allTools(): readonly NativeModelAdapterToolDefinition[] {
  return [...NATIVE_REPOSITORY_MODEL_TOOLS, ...NATIVE_BUS_THREAD_MODEL_TOOLS];
}

describe("native tool schemas stay Anthropic-compatible at the input_schema root", () => {
  it("advertises at least the known 29-tool catalog so this guard cannot pass vacuously", () => {
    expect(allTools().length).toBeGreaterThanOrEqual(29);
  });

  for (const tool of allTools()) {
    it(`${tool.name}: parameters carries no root-level oneOf/allOf/anyOf`, () => {
      for (const key of ROOT_COMBINATOR_KEYS) {
        expect(tool.parameters, `${tool.name}.parameters must not declare a root-level "${key}"`).not.toHaveProperty(key);
      }
    });
  }
});
