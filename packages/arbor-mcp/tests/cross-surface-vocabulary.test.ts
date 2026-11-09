/**
 * P5-1: one vocabulary across TUI, WebUI, CLI and MCP.
 *
 * One fixed scenario — a verified node, a critic-failed node, a node the
 * deterministic native worker's campaign-budget authority refused (typed
 * ADR-179 remedy), a pending node, and an automatic `budget_exhausted` halt
 * whose audit gate is recorded as a bypass — is persisted once, then read
 * back through each REAL surface:
 *
 * - CLI: `arbor report` human text (TTY) and `--json`, through `main`.
 * - MCP: `ArborMCPServer.callTool` (`arbor_query`, `arbor_gate_status`,
 *   `arbor_get_state`) and `readResource`.
 * - TUI: the headless harness over `RuntimePortAdapter`, projected and
 *   rendered by the registered `tree` and `campaigns` screens.
 * - WebUI: a real `ArborWebUIServer` over HTTP — its JSON routes, and its
 *   served client script evaluated in a `node:vm` sandbox (the
 *   webui-observability-panels pattern) to produce the operator HTML.
 *
 * Every fact a surface names must be named with the canonical term from
 * `@arbor/core`'s `OPERATOR_VOCABULARY` (its wire token, or its label). A
 * fact a surface does not show at all is allowed only if it is listed in
 * `KNOWN_ABSENCES`, and every listed absence is asserted to still be absent,
 * so the ledger cannot go stale in either direction. Wording drifts that are
 * not yet fixed live in `KNOWN_DRIFTS` under the same two-way ratchet.
 */
import { mkdtempSync, rmSync } from "node:fs";
import * as http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import * as vm from "node:vm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  NODE_ERROR_KINDS,
  OPERATOR_VOCABULARY,
  OUTCOME_KINDS,
  RUNTIME_REFUSAL_REMEDIES,
  TERMINAL_NODE_STATES,
  type Action,
  type OperatorVocabularyCategory,
  type Provenance,
} from "@arbor/core";
import type { CapabilitySupport, NativeModelPort, NativeTokenEstimateAuthority } from "@arbor/harness";
import { HeadlessHarness, campaignsScreen, clearRegisteredScreens, installScreens, treeScreen } from "@arbor/tui";
import { main, resolvePersistenceDir } from "../src/cli.js";
import { NativeAgentExecutor } from "../src/native-agent-executor.js";
import { NativeCampaignBudgetAuthority } from "../src/native-campaign-budget.js";
import { ArborRuntime } from "../src/runtime.js";
import { RuntimeCatalogRouter } from "../src/runtime-catalog.js";
import { ArborMCPServer } from "../src/server.js";
import { RuntimePortAdapter } from "../src/tui-adapter.js";
import { ArborWebUIServer } from "../src/webui.js";

const CAMPAIGN = "vocab-camp";
const rootAction: Action = { description: "root plan", estimated_gain: 1, estimated_cost: 1, category: "root", delegate_to: "crown" };
const child = (description: string): Action => ({ description, estimated_gain: 1, estimated_cost: 1, category: "impl", delegate_to: "seed" });
const verifiedProv: Provenance = { tag: "verified", cmd: "bun test", exit: 0, stdout_hash: `sha256:${"a".repeat(64)}` };
const scoreCtx = { accuracy_regression_rate: 0, crash_regression_rate: 0, best_known: 0, total_visits: 1 };

const capabilities = ["streaming", "interruption", "ephemeral_sessions", "tool_policy", "usage_reporting"].map((capability) => ({
  capability, grade: "native",
  evidence: { implementation_id: "cross-surface-vocabulary", observed_at: "2026-10-06T00:00:00.000Z", detail: "fixture" },
})) as readonly CapabilitySupport[];
const estimator: NativeTokenEstimateAuthority = {
  estimate(request) {
    const input = Buffer.byteLength(request.prompt, "utf8");
    return { kind: "estimated", input_tokens: input, output_tokens: 5, cache_read_tokens: input, cache_write_tokens: input, authority: "fixture-upper-bound" };
  },
};

