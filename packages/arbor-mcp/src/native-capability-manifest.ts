/**
 * Compatibility exports for the MCP-owned native tool surfaces. Capability
 * identity and descriptor bounds are canonical in @arbor/core; MCP keeps the
 * full schemas and operational implementations beside their owners.
 */
import {
  NATIVE_SKILL_DESCRIPTOR_MANIFEST,
  NATIVE_TOOL_RISK_MANIFEST,
} from "@arbor/core";

export { NATIVE_TOOL_RISK_MANIFEST };
export type { NativeToolRisk } from "@arbor/core";

/** Descriptor contract retained under its MCP-facing historical name. */
export const SKILL_DESCRIPTOR_MANIFEST = NATIVE_SKILL_DESCRIPTOR_MANIFEST;
