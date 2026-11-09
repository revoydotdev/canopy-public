/** Truthful execution identity for the existing harness-session projection. */
export type HarnessSessionConnectorId = "revoy-native" | "opencode";
export type HarnessSessionExecutionKind = "direct_native" | "connector_fallback";

export interface HarnessSessionExecution {
  readonly connector_id: HarnessSessionConnectorId;
  readonly execution_kind: HarnessSessionExecutionKind;
}

export const DIRECT_NATIVE_SESSION_EXECUTION: HarnessSessionExecution = Object.freeze({
  connector_id: "revoy-native",
  execution_kind: "direct_native",
});

export const OPENCODE_FALLBACK_SESSION_EXECUTION: HarnessSessionExecution = Object.freeze({
  connector_id: "opencode",
  execution_kind: "connector_fallback",
});