/** True when `value` is a wire token of `category` in the core vocabulary. */
function isOperatorTerm(category: OperatorVocabularyCategory, value: unknown): value is string {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(OPERATOR_VOCABULARY[category], value);
}

/** The two renderings a surface may print for a term: its wire token and its label. */
function operatorRenderings(category: OperatorVocabularyCategory, token: string): readonly [string, string] {
  if (!isOperatorTerm(category, token)) throw new Error(`${token} is not a canonical ${category} term`);
  return [token, (OPERATOR_VOCABULARY[category] as Readonly<Record<string, string>>)[token]!];
}

// ---------------------------------------------------------------------------
// The scenario's facts, each with the one canonical term every surface must use
// ---------------------------------------------------------------------------

const FACTS = {
  "root.state": { category: "node_state", token: "claimed" },
  "verified.state": { category: "node_state", token: "verified" },
  "failed.state": { category: "node_state", token: "failed" },
  "refused.state": { category: "node_state", token: "failed" },
  "pending.state": { category: "node_state", token: "pending" },
  "campaign.halt_reason": { category: "halt_reason", token: "budget_exhausted" },
  "campaign.terminal_outcome": { category: "terminal_outcome", token: "completed" },
  "root.provenance": { category: "provenance_tag", token: "claimed" },
  "verified.provenance": { category: "provenance_tag", token: "verified" },
  "refused.error_kind": { category: "node_error_kind", token: "internal_error" },
  "refused.remedy.authority": { category: "refusal_authority", token: "budget" },
  "refused.remedy.state": { category: "refusal_state", token: "refused" },
  "refused.remedy.actor": { category: "remedy_actor", token: "operator" },
  "refused.remedy.action": { category: "corrective_action", token: "raise_budget" },
  "audit.record.gate": { category: "gate", token: "audit" },
  "audit.record.result": { category: "gate_result", token: "bypass" },
  "audit.refusal.authority": { category: "refusal_authority", token: "audit" },
  "audit.refusal.state": { category: "refusal_state", token: "refused" },
  "audit.refusal.actor": { category: "remedy_actor", token: "operator" },
  "audit.refusal.action": { category: "corrective_action", token: "resolve_audit_findings" },
} as const satisfies Record<string, { category: OperatorVocabularyCategory; token: string }>;
type FactId = keyof typeof FACTS;

type Surface = "cli_text" | "cli_json" | "mcp" | "tui" | "webui_json" | "webui_html";
const SURFACES: readonly Surface[] = ["cli_text", "cli_json", "mcp", "tui", "webui_json", "webui_html"];

/**
 * Facts a surface does not render at all for this scenario. Absence is not a
 * naming drift, but it is a cross-surface gap: each entry is a fact an
 * operator can learn on one surface and not another. Removing an entry is how
 * a fix is recorded — the ratchet below fails until the list matches reality.
 */
const KNOWN_ABSENCES: Readonly<Record<Surface, readonly FactId[]>> = {
  // The human report names neither provenance, the error kind (it prints the
  // message as ROOT CAUSE), the terminal outcome, nor the raw gate record.
  cli_text: ["campaign.terminal_outcome", "root.provenance", "verified.provenance", "refused.error_kind", "audit.record.gate", "audit.record.result"],
  // The run report's campaign snapshot carries no `terminal_outcome`
  // (`listCampaigns` derives it; `getCampaignSnapshot` does not).
  cli_json: ["campaign.terminal_outcome"],
  mcp: [],
  // Tree inspector prints `error: <kind> — <message>` without the typed
  // remedy; neither the tree nor the campaigns screen projects a gate
  // refusal or the terminal outcome.
  tui: ["campaign.terminal_outcome", "refused.remedy.authority", "refused.remedy.state", "refused.remedy.actor", "refused.remedy.action",
    "audit.refusal.authority", "audit.refusal.state", "audit.refusal.actor", "audit.refusal.action"],
  // `/api/campaigns/:id` is the raw snapshot: gate records, no projection.
  webui_json: ["audit.refusal.authority", "audit.refusal.state", "audit.refusal.actor", "audit.refusal.action"],
  // The campaign detail markup shows node badges, failure text, halt reason
  // and the card's outcome badge, nothing typed beyond that.
  webui_html: ["root.provenance", "verified.provenance", "refused.error_kind",
    "refused.remedy.authority", "refused.remedy.state", "refused.remedy.actor", "refused.remedy.action",
    "audit.record.gate", "audit.record.result", "audit.refusal.authority", "audit.refusal.state", "audit.refusal.actor", "audit.refusal.action"],
};

