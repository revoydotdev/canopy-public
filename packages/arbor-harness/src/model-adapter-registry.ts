/**
 * Provider-neutral model-adapter composition for the owned native executor.
 *
 * A provider id (for billing, audit, and credential-scoping) is deliberately
 * distinct from the transport adapter that knows a wire protocol. This
 * registry contains only adapters the reference harness actually ships; it
 * never guesses that an arbitrary provider name implements a familiar API.
 */
import {
  createOpenAICompatibleModelPort,
  type OpenAICompatibleFetch,
} from "./openai-compatible.js";
import {
  createAnthropicMessagesModelPort,
} from "./anthropic-messages.js";
import {
  createBedrockMessagesModelPort,
} from "./bedrock-messages.js";
import {
  createVertexMessagesModelPort,
} from "./vertex-messages.js";
import {
  createOllamaNativeModelPort,
} from "./ollama-native.js";
import type { NativeContextEvidenceRef } from "./inference.js";
import type { NativeModelPort, NativeToolRisk } from "./native-worker.js";

/**
 * ADR-100 grows this from two entries to five: `aws-bedrock-messages` and
 * `gcp-vertex-messages` are Anthropic Messages-shaped managed endpoints
 * (SigV4/OAuth signing layered over the shared `anthropic-messages-wire.ts`
 * request/response contract); `ollama-native` replaces the prior
 * `openai-compatible` masquerade with Ollama's own wire shape.
 */
export const NATIVE_MODEL_ADAPTER_IDS = [
  "openai-compatible",
  "anthropic-messages",
  "aws-bedrock-messages",
  "gcp-vertex-messages",
  "ollama-native",
] as const;

/** Declarative tool shape owned by composition, not by a provider SDK. */
export interface NativeModelAdapterToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
  readonly risk: NativeToolRisk;
  readonly context_refs?: readonly NativeContextEvidenceRef[];
}

/** A caller-owned response-schema contract carried through an adapter. */
export interface NativeModelAdapterStructuredSchema {
  readonly schema_id: string;
  readonly name: string;
  readonly schema: Record<string, unknown>;
  readonly strict?: boolean;
}

/**
 * All non-secret facts needed to compose a model port. A credential lease is
 * intentionally absent: the worker injects it only at a session-owned run.
 */
export interface NativeModelAdapterRequest {
  readonly adapter_id: string;
  readonly provider_id: string;
  /** Required by `openai-compatible`/`anthropic-messages`/`ollama-native` (an HTTP endpoint to call). `aws-bedrock-messages` derives its host from `region`; `gcp-vertex-messages` derives its host from `project_id`/`location`, so neither requires this. */
  readonly base_url?: string;
  readonly model_id: string;
  readonly revision?: string | null;
  readonly observed_at: string;
  /** `aws-bedrock-messages` only: the AWS region (e.g. `us-east-1`) whose `bedrock-runtime` host to call. */
  readonly region?: string;
  /** `gcp-vertex-messages` only: the GCP project id owning the Agent Platform deployment. */
  readonly project_id?: string;
  /** `gcp-vertex-messages` only: a region, a multi-region (`us`/`eu`), or `global` (default). */
  readonly location?: string;
  readonly tools?: readonly NativeModelAdapterToolDefinition[];
  readonly structured_schemas?: readonly NativeModelAdapterStructuredSchema[];
  readonly human_input_tool?: { readonly name?: string };
  /** Opt-in only: composition passes this from an explicit configured capability. */
  readonly image_input?: { readonly max_images?: number; readonly max_bytes_per_image?: number };
  readonly credential_required?: boolean;
  readonly timeout_ms?: number;
  readonly max_response_bytes?: number;
  readonly max_tool_argument_bytes?: number;
  readonly max_output_tokens?: number;
  /** Anthropic-only: `cache_control` breakpoint opt-out/TTL. Ignored by other adapters. */
  readonly prompt_caching?: { readonly enabled?: boolean; readonly ttl?: "5m" | "1h" };
  /**
   * Anthropic-only: `api_key` (default) sends `x-api-key`; `oauth_bearer`
   * sends `Authorization: Bearer` + the OAuth beta header for a supported
   * OAuth credential. CLI subscriber tokens are rejected before adapter
   * composition. Ignored by `openai-compatible`/`ollama-native`.
   *
   * `aws_sigv4`/`oauth_service_account` are this tranche's stand-in for a
   * real `NativeCredentialMechanism` union member (ADR-100 Decision §3) --
   * `packages/arbor-config/src/native-secret.ts` still only declares
   * `"api_key" | "oauth_bearer"`, so no composition root can construct
   * these values yet. `aws-bedrock-messages`/`gcp-vertex-messages` accept
   * them here only to fail closed on an obvious mismatch (e.g. `api_key`
   * presented to Bedrock); they do not change the credential shape those
   * adapters expect (a JSON access-key blob for Bedrock, a bearer token for
   * Vertex -- see each adapter's module doc).
   */
  readonly credential_mechanism?: "api_key" | "oauth_bearer" | "aws_sigv4" | "oauth_service_account";
}

