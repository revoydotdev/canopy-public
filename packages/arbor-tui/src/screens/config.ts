/**
 * Config screen (roadmap 4C, item 21).
 *
 * Bounded view of the composed effective config from `config.get`: per-leaf
 * dotted path with source provenance (`default`|`file`|`injected`) and
 * STRUCTURAL redaction — a secret leaf's real value is absent, replaced by
 * an explicit `[redacted]` marker, regardless of tier. Never renders raw
 * env/process globals.
 *
 * Leaf module. Depends only on @arbor/core (via widgets) and the
 * runtime-port/screen contracts — never @arbor/mcp.
 */

import type { RowIdentity, ScreenId, ScreenModule, ScreenProjection } from "./screen.js";
import { buildScreenPipeline, defineVariant } from "./registry.js";
import { emptyCaption, unrecognisedCaption } from "./empty-state.js";
import { renderStatusDocument } from "./status-document.js";

const MAX_ROWS = 200;

interface ConfigShape {
  readonly leaves?: readonly Record<string, unknown>[];
  readonly native_selection?: unknown;
}

function isConfigShape(result: unknown): result is ConfigShape {
  return typeof result === "object" && result !== null && "leaves" in result && Array.isArray((result as { leaves?: unknown }).leaves);
}

function rowCountCaption(caption: string, count: number): string {
  return count > 0 ? `${caption} (${count})` : `no ${caption.toLowerCase()}`;
}

function nativeSelectionCaption(selection: unknown): string {
  if (typeof selection !== "object" || selection === null) return "Native: unavailable";
  const value = selection as Record<string, unknown>;
  if (value.kind === "native" && typeof value.adapter_id === "string" && typeof value.provider_id === "string" && typeof value.model === "string") {
    // A config pin is deliberately not displayed as if the provider honored
    // it. The session screen shows the separately response-observed revision.
    const revision = typeof value.revision === "string" && value.revision.trim()
      ? `; revision configured ${value.revision} (unobserved)`
      : "; revision unpinned";
    return `Native: direct (${value.adapter_id} → ${value.provider_id}/${value.model})${revision}`;
  }
  if (value.kind === "fallback" && typeof value.reason === "string") return `Native: connector fallback (${value.reason})`;
  if (value.kind === "unavailable" && typeof value.reason === "string") return `Native: blocked (${value.reason})`;
  return "Native: unavailable";
}

function nativePolicyCaption(leaves: readonly Record<string, unknown>[]): string {
  const values = new Map(leaves.filter((leaf): leaf is Record<string, unknown> & { path: string } => typeof leaf.path === "string").map((leaf) => [leaf.path, leaf.value]));
  const limits = [
    ["input", values.get("native.usage_budget.max_session_input_tokens")],
    ["output", values.get("native.usage_budget.max_session_output_tokens")],
    ["total", values.get("native.usage_budget.max_session_total_tokens")],
  ].filter(([, value]) => value !== undefined).map(([name, value]) => `${name}≤${String(value)}`);
  const priceSource = values.get("native.pricing.price_source_id");
  if (limits.length === 0 && priceSource === undefined) return "Native policy: no session budget/pricing configured";
  return `Native policy: ${limits.length === 0 ? "no token ceiling" : limits.join(", ")}${priceSource === undefined ? "" : ` · pricing ${String(priceSource)}`}`;
}

function projectConfig(leaves: readonly Record<string, unknown>[], limit: number, nativeSelection: unknown): Omit<ScreenProjection, "variant"> {
  const sliced = leaves.slice(0, limit);
  const bounded = sliced.map((leaf) => ({
    path: typeof leaf.path === "string" ? leaf.path : "?",
    source: typeof leaf.source === "string" ? leaf.source : "?",
    // Rendering must fail closed even if a future config projection regresses
    // and accidentally carries a secret value alongside its redaction marker.
    value: leaf.redacted === true ? "[redacted]" : (typeof leaf.value === "string" ? leaf.value : String(leaf.value ?? "")),
    redacted: leaf.redacted === true ? "yes" : "no",
  }));

  return {
    screen: "config",
    rows: bounded,
    columns: [
      { key: "path", title: "Key", width: 32 },
      { key: "source", title: "Source", width: 9 },
      { key: "value", title: "Value", width: 30 },
      { key: "redacted", title: "Secret", width: 7 },
    ],
    caption: `${rowCountCaption("Config", bounded.length)} · ${nativeSelectionCaption(nativeSelection)} · ${nativePolicyCaption(leaves)}`,
    // A leaf's dotted `path` is its own stable identity, even though this
    // read-only screen issues no per-leaf command today.
    row_ids: sliced.map((leaf): RowIdentity | null => (typeof leaf.path === "string" ? { id: leaf.path } : null)),
  };
}

function renderConfigTable(projection: ScreenProjection, width: number, height: number, offset?: number): readonly string[] {
  return renderStatusDocument(projection, width, height, offset, { wide_min_columns: 96, empty_caption: "Effective config not loaded" });
}

function emptyProjection(reason: "empty" | "unrecognised"): Omit<ScreenProjection, "variant"> {
  return {
    screen: "config",
    rows: [],
    columns: [{ key: "path", title: "Key", width: 10 }],
    caption: reason === "empty"
      ? emptyCaption({ what: "Effective config not loaded", how: "reopen Config (7) to refresh" })
      : unrecognisedCaption("Config"),
  };
}

const CONFIG_VARIANTS = [
  defineVariant({
    tag: "config",
    match: isConfigShape,
    project: (shape) => projectConfig(shape.leaves ?? [], MAX_ROWS, shape.native_selection),
    render: (projection, ctx) => renderConfigTable(projection, ctx.width, ctx.height, ctx.scroll_offset),
  }),
];

export const configScreen: ScreenModule = {
  id: "config" as ScreenId,
  title: "Config",
  required_capabilities: ["config.read"],

  surface: { commands: [], queries: ["config.get"] },

  ...buildScreenPipeline(CONFIG_VARIANTS, { emptyProjection }),
};
