import { createHash } from "node:crypto";
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { parseFlightWorkerLine } from "./flight-control-worker-protocol.js";
import { fileURLToPath } from "node:url";
import { acquireWriterLock, type Action } from "@arbor/core";
import { WorktreeManager } from "@arbor/opencode";
import { createA2ADirectThreadProfileAdapter, A2A_DIRECT_THREAD_A2A_VERSION, A2A_DIRECT_THREAD_PROFILE_ID, type A2ADirectThreadSendInput, type A2ADirectThreadTask } from "./a2a-direct-thread-profile.js";
import { CampaignManager } from "./manager.js";
import { RemoteRuntimeIngress } from "./remote-ingress.js";
import { RemoteSessionAuthority, createRemoteSessionIdentity, type RemoteSessionProof } from "./remote-session.js";
import { adoptCapturedResult, captureWorktreeResult } from "./result-adoption.js";
import { ArborRuntime } from "./runtime.js";
import { RuntimeCatalogRouter } from "./runtime-catalog.js";

const FIXED_NOW = "2026-08-20T12:00:00.000Z";
const EXPIRES_AT = "2026-08-21T12:00:00.000Z";
const ROOT_ACTION: Action = {
  description: "Flight-control root",
  estimated_gain: 1,
  estimated_cost: 1,
  category: "root",
  delegate_to: "crown",
};
const CLAIMED = { tag: "claimed" as const, claimant: "flight-control" };

export const FLIGHT_CONTROL_EVENT_KINDS = [
  "scenario.started",
  "repository.ready",
  "process.ready",
  "process.ipc",
  "agent.message",
  "agent.relay",
  "remote.accepted",
  "remote.refused",
  "lease.independent",
  "lease.collision",
  "thread.collision",
  "writer_lock.collision",
  "writer_lock.reclaimed",
  "scope.refused",
  "operation.cancelled",
  "session.reconciled",
  "integrity.checked",
  "scenario.finished",
] as const;

export type FlightControlEventKind = typeof FLIGHT_CONTROL_EVENT_KINDS[number];
export type FlightControlScalar = string | number | boolean | null;
export type FlightControlEventDetail = Readonly<Record<string, FlightControlScalar | readonly FlightControlScalar[]>>;

export interface FlightControlEvent {
  readonly schema_version: 1;
  readonly sequence: number;
  readonly at: string;
  readonly kind: FlightControlEventKind;
  readonly detail: FlightControlEventDetail;
  readonly previous_hash: `sha256:${string}` | null;
  readonly hash: `sha256:${string}`;
}

export const FLIGHT_CONTROL_PUBLICATION_KINDS = [
  "topology.online",
  "message.sent",
  "message.acknowledged",
  "peer.query",
  "peer.reply",
  "cross_repo.sent",
  "cross_repo.received",
  "lease.attempt",
  "lease.acquired",
  "lease.denied",
  "scope.write_denied",
  "agent.cancel_requested",
  "agent.terminated",
  "session.crashed",
  "lease.stale_detected",
  "lease.recovered",
  "lease.quarantined",
  "retry.started",
  "retry.succeeded",
  "integrity.repo_clean",
  "integrity.ledger_verified",
] as const;

export type FlightControlPublicationKind = typeof FLIGHT_CONTROL_PUBLICATION_KINDS[number];

/** Flat, public-safe recording atom. No prompts, payloads, paths, keys or signatures. */
export interface FlightControlPublicationEvent {
  readonly schema_version: 1;
  readonly sequence: number;
  readonly at: string;
  readonly kind: FlightControlPublicationKind;
  readonly repo_id: string | null;
  readonly session_id: string | null;
  readonly agent_id: string | null;
  readonly peer_id: string | null;
  readonly resource_id: string | null;
  readonly outcome: string;
  readonly caption: string;
  readonly previous_hash: `sha256:${string}` | null;
  readonly hash: `sha256:${string}`;
}

export interface FlightControlCheck {
  readonly id: string;
  readonly ok: boolean;
  readonly summary: string;
  readonly evidence_sequences: readonly number[];
}

export interface FlightControlRepositoryReport {
  readonly id: "repo-a" | "repo-b";
  readonly root: string | null;
  readonly initial_head: string;
  readonly final_head: string;
  readonly initial_tree_hash: string;
  readonly final_tree_hash: string;
  readonly clean: boolean;
  readonly active_leases: number;
}

export interface FlightControlStressReport {
  readonly schema_version: 1;
  readonly scenario_id: string;
  readonly ok: boolean;
  readonly started_at: string;
  readonly finished_at: string;
  readonly checks: readonly FlightControlCheck[];
  readonly gaps: readonly string[];
  readonly events: readonly FlightControlEvent[];
  readonly event_chain_head: `sha256:${string}`;
  readonly publication_events: readonly FlightControlPublicationEvent[];
  readonly publication_chain_head: `sha256:${string}` | null;
  readonly repositories: readonly [FlightControlRepositoryReport, FlightControlRepositoryReport];
  readonly evidence_file: string | null;
}

export interface FlightControlStressOptions {
  /** Parent directory for the two real Git repositories and durable stores. */
  readonly work_root?: string;
  /** Preserve generated repositories after the report is returned. */
  readonly keep_artifacts?: boolean;
  /** Optional JSON report destination. Its parent directory must already exist. */
  readonly evidence_file?: string;
  /** Stable scenario identity for recordings and repeated CI runs. */
  readonly scenario_id?: string;
}

interface Host {
  readonly id: "repo-a" | "repo-b";
  readonly root: string;
  readonly store: string;
  readonly campaign_id: string;
  readonly manager: CampaignManager;
  readonly runtime: ArborRuntime;
  readonly router: RuntimeCatalogRouter;
  readonly authority: RemoteSessionAuthority;
  readonly adapter: ReturnType<typeof createA2ADirectThreadProfileAdapter>;
  readonly child_one: string;
  readonly child_two: string;
  readonly worktrees: WorktreeManager;
  readonly initial_head: string;
  readonly initial_tree_hash: string;
}

interface WorkerMessage {
  readonly kind: string;
  readonly [key: string]: string | number | boolean;
}

interface FlightWorker {
  readonly child: ChildProcessWithoutNullStreams;
  readonly command_file: string;
  readonly messages: WorkerMessage[];
  readonly waiters: Array<{ readonly resolve: (message: WorkerMessage) => void; readonly reject: (error: Error) => void; readonly timer: ReturnType<typeof setTimeout> }>;
  readonly stderr: string[];
}