export interface NativeModelAdapterDescriptor {
  readonly adapter_id: string;
  readonly implementation_id: string;
  /** A human-readable boundary, never a claim about arbitrary providers. */
  readonly transport: string;
  readonly credential_delivery: "worker_owned_opaque_lease";
}

export interface NativeModelAdapter {
  readonly descriptor: NativeModelAdapterDescriptor;
  create(request: NativeModelAdapterRequest): NativeModelPort;
}

export type NativeModelAdapterResolution =
  | { readonly kind: "selected"; readonly adapter: NativeModelAdapter; readonly descriptor: NativeModelAdapterDescriptor }
  | { readonly kind: "unavailable"; readonly adapter_id: string; readonly reason: "not_registered" };

export class NativeModelAdapterRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NativeModelAdapterRegistryError";
  }
}

function copyDescriptor(descriptor: NativeModelAdapterDescriptor): NativeModelAdapterDescriptor {
  return Object.freeze({ ...descriptor });
}

function validateDescriptor(descriptor: NativeModelAdapterDescriptor): void {
  for (const [name, value] of Object.entries({ adapter_id: descriptor.adapter_id, implementation_id: descriptor.implementation_id, transport: descriptor.transport })) {
    if (typeof value !== "string" || value.trim().length === 0) throw new NativeModelAdapterRegistryError(`${name} must be non-empty`);
  }
  if (descriptor.credential_delivery !== "worker_owned_opaque_lease") {
    throw new NativeModelAdapterRegistryError("adapter credential_delivery must preserve worker-owned opaque leases");
  }
}

/**
 * A registry is a composition-root boundary, not a provider discovery system.
 * It copies descriptors at ingress/egress and exposes typed absence when an
 * unregistered adapter is selected.
 */
export class NativeModelAdapterRegistry {
  private readonly adapters = new Map<string, NativeModelAdapter>();

  register(adapter: NativeModelAdapter): NativeModelAdapterDescriptor {
    validateDescriptor(adapter.descriptor);
    const id = adapter.descriptor.adapter_id;
    if (this.adapters.has(id)) throw new NativeModelAdapterRegistryError(`model adapter already registered: ${id}`);
    const registered: NativeModelAdapter = Object.freeze({
      descriptor: copyDescriptor(adapter.descriptor),
      create: adapter.create.bind(adapter),
    });
    this.adapters.set(id, registered);
    return copyDescriptor(registered.descriptor);
  }

  inspect(adapterId: string): NativeModelAdapterDescriptor | null {
    const adapter = this.adapters.get(adapterId);
    return adapter === undefined ? null : copyDescriptor(adapter.descriptor);
  }

  list(): readonly NativeModelAdapterDescriptor[] {
    return [...this.adapters.values()]
      .map((adapter) => copyDescriptor(adapter.descriptor))
      .sort((left, right) => left.adapter_id.localeCompare(right.adapter_id));
  }

  resolve(adapterId: string): NativeModelAdapterResolution {
    const adapter = this.adapters.get(adapterId);
    return adapter === undefined
      ? Object.freeze({ kind: "unavailable", adapter_id: adapterId, reason: "not_registered" })
      : Object.freeze({ kind: "selected", adapter, descriptor: copyDescriptor(adapter.descriptor) });
  }

