import type { NativeModelAdapterToolDefinition, NativeToolPort } from "@arbor/harness";

export const MCP_PREFERRED_PROTOCOL_VERSION = "2026-07-28";
export const MCP_SUPPORTED_PROTOCOL_VERSIONS = Object.freeze([
  MCP_PREFERRED_PROTOCOL_VERSION,
  "2025-11-25",
  "2025-06-18",
] as const);
export type McpSupportedProtocolVersion = (typeof MCP_SUPPORTED_PROTOCOL_VERSIONS)[number];
export const MCP_MAX_SERVERS = 8;
export const MCP_MAX_TOOLS_PER_SERVER = 64;
export const MCP_MAX_TOOL_NAME_BYTES = 128;
export const MCP_MAX_METHOD_BYTES = 128;
export const MCP_MAX_DESCRIPTION_BYTES = 4 * 1024;
export const MCP_MAX_ARGUMENT_BYTES = 64 * 1024;
export const MCP_MAX_RESULT_BYTES = 64 * 1024;
export const MCP_MAX_SCHEMA_BYTES = 64 * 1024;
export const MCP_MAX_FRAME_BYTES = 1024 * 1024;
export const MCP_MAX_CONTENT_PARTS = 256;
export const MCP_MAX_SECRET_BYTES = 16 * 1024;
export const MCP_CALL_TIMEOUT_MS = 30_000;
export const MCP_CONNECT_TIMEOUT_MS = 10_000;
export const MCP_MAX_TIMEOUT_MS = 5 * 60_000;
export const MCP_MAX_CONCURRENT_CALLS = 4;
export const MCP_STDERR_BYTES = 8 * 1024;
export const MCP_MAX_RESOURCES_PER_SERVER = 64;
export const MCP_MAX_PROMPTS_PER_SERVER = 64;
export const MCP_MAX_RESOURCE_URI_BYTES = 2 * 1024;
export const MCP_MAX_PROMPT_NAME_BYTES = 128;
export const MCP_MAX_PROMPT_ARGUMENTS = 32;
export const MCP_MAX_INPUT_REQUESTS = 8;
export const MCP_MAX_ELICIT_MESSAGE_BYTES = 4 * 1024;
export const MCP_MAX_ELICIT_ROUNDTRIPS = 4;
export const MCP_MAX_REQUEST_STATE_BYTES = 16 * 1024;
export const MCP_LISTEN_TIMEOUT_MS = MCP_MAX_TIMEOUT_MS;

/** MCP client options are typed and validated at the canonical config boundary. */
export type McpServerConfig = import("@arbor/config").NativeMcpServerConfig;

export interface McpResourceDescription {
  readonly uri: string;
  readonly name: string;
  readonly description: string;
  readonly mimeType: string | null;
}

export interface McpResourceTemplateDescription {
  readonly uriTemplate: string;
  readonly name: string;
  readonly description: string;
  readonly mimeType: string | null;
}

export interface McpResourceContent {
  readonly uri: string;
  readonly mimeType: string | null;
  readonly text: string | null;
  readonly blob: string | null;
}

export interface McpPromptArgument {
  readonly name: string;
  readonly description: string;
  readonly required: boolean;
}

export interface McpPromptDescription {
  readonly name: string;
  readonly description: string;
  readonly arguments: readonly McpPromptArgument[];
}

export interface McpPromptMessage {
  readonly role: "user" | "assistant";
  readonly content: Readonly<Record<string, unknown>>;
}

export interface McpPromptResult {
  readonly description: string | null;
  readonly messages: readonly McpPromptMessage[];
}

/** A single server-issued input request from an `InputRequiredResult` (MRTR, SEP-2322). Only `elicitation/create` is resolved; any other method is a protocol error, since this client declares no other MRTR-eligible capability. */
export interface McpElicitationRequest {
  readonly mode: "form" | "url";
  readonly message: string;
  readonly requestedSchema?: Readonly<Record<string, unknown>>;
  readonly url?: string;
}

export interface McpElicitationResult {
  readonly action: "accept" | "decline" | "cancel";
  readonly content?: Readonly<Record<string, unknown>>;
}

/** Resolves elicitation input requests a connected MCP server raises mid-call via MRTR. Never invoked ambiently -- only when a server both declares the need and this port is configured for the connector. */
export interface McpElicitationPort {
  elicit(request: McpElicitationRequest, context: { readonly server_id: string }): Promise<McpElicitationResult>;
}

/** `subscriptions/listen` notification filter (2026-07-28 basic/patterns/subscriptions). */
export interface McpSubscriptionFilter {
  readonly toolsListChanged?: boolean;
  readonly resourcesListChanged?: boolean;
  readonly promptsListChanged?: boolean;
}

export interface McpToolDescription {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

export interface McpCallResult {
  readonly content: readonly unknown[];
  readonly isError: boolean;
}

export interface McpClientInspection {
  readonly state: "new" | "connecting" | "connected" | "closed" | "failed";
  readonly protocol_version: string | null;
  readonly server_info: Readonly<Record<string, unknown>> | null;
  readonly capabilities: Readonly<Record<string, unknown>> | null;
  readonly diagnostic: string | null;
}

export interface McpConnectorInspection {
  readonly server_id: string;
  readonly client: McpClientInspection;
  readonly resources: readonly McpResourceDescription[];
  readonly resource_templates: readonly McpResourceTemplateDescription[];
  readonly prompts: readonly McpPromptDescription[];
}

export interface McpAdvertisedToolPort extends NativeToolPort {
  readonly model_definition: NativeModelAdapterToolDefinition;
}

export interface McpToolPortOptions {
  readonly server_id: string;
  readonly tool: McpToolDescription;
  readonly client: Pick<import("./mcp-client.js").McpClient, "connected" | "callTool">;
  readonly risk: "low" | "high";
  readonly mutating: boolean;
  readonly credential_for_session?: (session_id: string) => import("@arbor/harness").NativeCredentialLeasePort | undefined;
  readonly redact?: (value: string) => string;
  readonly max_argument_bytes?: number;
  readonly max_result_bytes?: number;
  readonly call_timeout_ms?: number;
}

export interface McpConnectorDiagnostic {
  readonly server_id: string;
  readonly code: string;
  readonly message: string;
}