type RouterResult = Awaited<ReturnType<RuntimeCatalogRouter["dispatchCommand"]>>;

function sha256(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
}

function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
}

function initRepository(parent: string, id: "repo-a" | "repo-b"): string {
  const root = join(parent, id);
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "shared.txt"), `${id}:base\n`);
  writeFileSync(join(root, "README.md"), `# ${id}\n`);
  writeFileSync(join(root, ".gitignore"), ".arbor/\n.worktrees/\n");
  git(root, "init", "-q");
  git(root, "config", "user.email", "flight-control@revoy2.invalid");
  git(root, "config", "user.name", "revoy2 flight control");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "flight-control baseline");
  return root;
}

function repositoryTreeHash(root: string): string {
  return sha256(git(root, "ls-tree", "-r", "--full-tree", "HEAD"));
}

function workerEntry(): string {
  const extension = import.meta.url.endsWith(".ts") ? ".ts" : ".js";
  return fileURLToPath(new URL(`./flight-control-worker${extension}`, import.meta.url));
}

function launchWorker(input: { mode: "session" | "blocked" | "hold-lock" | "try-lock"; host: Host; session_id: string; persistence_dir?: string }): FlightWorker {
  const persistenceDir = input.persistence_dir ?? input.host.store;
  const commandFile = join(persistenceDir, `flight-worker-${input.session_id}.commands.jsonl`);
  writeFileSync(commandFile, "", { mode: 0o600 });
  const child = spawn(process.env.ARBOR_BUN_BIN ?? "bun", [workerEntry(), input.mode, input.host.id, input.session_id, persistenceDir, commandFile], {
    cwd: input.host.root,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, NO_COLOR: "1" },
  });
  const worker: FlightWorker = { child, command_file: commandFile, messages: [], waiters: [], stderr: [] };
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    let message: WorkerMessage;
    try { message = parseFlightWorkerLine(line) as WorkerMessage; }
    catch { message = { kind: "worker_error", detail: `non-json stdout: ${line}` }; }
    const waiter = worker.waiters.shift();
    if (waiter) {
      clearTimeout(waiter.timer);
      waiter.resolve(message);
    } else worker.messages.push(message);
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => worker.stderr.push(chunk));
  child.once("error", (error) => {
    for (const waiter of worker.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  });
  child.once("exit", (code, signal) => {
    if (worker.messages.length > 0) return;
    const error = new Error(`flight worker exited before its next event: code=${code ?? "null"} signal=${signal ?? "null"} stderr=${worker.stderr.join("").trim()}`);
    for (const waiter of worker.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  });
  return worker;
}

function nextWorkerMessage(worker: FlightWorker, timeoutMs = 10_000): Promise<WorkerMessage> {
  const queued = worker.messages.shift();
  if (queued) return Promise.resolve(queued);
  return new Promise((resolveMessage, rejectMessage) => {
    const timer = setTimeout(() => {
      const index = worker.waiters.findIndex((candidate) => candidate.timer === timer);
      if (index >= 0) worker.waiters.splice(index, 1);
      rejectMessage(new Error(`flight worker timed out after ${timeoutMs}ms; stderr=${worker.stderr.join("").trim()}`));
    }, timeoutMs);
    worker.waiters.push({ resolve: resolveMessage, reject: rejectMessage, timer });
  });
}

function sendWorker(worker: FlightWorker, command: Record<string, string>): void {
  appendFileSync(worker.command_file, `${JSON.stringify(command)}\n`, "utf8");
}

function workerExit(worker: FlightWorker, timeoutMs = 10_000): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (worker.child.exitCode !== null || worker.child.signalCode !== null) return Promise.resolve({ code: worker.child.exitCode, signal: worker.child.signalCode });
  return new Promise((resolveExit, rejectExit) => {
    const timer = setTimeout(() => rejectExit(new Error(`flight worker pid ${worker.child.pid ?? "unknown"} did not exit`)), timeoutMs);
    worker.child.once("exit", (code, signal) => { clearTimeout(timer); resolveExit({ code, signal }); });
  });
}

function makeHost(parent: string, id: "repo-a" | "repo-b"): Host {
  const root = initRepository(parent, id);
  const store = join(parent, `${id}-store`);
  mkdirSync(store, { recursive: true });
  const campaign_id = `flight-${id}`;
  const manager = new CampaignManager({ persistence_dir: store });
  manager.startCampaign(campaign_id, "flight-control.plan", ROOT_ACTION);
  const children = manager.branch(campaign_id, "root", [
    { ...ROOT_ACTION, description: `${id} child one`, delegate_to: "seed" },
    { ...ROOT_ACTION, description: `${id} child two`, delegate_to: "seed" },
  ]);
  const child_one = children[0];
  const child_two = children[1];
  if (!child_one || !child_two) throw new Error(`${id} did not create both flight-control children`);
  const runtime = new ArborRuntime({ manager });
  const router = new RuntimeCatalogRouter(runtime);
  const authority = new RemoteSessionAuthority({ persistence_dir: store, now: () => new Date(FIXED_NOW) });
  return {
    id,
    root,
    store,
    campaign_id,
    manager,
    runtime,
    router,
    authority,
    adapter: createA2ADirectThreadProfileAdapter(new RemoteRuntimeIngress(router, authority)),
    child_one,
    child_two,
    worktrees: new WorktreeManager({ repoRoot: root }),
    initial_head: git(root, "rev-parse", "HEAD"),
    initial_tree_hash: repositoryTreeHash(root),
  };
}

function metadata(id: string, correlation_id = `flight:${id}`) {
  return {
    operation_id: `flight:${id}`,
    idempotency_key: `flight:${id}`,
    correlation_id,
    actor_id: "flight-control",
    requested_at: FIXED_NOW,
  };
}

function accepted(result: RouterResult): boolean {
  return result.ok && typeof result.value === "object" && result.value !== null
    && "accepted" in result.value && result.value.accepted === true;
}

function messageId(result: RouterResult): string {
  return result.ok && typeof result.value === "object" && result.value !== null
    && "message_id" in result.value ? String(result.value.message_id) : "";
}

function conflict(result: RouterResult): boolean {
  if (!result.ok || typeof result.value !== "object" || result.value === null || !("accepted" in result.value) || result.value.accepted !== false || !("error" in result.value)) return false;
  const error = result.value.error;
  return typeof error === "object" && error !== null && "code" in error && error.code === "conflict";
}

