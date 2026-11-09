import { NATIVE_TOOL_RISK_MANIFEST as CORE_NATIVE_TOOL_RISK_MANIFEST } from "@arbor/core";
import type { NativeToolRisk } from "@arbor/core";

/**
 * Compatibility view for MCP callers that historically consumed a flat map.
 * Core owns the grouped declarations and every risk value.
 */
const groupedRisks = CORE_NATIVE_TOOL_RISK_MANIFEST;
export const NATIVE_TOOL_RISK_MANIFEST: Readonly<Record<string, NativeToolRisk>> = Object.freeze(Object.assign(
  {},
  ...Object.values(groupedRisks),
));