  create(request: NativeModelAdapterRequest): NativeModelPort {
    const resolved = this.resolve(request.adapter_id);
    if (resolved.kind === "unavailable") throw new NativeModelAdapterRegistryError(`native model adapter is unavailable: ${resolved.adapter_id}`);
    return resolved.adapter.create(request);
  }
}

/** The one built-in adapter is deliberately named for its wire contract. */
export function createOpenAICompatibleNativeModelAdapter(fetch: OpenAICompatibleFetch): NativeModelAdapter {
  return Object.freeze({
    descriptor: Object.freeze({
      adapter_id: "openai-compatible",
      implementation_id: "revoy2-openai-compatible-native-adapter",
      transport: "OpenAI-compatible chat-completions SSE",
      credential_delivery: "worker_owned_opaque_lease",
    }),
    create(request: NativeModelAdapterRequest) {
      if (request.adapter_id !== "openai-compatible") {
        throw new NativeModelAdapterRegistryError(`OpenAI-compatible adapter cannot compose ${request.adapter_id}`);
      }
      if (request.base_url === undefined) throw new NativeModelAdapterRegistryError("openai-compatible requires base_url");
      return createOpenAICompatibleModelPort({
        fetch,
        base_url: request.base_url,
        provider_id: request.provider_id,
        model_id: request.model_id,
        ...(request.revision === undefined ? {} : { revision: request.revision }),
        observed_at: request.observed_at,
        ...(request.tools === undefined ? {} : { tools: request.tools }),
        ...(request.structured_schemas === undefined ? {} : { structured_schemas: request.structured_schemas }),
        ...(request.human_input_tool === undefined ? {} : { human_input_tool: request.human_input_tool }),
        ...(request.image_input === undefined ? {} : { image_input: request.image_input }),
        ...(request.credential_required === undefined ? {} : { credential_required: request.credential_required }),
        ...(request.timeout_ms === undefined ? {} : { timeout_ms: request.timeout_ms }),
        ...(request.max_response_bytes === undefined ? {} : { max_response_bytes: request.max_response_bytes }),
        ...(request.max_tool_argument_bytes === undefined ? {} : { max_tool_argument_bytes: request.max_tool_argument_bytes }),
        ...(request.max_output_tokens === undefined ? {} : { max_output_tokens: request.max_output_tokens }),
      });
    },
  });
}

/** The Anthropic-native transport: real `tool_use`/`tool_result` blocks and `cache_control` breakpoints, not an OpenAI-shaped translation. */
export function createAnthropicMessagesNativeModelAdapter(fetch: OpenAICompatibleFetch): NativeModelAdapter {
  return Object.freeze({
    descriptor: Object.freeze({
      adapter_id: "anthropic-messages",
      implementation_id: "revoy2-anthropic-messages-native-adapter",
      transport: "Anthropic Messages API SSE",
      credential_delivery: "worker_owned_opaque_lease",
    }),
    create(request: NativeModelAdapterRequest) {
      if (request.adapter_id !== "anthropic-messages") {
        throw new NativeModelAdapterRegistryError(`Anthropic Messages adapter cannot compose ${request.adapter_id}`);
      }
      if (request.base_url === undefined) throw new NativeModelAdapterRegistryError("anthropic-messages requires base_url");
      if (request.credential_mechanism !== undefined && request.credential_mechanism !== "api_key" && request.credential_mechanism !== "oauth_bearer") {
        throw new NativeModelAdapterRegistryError(`credential_mechanism_unsupported_by_adapter: ${request.credential_mechanism} is not valid for anthropic-messages`);
      }
      return createAnthropicMessagesModelPort({
        fetch,
        base_url: request.base_url,
        provider_id: request.provider_id,
        model_id: request.model_id,
        observed_at: request.observed_at,
        ...(request.tools === undefined ? {} : { tools: request.tools }),
        ...(request.structured_schemas === undefined ? {} : { structured_schemas: request.structured_schemas }),
        ...(request.human_input_tool === undefined ? {} : { human_input_tool: request.human_input_tool }),
        ...(request.image_input === undefined ? {} : { image_input: request.image_input }),
        ...(request.credential_required === undefined ? {} : { credential_required: request.credential_required }),
        ...(request.timeout_ms === undefined ? {} : { timeout_ms: request.timeout_ms }),
        ...(request.max_response_bytes === undefined ? {} : { max_response_bytes: request.max_response_bytes }),
        ...(request.max_tool_argument_bytes === undefined ? {} : { max_tool_argument_bytes: request.max_tool_argument_bytes }),
        ...(request.max_output_tokens === undefined ? {} : { max_output_tokens: request.max_output_tokens }),
        ...(request.prompt_caching === undefined ? {} : { prompt_caching: request.prompt_caching }),
        ...(request.credential_mechanism === undefined ? {} : { credential_mechanism: request.credential_mechanism }),
      });
    },
  });
}