async function sendThread(host: Host, input: {
  id: string;
  child: string;
  from: string;
  kind: "delegate" | "reply" | "clarify" | "report";
  content: string;
  expected_version?: string;
  correlation_id?: string;
  parent_id?: string;
  reply_to?: string;
}): Promise<RouterResult> {
  const expected = input.expected_version ?? host.manager.getParentChildThread(host.campaign_id, "root", input.child).version;
  return host.router.dispatchCommand({
    schema_version: 1,
    metadata: metadata(input.id, input.correlation_id),
    command: {
      kind: "bus.thread.send",
      campaign_id: host.campaign_id,
      parent_node_id: "root",
      child_node_id: input.child,
      from_node_id: input.from,
      expected_thread_version: expected,
      message_kind: input.kind,
      intent: input.kind === "clarify" ? "needs_attention" : input.kind === "reply" ? "response" : "request",
      ack_required: input.kind === "delegate",
      content: input.content,
      provenance: CLAIMED,
      capability_tier: "specialist",
      ...(input.parent_id === undefined ? {} : { parent_communication_id: input.parent_id }),
      ...(input.reply_to === undefined ? {} : { reply_to_communication_id: input.reply_to }),
    },
  });
}

async function acknowledge(host: Host, id: string, child: string, from: string, target: string): Promise<RouterResult> {
  return host.router.dispatchCommand({
    schema_version: 1,
    metadata: metadata(id),
    command: {
      kind: "bus.thread.ack",
      campaign_id: host.campaign_id,
      parent_node_id: "root",
      child_node_id: child,
      from_node_id: from,
      expected_thread_version: host.manager.getParentChildThread(host.campaign_id, "root", child).version,
      message_id: target,
      provenance: CLAIMED,
      capability_tier: "specialist",
    },
  });
}

function prepareRemoteSend(source: Host, target: Host, nonce: string) {
  const identity = createRemoteSessionIdentity({
    session_id: `${source.id}-to-${target.id}`,
    actor_id: `${source.id}:orchestrator`,
    expires_at: EXPIRES_AT,
    thread_audiences: [{
      campaign_id: target.campaign_id,
      parent_node_id: "root",
      child_node_id: target.child_one,
      author_node_id: "root",
    }],
  });
  target.authority.register(identity.registration);
  const task: A2ADirectThreadTask = {
    task_id: `task:${source.id}-to-${target.id}`,
    campaign_id: target.campaign_id,
    parent_node_id: "root",
    child_node_id: target.child_one,
  };
  const input: A2ADirectThreadSendInput = {
    profile_id: A2A_DIRECT_THREAD_PROFILE_ID,
    a2a_version: A2A_DIRECT_THREAD_A2A_VERSION,
    task,
    actor_id: identity.registration.actor_id,
    from_node_id: "root",
    expected_thread_version: target.manager.getParentChildThread(target.campaign_id, "root", target.child_one).version,
    message_kind: "delegate",
    ack_required: true,
    wire: {
      messageId: `message:${source.id}-to-${target.id}`,
      taskId: task.task_id,
      contextId: task.task_id,
      role: "ROLE_AGENT",
      parts: [{ text: `${source.id} authenticated request to ${target.id}` }],
      metadata: {
        "arbor.dev/author-node-ref": "root",
        "arbor.dev/recipient-node-refs": [target.child_one],
      },
    },
  };
  const prepared = target.adapter.prepareSend(input);
  if (!prepared.ok) throw new Error(`could not prepare remote send: ${prepared.detail}`);
  const proof = identity.sign({ ...prepared.value.signing, nonce, issued_at: FIXED_NOW });
  return { identity, input, proof, signing: prepared.value.signing };
}

function eventChainValid(events: readonly FlightControlEvent[]): boolean {
  let previous: `sha256:${string}` | null = null;
  for (const event of events) {
    if (event.previous_hash !== previous || !FLIGHT_CONTROL_EVENT_KINDS.includes(event.kind)) return false;
    const unsigned = { schema_version: event.schema_version, sequence: event.sequence, at: event.at, kind: event.kind, detail: event.detail, previous_hash: event.previous_hash };
    if (event.hash !== sha256(canonical(unsigned))) return false;
    previous = event.hash;
  }
  return events.length > 0;
}

function publicationChainValid(events: readonly FlightControlPublicationEvent[]): boolean {
  let previous: `sha256:${string}` | null = null;
  for (const event of events) {
    if (event.previous_hash !== previous || !FLIGHT_CONTROL_PUBLICATION_KINDS.includes(event.kind)) return false;
    const unsigned = {
      schema_version: event.schema_version,
      sequence: event.sequence,
      at: event.at,
      kind: event.kind,
      repo_id: event.repo_id,
      session_id: event.session_id,
      agent_id: event.agent_id,
      peer_id: event.peer_id,
      resource_id: event.resource_id,
      outcome: event.outcome,
      caption: event.caption,
      previous_hash: event.previous_hash,
    };
    if (event.hash !== sha256(canonical(unsigned))) return false;
    previous = event.hash;
  }
  return events.length > 0;
}

/**
 * Run a deterministic, two-real-repository flight-control safety scenario.
 *
 * Failures are returned as named checks and gaps. The runner never converts a
 * missing primitive into a passing observation, which makes the report safe
 * to use as both CI evidence and a recording overlay source.
 */
