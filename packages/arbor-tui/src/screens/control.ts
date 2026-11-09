import { wrapDisplay } from "../widgets.js";
import type { RuntimeQueryKind } from "../runtime-port.js";
import type { RowIdentity, ScreenId, ScreenModule, ScreenProjection } from "./screen.js";
import { buildScreenPipeline, defineVariant } from "./registry.js";
import { renderStatusDocument } from "./status-document.js";

const MAX_ROWS = 100;
export const CONTROL_DISABLED_GUIDANCE = "Distributed control is disabled. Set ARBOR_DISTRIBUTED_CONTROL_CONFIG to a closed v1 authority or join config, then restart this runtime.";
const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const configured = (value: unknown): value is Record<string, unknown> => object(value) && value.availability === "configured" && typeof value.kind === "string" && object(value.value);
const disabled = (value: unknown): value is Record<string, unknown> => object(value) && value.availability === "disabled";
const string = (value: unknown, fallback = "—"): string => typeof value === "string" && value.length > 0 ? value.slice(0, 160) : fallback;
const number = (value: unknown): number | string => typeof value === "number" && Number.isFinite(value) ? value : "—";

function statusProjection(input: Record<string, unknown>): Omit<ScreenProjection, "variant"> {
  const value = input.value as Record<string, unknown>, coordinator = object(value.coordinator) ? value.coordinator : {}, registration = object(value.registration) ? value.registration : {}, bridge = object(value.bridge) ? value.bridge : {};
  return { screen: "control" as ScreenId, caption: `Flight control status · ledger refresh ${string(input.updated_at, "pending")}`, columns: [{ key: "role", title: "Role", width: 12 }, { key: "state", title: "State", width: 12 }, { key: "host", title: "Host", width: 20 }, { key: "coordinator", title: "Coordinator", width: 14 }, { key: "heartbeat", title: "Heartbeat", width: 22 }, { key: "bridge", title: "Bridge", width: 12 }, { key: "outbox", title: "Outbox", width: 8 }, { key: "dead", title: "Dead", width: 6 }], rows: [{ role: string(value.role), state: string(value.state), host: string(value.host_id, "authority"), coordinator: coordinator.reachable === true ? "reachable" : `offline: ${string(coordinator.error, "unconfigured")}`, heartbeat: string(registration.heartbeat_at, "not registered"), bridge: string(bridge.status, "disabled"), outbox: number(bridge.outbox_pending), dead: number(bridge.dead_letters) }] };
}
function discoverProjection(input: Record<string, unknown>): Omit<ScreenProjection, "variant"> {
  const value = input.value as Record<string, unknown>, hosts = Array.isArray(value.hosts) ? value.hosts.filter(object).slice(0, MAX_ROWS) : [];
  return { screen: "control" as ScreenId, caption: `Discovered live hosts · ${hosts.length}${value.truncated === true ? "+" : ""} shown`, columns: [{ key: "host", title: "Host", width: 20 }, { key: "repo", title: "Repository", width: 20 }, { key: "session", title: "Session", width: 20 }, { key: "capabilities", title: "Capabilities", width: 24 }, { key: "heartbeat", title: "Heartbeat", width: 22 }, { key: "expires", title: "Expires", width: 22 }], rows: hosts.map((host) => ({ host: string(host.host_id, "?"), repo: string(host.repo_id, "?"), session: string(host.session_id, "?"), capabilities: Array.isArray(host.capabilities) ? host.capabilities.filter((item) => typeof item === "string").slice(0, 16).join(", ") : "—", heartbeat: string(host.heartbeat_at), expires: string(host.expires_at) })), row_ids: hosts.map((host): RowIdentity | null => typeof host.host_id === "string" ? { id: host.host_id } : null) };
}
function inboxProjection(input: Record<string, unknown>): Omit<ScreenProjection, "variant"> {
  const value = input.value as Record<string, unknown>, messages = Array.isArray(value.messages) ? value.messages.filter(object).slice(0, MAX_ROWS) : [];
  return { screen: "control" as ScreenId, caption: `Redacted coordinator inbox · ${messages.length}${value.truncated === true ? "+" : ""} shown · payload bodies never projected`, columns: [{ key: "sequence", title: "Seq", width: 8 }, { key: "sender", title: "Sender", width: 20 }, { key: "kind", title: "Kind", width: 28 }, { key: "correlation", title: "Correlation", width: 20 }, { key: "created", title: "Created", width: 22 }, { key: "attempts", title: "Attempts", width: 8 }, { key: "bytes", title: "Bytes", width: 8 }, { key: "claimed", title: "Claimed", width: 8 }], rows: messages.map((message) => ({ sequence: number(message.sequence), sender: string(message.sender_host_id, "?"), kind: string(message.kind, "?"), correlation: string(message.correlation_id), created: string(message.created_at), attempts: number(message.delivery_attempts), bytes: number(message.payload_bytes), claimed: message.claimed === true ? "yes" : "no" })), row_ids: messages.map((message): RowIdentity | null => typeof message.message_id === "string" ? { id: message.message_id } : null) };
}
function render(projection: ScreenProjection, width: number, height: number, offset?: number): readonly string[] {
  // Prose that must be read wraps (sweep 2 at 132 columns cut "restart this
  // runtime" to "restart this r" — the remedy was the part that fell off).
  if (projection.variant === "disabled") return wrapDisplay(CONTROL_DISABLED_GUIDANCE, Math.max(1, width)).slice(0, Math.max(1, height));
  return renderStatusDocument(projection, width, height, offset, { wide_min_columns: 120, empty_caption: "Flight Control unavailable" });
}

export const controlScreen: ScreenModule = {
  id: "control" as ScreenId,
  title: "Flight Control",
  required_capabilities: ["control.read"],
  surface: { commands: [], queries: ["control.status", "control.discover", "control.inbox"] as RuntimeQueryKind[] },
  ...buildScreenPipeline([
    defineVariant({ tag: "disabled", match: disabled, project: () => ({ screen: "control" as ScreenId, caption: CONTROL_DISABLED_GUIDANCE, columns: [{ key: "status", title: "Status", width: 80 }], rows: [] }), render: (projection, context) => render(projection, context.width, context.height, context.scroll_offset) }),
    defineVariant({ tag: "status", match: (value): value is Record<string, unknown> => configured(value) && value.kind === "control.status", project: statusProjection, render: (projection, context) => render(projection, context.width, context.height, context.scroll_offset) }),
    defineVariant({ tag: "discover", match: (value): value is Record<string, unknown> => configured(value) && value.kind === "control.discover", project: discoverProjection, render: (projection, context) => render(projection, context.width, context.height, context.scroll_offset) }),
    defineVariant({ tag: "inbox", match: (value): value is Record<string, unknown> => configured(value) && value.kind === "control.inbox", project: inboxProjection, render: (projection, context) => render(projection, context.width, context.height, context.scroll_offset) }),
  ], { emptyProjection: () => ({ screen: "control" as ScreenId, caption: CONTROL_DISABLED_GUIDANCE, columns: [{ key: "status", title: "Status", width: 80 }], rows: [] }), shortCircuitEmptyRows: false }),
};
