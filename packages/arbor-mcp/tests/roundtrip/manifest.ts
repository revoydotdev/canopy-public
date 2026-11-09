/**
 * Phase 6.3 roundtrip-conformance manifest (ROADMAP.md Phase 6.3).
 *
 * 6.3's mechanism: every capability declares one roundtrip test that drives
 * it from an outermost entry point, through the ledger, and back out through
 * a projection — asserting on the *projected* result, never an internal
 * call — and the assertion must include payload substance, not just record
 * presence. This file is the checkable registry that claim is made against:
 * every `RUNTIME_CATALOG` entry marked `supported: true` (the canonical
 * command/query surface `arbor-mcp/src/cli.ts` — the 6.1 root-set entry
 * point — actually exposes to MCP tools, the web UI, and the TUI) must
 * appear here exactly once, either as a `landed` roundtrip pointing at a
 * real test, or as a `gap` pointing at why it deliberately isn't covered yet.
 *
 * `manifest.test.ts` enforces two things mechanically:
 *   1. exhaustiveness — every supported RUNTIME_CATALOG kind has exactly one
 *      manifest row, so a newly-added catalog capability with no entry here
 *      fails the build instead of silently shipping without conformance
 *      coverage;
 *   2. non-vaporware — every `landed` row's `file` exists on disk and
 *      contains the exact `it(...)` title named in `test`, so a roundtrip
 *      test that gets renamed, deleted, or was never written cannot be
 *      claimed as landed.
 *
 * This is the DETECTED tier (ROADMAP §6.3's strength ladder): it does not
 * prevent a bad roundtrip from being written, only makes an *absent* one
 * loudly unmergeable.
 */

import type { RuntimeCatalogKind } from "../../src/runtime-catalog.js";

export interface RoundtripLanded {
  readonly status: "landed";
  /** RUNTIME_CATALOG kind(s) this single test roundtrips together. */
  readonly capabilities: readonly RuntimeCatalogKind[];
  /** Path relative to the repo root. */
  readonly file: string;
  /** The exact `it(...)` title of the test that performs the roundtrip. */
  readonly test: string;
  /** entry point -> ledger -> projection, and the payload substance asserted (not just record presence). */
  readonly shape: string;
}

export interface RoundtripGap {
  readonly status: "gap";
  readonly capabilities: readonly RuntimeCatalogKind[];
  /** Verified-gap-register id (ROADMAP.md) this traces to, or a new finding id if not yet registered. */
  readonly gap: string;
  readonly note: string;
}

export type RoundtripManifestEntry = RoundtripLanded | RoundtripGap;