/** Amazon Bedrock's Anthropic Claude `InvokeModelWithResponseStream` -- SigV4-signed, no `@aws-sdk/*` dependency (ADR-100). */
export function createAwsBedrockMessagesNativeModelAdapter(fetch: OpenAICompatibleFetch): NativeModelAdapter {
  return Object.freeze({
    descriptor: Object.freeze({
      adapter_id: "aws-bedrock-messages",
      implementation_id: "revoy2-aws-bedrock-messages-native-adapter",
      transport: "Amazon Bedrock InvokeModelWithResponseStream (SigV4, eventstream)",
      credential_delivery: "worker_owned_opaque_lease",
    }),
    create(request: NativeModelAdapterRequest) {
      if (request.adapter_id !== "aws-bedrock-messages") {
        throw new NativeModelAdapterRegistryError(`Bedrock Messages adapter cannot compose ${request.adapter_id}`);
      }
      if (request.region === undefined) throw new NativeModelAdapterRegistryError("aws-bedrock-messages requires region");
      if (request.credential_mechanism !== undefined && request.credential_mechanism !== "aws_sigv4") {
        throw new NativeModelAdapterRegistryError(`credential_mechanism_unsupported_by_adapter: ${request.credential_mechanism} is not valid for aws-bedrock-messages`);
      }
      return createBedrockMessagesModelPort({
        fetch,
        region: request.region,
        provider_id: request.provider_id,
        model_id: request.model_id,
        observed_at: request.observed_at,
        ...(request.tools === undefined ? {} : { tools: request.tools }),
        ...(request.structured_schemas === undefined ? {} : { structured_schemas: request.structured_schemas }),
        ...(request.credential_required === undefined ? {} : { credential_required: request.credential_required }),
        ...(request.timeout_ms === undefined ? {} : { timeout_ms: request.timeout_ms }),
        ...(request.max_response_bytes === undefined ? {} : { max_response_bytes: request.max_response_bytes }),
        ...(request.max_tool_argument_bytes === undefined ? {} : { max_tool_argument_bytes: request.max_tool_argument_bytes }),
        ...(request.max_output_tokens === undefined ? {} : { max_output_tokens: request.max_output_tokens }),
      });
    },
  });
}