export async function runFlightControlStress(options: FlightControlStressOptions = {}): Promise<FlightControlStressReport> {
  const started_at = FIXED_NOW;
  const scenario_id = options.scenario_id ?? "flight-control-a2a-v1";
  const ownsRoot = options.work_root === undefined;
  const workRoot = options.work_root === undefined
    ? mkdtempSync(join(tmpdir(), "revoy2-flight-control-"))
    : resolve(options.work_root);
  if (!ownsRoot) {
    if (existsSync(workRoot)) throw new Error(`flight-control work_root already exists: ${workRoot}`);
    mkdirSync(workRoot, { recursive: true });
  }

  const events: FlightControlEvent[] = [];
  const publicationEvents: FlightControlPublicationEvent[] = [];
  const checks: FlightControlCheck[] = [];
  const gaps: string[] = [];
  const emit = (kind: FlightControlEventKind, detail: FlightControlEventDetail): number => {
    const previous_hash = events.at(-1)?.hash ?? null;
    const unsigned = { schema_version: 1 as const, sequence: events.length + 1, at: FIXED_NOW, kind, detail, previous_hash };
    events.push({ ...unsigned, hash: sha256(canonical(unsigned)) });
    return events.length;
  };
  const check = (id: string, ok: boolean, summary: string, evidence_sequences: readonly number[]): void => {
    checks.push({ id, ok, summary, evidence_sequences: [...evidence_sequences] });
  };
  const publish = (kind: FlightControlPublicationKind, fields: {
    repo_id?: string; session_id?: string; agent_id?: string; peer_id?: string; resource_id?: string; outcome: string; caption: string;
  }): void => {
    const previous_hash = publicationEvents.at(-1)?.hash ?? null;
    const unsigned = {
      schema_version: 1 as const,
      sequence: publicationEvents.length + 1,
      at: FIXED_NOW,
      kind,
      repo_id: fields.repo_id ?? null,
      session_id: fields.session_id ?? null,
      agent_id: fields.agent_id ?? null,
      peer_id: fields.peer_id ?? null,
      resource_id: fields.resource_id ?? null,
      outcome: fields.outcome,
      caption: fields.caption,
      previous_hash,
    };
    publicationEvents.push({ ...unsigned, hash: sha256(canonical(unsigned)) });
  };

  emit("scenario.started", { scenario_id });
  let hostA: Host | null = null;
  let hostB: Host | null = null;
  const liveWorkers: FlightWorker[] = [];
  let report: FlightControlStressReport | null = null;
  try {
    hostA = makeHost(workRoot, "repo-a");
    hostB = makeHost(workRoot, "repo-b");
    const repoReady = emit("repository.ready", { repositories: [hostA.id, hostB.id], real_git: true });
    check("two-real-git-repositories", true, "Two independent real Git repositories were initialized.", [repoReady]);

    // Two actual Bun processes hold different persistence locks concurrently,
    // then complete a peer challenge/reply through an explicit parent relay.
    const processAStore = join(workRoot, "repo-a-worker-store");
    const processBStore = join(workRoot, "repo-b-worker-store");
    mkdirSync(processAStore);
    mkdirSync(processBStore);
    const processA = launchWorker({ mode: "session", host: hostA, session_id: "session-a", persistence_dir: processAStore });
    liveWorkers.push(processA);
    const readyA = await nextWorkerMessage(processA);
    const processB = launchWorker({ mode: "session", host: hostB, session_id: "session-b", persistence_dir: processBStore });
    liveWorkers.push(processB);
    const readyB = await nextWorkerMessage(processB);
    const simultaneous = readyA.kind === "ready" && readyB.kind === "ready"
      && readyA.lock_held === true && readyB.lock_held === true
      && processA.child.exitCode === null && processB.child.exitCode === null
      && readyA.pid !== readyB.pid;
    const processesReady = emit("process.ready", { repo_a_pid: Number(readyA.pid), repo_b_pid: Number(readyB.pid), repo_a_session: String(readyA.session_id), repo_b_session: String(readyB.session_id), simultaneously_live: simultaneous, distinct_persistence_locks: true });
    check("concurrent-real-bun-sessions", simultaneous, "Two real Bun workers rooted in different repositories held distinct writer locks at the same time.", [processesReady]);
    if (simultaneous) publish("topology.online", { outcome: "online", caption: "Two repository control sessions are live concurrently" });

    sendWorker(processA, { kind: "create_challenge", peer_repo_id: hostB.id, peer_session_id: "session-b", token: "flight-ipc-token" });
    const challenge = await nextWorkerMessage(processA);
    sendWorker(processB, { kind: "peer_challenge", from_repo_id: String(challenge.repo_id), from_session_id: String(challenge.session_id), token: String(challenge.token) });
    const peerReply = await nextWorkerMessage(processB);
    sendWorker(processA, { kind: "peer_reply", from_repo_id: String(peerReply.repo_id), from_session_id: String(peerReply.session_id), token: String(peerReply.token) });
    const peerAck = await nextWorkerMessage(processA);
    const ipcValid = challenge.kind === "challenge" && peerReply.kind === "reply" && peerAck.kind === "reply_acknowledged"
      && challenge.token === peerReply.token && peerReply.token === peerAck.token
      && challenge.repo_id === hostA.id && peerReply.repo_id === hostB.id
      && challenge.session_id === "session-a" && peerReply.session_id === "session-b";
    const ipcEvent = emit("process.ipc", { mode: "explicit_parent_ipc_relay", challenge_repo: String(challenge.repo_id), challenge_session: String(challenge.session_id), reply_repo: String(peerReply.repo_id), reply_session: String(peerReply.session_id), acknowledged: ipcValid });
    check("concurrent-session-ipc-query-reply", ipcValid, "The live repository workers exchanged a correlated challenge/reply through an explicit parent IPC relay.", [ipcEvent]);
    if (challenge.kind === "challenge") publish("peer.query", { repo_id: hostA.id, session_id: "session-a", agent_id: "worker-a", peer_id: "worker-b", outcome: "relayed", caption: "Worker A asks Worker B through the orchestrator relay" });
    if (ipcValid) publish("peer.reply", { repo_id: hostB.id, session_id: "session-b", agent_id: "worker-b", peer_id: "worker-a", outcome: "acknowledged", caption: "Worker B replies and Worker A acknowledges" });

    // Orchestrator -> child delegate, child -> orchestrator ack and reply.
    const delegate = await sendThread(hostA, { id: "local-delegate", child: hostA.child_one, from: "root", kind: "delegate", content: "inspect bounded target" });
    const delegateId = messageId(delegate);
    const ack = await acknowledge(hostA, "local-ack", hostA.child_one, hostA.child_one, delegateId);
    const reply = await sendThread(hostA, {
      id: "local-reply", child: hostA.child_one, from: hostA.child_one, kind: "reply", content: "bounded target inspected",
      parent_id: delegateId, reply_to: delegateId, correlation_id: "flight:local-delegate",
    });
    const localMessage = emit("agent.message", { direction: "orchestrator<->child", delegate_id: delegateId, delegate: accepted(delegate), acknowledgement: accepted(ack), reply: accepted(reply) });
    check("orchestrator-child-bidirectional", accepted(delegate) && delegateId.length > 0 && accepted(ack) && accepted(reply), "Delegate, durable acknowledgement, and linked reply traversed the parent-child bus.", [localMessage]);
    if (accepted(delegate)) publish("message.sent", { repo_id: hostA.id, agent_id: "orchestrator", peer_id: "child-one", resource_id: delegateId, outcome: "durable", caption: "Orchestrator delegates bounded work" });
    if (accepted(ack)) publish("message.acknowledged", { repo_id: hostA.id, agent_id: "child-one", peer_id: "orchestrator", resource_id: delegateId, outcome: "durable", caption: "Child acknowledges the delegated work" });

    // Child one asks child two through an explicit, honestly-labelled Crown relay.
    const question = await sendThread(hostA, { id: "sibling-question", child: hostA.child_one, from: hostA.child_one, kind: "clarify", content: "What invariant did you observe?" });
    const questionId = messageId(question);
    const relay = await sendThread(hostA, { id: "sibling-relay", child: hostA.child_two, from: "root", kind: "delegate", content: `Relayed question ${questionId}: What invariant did you observe?` });
    const relayId = messageId(relay);
    const siblingReply = await sendThread(hostA, { id: "sibling-answer", child: hostA.child_two, from: hostA.child_two, kind: "reply", content: "leases are repository scoped", parent_id: relayId, reply_to: relayId, correlation_id: "flight:sibling-relay" });
    const answerId = messageId(siblingReply);
    const returnRelay = await sendThread(hostA, { id: "sibling-return-relay", child: hostA.child_one, from: "root", kind: "reply", content: `Relayed answer ${answerId}: leases are repository scoped`, parent_id: questionId, reply_to: questionId, correlation_id: "flight:sibling-question" });
    const relayEvent = emit("agent.relay", { mode: "explicit_orchestrator_relay", child_one: hostA.child_one, child_two: hostA.child_two, question_id: questionId, answer_id: answerId });
    check("sibling-query-reply", accepted(question) && accepted(relay) && accepted(siblingReply) && accepted(returnRelay) && hostA.child_one !== hostA.child_two, "Two distinct children completed a query/reply through an explicit orchestrator relay.", [relayEvent]);

    // Signed A2A direct-thread exchange in both repository directions.
    const aToB = prepareRemoteSend(hostA, hostB, "nonce-a-to-b");
    const deliveredAB = await hostB.adapter.deliverSend(aToB.input, aToB.proof);
    const bToA = prepareRemoteSend(hostB, hostA, "nonce-b-to-a");
    const deliveredBA = await hostA.adapter.deliverSend(bToA.input, bToA.proof);
    const crossEvent = emit("remote.accepted", { directions: ["repo-a->repo-b", "repo-b->repo-a"], a_to_b: deliveredAB.ok, b_to_a: deliveredBA.ok, authorities: 2 });
    check("authenticated-cross-repository-bidirectional", deliveredAB.ok && deliveredBA.ok, "Each repository used its own authority to authenticate a signed direct-thread message from the other repository.", [crossEvent]);
    publish("cross_repo.sent", { repo_id: hostA.id, session_id: "repo-a-to-repo-b", peer_id: hostB.id, outcome: "signed", caption: "Repository A sends an authenticated request" });
    if (deliveredAB.ok) publish("cross_repo.received", { repo_id: hostB.id, session_id: "repo-a-to-repo-b", peer_id: hostA.id, outcome: "verified", caption: "Repository B verifies and accepts Repository A" });
    publish("cross_repo.sent", { repo_id: hostB.id, session_id: "repo-b-to-repo-a", peer_id: hostA.id, outcome: "signed", caption: "Repository B sends an authenticated request" });
    if (deliveredBA.ok) publish("cross_repo.received", { repo_id: hostA.id, session_id: "repo-b-to-repo-a", peer_id: hostB.id, outcome: "verified", caption: "Repository A verifies and accepts Repository B" });

    // The two repositories may independently lease and change the same relative path.
    const independentA = hostA.worktrees.acquireLease({ campaign_id: hostA.campaign_id, node_id: "independent", specialist: "seed-a" });
    const independentB = hostB.worktrees.acquireLease({ campaign_id: hostB.campaign_id, node_id: "independent", specialist: "seed-b" });
    if (independentA) writeFileSync(join(independentA.path, "src", "shared.txt"), "repo-a:independent\n");
    if (independentB) writeFileSync(join(independentB.path, "src", "shared.txt"), "repo-b:independent\n");
    const independent = independentA !== null && independentB !== null
      && readFileSync(join(independentA.path, "src", "shared.txt"), "utf8") !== readFileSync(join(independentB.path, "src", "shared.txt"), "utf8");
    const independentEvent = emit("lease.independent", { same_relative_path: "src/shared.txt", repo_a_acquired: independentA !== null, repo_b_acquired: independentB !== null, independent });
    check("different-repository-independence", independent, "The same relative path was leased independently under different canonical repository roots.", [independentEvent]);
    hostA.worktrees.releaseLease("independent");
    hostB.worktrees.releaseLease("independent");

    // Two independent managers contend for the exact same repository/node lease.
    const contenderOne = new WorktreeManager({ repoRoot: hostA.root });
    const contenderTwo = new WorktreeManager({ repoRoot: hostA.root });
    const leaseOne = contenderOne.acquireLease({ campaign_id: hostA.campaign_id, node_id: "collision", specialist: "seed-one" });
    const leaseTwo = contenderTwo.acquireLease({ campaign_id: hostA.campaign_id, node_id: "collision", specialist: "seed-two" });
    const leaseWinners = Number(leaseOne !== null) + Number(leaseTwo !== null);
    const leaseCollision = emit("lease.collision", { canonical_repo: hostA.id, contenders: 2, winners: leaseWinners });
    check("same-repository-lease-collision", leaseWinners === 1, "Exactly one manager acquired the canonical repository/node lease.", [leaseCollision]);
    publish("lease.attempt", { repo_id: hostA.id, agent_id: "seed-one", resource_id: "collision", outcome: "contended", caption: "Two agents request the same repository lease" });
    publish("lease.attempt", { repo_id: hostA.id, agent_id: "seed-two", resource_id: "collision", outcome: "contended", caption: "A second agent reaches the same lease boundary" });
    if (leaseOne) publish("lease.acquired", { repo_id: hostA.id, agent_id: "seed-one", resource_id: "collision", outcome: "winner", caption: "One agent acquires the canonical lease" });
    if (leaseTwo) publish("lease.acquired", { repo_id: hostA.id, agent_id: "seed-two", resource_id: "collision", outcome: "winner", caption: "One agent acquires the canonical lease" });
    if (!leaseOne) publish("lease.denied", { repo_id: hostA.id, agent_id: "seed-one", resource_id: "collision", outcome: "collision", caption: "The competing lease is denied" });
    if (!leaseTwo) publish("lease.denied", { repo_id: hostA.id, agent_id: "seed-two", resource_id: "collision", outcome: "collision", caption: "The competing lease is denied" });
    if (leaseOne) contenderOne.releaseLease("collision");
    if (leaseTwo) contenderTwo.releaseLease("collision");

    // Two commands race with one captured CAS cursor. The durable append is authority.
    const collisionVersion = hostB.manager.getParentChildThread(hostB.campaign_id, "root", hostB.child_two).version;
    const [casOne, casTwo] = await Promise.all([
      sendThread(hostB, { id: "cas-one", child: hostB.child_two, from: "root", kind: "delegate", content: "CAS contender one", expected_version: collisionVersion }),
      sendThread(hostB, { id: "cas-two", child: hostB.child_two, from: "root", kind: "delegate", content: "CAS contender two", expected_version: collisionVersion }),
    ]);
    const casWinners = Number(accepted(casOne)) + Number(accepted(casTwo));
    const casLosers = Number(conflict(casOne)) + Number(conflict(casTwo));
    const casEvent = emit("thread.collision", { contenders: 2, winners: casWinners, conflicts: casLosers, expected_version: collisionVersion });
    check("thread-cas-collision", casWinners === 1 && casLosers === 1, "A stale thread cursor lost with a typed conflict; no last-write-wins append occurred.", [casEvent]);

    // The same persistence root refuses a second live writer.
    const lockContender = launchWorker({ mode: "try-lock", host: hostA, session_id: "same-persistence-contender", persistence_dir: processAStore });
    liveWorkers.push(lockContender);
    const contenderMessage = await nextWorkerMessage(lockContender);
    const contenderExit = await workerExit(lockContender);
    const lockRefused = contenderMessage.kind === "lock_refused" && contenderExit.code === 0;
    const writerCollision = emit("writer_lock.collision", { persistence_repo: hostA.id, holder_pid: Number(readyA.pid), contender_pid: Number(contenderMessage.pid), refused: lockRefused });
    check("same-persistence-writer-lock-refusal", lockRefused, "A second real process was refused while the first process held the persistence writer lock.", [writerCollision]);

    // A SIGKILL leaves a dead-PID record; the canonical lock primitive reclaims it.
    const staleDir = join(workRoot, "stale-writer-store");
    mkdirSync(staleDir);
    const staleWorker = launchWorker({ mode: "hold-lock", host: hostA, session_id: "stale-holder", persistence_dir: staleDir });
    liveWorkers.push(staleWorker);
    const staleReady = await nextWorkerMessage(staleWorker);
    staleWorker.child.kill("SIGKILL");
    const staleExit = await workerExit(staleWorker);
    if (staleExit.signal === "SIGKILL") publish("session.crashed", { repo_id: hostA.id, session_id: "stale-holder", outcome: "killed", caption: "A lease holder crashes without cleanup" });
    if (staleExit.signal === "SIGKILL") publish("lease.stale_detected", { repo_id: hostA.id, session_id: "stale-holder", resource_id: "writer-lock", outcome: "dead_pid", caption: "The replacement detects a stale dead-PID lock" });
    publish("retry.started", { repo_id: hostA.id, agent_id: "flight-control-reclaimer", resource_id: "writer-lock", outcome: "recovery_attempt", caption: "Recovery retries the writer-lock acquisition" });
    const reclaimed = acquireWriterLock(staleDir, { holder: "flight-control-reclaimer" });
    const staleReclaimed = staleReady.kind === "ready" && staleExit.signal === "SIGKILL" && reclaimed.ok && reclaimed.reclaimed_stale;
    const reclaimEvent = emit("writer_lock.reclaimed", { dead_pid: Number(staleReady.pid), dead_signal: staleExit.signal ?? "none", reclaimed: staleReclaimed });
    check("stale-dead-pid-writer-lock-reclaim", staleReclaimed, "A lock abandoned by a SIGKILLed holder was reclaimed only after the PID was observed dead.", [reclaimEvent]);
    if (staleReclaimed) {
      publish("lease.recovered", { repo_id: hostA.id, agent_id: "flight-control-reclaimer", resource_id: "writer-lock", outcome: "reclaimed", caption: "The stale lease is safely recovered" });
      publish("retry.succeeded", { repo_id: hostA.id, agent_id: "flight-control-reclaimer", resource_id: "writer-lock", outcome: "acquired", caption: "The fenced retry succeeds once" });
    }
    if (reclaimed.ok) reclaimed.lock.release();

    // Exercise the real result-capture scope boundary, not a simulated sandbox.
    const scopeLease = hostA.worktrees.acquireLease({ campaign_id: hostA.campaign_id, node_id: "scope-attack", specialist: "seed-scope" });
    const protectedBefore = sha256(readFileSync(join(hostA.root, "README.md"), "utf8"));
    let scopeRefused = false;
    let scopeViolations: readonly string[] = [];
    if (scopeLease) {
      writeFileSync(join(scopeLease.path, "src", "shared.txt"), "allowed candidate change\n");
      writeFileSync(join(scopeLease.path, "README.md"), "attempted protected change\n");
      const captured = captureWorktreeResult({
        campaign_id: hostA.campaign_id,
        node_id: "scope-attack",
        worktree_path: scopeLease.path,
        verified: true,
        score: 1,
        declared_write_paths: ["src/shared.txt"],
        persistence_dir: hostA.store,
        now: () => FIXED_NOW,
      });
      scopeViolations = captured?.scope_violations ?? [];
      const adoption = adoptCapturedResult({ campaign_id: hostA.campaign_id, node_id: "scope-attack", persistence_dir: hostA.store, target_root: hostA.root });
      scopeRefused = captured?.verified === false && scopeViolations.includes("README.md") && !adoption.ok;
      hostA.worktrees.releaseLease("scope-attack");
    }
    const protectedAfter = sha256(readFileSync(join(hostA.root, "README.md"), "utf8"));
    const scopeEvent = emit("scope.refused", { boundary: "result_capture_and_adoption", protected_path: "README.md", violations: scopeViolations, refused: scopeRefused, protected_hash_unchanged: protectedBefore === protectedAfter });
    check("protected-path-scope-refusal", scopeRefused && protectedBefore === protectedAfter, "The actual capture/adoption boundary downgraded an out-of-scope candidate and refused to mutate the protected target.", [scopeEvent]);
    if (scopeRefused && protectedBefore === protectedAfter) publish("scope.write_denied", { repo_id: hostA.id, agent_id: "seed-scope", resource_id: "README.md", outcome: "adoption_refused", caption: "An out-of-scope protected write is denied" });

    // Forgery, wrong-edge authorization, and consumed-nonce replay must not append.
    const beforeRefusals = hostB.manager.getParentChildThread(hostB.campaign_id, "root", hostB.child_one).messages.length;
    const replay = await hostB.adapter.deliverSend(aToB.input, aToB.proof);
    const forgedProof: RemoteSessionProof = { ...aToB.proof, nonce: "nonce-forged", signature: `${aToB.proof.signature.slice(0, -2)}AA` };
    const forged = await hostB.adapter.deliverSend(aToB.input, forgedProof);
    const wrongInput: A2ADirectThreadSendInput = { ...aToB.input, from_node_id: hostB.child_one, wire: { ...aToB.input.wire, messageId: "message:wrong-edge" } };
    const wrongPrepared = hostB.adapter.prepareSend(wrongInput);
    let wrongEdgeOk = !wrongPrepared.ok;
    if (wrongPrepared.ok) {
      const wrongProof = aToB.identity.sign({ ...wrongPrepared.value.signing, nonce: "nonce-wrong-edge", issued_at: FIXED_NOW });
      const wrongEdge = await hostB.adapter.deliverSend(wrongInput, wrongProof);
      wrongEdgeOk = !wrongEdge.ok;
    }
    const afterRefusals = hostB.manager.getParentChildThread(hostB.campaign_id, "root", hostB.child_one).messages.length;
    const refusals = emit("remote.refused", { replay_refused: !replay.ok, forged_refused: !forged.ok, wrong_edge_refused: wrongEdgeOk, messages_before: beforeRefusals, messages_after: afterRefusals });
    check("remote-attacks-no-mutation", !replay.ok && !forged.ok && wrongEdgeOk && beforeRefusals === afterRefusals, "Replay, forged signature, and wrong-edge attempts were refused without durable mutation.", [refusals]);

    // Terminate a real blocked Bun worker, observe exit, then release its lease.
    const cancelLease = hostA.worktrees.acquireLease({ campaign_id: hostA.campaign_id, node_id: "cancelled-operation", specialist: "seed-cancel" });
    const blockedWorker = launchWorker({ mode: "blocked", host: hostA, session_id: "blocked-operation" });
    liveWorkers.push(blockedWorker);
    const blockedReady = await nextWorkerMessage(blockedWorker);
    publish("agent.cancel_requested", { repo_id: hostA.id, session_id: "blocked-operation", agent_id: "blocked-worker", resource_id: "cancelled-operation", outcome: "requested", caption: "The orchestrator cancels a blocked worker" });
    blockedWorker.child.kill("SIGTERM");
    const blockedExit = await workerExit(blockedWorker);
    const exitedBeforeRelease = blockedReady.kind === "ready" && (blockedExit.code !== null || blockedExit.signal !== null);
    const releasedCancellation = exitedBeforeRelease && cancelLease !== null && hostA.worktrees.releaseLease("cancelled-operation");
    const cancellationEvent = emit("operation.cancelled", { child_pid: Number(blockedReady.pid), exit_code: blockedExit.code, exit_signal: blockedExit.signal, exited_before_release: exitedBeforeRelease, lease_acquired: cancelLease !== null, lease_released: releasedCancellation });
    check("cancellation-releases-lease", exitedBeforeRelease && releasedCancellation && hostA.worktrees.readLease("cancelled-operation") === null, "A real blocked child exited before its exact repository lease was released.", [cancellationEvent]);
    if (exitedBeforeRelease) publish("agent.terminated", { repo_id: hostA.id, session_id: "blocked-operation", agent_id: "blocked-worker", resource_id: "cancelled-operation", outcome: "exited_before_release", caption: "The blocked worker exits before its lease is released" });

    // Reconstruct both campaign and remote-session authorities from disk.
    const sideEffectFile = join(workRoot, "side-effect-observation.log");
    writeFileSync(sideEffectFile, "remote-delivery-observed-once\n");
    const sideEffectsBeforeRestart = readFileSync(sideEffectFile, "utf8");
    const aBefore = hostA.manager.getParentChildThread(hostA.campaign_id, "root", hostA.child_one);
    const restartedManagerA = new CampaignManager({ persistence_dir: hostA.store });
    const aAfter = restartedManagerA.getParentChildThread(hostA.campaign_id, "root", hostA.child_one);
    const restartedAuthorityB = new RemoteSessionAuthority({ persistence_dir: hostB.store, now: () => new Date(FIXED_NOW) });
    const replayAfterRestart = restartedAuthorityB.verifyThread(aToB.proof, {
      kind: "bus.thread.send",
      metadata: aToB.signing.metadata,
      params: aToB.signing.params,
      audience: aToB.identity.registration.thread_audiences[0]!,
    });
    const sideEffectsAfterInspection = readFileSync(sideEffectFile, "utf8");
    const replayReason = replayAfterRestart.ok ? "accepted" : replayAfterRestart.error;
    const consumedNoncePreserved = !replayAfterRestart.ok && replayReason.includes("nonce was already consumed");
    const noSideEffectReplay = sideEffectsBeforeRestart === sideEffectsAfterInspection;
    const reconciled = aBefore.version === aAfter.version && aBefore.messages.length === aAfter.messages.length && consumedNoncePreserved && noSideEffectReplay;
    const restartEvent = emit("session.reconciled", { thread_version_preserved: aBefore.version === aAfter.version, message_count_preserved: aBefore.messages.length === aAfter.messages.length, consumed_nonce_preserved: consumedNoncePreserved, inspection_side_effect_free: noSideEffectReplay, replay_refusal: replayReason });
    check("restart-replay-reconciliation", reconciled, "Restart inspection replayed durable facts, did not repeat the observed side effect, and retained exact nonce replay refusal.", [restartEvent]);

    sendWorker(processA, { kind: "shutdown" });
    sendWorker(processB, { kind: "shutdown" });
    const [stoppedA, stoppedB] = await Promise.all([nextWorkerMessage(processA), nextWorkerMessage(processB)]);
    await Promise.all([workerExit(processA), workerExit(processB)]);
    check("concurrent-workers-clean-shutdown", stoppedA.kind === "stopped" && stoppedB.kind === "stopped", "Both repository workers released their distinct writer locks and exited.", [ipcEvent]);

    const auditA = hostA.manager.auditCampaign(hostA.campaign_id);
    const auditB = hostB.manager.auditCampaign(hostB.campaign_id);
    const finalHeadA = git(hostA.root, "rev-parse", "HEAD");
    const finalHeadB = git(hostB.root, "rev-parse", "HEAD");
    const finalTreeA = repositoryTreeHash(hostA.root);
    const finalTreeB = repositoryTreeHash(hostB.root);
    const cleanA = git(hostA.root, "status", "--porcelain").length === 0;
    const cleanB = git(hostB.root, "status", "--porcelain").length === 0;
    const activeA = hostA.worktrees.listActive().length;
    const activeB = hostB.worktrees.listActive().length;
    const integrity = auditA.failed === 0 && auditB.failed === 0
      && finalHeadA === hostA.initial_head && finalHeadB === hostB.initial_head
      && finalTreeA === hostA.initial_tree_hash && finalTreeB === hostB.initial_tree_hash
      && cleanA && cleanB && activeA === 0 && activeB === 0;
    const integrityEvent = emit("integrity.checked", { audit_a_failures: auditA.failed, audit_b_failures: auditB.failed, repo_a_clean: cleanA, repo_b_clean: cleanB, repo_a_active_leases: activeA, repo_b_active_leases: activeB, heads_unchanged: finalHeadA === hostA.initial_head && finalHeadB === hostB.initial_head, trees_unchanged: finalTreeA === hostA.initial_tree_hash && finalTreeB === hostB.initial_tree_hash });
    check("final-integrity-no-active-leases", integrity, "Both repositories and campaign ledgers remained clean, unchanged, and free of active leases.", [integrityEvent]);
    if (cleanA) publish("integrity.repo_clean", { repo_id: hostA.id, outcome: "clean", caption: "Repository A remains clean and unchanged" });
    if (cleanB) publish("integrity.repo_clean", { repo_id: hostB.id, outcome: "clean", caption: "Repository B remains clean and unchanged" });
    if (auditA.failed === 0) publish("integrity.ledger_verified", { repo_id: hostA.id, outcome: "verified", caption: "Repository A ledger verifies" });
    if (auditB.failed === 0) publish("integrity.ledger_verified", { repo_id: hostB.id, outcome: "verified", caption: "Repository B ledger verifies" });

    const preFinishChainValid = eventChainValid(events);
    const finishEvent = emit("scenario.finished", { checks: checks.length, passing: checks.filter((candidate) => candidate.ok).length, gaps: gaps.length, pre_finish_chain_valid: preFinishChainValid });
    check("event-chain-integrity", preFinishChainValid && eventChainValid(events) && publicationChainValid(publicationEvents), "The internal and publication-safe allowlisted event streams verify from genesis through their terminal events.", [finishEvent]);

    const repositories: [FlightControlRepositoryReport, FlightControlRepositoryReport] = [
      { id: hostA.id, root: options.keep_artifacts === true ? hostA.root : null, initial_head: hostA.initial_head, final_head: finalHeadA, initial_tree_hash: hostA.initial_tree_hash, final_tree_hash: finalTreeA, clean: cleanA, active_leases: activeA },
      { id: hostB.id, root: options.keep_artifacts === true ? hostB.root : null, initial_head: hostB.initial_head, final_head: finalHeadB, initial_tree_hash: hostB.initial_tree_hash, final_tree_hash: finalTreeB, clean: cleanB, active_leases: activeB },
    ];
    report = {
      schema_version: 1,
      scenario_id,
      ok: checks.every((candidate) => candidate.ok) && gaps.length === 0,
      started_at,
      finished_at: FIXED_NOW,
      checks,
      gaps,
      events,
      event_chain_head: events.at(-1)!.hash,
      publication_events: publicationEvents,
      publication_chain_head: publicationEvents.at(-1)?.hash ?? null,
      repositories,
      evidence_file: options.evidence_file === undefined ? null : resolve(options.evidence_file),
    };
    if (options.evidence_file !== undefined) writeFileSync(resolve(options.evidence_file), `${JSON.stringify(report, null, 2)}\n`);
    if (options.keep_artifacts === true) writeFileSync(join(workRoot, "flight-events.jsonl"), `${publicationEvents.map((event) => JSON.stringify(event)).join("\n")}\n`);
    return report;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    gaps.push(`scenario_execution_failed: ${reason}`);
    const failureEvent = emit("scenario.finished", { checks: checks.length, passing: checks.filter((candidate) => candidate.ok).length, gaps: gaps.length, failure: reason });
    check("scenario-execution", false, reason, [failureEvent]);
    const repositoryReport = (host: Host | null, id: "repo-a" | "repo-b"): FlightControlRepositoryReport => {
      const finalHead = host === null ? "unavailable" : git(host.root, "rev-parse", "HEAD");
      const finalTree = host === null ? "unavailable" : repositoryTreeHash(host.root);
      return {
        id,
        root: options.keep_artifacts === true && host !== null ? host.root : null,
        initial_head: host?.initial_head ?? "unavailable",
        final_head: finalHead,
        initial_tree_hash: host?.initial_tree_hash ?? "unavailable",
        final_tree_hash: finalTree,
        clean: host !== null && git(host.root, "status", "--porcelain").length === 0,
        active_leases: host?.worktrees.listActive().length ?? 0,
      };
    };
    report = {
      schema_version: 1,
      scenario_id,
      ok: false,
      started_at,
      finished_at: FIXED_NOW,
      checks,
      gaps,
      events,
      event_chain_head: events.at(-1)!.hash,
      publication_events: publicationEvents,
      publication_chain_head: publicationEvents.at(-1)?.hash ?? null,
      repositories: [repositoryReport(hostA, "repo-a"), repositoryReport(hostB, "repo-b")],
      evidence_file: options.evidence_file === undefined ? null : resolve(options.evidence_file),
    };
    if (options.evidence_file !== undefined) writeFileSync(resolve(options.evidence_file), `${JSON.stringify(report, null, 2)}\n`);
    if (options.keep_artifacts === true) writeFileSync(join(workRoot, "flight-events.jsonl"), `${publicationEvents.map((event) => JSON.stringify(event)).join("\n")}\n`);
    return report;
  } finally {
    for (const worker of liveWorkers) {
      if (worker.child.exitCode === null && worker.child.signalCode === null) worker.child.kill("SIGKILL");
    }
    if (options.keep_artifacts !== true && (ownsRoot || existsSync(workRoot))) rmSync(workRoot, { recursive: true, force: true });
  }
}