/**
 * Operator-visible words that name a canonical term with a non-canonical
 * word. Same two-way ratchet: each must still be observed where listed, and
 * no unlisted non-canonical word may appear in a checked slot.
 */
const KNOWN_DRIFTS: readonly { readonly surface: Surface; readonly slot: string; readonly word: string; readonly canonical: string }[] = [
];

// ---------------------------------------------------------------------------
// Surface capture
// ---------------------------------------------------------------------------

let root = "";
let ids = { verified: "", failed: "", refused: "", pending: "" };
type Captured = Partial<Record<FactId, string>>;
const facts = {} as Record<Surface, Captured>;
const slots = {} as Record<Surface, Record<string, string[]>>;
const json = {} as Record<"cli_json" | "mcp" | "webui_json", unknown[]>;
let mcpHaltCheck: { readonly get_state: Json; readonly resource: Json; readonly halt_check: Json } | null = null;

async function cli(args: string[], tty: boolean): Promise<string> {
  const stdout = new PassThrough() as PassThrough & { isTTY?: boolean };
  stdout.isTTY = tty;
  let text = "";
  stdout.on("data", (chunk: Buffer) => { text += chunk.toString(); });
  await main(args, { cwd: root, persistence_dir: undefined, stdin: new PassThrough(), stdout, stderr: new PassThrough(), runtime_factory: undefined });
  return text;
}

function httpGet(port: number, path: string, headers: Readonly<Record<string, string>>): Promise<string> {
  return new Promise((resolve, reject) => {
    http.get({ hostname: "127.0.0.1", port, path, headers }, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => resolve(data));
    }).on("error", reject);
  });
}

function pickFunction(script: string, name: string): string {
  const start = script.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`client function ${name} is not served`);
  let depth = 0;
  let i = script.indexOf("{", start);
  for (; i < script.length; i++) {
    if (script[i] === "{") depth++;
    else if (script[i] === "}") { depth--; if (depth === 0) break; }
  }
  return script.slice(start, i + 1);
}

type Json = Record<string, any>;
const match = (text: string, pattern: RegExp): string | undefined => pattern.exec(text)?.[1];

/** Facts read from a raw campaign snapshot (`nodes[]` + `halt_reason`). */
function snapshotFacts(campaign: Json): Captured {
  const node = (id: string): Json => (campaign.nodes as Json[]).find((entry) => entry.id === id) ?? {};
  const remedy = node(ids.refused).outcome?.error?.remedy ?? {};
  const audit = ((node("root").gate_records ?? []) as Json[]).filter((record) => record.result !== "pass").at(-1) ?? {};
  return {
    "root.state": node("root").state, "verified.state": node(ids.verified).state, "failed.state": node(ids.failed).state,
    "refused.state": node(ids.refused).state, "pending.state": node(ids.pending).state,
    "campaign.halt_reason": campaign.halt_reason ?? undefined,
    "root.provenance": node("root").provenance?.tag, "verified.provenance": node(ids.verified).provenance?.tag,
    "refused.error_kind": node(ids.refused).outcome?.error?.kind,
    "refused.remedy.authority": remedy.gate, "refused.remedy.state": remedy.state,
    "refused.remedy.actor": remedy.correcting_actor, "refused.remedy.action": remedy.corrective_action,
    "audit.record.gate": audit.gate, "audit.record.result": audit.result,
  };
}