export const ROUNDTRIP_MANIFEST: readonly RoundtripManifestEntry[] = [
  {
    status: "landed",
    capabilities: ["git.workspace", "git.worktree.create", "git.worktree.switch", "git.worktree.cleanup"],
    file: "packages/arbor-mcp/tests/roundtrip/workspace-governance-peer.test.ts",
    test: "creates, projects, switches, refuses dirty cleanup, and cleans up a governed worktree through git.workspace",
    shape: "session-signed git.worktree.create/switch/cleanup commands via createCliRuntime + RuntimeCatalogRouter -> real git worktree on disk -> git.workspace projection; asserts the worktree count and inspected_path change, the lease dir and `git worktree list` agree, dirty unauthorized cleanup is refused and preserves the lease, and authorized cleanup removes it.",
  },
  {
    status: "landed",
    capabilities: ["governance.record.read", "governance.record.search"],
    file: "packages/arbor-mcp/tests/roundtrip/workspace-governance-peer.test.ts",
    test: "searches and reads ADR records through governance.record.search and governance.record.read",
    shape: "governance.record.search/read queries via createCliRuntime + RuntimeCatalogRouter -> GovernanceRecordStore over a decisions/ directory on disk; asserts the search filter returns only the matching ADR id, unfiltered search returns both, read projects the real record title, and an empty id fails validation.",
  },
  {
    status: "landed",
    capabilities: ["campaign.start", "campaign.halt", "tree.branch"],
    file: "packages/arbor-mcp/tests/runtime-catalog.test.ts",
    test: "routes validated campaign start, branch, and independently-audited halt with idempotency",
    shape: "RuntimeCatalogRouter.dispatchCommand -> CampaignManager ledger -> campaign.snapshot projection; asserts the campaign actually transitions (started/branched/halted state), not just accepted:true.",
  },
  {
    status: "landed",
    capabilities: ["tree.prune", "operation.get"],
    file: "packages/arbor-mcp/tests/runtime-catalog.test.ts",
    test: "routes only the currently safe prune command and honors idempotency",
    shape: "dispatchCommand(tree.prune) -> ledger -> operation.get projection; asserts the operation record's state/capability reflect the real prune, and a second prune of the (now-pruned) root is rejected as a conflict.",
  },
  {
    status: "landed",
    capabilities: ["operation.list"],
    file: "packages/arbor-mcp/tests/runtime-catalog.test.ts",
    test: "dispatches operation.list against the real OperationRegistry — active/terminal filtering and validation",
    shape: "dispatchCommand(tree.prune) -> OperationRegistry ledger -> operation.list query; asserts a just-completed (terminal) operation is genuinely excluded by default and genuinely included with include_terminal:true, reflecting the real record's state/capability — not a static accepted:true or a fabricated row. G-32 closure: this is the enumeration query the `operations` TUI screen needed and the catalog previously lacked.",
  },
  {
    status: "landed",
    capabilities: ["inspect.action"],
    file: "packages/arbor-mcp/tests/runtime-catalog.test.ts",
    test: "routes inspect.action through the canonical operation snapshot",
    shape: "inspect.action query -> OperationRegistry -> authoritative snapshot-stamped structured action projection; asserts lifecycle, stable action identity, capability, and missing-action conflict.",
  },
  {
    status: "landed",
    capabilities: ["governance.snapshot"],
    file: "packages/arbor-mcp/tests/runtime-catalog.test.ts",
    test: "dispatches governance.snapshot against the real decisions/ corpus",
    shape: "governance.snapshot query -> scanDecisionsCorpus over the real decisions/ directory -> GovernanceSnapshot projection; asserts the projected record count matches the actual number of ADR files on disk and that a nonexistent repo_root reports `unavailable` rather than an empty snapshot, since \"nothing to govern\" and \"could not look\" must not be the same answer. Closes the governance screen's empty surface.queries, which would otherwise have shown \"awaiting first projection\" forever on the live pane.",
  },
  {
    status: "landed",
    capabilities: ["governance.backlog"],
    file: "packages/arbor-mcp/tests/runtime-catalog.test.ts",
    test: "dispatches governance.backlog against a real decisions/ corpus",
    shape: "governance.backlog query -> deriveBacklog/selectNextBacklogItem over a real decisions/ corpus (arbor-governance's own fixture, since the live repo corpus's backlog is empty today) -> GovernanceBacklogSnapshot projection; asserts every projected item resolves to a real, on-disk ADR file, that `selected` is always one of the backlog's own items, and that a nonexistent repo_root reports `unavailable` rather than an empty backlog. Closes finding 15 (TUI-vs-backend observability gap audit): the backlog `selfhost.ts` already uses to pick a self-host campaign's next task was previously CLI-stdout-only.",
  },
  {
    status: "landed",
    capabilities: ["kb.list"],
    file: "packages/arbor-mcp/tests/runtime-catalog.test.ts",
    test: "dispatches kb.list against real KB entries — content, filtering, bounds, and tier gating",
    shape: "recordResult (a real rejected branch) -> KnowledgeBase memory-fact projection -> kb.list query; asserts the projected failure_mode entry carries its real failure_mode/root_cause content (not just an opaque id), that the type filter genuinely narrows the result, and that limit/campaign_id are validated. Closes finding 8: KB entries were previously visible only as an opaque id flashing through the diagnostics event log.",
  },
  {
    status: "landed",
    capabilities: ["audit.list"],
    file: "packages/arbor-mcp/tests/runtime-catalog.test.ts",
    test: "dispatches audit.list against the real evidence ledger — content, bounds, and gating",
    shape: "recordResult (a real verified branch) -> EvidenceLedger -> audit.list query; asserts the projected trace packet carries its real action_description (not just an opaque id), that limit genuinely bounds the result, and that an unknown campaign_id reports a real error rather than a silently empty list. Closes finding 9: the evidence ledger was previously visible only as an opaque id flashing through the diagnostics event log.",
  },
  {
    status: "landed",
    capabilities: ["output.list"],
    file: "packages/arbor-mcp/tests/runtime-catalog.test.ts",
    test: "dispatches output.list against a real OutputEvidenceStore — ordering, bounds, gating, and unconfigured persistence",
    shape: "OutputEvidenceStore.put (real on-disk artifacts) -> content-addressed descriptor records -> output.list query; asserts the projected ids and byte_counts are the real stored values (proving the rows came from disk, not from the query), that `limit` genuinely bounds the result, that a caller lacking output.read is denied, and that an unconfigured store reports `unavailable` rather than an empty list — \"not configured\" must not read as \"no outputs\". G-32's last residual: this is the enumeration query the `output` TUI screen needed, since output.descriptor/output.raw both hard-require an evidence_id and nothing could enumerate one.",
  },
  {
    status: "landed",
    capabilities: ["campaign.list", "campaign.snapshot", "campaign.tree"],
    file: "packages/arbor-mcp/tests/runtime-catalog.test.ts",
    test: "routes bounded snapshot/list/tree queries and pages via cursor",
    shape: "campaign.start (outer entry) -> manager -> campaign.list/snapshot/tree queries; asserts cursor paging returns the real node set, not a fixed page.",
  },
  {
    status: "landed",
    capabilities: ["operation.cancel", "task.retry", "task.list", "event.resume"],
    file: "packages/arbor-mcp/tests/runtime-catalog.test.ts",
    test: "routes task cancellation, retry, listing, and bounded event recovery through ArborRuntime",
    shape: "dispatchCommand(operation.cancel/task.retry) -> TaskSupervisor -> task.list projection; asserts the supervised task's state actually flips (cancel_requested -> retrying), and event.resume replays the real published event vs. a resync marker for the wrong stream — substance, not presence.",
  },
  {
    status: "landed",
    capabilities: ["communication.record", "communication.selection", "communication.history"],
    file: "packages/arbor-mcp/tests/runtime-catalog.test.ts",
    test: "projects communication sensitivity by adapter tier and does not expose an inbox count",
    shape: "dispatchCommand(communication.record) at specialist+critic tier -> node_communication ledger -> communication.selection projection at specialist tier; asserts the critic-authored message is structurally absent from the lower-tier projection (capability redaction is real, not cosmetic) and no raw pending count leaks.",
  },
  {
    status: "landed",
    capabilities: ["output.capture", "output.descriptor", "output.raw"],
    file: "packages/arbor-mcp/tests/output-runtime.test.ts",
    test: "bounds adversarial no-newline previews without publishing raw events",
    shape: "dispatchCommand(output.capture) with oversized content -> content-addressed OutputEvidence store -> output.raw query; asserts the bounded preview is genuinely abbreviated (bytes <= policy max) while output.raw returns the full original content byte-for-byte — preview != full is the substance assertion G-09's Hollow-shape sibling gaps lack.",
  },
  {
    status: "landed",
    capabilities: ["surveillance.scan", "surveillance.findings"],
    file: "packages/arbor-mcp/tests/surveillance-runtime.test.ts",
    test: "uses canonical manager/supervisor facts and publishes only after durable dedup",
    shape: "dispatchCommand(surveillance.scan) over a real orphaned supervisor task -> SurveillanceMonitor ledger dedup -> surveillance.findings query; asserts the finding's `kind` is genuinely \"orphaned_work\" (a real detector verdict), not merely that the findings array is non-empty.",
  },
  {
    status: "landed",
    capabilities: ["approval.request", "approval.approve", "approval.reject", "approval.expire", "approval.list"],
    file: "packages/arbor-mcp/tests/approval-identity-boundaries.test.ts",
    test: "binds TUI proposals and decisions to distinct signed local sessions",
    shape: "signed RuntimePortAdapter approval.request -> ApprovalService ledger -> signed approval.approve -> approval.list query; asserts self-approval by the proposer is genuinely rejected (accepted:false) and a distinct authenticated actor's approval genuinely flips status to \"approved\" in the list projection.",
  },
  {
    status: "landed",
    capabilities: ["job.submit", "job.cancel", "job.retry", "job.pause", "job.resume", "job.list"],
    file: "packages/arbor-mcp/tests/job-scheduler.test.ts",
    test: "submit/cancel/retry/pause/resume/list round-trip through the router",
    shape: "dispatchCommand(job.submit/pause/resume/cancel/retry) -> JobScheduler + TaskSupervisor ledger -> job.list query; asserts the listed job's state machine actually reflects each command (started -> paused -> resumed -> ...), not a static accepted:true.",
  },
  {
    status: "landed",
    capabilities: ["userinput.ask", "userinput.answer", "userinput.list", "userinput.awaiting"],
    file: "packages/arbor-mcp/tests/user-input.test.ts",
    test: "catalog: userinput.answer flips awaiting to false",
    shape: "dispatchCommand(userinput.ask) -> RequestUserInput ledger record -> userinput.answer -> userinput.awaiting query; asserts the awaiting flag is genuinely false only after a real answer is recorded — the pending-interview guard's actual signal, not a record-exists check.",
  },
  {
    status: "landed",
    capabilities: ["config.get"],
    file: "packages/arbor-mcp/tests/config-inspection.test.ts",
    test: "returns the effective view through the catalog router",
    shape: "ConfigInspectionService.compose(defaults/file/injected) -> config.get query through RuntimeCatalogRouter; asserts later-source precedence and secret redaction are real in the projected leaves, not just that a view object exists. NOTE: `file` is only ever a real `arbor.jsonc` when a caller constructs `ConfigInspectionService` with it — `runtime.ts` currently defaults to `new ConfigInspectionService()` with no file source (see wave-3 report follow-up).",
  },
  {
    status: "landed",
    capabilities: ["native.budget.get"],
    file: "packages/arbor-mcp/tests/native-campaign-budget-projection.test.ts",
    test: "projects the durable authority snapshot, including reservations, through the canonical query",
    shape: "NativeCampaignBudgetAuthority.initialize/reserve -> durable revisioned allocation record -> native.budget.get; asserts an actual reservation, token consumption/reservation/remaining values, and typed unconfigured absence rather than telemetry-derived spend.",
  },
  {
    status: "landed",
    capabilities: ["agent.list"],
    file: "packages/arbor-mcp/tests/agent-registry.test.ts",
    test: "returns definitions + live through the catalog router",
    shape: "TaskSupervisor task registration -> AgentRegistry projection -> agent.list query; asserts live instances are derived only for known agent definitions (never fabricated) and terminal-task inclusion is real.",
  },
  {
    status: "landed",
    capabilities: ["capability.introspect"],
    file: "packages/arbor-mcp/tests/capability-introspection.test.ts",
    test: "reports the enforced catalog-derived action class, mutability, tier, and every tier entitlement",
    shape: "capability.introspect -> RUNTIME_CATALOG direction-derived action class -> required tier/entitlement projection; asserts the report is derived from the same catalog boundary rather than a client-supplied authority assertion.",
  },
  {
    status: "landed",
    capabilities: ["tree.interrupt"],
    file: "packages/arbor-mcp/tests/interruption-runtime.test.ts",
    test: "survives kill/restart as typed evidence and cannot be confused with critic approval, failure, or liveness — all three ledger phases survive and the node is counted in zero test counts except interrupted",
    shape: "dispatchCommand(tree.interrupt) -> typed interruption ledger phases (request/ack/apply) -> campaign.snapshot after simulated restart; asserts the node's outcome is genuinely `interrupted` and distinct from every other terminal state, not merely present.",
  },
  {
    status: "landed",
    capabilities: ["phase_message.list"],
    file: "packages/arbor-mcp/tests/phase-message-catalog.test.ts",
    test: "a real campaign run durably records a `final` phase message the query kind returns",
    shape: "runCampaign (arbor-opencode) -> ManagerTelemetryAdapter.recordPhaseMessage -> EvidenceLedger.recordPhaseMessage (ADR-016) -> phase_message.list projection via RuntimeCatalogRouter; asserts the projected record's phase (`final`) and content are byte-identical to the specialist's real completed output, not merely that a record exists.",
  },
  {
    status: "landed",
    capabilities: ["compaction.record", "compaction.list", "compaction.guard"],
    file: "packages/arbor-mcp/tests/s06-compaction-catalog-reachability.test.ts",
    test: "arbor_query projects the real producer's nonempty evidence witness, differs before/after, and survives restart",
    shape: "arbor-opencode's real `structural_compaction` producer (composeLoopConfigPorts, loop-ports-helper.ts) -> CampaignManager.recordCompactionLifecycle ledger -> compaction.list/compaction.guard projected through RuntimeCatalogRouter via ArborMCPServer.callTool(\"arbor_query\"/\"arbor_command\"); asserts the catalog projection is empty before the real fold and non-empty with genuine `audit://output-artifacts/...` evidence ids after, that compaction.guard flips active on a real interrupted attempt and clears on a real completed one, and that the record survives a process restart through the same client surface. G-04's original 'evidence pointers are empty' note is superseded — `structural_compaction.compact` (loop-ports-helper.ts) always captures real content-addressed evidence before recording.",
  },
  {
    status: "landed",
    capabilities: ["recovery.retry", "recovery.abandon"],
    file: "packages/arbor-mcp/tests/tui-operator-controls.test.ts",
    test: "'r' retries an interrupted selected node through recovery.pending and the real RecoveryService",
    shape: "recovery.pending -> durable selected node identity (campaign/prior operation/CAS version) -> recovery.retry -> RecoveryService -> CampaignManager.persistRetryTransition; asserts the real node changes from interrupted to pending. recovery.abandon's authorization/lease and durable-abandonment path is exercised by RecoveryService's 'requires operator/auditor abandonment' test.",
  },
  {
    status: "landed",
    capabilities: ["recovery.pending"],
    file: "packages/arbor-mcp/tests/runtime-catalog.test.ts",
    test: "projects recovery.pending from the durable manager view with its CAS revision",
    shape: "interrupted node -> CampaignManager.getRecoverableNodes -> recovery.pending catalog query; asserts the real prior interruption operation and durable revision are projected, rather than a client-generated target.",
  },
  {
    status: "landed",
    capabilities: ["bus.record", "bus.history"],
    file: "packages/arbor-mcp/tests/bus-a2a-sibling-runtime.test.ts",
    test: "records a bus message and projects it back through bus.history with conversation grouping and tier redaction",
    shape: "dispatchCommand(bus.record) -> node_communication ledger (via CampaignManager.recordBusMessage) -> bus.history query (CampaignManager.getConversationBus); asserts the specialist-tier reader's projection contains the real message content grouped under its conversation_id and structurally lacks the critic-tier conversation entirely, while an orchestrator-tier reader sees it — capability redaction is real, not a stub, closing G-29 for the operator-facing bus surface.",
  },
  {
    status: "landed",
    capabilities: ["bus.thread.send", "bus.thread.ack", "bus.thread.history"],
    file: "packages/arbor-mcp/tests/parent-child-thread-runtime.test.ts",
    test: "durably supports bidirectional reply, explicit ack, needs-attention, and restart restoration",
    shape: "dispatchCommand(bus.thread.send) from either endpoint and bus.thread.ack -> the same append-only NodeCommunication ledger -> bus.thread.history; asserts direct parent/child identity, CAS and idempotency, same-thread/correlation-bound reply, persisted deadline-derived pending/acknowledged/timed_out delivery, needs-attention visibility, evidence references, and a fresh manager's restart replay.",
  },
  {
    status: "landed",
    capabilities: ["sibling.status"],
    file: "packages/arbor-mcp/tests/bus-a2a-sibling-runtime.test.ts",
    test: "flips active siblings from delegate to closed via communication.record dispatched through the router",
    shape: "dispatchCommand(communication.record, kind=delegate) -> node_communication ledger -> sibling.status query (CampaignManager.getSiblingStatus) shows the sibling active; a matching kind=report acknowledging the real delegate record id then flips it closed — asserts the reconciled active-list value actually changes from a real ledger fact, not a static accepted:true, closing G-29 for 4D.5's read surface.",
  },
  { status: "landed", capabilities: ["sibling.spawn"], file: "packages/arbor-mcp/tests/sibling-spawn.test.ts", test: "branches, leases and supervises an isolated bounded child idempotently", shape: "sibling.spawn -> campaign child + WorktreeManager lease + TaskSupervisor child; asserts an isolated worktree projection and idempotent operation replay." },
  {
    status: "landed",
    capabilities: ["a2a.send", "a2a.receive"],
    file: "packages/arbor-mcp/tests/bus-a2a-sibling-runtime.test.ts",
    test: "a2a.receive converts an inbound A2A message into a durably recorded NodeCommunication",
    shape: "dispatchCommand(a2a.receive) -> a2a-bridge.ts inboundA2AToNodeCommunication -> node_communication ledger -> communication.history query asserts the recorded payload content and a2a-derived idempotency_key match the inbound wire message byte-for-byte, not just record presence. a2a.send's roundtrip (dispatchCommand(a2a.send) -> ledger record -> outboundNodeCommunicationToA2A projection returned in the acknowledgement, asserted against communication.history) lives in the sibling test \"a2a.send records the outbound communication and projects it back as a wire-format A2A message\" in the same file/describe block. Both are unavailable (accepted:false, error.code:unavailable) until a signing A2ABridgeConfig is injected, covered by \"keeps a2a commands unavailable until a bridge config is injected\" in the same file. LANDED-BUT-ENV-GATED: this test injects the bridge config directly into RuntimeCatalogRouter's options. In production the config is composed identically by all three long-lived roots — server.ts:44 (which cli.ts:1515's `serve` constructs), webui.ts:35, and tui.ts:417 — each spreading the same env-gated `a2aBridgeOption()` (a2a-bridge.ts:48). So a2a.send/a2a.receive are unavailable exactly when ARBOR_A2A_SIGNING_SECRET is unset and available on all three alike once it is set; `serve` is NOT structurally different from `tui` here. The one composition root that never gets a bridge regardless of environment is `remote-serve` (cli.ts:1504), which builds a bare `new RuntimeCatalogRouter(runtime)` with no options.",
  },
  {
    status: "landed",
    capabilities: ["foreground.derive", "nodecard.resolve", "a2a.cards"],
    file: "packages/arbor-mcp/tests/runtime-catalog.test.ts",
    test: "derives foregrounds and node cards from live node state and only publishes A2A cards with a configured secret",
    shape: "live campaign snapshot -> the same opencode foreground/node-card derivation used by dispatch -> catalog projections; asserts configured model/input/output influence, A2A card fail-closed behavior without a secret, and signed publication after a secret is supplied. a2a.cards is gated on the same RuntimeCatalogRouter `a2a_bridge` option as a2a.send/a2a.receive (runtime-catalog.ts's a2a.cards handler returns error.code:unavailable when it is unset) — see the a2a.send/a2a.receive entry above: server.ts, webui.ts and tui.ts all compose that config from the same env-gated helper, so a2a.cards is unavailable exactly when ARBOR_A2A_SIGNING_SECRET is unset, on those roots alike.",
  },
  {
    status: "landed",
    capabilities: ["context.artifact.capture", "context.workspace", "context.overlays", "context.governance", "fold.propose", "fold.approve", "fold.rollback", "playbook.propose", "playbook.approve", "harness.propose", "harness.approve", "harness.rollback", "harness.evaluate", "harness.promote"],
    file: "packages/arbor-mcp/tests/governed-context-catalog.test.ts",
    test: "round-trips governed context, folds, playbook, and harness overlays through the same canonical router used by TUI transports",
    shape: "context.artifact.capture -> bounded context.workspace -> fold proposal containing durable parent/subagent message range + content-addressed artifact refs -> independent critic approval -> context.overlays; then campaign-local playbook/harness proposal, critic activation, measured replay/holdout evaluation, human promotion, and rollback -> context.governance. The test proves the canonical router returns active/rolled-back projected state from real service records. It deliberately does not claim A2A wire conformance; context/thread/task/message/artifact identities remain separate in ADR-038 and audit/codex-a2a-messaging-reference.md.",
  },
  {
    status: "landed",
    capabilities: ["harness.evaluation.start", "harness.evaluation.candidates"],
    file: "packages/arbor-mcp/tests/tui-governed-context-controls.test.ts",
    test: "runs the selected active revision hermetically, then exposes measured run detail and canonical promotion/quarantine forms",
    shape: "TUI selected active governed revision -> typed harness.evaluation.start form -> signed RuntimePortAdapter -> canonical catalog -> composed hermetic evaluator -> durable unmeasured run; candidates remains explicitly retryable after absence of measured evidence. The test never starts a provider/tool/network evaluator.",
  },
  {
    status: "landed",
    capabilities: ["harness.evaluation.runs", "harness.evaluation.detail", "harness.quarantine"],
    file: "packages/arbor-mcp/tests/webui.test.ts",
    test: "round-trips measured evaluation status/detail and a multi-evidence quarantine through the exact web catalog routes",
    shape: "Web runtime query routes return durable run status and bounded redacted detail; the quarantine command carries two revision-bound measured evidence ids plus a special-character reason through the canonical catalog, and the service projects a durable quarantined revision. No raw scenario/provider trace is exposed.",
  },
  {
    status: "landed",
    capabilities: ["subagent.execute", "subagent.executions"],
    file: "packages/arbor-mcp/tests/native-cli-production-e2e.test.ts",
    test: "executes only an independently activated declarative descriptor as one fixed no-tools native child and persists lineage/evidence",
    shape: "active independently approved descriptor -> subagent.execute persists a request before a real no-tools native child -> content-addressed claimed result and source evidence -> subagent.executions projection; asserts child session/worktree lineage, one-child binding, and absence of recursive/tool authority.",
  },
  {
    status: "landed",
    capabilities: ["trust.session.enroll", "trust.session.rotate", "trust.session.revoke", "trust.session.list", "trust.session.status"],
    file: "packages/arbor-mcp/tests/trust-session-catalog.test.ts",
    test: "enrols bounded direct-edge authority, rotates/revokes it, and keeps public keys out of operator projections",
    shape: "trust.session.enroll -> persisted RemoteSessionAuthority -> trust.session.list/status; trust.session.rotate -> status projection with prior key id revoked; trust.session.revoke -> status=revoked plus durable OperationRegistry actor/capability attribution. The test asserts real lifecycle state and deliberately verifies projections omit the enrolled PEM; no network listener, public A2A transport, or public PKI claim is involved.",
  },
  {
    status: "landed",
    capabilities: ["harness.connector.inventory"],
    file: "packages/arbor-mcp/tests/harness-connector-inventory.test.ts",
    test: "uses the CLI's actual configured-native composition rather than a hand-built registry",
    shape: "createCliRuntime with a complete native selection -> the canonical harness.connector.inventory query -> registered direct-native descriptor, capability-grade inventory, and selected execution projection. The companion adversarial test proves free-form connector diagnostics/evidence cannot leak secrets into any catalog/TUI/Web projection.",
  },
  {
    status: "landed",
    capabilities: ["project.registry.list", "project.manage"],
    file: "packages/arbor-mcp/tests/project-registry-roundtrip.test.ts",
    test: "routes project.registry.list to a real registry read and reports an entry that cannot discharge",
    shape: "createCliRuntime over a real on-disk registry -> the canonical project.registry.list and project.manage queries -> the projections the TUI's project-registry screen consumes. Asserts an entry whose recorded path no longer exists is reported ok:false WITH failure codes rather than omitted, and that the projection's own top-level ok goes false so a caller reading only the summary cannot conclude all is well. Companion cases cover the empty registry as a valid state (a fresh checkout governs zero projects) and the manage reconcile pass accounting for the same undischargeable entry. Screen-level tests render a supplied projection; this proves the projection itself is produced, which is the difference between a live capability and a Hollow one.",
  },
  {
    status: "landed",
    capabilities: ["harness.native.readiness"],
    file: "packages/arbor-mcp/tests/native-harness-readiness.test.ts",
    test: "makes auto mode direct-native only with complete config plus credential presence, otherwise reports truthful fallback",
    shape: "createCliRuntime -> canonical harness.native.readiness query -> secret-free setup projection; asserts auto mode stays connector fallback when the documented credential is absent and admits direct native only when config, shipped adapter, and credential presence agree. The companion CLI/TUI tests exercise the same projection without endpoint probing or secret values.",
  },
  {
    status: "landed",
    capabilities: ["harness.session.list", "harness.session.inspect", "harness.session.events"],
    file: "packages/arbor-mcp/tests/harness-session-journal.test.ts",
    test: "durably replays redacted session observations",
    shape: "native session start/events/terminal -> atomic NDJSON journal -> replayed bounded list/inspect/events projections; asserts model-private payloads are redacted before persistence.",
  },
  {
    status: "landed",
    capabilities: ["harness.session.interrupt"],
    file: "packages/arbor-mcp/tests/live-native-session-roundtrip.test.ts",
    test: "lists, inspects, redacts events, and aborts the exact live session without a node-interrupt fallback",
    shape: "createNativeLoopExecutor registers its session-owned AbortController with ArborRuntime's live registry -> RuntimeCatalogRouter list/inspect/events reads the active native session with redaction -> harness.session.interrupt aborts that exact controller -> native worker settles interrupted -> durable journal replay is terminal; a terminal session is conflict and an unknown/non-live session is unavailable. TUI list/detail/events/confirmed interrupt uses the same adapter/router path in tui-harness-sessions.test.ts.",
  },
  {
    status: "landed",
    capabilities: ["result.list", "result.inspect", "result.scope.authorize", "result.adopt", "result.revert", "result.review.workspace", "result.review.comment", "result.review.request_revision", "result.review.editor_handoff"],
    file: "packages/arbor-mcp/tests/runtime-catalog.test.ts",
    test: "reviews and adopts an exact verified capture through the canonical router",
    shape: "verified worktree capture -> result.list/result.inspect bounded hash-checked review -> separate result.scope.authorize for exact observed paths and patch hash -> result.adopt consuming that authorization -> exact workspace patch application and idempotent replay -> receipt-bound result.revert; asserts stale hashes, missing workspace authority, repeat undo, and operator-diverged workspace states all fail closed.",
  },
  {
    status: "landed",
    capabilities: ["session.identity.get", "session.identity.search", "session.identity.mutate", "result.verification.get", "result.verification.list", "notification.list", "notification.read", "followup.list", "followup.create"],
    file: "packages/arbor-mcp/tests/product-ux-runtime-catalog.test.ts",
    test: "round-trips session identity, verification, notifications, and follow-up lineage through canonical catalog routes",
    shape: "canonical identity mutation -> durable identity search/get; canonical followup.create -> typed parent/source lineage projection; canonical session-completion verification fact -> verification list; notification.read -> unread notification projection. The assertions cover durable product records only, never model history, credentials, approval state, or inherited authority.",
  },
  {
    status: "landed",
    capabilities: ["doctor.get", "migration.inspect", "migration.preview", "migration.apply", "migration.rollback"],
    file: "packages/arbor-mcp/tests/s15-maintenance-journey.test.ts",
    test: "previews, applies, survives a real restart, inspects, and rolls back through arbor_command/arbor_query with no secret disclosure",
    shape: "arbor_command/arbor_query over the real client surface: doctor.get -> migration.preview -> migration.apply -> real restart -> migration.inspect -> migration.rollback against a disposable old-state fixture; asserts the migrated and rolled-back state and that no secret appears in any projection. A fabricated receipt_id and a stale preview hash are refused through the same surface.",
  },

  {
    status: "gap",
    capabilities: ["integration.list", "integration.inspect", "integration.admit", "integration.install", "integration.enable", "integration.disable", "integration.update", "remote.inspect", "remote.control", "scheduler.inspect", "scheduler.control"],
    gap: "NEW-6.3-2026-08-20",
    note: "The product integration control plane is capability-bound and catalog-routed, but no one disposable outermost trajectory yet composes browser/IDE/GitHub/plugin/remote/scheduler controls together. The manifest records that coverage boundary rather than treating acknowledged activation as a roundtrip proof.",
  },
  {
    status: "gap",
    capabilities: ["harness.session.attach", "harness.session.availability", "harness.session.steer", "harness.session.resume", "harness.session.fork", "harness.session.respawn"],
    gap: "NEW-6.3-2026-08-20",
    note: "Attach/steer and governed continuation contracts are exercised in focused Web/session/recovery tests, including fresh admission and idempotent fork preparation. A complete outermost route that composes live attach, terminal continuation, and canonical campaign.run remains pending; liveness probes each read seam without fabricating a session.",
  },
  {
    status: "landed",
    capabilities: ["taskcomposer.submit", "taskcomposer.confirm", "taskcomposer.cancel", "taskcomposer.reject", "taskcomposer.get", "taskcomposer.list"],
    file: "packages/arbor-mcp/tests/task-composer.test.ts",
    test: "reaches the asynchronous composer only through the canonical catalog",
    shape: "typed taskcomposer.submit -> awaited RuntimeCatalogRouter -> TaskComposer planner and durable draft store -> taskcomposer.list/get projections; taskcomposer.cancel aborts the active provider signal, persists cancelled state, and prevents late planner completion from resurrecting the draft. The router exposes no raw planner transcript, credentials, or direct manager/planner authority.",
  },
  {
    status: "landed",
    capabilities: ["taskcomposer.answer"],
    file: "packages/arbor-mcp/tests/task-composer.test.ts",
    test: "answers a planner question through the canonical catalog with revision CAS",
    shape: "awaiting clarification draft -> revision-bound taskcomposer.answer -> TaskComposer replans with the bounded answer -> proposed draft. The assertion proves the answer travels through the catalog's awaited operation boundary rather than a TUI-local state mutation.",
  },
  {
    status: "landed",
    capabilities: ["control.status", "control.discover", "control.inbox"],
    file: "packages/arbor-mcp/tests/distributed-control-surfaces.test.ts",
    test: "publishes three capability-gated catalog queries and actionable disabled projections",
    shape: "RuntimeCatalogRouter control.status/discover/inbox queries -> runtime-owned DistributedControlRuntime projection, or the same typed disabled projection when unconfigured; asserts capability gating, bounded inbox validation, and actionable configuration guidance rather than an empty or fabricated result.",
  },
  {
    status: "landed",
    capabilities: ["peer.grant", "peer.query", "peer.reply", "peer.history"],
    file: "packages/arbor-mcp/tests/native-peer-channel-adversarial.test.ts",
    test: "durably queries/replies, escalates disagreement, detects a wait cycle, redacts by tier, and replays after restart",
    shape: "parent-authorized peer.grant -> peer.query/reply commands -> durable native peer-channel ledger -> peer.history projection after restart; asserts real message content, unresolved-query state, disagreement escalation, cycle refusal, and tier redaction.",
  },
  {
    status: "landed",
    capabilities: ["peer.grants"],
    file: "packages/arbor-mcp/tests/roundtrip/workspace-governance-peer.test.ts",
    test: "enumerates the durable grant collection through peer.grants with caller scoping and restart replay",
    shape: "parent-authorized peer.grant commands -> durable native-peer-grants.json -> peer.grants query; asserts the parent sees every grant with real endpoints/disclosure bounds, each peer sees only grants it is party to, an unauthenticated caller is denied, and a restarted runtime replays the same collection.",
  },
  {
    status: "landed",
    capabilities: ["taskcomposer.retry"],
    file: "packages/arbor-mcp/tests/s06-retry-catalog-reachability.test.ts",
    test: "dispatchCommand(taskcomposer.retry) supersedes the failed attempt in place with an advanced revision, projected via taskcomposer.get/list",
    shape: "arbor_command(taskcomposer.submit) with a planner that exhausts its in-dispatch attempt budget -> status: failed -> arbor_command(taskcomposer.retry) -> a genuinely distinct planner attempt (a fresh session_id, not a replay) -> taskcomposer.get/list projection via RuntimeCatalogRouter; asserts the same draft identity now shows the retried outcome with a strictly advanced CAS revision, and that a fresh ArborMCPServer/ArborRuntime reading the same persistence_dir (a restart) projects the identical identity/revision/outcome through the same client surface.",
  },
  {
    status: "gap",
    capabilities: ["integration.rollback"],
    gap: "NEW-6.3-2026-08-20",
    note: "The canonical lifecycle rollback command has durable state and focused lifecycle coverage, but no outermost catalog-to-projection roundtrip has been designated yet.",
  },
];
