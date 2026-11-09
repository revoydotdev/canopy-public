import type { NativeStructuredOutputContract, NativeStructuredOutputValidation, OpenAICompatibleStructuredSchema } from "@arbor/harness";
import { SKILL_DESCRIPTOR_MANIFEST } from "../native-capability-manifest.js";

export const NATIVE_SKILL_RESULT_SCHEMA_ID = SKILL_DESCRIPTOR_MANIFEST.structured_output_ids[0];
export const NATIVE_SKILL_RESULT_SCHEMA: OpenAICompatibleStructuredSchema = Object.freeze({
  schema_id: NATIVE_SKILL_RESULT_SCHEMA_ID,
  name: "revoy_native_skill_result",
  strict: true,
  schema: {
    type: "object", additionalProperties: false, required: ["summary", "evidence_ids"],
    properties: {
      summary: { type: "string", minLength: 1, maxLength: 8_192 },
      evidence_ids: { type: "array", maxItems: 32, items: { type: "string", minLength: 1, maxLength: 256 } },
    },
  },
});

export const NATIVE_SKILL_RESULT_CONTRACT: NativeStructuredOutputContract = Object.freeze({
  schema_id: NATIVE_SKILL_RESULT_SCHEMA_ID,
  validate(value: unknown): NativeStructuredOutputValidation {
    if (!plain(value) || Object.keys(value).length !== 2 || typeof value.summary !== "string" || !value.summary.trim() || value.summary.length > 8_192 || !Array.isArray(value.evidence_ids) || value.evidence_ids.length > 32 || value.evidence_ids.some((id) => typeof id !== "string" || !id.trim() || id.length > 256)) return { valid: false, reason: "skill result must contain only bounded summary and evidence_ids" };
    return { valid: true };
  },
});

function plain(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