function refusalFacts(projection: Json | null | undefined): Captured {
  if (!projection) return {};
  return {
    "audit.refusal.authority": projection.gate, "audit.refusal.state": projection.state,
    "audit.refusal.actor": projection.correcting_actor, "audit.refusal.action": projection.corrective_action,
  };
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "arbor-xsurface-vocab-"));

  // The refusal is produced by the real deterministic native worker: its
  // campaign-budget reservation refuses before any model call.
  const model: NativeModelPort = { async run() { throw new Error("the budget authority must refuse before a model call"); } };
  const executor = new NativeAgentExecutor({
    workspace_root: "/workspace", capabilities, model_for_role: () => model,
    campaign_budget: { authority: new NativeCampaignBudgetAuthority(join(root, "budget")), config: { max_tokens: 1, provenance: { tag: "generated", generator: "fixture", input_hash: "fixture" } }, max_input_tokens: 100, max_output_tokens: 5, token_estimator: estimator },
  });
  const refusal = await executor.specialize({ campaign_id: CAMPAIGN, node_id: "n", action: {}, prompt: "do work", worktree_path: "", specialist_agent: "seed" });
  if (refusal.error === undefined) throw new Error("fixture: the campaign-budget authority did not refuse");

  const seeding = new ArborRuntime({ persistence_dir: resolvePersistenceDir(root) });
  seeding.manager.startCampaign(CAMPAIGN, "plan.md", rootAction);
  const [verified, failed, refused, pending] = seeding.manager.branch(CAMPAIGN, "root", [child("verified work"), child("failed work"), child("refused work"), child("pending work")]);
  ids = { verified: verified!, failed: failed!, refused: refused!, pending: pending! };
  for (const id of [ids.verified, ids.failed, ids.refused]) seeding.manager.expandNode(CAMPAIGN, id, { worktree_isolated: true, starting_commit_correct: true, lease_acquired: true });
  seeding.manager.recordResult(CAMPAIGN, ids.verified, {
    specialist_output: "done", specialist_agent: "seed", provenance: verifiedProv,
    critic_agent: "lenticel", critic_approved: true, critic_rationale: "acceptance passed", score_ctx: scoreCtx,
  });
  seeding.manager.recordResult(CAMPAIGN, ids.failed, {
    specialist_output: "attempted", specialist_agent: "seed", provenance: { tag: "claimed", claimant: "seed" },
    critic_agent: "lenticel", critic_approved: false, critic_rationale: "acceptance failed", score_ctx: scoreCtx,
  });
  seeding.manager.recordResult(CAMPAIGN, ids.refused, {
    specialist_output: refusal.output, specialist_agent: "seed", provenance: { tag: "claimed", claimant: "seed" },
    critic_agent: "lenticel", critic_approved: false, critic_rationale: "budget refused the session", score_ctx: scoreCtx,
    node_error: refusal.error,
  });
  seeding.manager.completeAutoHalt(CAMPAIGN, "budget_exhausted");
  await seeding.close();

  // ---- CLI ----------------------------------------------------------------
  const text = await cli(["report", "--campaign", CAMPAIGN], true);
  const stateOf = (id: string) => match(text, new RegExp(`^${id}\\s+(\\S+)\\s`, "m"));
  const nodeRemedy = new RegExp(`^Node ${ids.refused} (\\S+) (\\S+): correcting actor (\\S+); corrective action (\\S+)\\.`, "m").exec(text);
  facts.cli_text = {
    "root.state": stateOf("root"), "verified.state": stateOf(ids.verified), "failed.state": stateOf(ids.failed),
    "refused.state": stateOf(ids.refused), "pending.state": stateOf(ids.pending),
    "campaign.halt_reason": match(text, /^Outcome: halted \((\S+)\)/m),
    "refused.remedy.authority": nodeRemedy?.[1], "refused.remedy.state": nodeRemedy?.[2],
    "refused.remedy.actor": nodeRemedy?.[3], "refused.remedy.action": nodeRemedy?.[4],
    "audit.refusal.authority": match(text, /^Gate (\S+) \S+: /m), "audit.refusal.state": match(text, /^Gate \S+ (\S+): /m),
    "audit.refusal.actor": match(text, /^Correcting actor: (\S+);/m), "audit.refusal.action": match(text, /^Corrective action: (\S+)$/m),
  };
  slots.cli_text = {};

  const report = JSON.parse(await cli(["report", "--campaign", CAMPAIGN, "--json"], false)) as Json;
  facts.cli_json = { ...snapshotFacts(report.value.campaign), ...refusalFacts(report.value.gate_refusal), "campaign.terminal_outcome": report.value.campaign.terminal_outcome };
  json.cli_json = [report];
  slots.cli_json = {};

  const runtime = new ArborRuntime({ persistence_dir: resolvePersistenceDir(root) });
  try {
    // ---- MCP --------------------------------------------------------------
    const mcp = new ArborMCPServer(runtime);
    const tree = await mcp.callTool("arbor_query", { kind: "campaign.tree", campaign_id: CAMPAIGN, limit: 50 }) as Json;
    const list = await mcp.callTool("arbor_query", { kind: "campaign.list", limit: 50 }) as Json;
    const gate = await mcp.callTool("arbor_gate_status", { campaign_id: CAMPAIGN, gate: "audit" }) as Json;
    const listed = (list.value.items as Json[]).find((item) => item.id === CAMPAIGN)!;
    facts.mcp = { ...snapshotFacts(tree.value), ...refusalFacts(gate.projection), "campaign.terminal_outcome": listed.terminal_outcome };
    json.mcp = [tree, list, gate];
    slots.mcp = {};
    mcpHaltCheck = {
      get_state: await mcp.callTool("arbor_get_state", { campaign_id: CAMPAIGN }) as Json,
      resource: mcp.readResource(`arbor://campaigns/${CAMPAIGN}/state`) as Json,
      halt_check: await mcp.callTool("arbor_halt_check", { campaign_id: CAMPAIGN }) as Json,
    };

    // ---- TUI --------------------------------------------------------------
    installScreens();
    const ui = new HeadlessHarness({
      client: { connect: () => {}, disconnect: () => {}, requestSnapshot: () => {}, close: () => {}, interruptCampaign: () => {} },
      terminal: { restore: () => {} }, clock: { now: () => 1 },
      telemetrySource: { fetch: async () => ({ campaign_id: CAMPAIGN, source_record_count: 0, counters: [], phase_histograms: [], usage_cost: [], context_economy: [], tool_economy: [] }) },
      runtime: new RuntimePortAdapter(new RuntimeCatalogRouter(runtime)) as never,
    });
    await ui.dispatch({ type: "ui_intent", intent: { type: "focus_screen", screen: "tree" }, at: 1 });
    await ui.dispatch({ type: "ui_intent", intent: { type: "issue_query", queryId: "tree", request: { kind: "campaign.tree", query_id: "tree", params: { campaign_id: CAMPAIGN, limit: 50 } } }, at: 2 });
    const projection = treeScreen.project(ui.model.screens.get("tree"), { width: 200, height: 60 });
    const frame = (width: number, selected?: string) => treeScreen.render({ projection, width, height: 60, unicode: false, ...(selected === undefined ? {} : { selected_id: selected }) });
    const wide = { root: frame(200, "root").join("\n"), verified: frame(200, ids.verified).join("\n"), refused: frame(200, ids.refused).join("\n") };
    const narrow = frame(100);
    await ui.dispatch({ type: "ui_intent", intent: { type: "focus_screen", screen: "campaigns" }, at: 3 });
    await ui.dispatch({ type: "ui_intent", intent: { type: "issue_query", queryId: "list", request: { kind: "campaign.list", query_id: "list", params: { limit: 50 } } }, at: 4 });
    const campaignsFrame = campaignsScreen.render({ projection: campaignsScreen.project(ui.model.screens.get("campaigns"), { width: 160, height: 20 }), width: 160, height: 20, unicode: false });
    const campaignRow = campaignsFrame.find((line) => line.trim().startsWith(CAMPAIGN))?.trim().split(/\s{2,}/) ?? [];
    // The tree frame draws a node's state as a glyph mnemonic; the word lives
    // in the projected `State` column the screen renders from.
    const rowState = (id: string) => projection.rows.find((row) => row.id === id)?.state as string | undefined;
    facts.tui = {
      "root.state": rowState("root"), "verified.state": rowState(ids.verified), "failed.state": rowState(ids.failed),
      "refused.state": rowState(ids.refused), "pending.state": rowState(ids.pending),
      "campaign.halt_reason": campaignRow[2],
      "root.provenance": match(wide.root, /^Provenance: (\S+)/m), "verified.provenance": match(wide.verified, /^Provenance: (\S+)/m),
      "refused.error_kind": match(wide.refused, /^Outcome: error: (\S+) /m),
      "audit.record.gate": match(wide.root, /^Gates: .*latest: (\S+?)=/m), "audit.record.result": match(wide.root, /^Gates: .*latest: \S+?=(\S+)/m),
    };
    // Legend entries are `<glyph>[<letter>] <word>`. The `k` entry names a
    // provenance class shown on a `claimed` node, not a node state, so it is
    // checked against the provenance vocabulary; every other entry is a node state.
    const legendEntries = wide.root.split("\n")[1]!.replace(/^LEGEND /, "").split(" | ")
      .map((entry) => ({ key: entry.includes(" ") ? entry.slice(0, entry.indexOf(" ")) : "", word: entry.includes(" ") ? entry.slice(entry.indexOf(" ") + 1) : entry }))
      .filter((entry) => !["selected", "decomposition", "siblings=alternatives"].includes(entry.word));
    const legendProvenance = legendEntries.filter((entry) => entry.key.endsWith("k")).map((entry) => entry.word);
    const legend = legendEntries.filter((entry) => !entry.key.endsWith("k")).map((entry) => entry.word);
    const summary = narrow[0]!.split(" · ").slice(1).map((entry) => /^\d+(?:\/\d+)? (.+)$/.exec(entry)?.[1] ?? entry);
    slots.tui = {
      // Non-state legend entries name the cursor and the tree shape, not a node state.
      "tree.legend": legend.flatMap((word) => word.split("/")),
      "tree.legend.provenance": legendProvenance,
      "tree.summary": summary,
    };

    // ---- WebUI ------------------------------------------------------------
    const webui = new ArborWebUIServer(runtime);
    await new Promise<void>((resolve) => { void webui.start(0, resolve); });
    try {
      const port = webui.getPort()!;
      const headers = webui.operatorRequestHeaders();
      const campaigns = JSON.parse(await httpGet(port, "/api/campaigns", headers)) as Json[];
      const detail = JSON.parse(await httpGet(port, `/api/campaigns/${CAMPAIGN}`, headers)) as Json;
      facts.webui_json = { ...snapshotFacts(detail), "campaign.terminal_outcome": campaigns.find((item) => item.id === CAMPAIGN)?.terminal_outcome };
      json.webui_json = [campaigns, detail];
      slots.webui_json = {};

      const page = await httpGet(port, "/", headers);
      const script = page.split("<script>")[1]!.split("</script>")[0]!;
      const line = (prefix: string) => {
        const found = script.split("\n").find((entry) => entry.startsWith(prefix));
        if (found === undefined) throw new Error(`client binding ${prefix} is not served`);
        return found;
      };
      const elements = new Map<string, { innerHTML: string }>();
      const sandbox: Record<string, unknown> = {
        document: { getElementById: (id: string) => { if (!elements.has(id)) elements.set(id, { innerHTML: "" }); return elements.get(id); } },
        encodeURIComponent, decodeURIComponent, JSON, String, Array, Map, Set, Math, Number, Object,
        __campaigns: campaigns, __detail: detail,
      };
      vm.createContext(sandbox);
      vm.runInContext([
        line("const esc = "), line("const sessionArg = "), line("const humanizeEnum = "), line("const kineticTreeHistory = "),
        ...["badge", "treeStateClass", "shortTreeLabel", "nodeFailureSummary", "activeTreePath", "kineticTreeMarkup", "renderCampaigns"].map((name) => pickFunction(script, name)),
        "renderCampaigns(__campaigns); globalThis.__detailHtml = kineticTreeMarkup(__detail);",
      ].join("\n"), sandbox);
      const cards = [...elements.values()].map((element) => element.innerHTML).join("\n");
      const html = String(sandbox.__detailHtml);
      const badgeOf = (description: string) => match(html, new RegExp(`<span class="badge [^"]+">([^<]+)</span> ${description}`));
      facts.webui_html = {
        "root.state": badgeOf("root plan"), "verified.state": badgeOf("verified work"), "failed.state": badgeOf("failed work"),
        "refused.state": badgeOf("refused work"), "pending.state": badgeOf("pending work"),
        "campaign.halt_reason": match(html, /plan\.md · iteration \d+ · ([^<]+)<\/span>/),
        "campaign.terminal_outcome": match(cards, /badge-halted">([^<]+)</),
      };
      slots.webui_html = {};
    } finally {
      await webui.stop();
    }
  } finally {
    await runtime.close();
  }
}, 120_000);

