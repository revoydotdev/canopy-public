import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { basename, join } from "node:path";
import { EvidenceLedger } from "@arbor/audit";
import { validateCampaignSnapshot } from "@arbor/core";
import { evaluateProjectRegistry, type ProjectRegistryReport } from "./project-registry.js";
import type { NativeHarnessReadinessProjection } from "./native-harness-readiness.js";
import { resolveConfiguredHarnessIntegrationId } from "./canopy-lane-policy.js";

// ADR-027 intentionally persists governance evidence in the audit store with
// no campaign snapshot. It is a reconciled control-plane ledger, not an orphan.
const NON_CAMPAIGN_LEDGER_IDS = new Set(["governance"]);

export type StoreMismatchKind =
  | "tree_without_ledger" | "ledger_without_tree"
  | "malformed_tree_filename" | "malformed_ledger_filename"
  | "invalid_tree_json" | "invalid_tree_shape"
  | "invalid_ledger_json" | "invalid_ledger_integrity"
  | "ledger_campaign_id_mismatch" | "duplicate_campaign_id" | "scan_cap_reached";

export interface StoreMismatch {
  readonly kind: StoreMismatchKind;
  readonly campaign_id: string | null;
  readonly path: string;
  readonly detail: string;
}
export interface StoreReconciliation {
  readonly inventory_agrees: boolean;
  readonly tree_files: number;
  readonly ledger_files: number;
  readonly tree_bytes: number;
  readonly ledger_bytes: number;
  readonly campaigns: readonly string[];
  readonly record_sources: Readonly<Record<string, number>>;
  readonly mismatches: readonly StoreMismatch[];
  readonly scan_cap: number;
  readonly latest_terminal_profile: null | {
    readonly campaign_id: string;
    readonly timestamp: string;
    readonly focus_tracking: boolean | null;
    readonly notifications: boolean | null;
    readonly multiplexer: "none" | "tmux" | "zellij" | "screen" | "unknown" | null;
    readonly theme_mode: "dark" | "light";
    readonly theme_source: "terminal" | "timeout_default";
  };
  readonly notification_delivery: {
    readonly attempted: number;
    readonly emitted: number;
    readonly dropped: number;
    readonly false_fraction: number | null;
  };
}
export interface TerminalDoctorReport {
  readonly streams: { readonly stdin: { readonly is_tty: boolean }; readonly stdout: { readonly is_tty: boolean }; readonly stderr: { readonly is_tty: boolean } };
  readonly multiplexer: { readonly kind: "tmux" | "screen" | "zellij" | "none"; readonly reason: string };
  readonly focus_reporting: { readonly kind: "available" | "unavailable" | "unknown"; readonly reason: string };
  readonly color_output: { readonly enabled: boolean; readonly reason: string };
}
export interface OperatorDoctorReport {
  readonly store: StoreReconciliation;
  readonly terminal: TerminalDoctorReport;
  readonly stored: { readonly config_file: boolean; readonly keymap_file: boolean; readonly native_credential_present: boolean };
  readonly harness_integration: HarnessIntegrationDoctorReport;
  /**
   * Roadmap 23's multi-project registry (ADR-076) reused `evaluateProjectRegistry`
   * — the same authority `gate:project-registry` calls — rather than
   * re-deriving discharge here. Before this field `doctor` was blind to
   * enrolled-project governance entirely: an operator could run `arbor doctor`,
   * see a clean report, and still be sitting on an undischarged or
   * profile-drifted registry entry that only `gate:project-registry` (run
   * separately, and only at `--tier stop` in `gate:all`) would ever surface.
   */
  readonly project_governance: ProjectRegistryReport;
}
export interface HarnessIntegrationDoctorReport {
  readonly integration_id: string;
  readonly executable_present: boolean;
  readonly authenticated: boolean | null;
  readonly detail: string;
}
export interface DoctorInputs {
  readonly persistence_dir: string;
  readonly cwd: string;
  readonly streams: { readonly stdin: boolean; readonly stdout: boolean; readonly stderr: boolean };
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly native_credential_present: boolean;
  readonly focus_reporting?: { readonly kind: "available" | "unavailable"; readonly reason: string };
  readonly scan_cap?: number;
  readonly harness_integration?: HarnessIntegrationDoctorReport;
}

