/**
 * The credential counterpart to ArborConfig.native.
 *
 * Provider selection is ordinary typed config and can therefore be projected
 * with its file/env provenance. A credential is neither config nor
 * projection data: it is read from the documented environment variable only
 * at composition time and can be supplied only to a callback.
 */

/** Revoy's provider-independent override. It always has highest precedence. */
export const NATIVE_PROVIDER_API_KEY_ENV = "ARBOR_NATIVE_API_KEY";

const PROVIDER_API_KEY_ENVS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  anthropic: ["ANTHROPIC_API_KEY"],
  claude: ["ANTHROPIC_API_KEY"],
  deepseek: ["DEEPSEEK_API_KEY"],
  gemini: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
  google: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
  groq: ["GROQ_API_KEY"],
  huggingface: ["HF_TOKEN", "HUGGINGFACE_API_KEY"],
  hf: ["HF_TOKEN", "HUGGINGFACE_API_KEY"],
  mistral: ["MISTRAL_API_KEY"],
  openai: ["OPENAI_API_KEY"],
  openrouter: ["OPENROUTER_API_KEY"],
  ollama: ["OLLAMA_API_KEY"],
  together: ["TOGETHER_API_KEY"],
  xai: ["XAI_API_KEY"],
});

/** Ordered, secret-free candidate names for one configured provider. */
export function nativeProviderCredentialEnvCandidates(providerId?: string): readonly string[] {
  const normalized = providerId?.trim().toLowerCase() ?? "";
  return Object.freeze([
    NATIVE_PROVIDER_API_KEY_ENV,
    ...(PROVIDER_API_KEY_ENVS[normalized] ?? []),
  ]);
}

/**
 * The auth mechanism a resolved credential presents to its adapter.
 * `api_key` sends `x-api-key`/`Authorization: Bearer <key>` as today;
 * `oauth_bearer` sends `Authorization: Bearer <token>`; Anthropic's Messages
 * adapter also adds its provider OAuth beta header. Static, non-secret: it never depends on the secret
 * value itself, only on which credential source produced it.
 */
export type NativeCredentialMechanism = "api_key" | "oauth_bearer";

/**
 * The provider-neutral shape the native executor composition root consumes,
 * regardless of which concrete credential source produced it. `native-secret.ts`
 * (this file) is the `api_key` source; `native-oauth-secret.ts` owns the
 * OAuth and workload-token sources. All satisfy this shape structurally.
 */
export interface NativeCredentialOverlay {
  readonly source: "env" | "absent" | "claude_oauth" | "codex_oauth" | "openrouter_oauth" | "openai_wif";
  readonly mechanism: NativeCredentialMechanism;
  readonly present: boolean;
  /**
   * Provides the secret only to an immediate composition callback. It is not
   * serializable config state, so config/audit/TUI projections cannot retain
   * it by accident. Mechanism is not secret -- it is safe to branch adapter
   * wiring on -- so it is handed to the recipient alongside the secret.
   */
  inject<T>(recipient: (secret: string, mechanism: NativeCredentialMechanism) => T): T | undefined;
}

export interface NativeProviderSecretOverlay extends NativeCredentialOverlay {
  readonly source: "env" | "absent";
  readonly mechanism: "api_key";
  readonly env_var: string | null;
  readonly present: boolean;
}

/**
 * Read the native credential from an explicit env object. Empty strings count
 * as absent: an empty bearer token is never a meaningful credential and must
 * not make the native path appear configured.
 */
export function loadNativeProviderSecretOverlay(
  env: NodeJS.ProcessEnv = process.env,
  providerId?: string,
): NativeProviderSecretOverlay {
  const envVar = nativeProviderCredentialEnvCandidates(providerId)
    .find((candidate) => (env[candidate]?.length ?? 0) > 0);
  if (envVar === undefined) {
    return Object.freeze({
      source: "absent" as const,
      mechanism: "api_key" as const,
      env_var: null,
      present: false,
      inject<T>(_recipient: (apiKey: string, mechanism: "api_key") => T): T | undefined { return undefined; },
    });
  }
  // Snapshot the value at composition time. A mutable process.env must not
  // change or revoke the already-admitted credential source between readiness
  // inspection and the session-owned lease callback.
  const apiKey = env[envVar]!;
  return Object.freeze({
    source: "env" as const,
    mechanism: "api_key" as const,
    env_var: envVar,
    present: true,
    inject<T>(recipient: (apiKey: string, mechanism: "api_key") => T): T | undefined { return recipient(apiKey, "api_key"); },
  });
}
