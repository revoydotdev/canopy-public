import { describe, expect, it } from "vitest";
import { SKILL_STRUCTURED_OUTPUT_IDS } from "../../src/skills/catalog.js";
import { SKILL_DESCRIPTOR_MANIFEST } from "../../src/native-capability-manifest.js";
import { NATIVE_SKILL_CAPABILITY_MANIFEST } from "../../src/skills/capabilities.js";
import { NATIVE_SKILL_RESULT_CONTRACT, NATIVE_SKILL_RESULT_SCHEMA } from "../../src/skills/structured-output.js";

describe("native skill result contract", () => {
  it("accepts only the closed bounded result projection", () => {
    expect(SKILL_STRUCTURED_OUTPUT_IDS).toBe(SKILL_DESCRIPTOR_MANIFEST.structured_output_ids);
    expect(NATIVE_SKILL_RESULT_SCHEMA.schema_id).toBe(SKILL_DESCRIPTOR_MANIFEST.structured_output_ids[0]);
    expect(SKILL_STRUCTURED_OUTPUT_IDS).toEqual([NATIVE_SKILL_RESULT_SCHEMA.schema_id]);
    expect(SKILL_STRUCTURED_OUTPUT_IDS).toEqual(NATIVE_SKILL_CAPABILITY_MANIFEST.structured_output_ids);
    expect(NATIVE_SKILL_CAPABILITY_MANIFEST.tools).toEqual({ "skill.load": "low", "skill.list": "low" });
    expect(NATIVE_SKILL_RESULT_CONTRACT.schema_id).toBe(NATIVE_SKILL_RESULT_SCHEMA.schema_id);
    expect(NATIVE_SKILL_RESULT_CONTRACT.validate({ summary: "done", evidence_ids: ["e-1"] })).toEqual({ valid: true });
    expect(NATIVE_SKILL_RESULT_CONTRACT.validate({ summary: "done", evidence_ids: [], authority: "self-approved" })).toMatchObject({ valid: false });
  });
});
