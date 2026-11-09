/**
 * Seed presets: durable project state built through the real runtime, with
 * the acceptance check that EC-015 found the ad-hoc seeder lacked.
 *
 * `RuntimeCatalogRouter.dispatchCommand` returns a two-level result: `ok`
 * says the ENVELOPE routed; the command itself reports `value.accepted`. A
 * seeder that reads `ok` alone records a runtime rejection as a success and
 * then investigates a phantom defect (EC-013/014 cost two ticks each). Every
 * dispatch here goes through `accepted()`, and a required step that is
 * rejected throws, so a preset can never report state it did not create.
 *
 * Two seeds bypass the router on purpose: approvals require an authenticated
 * operator identity at the router (a governance boundary, EC-032) and peer
 * grants require a parent caller context, so both use the runtime service
 * the composition root itself uses.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { CampaignManager } from "../../../packages/arbor-mcp/src/manager.ts";
import { ArborRuntime } from "../../../packages/arbor-mcp/src/runtime.ts";
import { RuntimeCatalogRouter } from "../../../packages/arbor-mcp/src/runtime-catalog.ts";

export const CAMPAIGN_ID = "seed-campaign";
const FAR_FUTURE = "2099-01-01T00:00:00.000Z";
const NOW = () => new Date().toISOString();

const ROOT_ACTION = { description: "seeded root objective", estimated_gain: 1, estimated_cost: 1, category: "root", delegate_to: "crown" };
const CHILD_ACTIONS = [
  { description: "seeded analysis of the migration", estimated_gain: 1, estimated_cost: 1, category: "code", delegate_to: "worker" },
  { description: "seeded review of the analysis", estimated_gain: 1, estimated_cost: 1, category: "code", delegate_to: "heartwood" },
];

const metadata = (op) => ({ operation_id: op, idempotency_key: op, actor_id: "seed-operator", correlation_id: "seed", requested_at: NOW() });

/** The two-level acceptance read (mirrors `classifyResult` in liveness.ts). */
export function accepted(result) {
  if (!result || result.ok === false) return { accepted: false, error: result?.error?.summary ?? "dispatch failed with no typed error" };
  const value = result.value;
  if (value && typeof value === "object" && value.accepted === false) return { accepted: false, error: value.error?.summary ?? "rejected with no typed error" };
  return { accepted: true, value };
}

class SeedLedger {
  steps = [];
  constructor(preset) { this.preset = preset; }
  record(name, outcome, detail = null, extra = {}) { this.steps.push({ name, outcome, detail, ...extra }); return this; }
  async dispatch(router, name, envelope, { required = true } = {}) {
    const verdict = accepted(await router.dispatchCommand(envelope));
    this.record(name, verdict.accepted ? "accepted" : "rejected", verdict.accepted ? null : verdict.error);
    if (!verdict.accepted && required) throw new Error(`seed step "${name}" was rejected by the runtime: ${verdict.error}`);
    return verdict;
  }
  toJSON() { return { preset: this.preset, campaign_id: CAMPAIGN_ID, steps: this.steps, seeded_at: NOW() }; }
}