/**
 * Local-only readiness probe. Output is bounded to status/version and never includes auth identity or tokens.
 *
 * Parity gap #4: `ARBOR_HARNESS_INTEGRATION` names only the three subprocess
 * connectors (claude-code/opencode/codex); the native lane is selected
 * separately, by `native.mode` in `arbor.jsonc`. Before this branch, an
 * operator who set `ARBOR_HARNESS_INTEGRATION=native` — the natural guess,
 * since that is the value's obvious name for "use the native harness" — hit
 * the `unsupported integration id` fallthrough on the standard health-check
 * path (`doctor.get` / `inspectOperatorDoctor()`), even when native execution
 * was fully configured and ready. `native` is now a first-class integration
 * id here, reported from the already-computed native readiness projection
 * (adapter availability, credential presence via its own
 * `credential_absent` reason vocabulary, and mode) rather than an executable
 * probe — there is no subprocess to shell out to for the native lane.
 */
export function inspectHarnessIntegrationEnvironment(
  env: Readonly<Record<string, string | undefined>> = process.env,
  execute: (file: string, args: readonly string[]) => string = (file, args) => execFileSync(file, [...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }),
  native?: Pick<NativeHarnessReadinessProjection, "execution" | "credential" | "adapter" | "selection">,
): HarnessIntegrationDoctorReport {
  // Canopy-only: the same default `createCliRuntime` composes (the native
  // lane), from the one resolver, so doctor cannot report a connector the
  // runtime would never select.
  const integrationId = resolveConfiguredHarnessIntegrationId(env);
  if (integrationId === "native") {
    if (native === undefined) {
      return { integration_id: "native", executable_present: false, authenticated: null, detail: "native harness readiness was not supplied to this probe; run `arbor doctor` for the merged report" };
    }
    const detail = native.execution.kind === "direct_native"
      ? `direct native execution ready (mode ${native.selection.mode ?? "unset"}, adapter ${native.adapter.adapter_id ?? "unconfigured"}, model ${native.selection.model_id ?? "unconfigured"})`
      : native.execution.kind === "connector_fallback"
        ? `native mode ${native.selection.mode ?? "unset"} is falling back to a connector: ${native.execution.reason}`
        : `native execution unavailable (mode ${native.selection.mode ?? "unset"}): ${native.execution.reason}`;
    return {
      integration_id: "native",
      executable_present: native.adapter.availability === "available",
      authenticated: native.credential.required ? native.credential.present : null,
      detail,
    };
  }
  try {
    if (integrationId === "claude-code") {
      const status = JSON.parse(execute("claude", ["auth", "status", "--json"])) as { loggedIn?: unknown; authMethod?: unknown };
      const authenticated = status.loggedIn === true;
      return { integration_id: integrationId, executable_present: true, authenticated, detail: authenticated ? `authenticated (${typeof status.authMethod === "string" ? status.authMethod : "method undisclosed"})` : "Claude Code is installed but not logged in; run `claude login`" };
    }
    if (integrationId === "opencode") {
      const version = execute("opencode", ["--version"]).trim().split(/\s+/)[0] || "version undisclosed";
      return { integration_id: integrationId, executable_present: true, authenticated: null, detail: `installed (${version}); provider authentication remains integration-owned` };
    }
    if (integrationId === "codex") {
      const codexBin = env.ARBOR_CODEX_BIN?.trim() || "codex";
      const model = env.ARBOR_CODEX_MODEL?.trim() || "Codex default";
      const version = execute(codexBin, ["--version"]).trim().split(/\s+/)[0] || "version undisclosed";
      return { integration_id: integrationId, executable_present: true, authenticated: null, detail: `installed (${version}); model ${model}; authentication is indeterminate (version probe only)` };
    }
    return { integration_id: integrationId, executable_present: false, authenticated: null, detail: "unsupported integration id" };
  } catch {
    if (integrationId === "codex") {
      const model = env.ARBOR_CODEX_MODEL?.trim() || "Codex default";
      return { integration_id: integrationId, executable_present: false, authenticated: null, detail: `Codex executable is unavailable; install Codex or set ARBOR_CODEX_BIN to an executable path; model ${model}; authentication is indeterminate until a governed Codex run` };
    }
    return { integration_id: integrationId, executable_present: false, authenticated: integrationId === "claude-code" ? false : null, detail: integrationId === "claude-code" ? "Claude Code is unavailable or not logged in; install it and run \`claude login\`" : "integration executable is unavailable" };
  }
}