afterAll(() => {
  clearRegisteredScreens();
  if (root) rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

describe("@arbor/core OPERATOR_VOCABULARY", () => {
  it("labels every term as its token read with spaces, so a humanized and a raw surface name one fact the same way", () => {
    for (const [category, table] of Object.entries(OPERATOR_VOCABULARY)) {
      for (const [token, label] of Object.entries(table)) {
        expect(label, `${category}.${token}`).toBe(token.replace(/_/g, " "));
      }
    }
    expect(isOperatorTerm("node_state", "working")).toBe(false);
  });

  it("is the same closed set the owning core constants enumerate, not a parallel list", () => {
    expect(Object.keys(OPERATOR_VOCABULARY.node_error_kind).sort()).toEqual([...NODE_ERROR_KINDS].sort());
    expect(Object.keys(OPERATOR_VOCABULARY.outcome_kind).sort()).toEqual([...OUTCOME_KINDS].sort());
    expect(Object.keys(OPERATOR_VOCABULARY.refusal_authority).sort()).toEqual(Object.keys(RUNTIME_REFUSAL_REMEDIES).sort());
    for (const state of TERMINAL_NODE_STATES) expect(isOperatorTerm("node_state", state)).toBe(true);
    // Every ADR-179 (actor, action) pair, plus the authority-independent
    // `unavailable` remedy, is nameable.
    for (const pair of [...Object.values(RUNTIME_REFUSAL_REMEDIES).flat(), { actor: "runtime_host", action: "compose_gate_authority" }]) {
      expect(isOperatorTerm("remedy_actor", pair.actor)).toBe(true);
      expect(isOperatorTerm("corrective_action", pair.action)).toBe(true);
    }
  });
});

describe("cross-surface vocabulary parity (TUI, WebUI, CLI, MCP)", () => {
  it("names every scenario fact with its canonical term on every surface that shows it", () => {
    const misnamed: string[] = [];
    for (const surface of SURFACES) {
      for (const [fact, expected] of Object.entries(FACTS) as [FactId, (typeof FACTS)[FactId]][]) {
        const rendered = facts[surface][fact];
        if (rendered === undefined) continue;
        const accepted = operatorRenderings(expected.category, expected.token);
        if (!accepted.includes(rendered)) misnamed.push(`${surface} ${fact}: rendered ${JSON.stringify(rendered)}, canonical ${accepted.map((value) => JSON.stringify(value)).join(" or ")}`);
      }
    }
    expect(misnamed).toEqual([]);
  });

  it("shows every fact everywhere except the recorded absences, and every recorded absence is still real", () => {
    const unexpected: string[] = [];
    const stale: string[] = [];
    for (const surface of SURFACES) {
      for (const fact of Object.keys(FACTS) as FactId[]) {
        const absent = facts[surface][fact] === undefined;
        const listed = KNOWN_ABSENCES[surface].includes(fact);
        if (absent && !listed) unexpected.push(`${surface} ${fact}`);
        if (!absent && listed) stale.push(`${surface} ${fact} is now rendered; remove it from KNOWN_ABSENCES`);
      }
    }
    expect(unexpected).toEqual([]);
    expect(stale).toEqual([]);
  });

  it("uses only canonical node-state words in the TUI tree legend and summary, apart from the recorded drifts", () => {
    const observed: string[] = [];
    const drift: string[] = [];
    for (const surface of SURFACES) {
      for (const [slot, words] of Object.entries(slots[surface])) {
        if (slot === "tree.legend.provenance") continue; // checked against provenance_tag below
        for (const word of words) {
          if (isOperatorTerm("node_state", word) || Object.values(OPERATOR_VOCABULARY.node_state).includes(word)) continue;
          observed.push(`${surface}:${slot}:${word}`);
          if (!KNOWN_DRIFTS.some((entry) => entry.surface === surface && entry.slot === slot && entry.word === word)) drift.push(`${surface} ${slot}: "${word}" is not a node_state term`);
        }
      }
    }
    expect(drift).toEqual([]);
    for (const entry of KNOWN_DRIFTS) {
      expect(isOperatorTerm("node_state", entry.canonical)).toBe(true);
      expect(observed, `KNOWN_DRIFTS entry ${entry.surface}:${entry.slot}:${entry.word} is fixed; remove it`).toContain(`${entry.surface}:${entry.slot}:${entry.word}`);
    }
  });

  it("labels the TUI tree legend's provenance glyph with a provenance_tag term", () => {
    expect(slots.tui["tree.legend.provenance"]).toEqual(["critic approved"]);
    for (const word of slots.tui["tree.legend.provenance"]!) {
      expect(isOperatorTerm("provenance_tag", word) || Object.values(OPERATOR_VOCABULARY.provenance_tag).includes(word), word).toBe(true);
    }
  });

  it("carries only canonical tokens in every typed field of the CLI, MCP and WebUI JSON", () => {
    const violations: string[] = [];
    const check = (category: OperatorVocabularyCategory, value: unknown, path: string) => {
      if (value === null || value === undefined) return;
      if (!isOperatorTerm(category, value)) violations.push(`${path} = ${JSON.stringify(value)} is not a ${category} term`);
    };
    const walk = (value: unknown, path: string, parent: string): void => {
      if (Array.isArray(value)) { value.forEach((entry, index) => walk(entry, `${path}[${index}]`, parent)); return; }
      if (value === null || typeof value !== "object") return;
      const record = value as Json;
      const refusal = record.kind === "gate.refusal";
      for (const [key, child] of Object.entries(record)) {
        const at = `${path}.${key}`;
        if (key === "halt_reason") check("halt_reason", child, at);
        else if (key === "root_node_state" || key === "active_node_state") check("node_state", child, at);
        else if (key === "provenance_tag") check("provenance_tag", child, at);
        else if (key === "terminal_outcome") check("terminal_outcome", child, at);
        else if (key === "correcting_actor") check("remedy_actor", child, at);
        else if (key === "corrective_action") check("corrective_action", child, at);
        else if (refusal && key === "gate") check("refusal_authority", child, at);
        else if (refusal && key === "state") check("refusal_state", child, at);
        else if (parent === "nodes" && key === "state") check("node_state", child, at);
        else if (parent === "gate_records" && key === "gate") check("gate", child, at);
        else if (parent === "gate_records" && key === "result") check("gate_result", child, at);
        else if (key === "tag" && parent === "provenance") check("provenance_tag", child, at);
        else if (key === "kind" && parent === "outcome") check("outcome_kind", child, at);
        else if (key === "kind" && parent === "error" && path.includes("outcome")) check("node_error_kind", child, at);
        walk(child, at, key);
      }
    };
    for (const [surface, documents] of Object.entries(json)) documents.forEach((document, index) => walk(document, `${surface}[${index}]`, ""));
    expect(violations).toEqual([]);
  });

  it("reports the RECORDED halt next to the re-derived status on arbor_get_state, arbor_halt_check and the state resource", () => {
    // `status` (and arbor_halt_check's top-level fields) are `haltCheck`'s
    // fresh evaluation of the automatic conditions, which never sees a
    // durably recorded halt; their meaning is unchanged. The separate `halt`
    // field carries what the campaign actually recorded.
    expect(facts.mcp["campaign.halt_reason"]).toBe("budget_exhausted");
    expect(mcpHaltCheck?.get_state.status).toMatchObject({ halted: false, reason: null });
    expect(mcpHaltCheck?.resource.status).toMatchObject({ halted: false, reason: null });
    expect(mcpHaltCheck?.halt_check).toMatchObject({ halted: false, reason: null });
    for (const halt of [mcpHaltCheck?.get_state.halt, mcpHaltCheck?.resource.halt, mcpHaltCheck?.halt_check.halt]) {
      expect(halt).toMatchObject({ halted: true, reason: "budget_exhausted", actor: null });
      expect(typeof halt.at).toBe("string");
      expect(halt.operation_id).toBe(`${CAMPAIGN}:auto-halt:budget_exhausted`);
      expect(isOperatorTerm("halt_reason", halt.reason)).toBe(true);
    }
  });
});