/** An enrolled-looking empty project: nothing durable, a real file tree for the Project Repo tab. */
export async function greenfield(projectDir) {
  const ledger = new SeedLedger("greenfield");
  mkdirSync(join(projectDir, "src"), { recursive: true });
  writeFileSync(join(projectDir, "README.md"), "# pilot-project\n\nA scratch project for TUI piloting.\n", "utf8");
  writeFileSync(join(projectDir, "src", "main.ts"), "export function main(): number { return 0; }\n", "utf8");
  writeFileSync(join(projectDir, "src", "greeting.ts"), "export const greeting = (name: string): string => `hello ${name}`;\n", "utf8");
  writeFileSync(join(projectDir, "package.json"), JSON.stringify({ name: "pilot-project", version: "0.0.0", private: true, type: "module" }, null, 2), "utf8");
  ledger.record("files", "applied", "README.md, package.json, src/main.ts, src/greeting.ts");
  // `core.hooksPath=/dev/null`: this workstation's global hooks path points at
  // revoy2's own pre-commit, which refuses any repo without it (EC-022).
  // A real campaign inspects repository status before isolating a worktree;
  // without a repository the only node fails with "fatal: not a git
  // repository" and the Console reports no_nodes (lifecycle pilot, EC-061).
  const git = (...args) => spawnSync("git", ["-c", "user.name=pilot", "-c", "user.email=pilot@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], { cwd: projectDir, encoding: "utf8", env: { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_INDEX_FILE: undefined } });
  const init = git("init", "-q", "-b", "main");
  const add = init.status === 0 ? git("add", "-A") : init;
  const commit = add.status === 0 ? git("commit", "-q", "-m", "pilot: initial project") : add;
  ledger.record("git", commit.status === 0 ? "applied" : "rejected", commit.status === 0 ? "initialised with one commit on main" : (commit.stderr || commit.stdout || "git failed").trim().slice(0, 200));
  return ledger;
}

/**
 * The EC-015 set (campaign, child nodes, job, approval, interview, bus record,
 * parent/child thread) plus the EC-042 peer grant, all durable under `.arbor`.
 */
export async function populated(projectDir) {
  const ledger = await greenfield(projectDir);
  ledger.preset = "populated";
  const persistence = join(projectDir, ".arbor");
  mkdirSync(persistence, { recursive: true });

  const manager = new CampaignManager({ persistence_dir: persistence });
  manager.startCampaign(CAMPAIGN_ID, "plan.md", ROOT_ACTION);
  ledger.record("campaign.start", "applied", CAMPAIGN_ID);
  const [worker, reviewer] = manager.branch(CAMPAIGN_ID, "root", CHILD_ACTIONS);
  if (!worker || !reviewer) throw new Error("seed: manager.branch did not create two children");
  ledger.record("tree.branch", "applied", `${worker}, ${reviewer}`, { nodes: { worker, reviewer } });

  const runtime = new ArborRuntime({ manager, persistence_dir: persistence });
  const router = new RuntimeCatalogRouter(runtime);
  try {
    await ledger.dispatch(router, "job.submit", {
      schema_version: 1, metadata: metadata("seed:job"),
      command: { kind: "job.submit", id: "seeded-analysis", operation_id: "seed:job:op", job_kind: "specialist.expand", owner_scope_id: CAMPAIGN_ID, idempotency_key: "seed:job" },
    }, { required: false });

    const approval = runtime.approvals.request({
      request_id: "seeded-approval", idempotency_key: "seeded-approval", action: "output.raw",
      subject: "seeded disclosure review", resource_id: CAMPAIGN_ID, proposer: "seed-operator",
      rationale: "Action-specific rationale: the raw output must be reviewed before disclosure.", expires_at: FAR_FUTURE,
    });
    ledger.record("approval.request", approval.ok ? "accepted" : "rejected", approval.ok ? approval.record.request_id : approval.error);
    if (!approval.ok) throw new Error(`seed: approval.request rejected: ${approval.error}`);

    await ledger.dispatch(router, "userinput.ask", {
      schema_version: 1, metadata: metadata("seed:ask"),
      command: {
        kind: "userinput.ask", campaign_id: CAMPAIGN_ID, node_id: "root",
        question: {
          operation_id: "seed:ask", question: "Should the seeded migration proceed?",
          options: [{ id: "proceed", text: "Proceed", is_other: false }, { id: "hold", text: "Hold for review", is_other: false }],
          authority: "lead", blocking: "blocking", requester_role: "taproot", idempotency_key: "seed:ask", as_of: "seq:100",
        },
      },
    });

    await ledger.dispatch(router, "bus.record", {
      schema_version: 1, metadata: metadata("seed:bus"),
      command: {
        kind: "bus.record", campaign_id: CAMPAIGN_ID, node_id: worker,
        communication: {
          author_node_id: worker, recipient_node_id: "root", other_recipient_node_ids: [],
          kind: "report", payload: { content: "seeded broadcast for surface piloting", provenance: { tag: "claimed", claimant: worker } },
          capability_tier: "specialist", trigger_turn: false, as_of: NOW(), correlation_id: "seed:bus", idempotency_key: "seed:bus",
          acknowledges_communication_id: null, retracts_communication_id: null, conversation_id: "seed-conversation",
        },
      },
    });

    await ledger.dispatch(router, "bus.thread.send", {
      schema_version: 1, metadata: metadata("seed:thread"),
      command: {
        kind: "bus.thread.send", campaign_id: CAMPAIGN_ID, parent_node_id: "root", child_node_id: worker, from_node_id: "root",
        expected_thread_version: "origin", message_kind: "delegate", content: "seeded delegation: begin the analysis",
        provenance: { tag: "claimed", claimant: "root" }, capability_tier: "specialist",
      },
    });

    try {
      runtime.nativePeerChannels.grant(
        { kind: "peer.grant", grant_id: "seeded-grant", campaign_id: CAMPAIGN_ID, parent_node_id: "root", left_node_id: worker, right_node_id: reviewer, capabilities: ["query", "reply"], capability_tier: "specialist", max_disclosure_bytes: 4096, expires_at: FAR_FUTURE, provenance: { tag: "claimed", claimant: "seed-operator" } },
        { kind: "parent", actor_id: "seed-operator", campaign_id: CAMPAIGN_ID, node_id: "root", capability_tier: "orchestrator" },
      );
      ledger.record("peer.grant", "accepted", "seeded-grant");
    } catch (error) {
      ledger.record("peer.grant", "rejected", error instanceof Error ? error.message : String(error));
    }
  } finally {
    const closed = await runtime.close();
    ledger.record("runtime.close", closed.ok ? "applied" : "rejected", closed.ok ? null : JSON.stringify(closed.error ?? closed));
  }
  return ledger;
}

/** Populated, then one audit record truncated mid-line (EC-039's reproduction). */
export async function corruptLedger(projectDir) {
  const ledger = await populated(projectDir);
  ledger.preset = "corrupt-ledger";
  const path = join(projectDir, ".arbor", "audit", `${CAMPAIGN_ID}.jsonl`);
  if (!existsSync(path)) throw new Error(`seed: expected audit ledger at ${path}`);
  const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
  const last = lines.at(-1);
  lines[lines.length - 1] = last.slice(0, Math.max(8, Math.floor(last.length / 2)));
  writeFileSync(path, `${lines.join("\n")}\n`, "utf8");
  ledger.record("corrupt", "applied", `${path}: last record truncated`);
  return ledger;
}

/** Populated, then `.arbor` made read-only (EC-040's reproduction). */
export async function readonlyArbor(projectDir) {
  const ledger = await populated(projectDir);
  ledger.preset = "readonly-arbor";
  const root = join(projectDir, ".arbor");
  const walk = (dir) => { for (const entry of readdirSync(dir)) { const p = join(dir, entry); if (statSync(p).isDirectory()) walk(p); chmodSync(p, statSync(p).isDirectory() ? 0o555 : 0o444); } };
  walk(root); chmodSync(root, 0o555);
  ledger.record("chmod", "applied", `${root}: read-only`);
  return ledger;
}

/** Populated, plus a hand-edit slip in arbor.jsonc (EC-041's reproduction). */
export async function badConfig(projectDir) {
  const ledger = await populated(projectDir);
  ledger.preset = "bad-config";
  writeFileSync(join(projectDir, "arbor.jsonc"), '{\n  // trailing comma and a missing brace, as a slip would leave it\n  "tui": { "theme": "moss-agate", }\n', "utf8");
  ledger.record("arbor.jsonc", "applied", "invalid JSON written");
  return ledger;
}

export const SEED_PRESETS = Object.freeze({
  greenfield, populated, "corrupt-ledger": corruptLedger, "readonly-arbor": readonlyArbor, "bad-config": badConfig,
});

export async function applySeed(name, projectDir) {
  const preset = SEED_PRESETS[name];
  if (!preset) throw new Error(`unknown seed preset "${name}" (have: ${Object.keys(SEED_PRESETS).join(", ")})`);
  mkdirSync(projectDir, { recursive: true });
  return preset(projectDir);
}