function issue(kind: StoreMismatchKind, path: string, detail: string, campaignId: string | null = null): StoreMismatch {
  return { kind, campaign_id: campaignId, path, detail };
}
function filesAt(path: string): readonly string[] {
  if (!existsSync(path)) return [];
  return readdirSync(path, { withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => join(path, entry.name)).sort();
}
function campaignStem(path: string, extension: "json" | "jsonl"): string | null {
  const suffix = `.${extension}`;
  const name = basename(path);
  return name.endsWith(suffix) && name.slice(0, -suffix.length).trim() ? name.slice(0, -suffix.length) : null;
}

/** Non-mutating cross-store inventory. Recovery/quarantine loaders are deliberately excluded. */
export function reconcileStore(persistenceDir: string, scanCap = 10_000): StoreReconciliation {
  const mismatches: StoreMismatch[] = [];
  const tree = new Map<string, string>();
  const ledger = new Map<string, string>();
  const recordSources: Record<string, number> = {};
  let latestTerminalProfile: StoreReconciliation["latest_terminal_profile"] = null;
  let notificationAttempts = 0;
  let notificationsEmitted = 0;
  let treeBytes = 0;
  let ledgerBytes = 0;
  const candidates = [
    ...filesAt(join(persistenceDir, "tree")).map((path) => ({ path, kind: "tree" as const })),
    ...filesAt(join(persistenceDir, "audit")).map((path) => ({ path, kind: "ledger" as const })),
  ];
  if (candidates.length > scanCap) mismatches.push(issue("scan_cap_reached", persistenceDir, `${candidates.length - scanCap} file(s) were not inspected`));
  for (const candidate of candidates.slice(0, scanCap)) {
    const extension = candidate.kind === "tree" ? "json" : "jsonl";
    const id = campaignStem(candidate.path, extension);
    if (id === null) {
      mismatches.push(issue(candidate.kind === "tree" ? "malformed_tree_filename" : "malformed_ledger_filename", candidate.path, `expected a non-empty .${extension} campaign filename`));
      continue;
    }
    const index = candidate.kind === "tree" ? tree : ledger;
    const duplicate = [...index.keys()].find((known) => known.toLocaleLowerCase("en-US") === id.toLocaleLowerCase("en-US"));
    if (duplicate !== undefined) {
      mismatches.push(issue("duplicate_campaign_id", candidate.path, `campaign id collides with ${JSON.stringify(duplicate)}`, id));
      continue;
    }
    index.set(id, candidate.path);
    const bytes = statSync(candidate.path).size;
    if (candidate.kind === "tree") treeBytes += bytes; else ledgerBytes += bytes;
    const data = readFileSync(candidate.path, "utf8");
    if (candidate.kind === "tree") {
      let parsed: unknown;
      try { parsed = JSON.parse(data); }
      catch (error) { mismatches.push(issue("invalid_tree_json", candidate.path, error instanceof Error ? error.message : String(error), id)); continue; }
      try { validateCampaignSnapshot(parsed, id); }
      catch (error) { mismatches.push(issue("invalid_tree_shape", candidate.path, error instanceof Error ? error.message : String(error), id)); }
      continue;
    }
    const rows: unknown[] = [];
    let rowError: string | null = null;
    for (const [offset, line] of data.split("\n").entries()) {
      if (!line.trim()) continue;
      try { rows.push(JSON.parse(line)); }
      catch (error) { rowError = `line ${offset + 1}: ${error instanceof Error ? error.message : String(error)}`; break; }
    }
    if (rowError !== null) { mismatches.push(issue("invalid_ledger_json", candidate.path, rowError, id)); continue; }
    if (rows.some((row) => typeof row === "object" && row !== null && "campaign_id" in row && (row as { campaign_id?: unknown }).campaign_id !== id)) {
      mismatches.push(issue("ledger_campaign_id_mismatch", candidate.path, "a ledger record campaign_id differs from its filename", id));
      continue;
    }
    const parsedLedger = new EvidenceLedger();
    let integrity: ReturnType<EvidenceLedger["verifyIntegrity"]>;
    try {
      parsedLedger.fromJSONL(data);
      integrity = parsedLedger.verifyIntegrity();
    } catch (error) {
      mismatches.push(issue("invalid_ledger_integrity", candidate.path, error instanceof Error ? error.message : String(error), id));
      continue;
    }
    if (!integrity.valid) { mismatches.push(issue("invalid_ledger_integrity", candidate.path, integrity.error ?? "ledger integrity failed", id)); continue; }
    for (const packet of parsedLedger.getPackets()) {
      const source = packet.kind ?? "trace";
      recordSources[source] = (recordSources[source] ?? 0) + 1;
      if (packet.kind === "terminal_profile" && (latestTerminalProfile === null || packet.timestamp > latestTerminalProfile.timestamp)) {
        latestTerminalProfile = {
          campaign_id: packet.campaign_id, timestamp: packet.timestamp,
          focus_tracking: packet.profile.capabilities?.focus_tracking ?? null,
          notifications: packet.profile.capabilities?.notifications ?? null,
          multiplexer: packet.profile.capabilities?.multiplexer ?? null,
          theme_mode: packet.profile.theme_mode, theme_source: packet.profile.theme_source,
        };
      }
      if (packet.kind === "terminal_notification") {
        notificationAttempts += 1;
        if (packet.notification.emitted) notificationsEmitted += 1;
      }
    }
  }
  for (const [id, path] of tree) if (!ledger.has(id)) mismatches.push(issue("tree_without_ledger", path, "campaign snapshot has no matching audit ledger", id));
  for (const [id, path] of ledger) if (!tree.has(id) && !NON_CAMPAIGN_LEDGER_IDS.has(id)) mismatches.push(issue("ledger_without_tree", path, "audit ledger has no matching campaign snapshot", id));
  return {
    inventory_agrees: mismatches.length === 0, tree_files: tree.size, ledger_files: ledger.size,
    tree_bytes: treeBytes, ledger_bytes: ledgerBytes,
    campaigns: [...new Set([...tree.keys(), ...[...ledger.keys()].filter((id) => !NON_CAMPAIGN_LEDGER_IDS.has(id))])].sort(),
    record_sources: Object.fromEntries(Object.entries(recordSources).sort(([a], [b]) => a.localeCompare(b))),
    mismatches, scan_cap: scanCap, latest_terminal_profile: latestTerminalProfile,
    notification_delivery: {
      attempted: notificationAttempts,
      emitted: notificationsEmitted,
      dropped: notificationAttempts - notificationsEmitted,
      false_fraction: notificationAttempts === 0 ? null : (notificationAttempts - notificationsEmitted) / notificationAttempts,
    },
  };
}

function multiplexer(env: Readonly<Record<string, string | undefined>>): TerminalDoctorReport["multiplexer"] {
  if (env.TMUX) return { kind: "tmux", reason: "TMUX is set" };
  if (env.ZELLIJ) return { kind: "zellij", reason: "ZELLIJ is set" };
  if (env.STY) return { kind: "screen", reason: "STY is set" };
  return { kind: "none", reason: "TMUX, ZELLIJ, and STY are absent" };
}
export function inspectOperatorEnvironment(inputs: DoctorInputs): OperatorDoctorReport {
  const env = inputs.env ?? process.env;
  const store = reconcileStore(inputs.persistence_dir, inputs.scan_cap);
  const observed = store.latest_terminal_profile;
  const focus = inputs.focus_reporting ?? (observed === null
    ? { kind: "unknown" as const, reason: "no durable OpenTUI renderer capability observation exists" }
    : observed.focus_tracking
      ? { kind: "available" as const, reason: `renderer observed focus tracking for campaign ${observed.campaign_id}` }
      : { kind: "unavailable" as const, reason: `renderer observed focus tracking unavailable for campaign ${observed.campaign_id}` });
  return {
    store,
    terminal: {
      streams: { stdin: { is_tty: inputs.streams.stdin }, stdout: { is_tty: inputs.streams.stdout }, stderr: { is_tty: inputs.streams.stderr } },
      multiplexer: observed?.multiplexer && observed.multiplexer !== "unknown"
        ? { kind: observed.multiplexer, reason: `renderer capability observation for campaign ${observed.campaign_id}` }
        : multiplexer(env), focus_reporting: focus,
      color_output: inputs.streams.stdout && env.NO_COLOR === undefined
        ? { enabled: true, reason: "stdout is a terminal and NO_COLOR is absent" }
        : { enabled: false, reason: !inputs.streams.stdout ? "stdout is not a terminal" : "NO_COLOR is set" },
    },
    stored: { config_file: existsSync(join(inputs.cwd, "arbor.jsonc")), keymap_file: existsSync(join(inputs.cwd, "arbor.keymap.jsonc")), native_credential_present: inputs.native_credential_present },
    harness_integration: inputs.harness_integration ?? { integration_id: "unprobed", executable_present: false, authenticated: null, detail: "integration probe was not requested" },
    project_governance: evaluateProjectRegistry(inputs.persistence_dir),
  };
}
export function formatOperatorDoctor(report: OperatorDoctorReport): string {
  const mismatchLines = report.store.mismatches.length === 0 ? ["  inventory agrees: yes"] : ["  inventory agrees: no", ...report.store.mismatches.map((item) => `  ${item.kind}: ${item.campaign_id ?? "-"} (${item.detail})`)];
  return [
    "Store reconciliation", ...mismatchLines,
    `  snapshots/ledgers: ${report.store.tree_files}/${report.store.ledger_files}`,
    `  bytes snapshot/ledger: ${report.store.tree_bytes}/${report.store.ledger_bytes}`,
    `  record sources: ${Object.entries(report.store.record_sources).map(([key, value]) => `${key}=${value}`).join(", ") || "none"}`,
    `  terminal notification delivery: ${report.store.notification_delivery.emitted}/${report.store.notification_delivery.attempted} emitted (false fraction ${report.store.notification_delivery.false_fraction ?? "unavailable"})`,
    "Environment and terminal",
    `  stdin/stdout/stderr TTY: ${report.terminal.streams.stdin.is_tty}/${report.terminal.streams.stdout.is_tty}/${report.terminal.streams.stderr.is_tty}`,
    `  multiplexer: ${report.terminal.multiplexer.kind} (${report.terminal.multiplexer.reason})`,
    `  focus reporting: ${report.terminal.focus_reporting.kind} (${report.terminal.focus_reporting.reason})`,
    `  color output: ${report.terminal.color_output.enabled ? "enabled" : "disabled"} (${report.terminal.color_output.reason})`,
    "Harness integration",
    `  ${report.harness_integration.integration_id}: ${report.harness_integration.executable_present ? "available" : "unavailable"} (${report.harness_integration.detail})`,
    "Stored presence (values never displayed)",
    `  config/keymap/native credential: ${report.stored.config_file}/${report.stored.keymap_file}/${report.stored.native_credential_present}`,
    "Project governance (registry — ADR-076)",
    ...formatProjectGovernanceDoctor(report.project_governance),
  ].join("\n");
}

function formatProjectGovernanceDoctor(report: ProjectRegistryReport): string[] {
  if (report.entry_count === 0) {
    return [
      report.present
        ? "  0 entries — governing no projects (a valid state, not a failure)"
        : "  no registry file present — nothing has been registered here yet",
    ];
  }
  const lines = [`  ${report.entry_count} entr${report.entry_count === 1 ? "y" : "ies"}, ${report.ok ? "all discharged" : "DISCHARGE FAILED for at least one entry"}`];
  for (const verification of report.verifications) {
    lines.push(`    ${verification.ok ? "OK" : "FAIL"}  ${verification.project_id}  ${verification.path}`);
    for (const failure of verification.failures) lines.push(`        [${failure.code}] ${failure.detail}`);
  }
  return lines;
}