/** Claude on Google Cloud's Agent Platform (Vertex AI) `streamRawPredict` -- OAuth2-bearer, no `@google-cloud/*` dependency (ADR-100). */
export function createGcpVertexMessagesNativeModelAdapter(fetch: OpenAICompatibleFetch): NativeModelAdapter {
  return Object.freeze({
    descriptor: Object.freeze({
      adapter_id: "gcp-vertex-messages",
      implementation_id: "revoy2-gcp-vertex-messages-native-adapter",
      transport: "Vertex AI Agent Platform streamRawPredict SSE",
      credential_delivery: "worker_owned_opaque_lease",
    }),
    create(request: NativeModelAdapterRequest) {
      if (request.adapter_id !== "gcp-vertex-messages") {
        throw new NativeModelAdapterRegistryError(`Vertex Messages adapter cannot compose ${request.adapter_id}`);
      }
      if (request.project_id === undefined) throw new NativeModelAdapterRegistryError("gcp-vertex-messages requires project_id");
      if (request.credential_mechanism !== undefined && request.credential_mechanism !== "oauth_service_account") {
        throw new NativeModelAdapterRegistryError(`credential_mechanism_unsupported_by_adapter: ${request.credential_mechanism} is not valid for gcp-vertex-messages`);
      }
      return createVertexMessagesModelPort({
        fetch,
        project_id: request.project_id,
        ...(request.location === undefined ? {} : { location: request.location }),
        provider_id: request.provider_id,
        model_id: request.model_id,
        observed_at: request.observed_at,
        ...(request.tools === undefined ? {} : { tools: request.tools }),
        ...(request.structured_schemas === undefined ? {} : { structured_schemas: request.structured_schemas }),
        ...(request.credential_required === undefined ? {} : { credential_required: request.credential_required }),
        ...(request.timeout_ms === undefined ? {} : { timeout_ms: request.timeout_ms }),
        ...(request.max_response_bytes === undefined ? {} : { max_response_bytes: request.max_response_bytes }),
        ...(request.max_tool_argument_bytes === undefined ? {} : { max_tool_argument_bytes: request.max_tool_argument_bytes }),
        ...(request.max_output_tokens === undefined ? {} : { max_output_tokens: request.max_output_tokens }),
      });
    },
  });
}

/** Ollama's native `/api/chat` -- honest local behavior instead of an `openai-compatible` masquerade (ADR-100). */
export function createOllamaNativeNativeModelAdapter(fetch: OpenAICompatibleFetch): NativeModelAdapter {
  return Object.freeze({
    descriptor: Object.freeze({
      adapter_id: "ollama-native",
      implementation_id: "revoy2-ollama-native-adapter",
      transport: "Ollama /api/chat newline-delimited JSON",
      credential_delivery: "worker_owned_opaque_lease",
    }),
    create(request: NativeModelAdapterRequest) {
      if (request.adapter_id !== "ollama-native") {
        throw new NativeModelAdapterRegistryError(`Ollama adapter cannot compose ${request.adapter_id}`);
      }
      return createOllamaNativeModelPort({
        fetch,
        ...(request.base_url === undefined ? {} : { base_url: request.base_url }),
        provider_id: request.provider_id,
        model_id: request.model_id,
        observed_at: request.observed_at,
        ...(request.tools === undefined ? {} : { tools: request.tools }),
        ...(request.structured_schemas === undefined ? {} : { structured_schemas: request.structured_schemas }),
        ...(request.credential_required === undefined ? {} : { credential_required: request.credential_required }),
        ...(request.timeout_ms === undefined ? {} : { timeout_ms: request.timeout_ms }),
        ...(request.max_response_bytes === undefined ? {} : { max_response_bytes: request.max_response_bytes }),
        ...(request.max_tool_argument_bytes === undefined ? {} : { max_tool_argument_bytes: request.max_tool_argument_bytes }),
        ...(request.max_output_tokens === undefined ? {} : { max_output_tokens: request.max_output_tokens }),
      });
    },
  });
}

/**
 * The reference harness's intentionally small built-in catalog. Adding a
 * transport requires a real adapter plus an explicit config/schema change;
 * endpoint/provider strings alone never opt a workload into imaginary support.
 */
export function createReferenceNativeModelAdapterRegistry(fetch: OpenAICompatibleFetch): NativeModelAdapterRegistry {
  const registry = new NativeModelAdapterRegistry();
  const adapters = [
    createOpenAICompatibleNativeModelAdapter(fetch),
    createAnthropicMessagesNativeModelAdapter(fetch),
    createAwsBedrockMessagesNativeModelAdapter(fetch),
    createGcpVertexMessagesNativeModelAdapter(fetch),
    createOllamaNativeNativeModelAdapter(fetch),
  ];
  for (const adapter of adapters) {
    // Keep the closed published catalog joined to the executable composition:
    // an implementation cannot be registered as a built-in merely by sharing a
    // provider-like name.
    if (!(NATIVE_MODEL_ADAPTER_IDS as readonly string[]).includes(adapter.descriptor.adapter_id)) {
      throw new NativeModelAdapterRegistryError("built-in adapter is absent from the closed reference catalog");
    }
    registry.register(adapter);
  }
  return registry;
}
