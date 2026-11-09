import { NATIVE_PROVIDER_ADAPTER_IDS, type NativeProviderConfig } from "./types.js";

/** A composition-safe result for choosing native execution or its fallback. */
export type NativeProviderSelection =
  | {
    readonly kind: "native";
    readonly adapter_id: string;
    readonly provider_id: string;
    readonly base_url: string;
    readonly model: string;
    /** Configured response revision pin, validated by a supporting adapter. */
    readonly revision: string | null;
    /** `native` means explicitly required; `auto` means a complete selection enabled it. */
    readonly selected_by: "native" | "auto";
  }
  | {
    readonly kind: "fallback";
    readonly reason: "forced_by_config" | "selection_incomplete";
  }
  | {
    /** Explicit-native is never silently weakened to fallback by a malformed selection. */
    readonly kind: "unavailable";
    readonly reason: "native_selection_incomplete" | "native_adapter_unsupported";
    readonly adapter_id?: string;
  };

/**
 * Decide executor selection from the typed, non-secret config only.
 * Credential availability is intentionally orthogonal: callers apply an
 * opaque `NativeProviderSecretOverlay` when they compose the selected model.
 */
export function resolveNativeProviderSelection(config: NativeProviderConfig): NativeProviderSelection {
  if (config.mode === "fallback") return Object.freeze({ kind: "fallback", reason: "forced_by_config" });
  const adapter_id = typeof config.adapter_id === "string" ? config.adapter_id.trim() : "";
  if (!(NATIVE_PROVIDER_ADAPTER_IDS as readonly string[]).includes(adapter_id)) {
    return Object.freeze({ kind: "unavailable", reason: "native_adapter_unsupported", ...(adapter_id.length > 0 ? { adapter_id } : {}) });
  }
  const provider_id = config.provider_id.trim();
  const base_url = config.base_url.trim();
  const model = config.model.trim();
  const revision = config.revision?.trim() ?? "";
  if (provider_id.length > 0 && base_url.length > 0 && model.length > 0) {
    return Object.freeze({ kind: "native", adapter_id, provider_id, base_url, model, revision: revision || null, selected_by: config.mode });
  }
  if (config.mode === "native") return Object.freeze({ kind: "unavailable", reason: "native_selection_incomplete" });
  return Object.freeze({ kind: "fallback", reason: "selection_incomplete" });
}
