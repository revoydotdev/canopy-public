import type { NativeStructuredOutputContract, NativeStructuredOutputValidation, OpenAICompatibleStructuredSchema } from "@arbor/harness";
import { isHighRiskCommandIntent, type Action } from "@arbor/core";
import { validateTaskComposerProposal, type TaskComposerProposal } from "./task-composer-contracts.js";
import { isAgentRole } from "./agent-registry.js";

/**
 * The campaign loop uses an action's `delegate_to` verbatim as the botanical
 * tree agent (`loop.ts`: `specialistAgent = action.delegate_to ?? "seed"`),
 * and `foreground.derive` throws "unknown foreground agent <x>" unless it is a
 * valid `AgentRole`. A provider plans in human vocabulary ("human", "writer",
 * "documentation-writer") and will not emit a botanical codename, so an
 * un-normalized plan crashes the run. Coerce to the loop's own default
 * (`"seed"`, a valid specialist) whenever the model's value is not a real
 * role; the meaningful routing signal (`execution_role`, `category`) is
 * preserved untouched.
 */
const FALLBACK_DELEGATE: string = "seed";
function normalizeDelegate(candidate: unknown): string {
  return typeof candidate === "string" && isAgentRole(candidate) ? candidate : FALLBACK_DELEGATE;
}

export const NATIVE_TASK_PLAN_SCHEMA_ID = "revoy.native.task-plan.v1";

const actionSchema = {
  type: "object", additionalProperties: false,
  required: ["description", "estimated_gain", "estimated_cost", "category", "delegate_to", "constraints", "execution_role", "skill_id", "skill_version", "high_risk_tool_scope", "decomposition_depth", "depends_on"],
  properties: {
    description: { type: "string", minLength: 1 }, estimated_gain: { type: "number", minimum: 0 }, estimated_cost: { type: "number", minimum: 0 },
    category: { type: "string", minLength: 1 }, delegate_to: { type: "string", minLength: 1 },
    constraints: { type: "array", items: { type: "string", minLength: 1 }, maxItems: 32 },
    depends_on: {
      type: ["array", "null"], items: { type: "string", minLength: 1 }, maxItems: 32,
      description: "Exact description strings of sibling actions in THIS plan that must be verified before this action is admitted as an executable tree node. Null/empty means no prerequisite.",
    },
    execution_role: {
      type: ["string", "null"], enum: ["architect", "documentation-writer", null],
      description: "Optional restricted execution profile. Use null for ALL ordinary implementation, design, frontend, test, configuration, and code-writing actions. Use architect only for a read-only planning/analysis action with no writes or declared state-changing/validation commands; non-mutating inspection commands remain available. Use documentation-writer only for documentation-only changes.",
    },
    skill_id: { type: ["string", "null"], pattern: "^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$", description: "Optional governed skill id. Set skill_id and skill_version together, or set both to null." },
    skill_version: { type: ["string", "null"], pattern: "^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(?:-[0-9A-Za-z.-]+)?(?:\\+[0-9A-Za-z.-]+)?$", description: "Exact immutable SemVer for skill_id; never select an unversioned latest value." },
    high_risk_tool_scope: {
      type: ["object", "null"], additionalProperties: false, required: ["write_paths", "command_argv"],
      description: "The exact high-risk effect surface this action's executor is authorized to use. Declare every file write and every state-changing or validation command; use null for a read-only action, which may still use non-mutating repository inspection commands.",
      properties: {
        write_paths: { type: "array", items: { type: "string", minLength: 1 }, maxItems: 32, description: "Every repository-relative file path (e.g. \"docs/native-doctor.md\") this action's executor will create or modify. A write to any path not listed here is denied — list all of them, and none it will not touch." },
        command_argv: {
          type: "array", maxItems: 32,
          description: "Every state-changing or validation command this action's executor will run. Non-mutating repository inspection commands do not belong here. Empty when the action runs no effectful or validation commands. Prefer a literal argv array (e.g. [\"npm\",\"test\"]) whenever the exact command is known. ADR-119: when the exact final argv cannot be known at plan time (a scaffolding tool, a generated name, a discovered file), declare an intent object naming only the leading, known tokens instead of guessing.",
          items: {
            oneOf: [
              { type: "array", minItems: 1, maxItems: 32, items: { type: "string", minLength: 1 }, description: "The exact argv this action's executor will run." },
              {
                type: "object", additionalProperties: false, required: ["argv_prefix", "purpose"],
                description: "ADR-119: a plan-time-knowable command intent, for when the exact final argv is genuinely unknowable at plan time. The executor may run any command whose argv starts with argv_prefix, but only for the first such call; every later call under this same intent is checked byte-exact against the argv the first call actually ran.",
                properties: {
                  argv_prefix: { type: "array", minItems: 1, maxItems: 32, items: { type: "string", minLength: 1 }, description: "Only the leading tokens known at plan time, e.g. [\"npm\", \"create\"]." },
                  purpose: { type: "string", minLength: 1, description: "Why this command family is needed." },
                },
              },
            ],
          },
        },
      },
    },
    decomposition_depth: { type: ["integer", "null"], minimum: 0, maximum: 8 },
  },
} as const;

export const NATIVE_TASK_PLAN_SCHEMA: OpenAICompatibleStructuredSchema = Object.freeze({
  schema_id: NATIVE_TASK_PLAN_SCHEMA_ID, name: "revoy_native_task_plan", strict: true,
  schema: { type: "object", additionalProperties: false, required: ["summary", "assumptions", "questions", "root_action", "actions", "acceptance_checks", "acceptance_mapping", "risk_notes"], properties: {
    summary: { type: "string", minLength: 1 }, assumptions: { type: "array", items: { type: "string", minLength: 1 }, maxItems: 32 },
    questions: { type: "array", maxItems: 8, items: { type: "object", additionalProperties: false, required: ["id", "question"], properties: { id: { type: "string", minLength: 1 }, question: { type: "string", minLength: 1 } } } },
    root_action: actionSchema, actions: { type: "array", minItems: 1, maxItems: 32, items: actionSchema },
    acceptance_checks: { type: "array", items: { type: "string", minLength: 1 }, maxItems: 32 },
    acceptance_mapping: { type: "array", maxItems: 32, items: { type: "object", additionalProperties: false, required: ["criterion", "action_descriptions"], properties: { criterion: { type: "string", minLength: 1 }, action_descriptions: { type: "array", minItems: 1, maxItems: 32, items: { type: "string", minLength: 1 } } } } },
    risk_notes: { type: "array", items: { type: "string", minLength: 1 }, maxItems: 32 },
  } },
});

/**
 * S02 (audit/2026-09-06-remediation): pre-execution plan-feasibility
 * admission. `validateTaskComposerProposal` proves the plan is well-typed;
 * these checks additionally prove it is not internally self-contradictory
 * in ways that were observed to burn a full specialist/critic cycle before
 * failing — see `api-verification-scope-mismatch-20260905.md` (verification
 * demanded from a node with no declared command authority) and
 * `live-haiku/cancellation/findings.md` (`bun install` producing an
 * undeclared `bun.lock`; bare `bun build` exiting 1 with "Missing
 * entrypoints" on Bun 1.4.0). Every check here is a REJECTION, never a
 * silent scope broadening: an infeasible plan is failed back to the planner
 * (via the same `structured_output_invalid` retry path schema failures
 * already use) so the model can either declare the missing authority or
 * repair the command — this module never adds authority on the plan's
 * behalf.
 */
export interface PlanFeasibilityRejection {
  readonly kind: "acceptance_authority_missing" | "declared_write_scope_incomplete" | "unsatisfiable_command";
  readonly reason: string;
}

/** Loose match: only a real verb signals a verification demand, never file extensions or prose padding. */
const VERIFICATION_DEMAND_RE = /\b(verify|verification|verified|test|tested|testing|build|built|run|running|check|checked|validate|validated|lint|linted|compile|compiled)\b/i;

function actionHasCommandAuthority(action: Pick<Action, "high_risk_tool_scope">): boolean {
  return (action.high_risk_tool_scope?.command_argv.length ?? 0) > 0;
}

/**
 * `api-verification-scope-mismatch-20260905.md`: an acceptance criterion
 * that reads as a verification demand ("verify", "run the tests", "build
 * succeeds") must be satisfiable by at least one of the actions it names —
 * otherwise the plan authored a check the tree can never pass, and the
 * observed failure mode was a critic denying the node for exactly this gap
 * after specialist dispatch, not before it.
 */
function findAcceptanceAuthorityGap(proposal: TaskComposerProposal): PlanFeasibilityRejection | null {
  if (proposal.acceptance_mapping === undefined) return null;
  // Descriptions are the mapping's only join key and are not unique, so keep every action per description.
  const actionsByDescription = new Map<string, Action[]>();
  for (const action of [proposal.root_action, ...proposal.actions]) {
    const bucket = actionsByDescription.get(action.description);
    if (bucket === undefined) actionsByDescription.set(action.description, [action]);
    else bucket.push(action);
  }
  for (const assignment of proposal.acceptance_mapping) {
    if (!VERIFICATION_DEMAND_RE.test(assignment.criterion)) continue;
    const mapped = assignment.action_descriptions.flatMap((description) => actionsByDescription.get(description) ?? []);
    if (mapped.length === 0) continue; // schema requires >=1 description, but an unmatched description is not this check's concern
    if (mapped.some(actionHasCommandAuthority)) continue;
    return {
      kind: "acceptance_authority_missing",
      reason: `acceptance criterion "${assignment.criterion}" demands verification, but none of its mapped action(s) (${assignment.action_descriptions.join(", ")}) declare any high_risk_tool_scope.command_argv authority to run it; declare the verification command on one of them or remove the criterion`,
    };
  }
  return null;
}

/** Argv-prefix match with a trailing exact-token bound, so "bunx" or "bundle" never match "bun". */
function argvStartsWith(argv: readonly string[], ...prefix: readonly string[]): boolean {
  return prefix.every((token, index) => argv[index] === token);
}

/**
 * `live-haiku/cancellation/findings.md` P1: "bare `bun build` exits 1 with
 * Missing entrypoints" on Bun 1.4.0 — confirmed against an installed Bun,
 * not inferred. Scoped to the exact observed shape (no further argv) so a
 * real `bun build src/index.ts` is never flagged.
 */
function unsatisfiableCommandReason(argv: readonly string[]): string | null {
  if (argv.length === 2 && argvStartsWith(argv, "bun", "build")) {
    return "bare `bun build` with no entrypoints exits 1 with \"Missing entrypoints\" (confirmed on installed Bun 1.4.0); declare the entrypoint file(s) in the argv";
  }
  return null;
}

/** Package-manager install flags that suppress writing/refreshing the ordinary lockfile. */
const LOCKFILE_SUPPRESSING_FLAGS = ["--frozen-lockfile", "--no-save", "--immutable", "--ignore-lockfile"] as const;

/**
 * `live-haiku/cancellation/findings.md` P1: "the actual adoption descriptor
 * records bun.lock as a scope violation after bun install" — the dependency
 * command's ordinary artifact was absent from the admitted write scope.
 * Returns the lockfile path an ordinary (non-frozen) install command will
 * write, or null when the argv is not a lockfile-writing install.
 */
function installLockfilePath(argv: readonly string[]): string | null {
  if (LOCKFILE_SUPPRESSING_FLAGS.some((flag) => argv.includes(flag))) return null;
  if (argvStartsWith(argv, "bun", "install") || argvStartsWith(argv, "bun", "i")) return "bun.lock";
  if (argvStartsWith(argv, "npm", "install")) return "package-lock.json";
  if (argvStartsWith(argv, "yarn") && (argv.length === 1 || argvStartsWith(argv, "yarn", "install"))) return "yarn.lock";
  if (argvStartsWith(argv, "pnpm", "install") || argvStartsWith(argv, "pnpm", "i")) return "pnpm-lock.yaml";
  return null;
}

function declaresPath(writePaths: readonly string[], path: string): boolean {
  return writePaths.some((declared) => declared === path || declared.endsWith(`/${path}`));
}

/**
 * Every literal (non-intent) command_argv across the plan's own actions,
 * paired with the declaring action. ADR-119 intent entries are excluded:
 * their final argv is genuinely unknowable at plan time, so neither check
 * below can be evaluated against them.
 *
 * `proposal.actions` is walked BEFORE `root_action` on purpose:
 * `normalizeProviderPlan`'s root recovery copies the union of every child
 * action's `high_risk_tool_scope` onto `root_action` (comment above that
 * function), so a command a CHILD action declared also appears, verbatim,
 * on `root_action`. Checking children first means the first-match callers
 * below (`findUnsatisfiableCommand`, `findIncompleteWriteScope`) name the
 * action that actually declared the command instead of the root recovery
 * fallback that only inherited it — the hoisting itself is unchanged, only
 * which action gets blamed for a command found on both.
 */
function literalCommandsOf(proposal: TaskComposerProposal): readonly { readonly action: Action; readonly argv: readonly string[] }[] {
  const out: { action: Action; argv: readonly string[] }[] = [];
  for (const action of [...proposal.actions, proposal.root_action]) {
    for (const entry of action.high_risk_tool_scope?.command_argv ?? []) {
      if (!isHighRiskCommandIntent(entry)) out.push({ action, argv: entry });
    }
  }
  return out;
}

function findUnsatisfiableCommand(proposal: TaskComposerProposal): PlanFeasibilityRejection | null {
  for (const { action, argv } of literalCommandsOf(proposal)) {
    const reason = unsatisfiableCommandReason(argv);
    if (reason !== null) return { kind: "unsatisfiable_command", reason: `action "${action.description}" declares command [${argv.join(" ")}]: ${reason}` };
  }
  return null;
}

function findIncompleteWriteScope(proposal: TaskComposerProposal): PlanFeasibilityRejection | null {
  for (const { action, argv } of literalCommandsOf(proposal)) {
    const lockfile = installLockfilePath(argv);
    if (lockfile === null) continue;
    const writePaths = action.high_risk_tool_scope!.write_paths;
    if (!declaresPath(writePaths, lockfile)) {
      return {
        kind: "declared_write_scope_incomplete",
        reason: `action "${action.description}" declares command [${argv.join(" ")}], which writes ${lockfile}, but its high_risk_tool_scope.write_paths does not include ${lockfile}; declare it explicitly or pass an install flag (${LOCKFILE_SUPPRESSING_FLAGS.join(", ")}) that skips writing it`,
      };
    }
  }
  return null;
}

/** First infeasible prerequisite found, or null when the plan is admissible. Order is deterministic (acceptance -> command satisfiability -> write scope) so the same infeasible plan always fails the same way. */
export function assessPlanFeasibility(proposal: TaskComposerProposal): PlanFeasibilityRejection | null {
  return findAcceptanceAuthorityGap(proposal) ?? findUnsatisfiableCommand(proposal) ?? findIncompleteWriteScope(proposal);
}

export const NATIVE_TASK_PLAN_CONTRACT: NativeStructuredOutputContract = Object.freeze({
  schema_id: NATIVE_TASK_PLAN_SCHEMA_ID,
  validate(value: unknown): NativeStructuredOutputValidation {
    const result = validateTaskComposerProposal(normalizeProviderPlan(value));
    if (!result.ok) return { valid: false, reason: result.error };
    const feasibility = assessPlanFeasibility(result.value);
    if (feasibility !== null) return { valid: false, reason: `plan feasibility (${feasibility.kind}): ${feasibility.reason}` };
    return { valid: true };
  },
});

/**
 * `decompose-policy.ts` (arbor-opencode) documents itself as the SOLE setter
 * of `action.decomposition_depth` for FAULT_MATRIX's timeout -> "decompose"
 * recovery bookkeeping: a freshly planned action must always start at the
 * "not yet decomposed" sentinel, which is absence of the field (both
 * `decompose-policy.ts`'s `currentDepth` reader and `Action`'s own doc treat
 * `decomposition_depth ?? 0` as that sentinel). But the plan schema requires
 * the model to emit a value for every planned action, and a model that
 * self-assigns a depth near the recovery ceiling pre-consumes the entire
 * recovery budget before any real decomposition ever happened. Every
 * INITIAL-plan action's model-supplied depth is neutralized here,
 * regardless of what the model wrote; only `decompose-policy.ts`'s own
 * `validateDecomposition` may set a positive depth, on a child it produces
 * after a real decompose hop.
 */
function neutralizeInitialDecompositionDepth(candidate: Record<string, unknown>): Record<string, unknown> {
  return { ...candidate, decomposition_depth: null };
}

function normalizeHighRiskScope(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  const scope = value as Record<string, unknown>;
  const writePaths = scope.write_paths === undefined ? [] : scope.write_paths;
  let commandArgv = scope.command_argv === undefined ? [] : scope.command_argv;
  if (Array.isArray(commandArgv) && commandArgv.length > 0 && commandArgv.every((part) => typeof part === "string")) {
    commandArgv = [commandArgv];
  }
  if (!Array.isArray(writePaths) || !writePaths.every((path) => typeof path === "string")
    || !Array.isArray(commandArgv) || !commandArgv.every((entry) => isNormalizedCommandArgvEntry(entry))) return value;
  // Construct only the closed authority shape. Dropping descriptive provider
  // extras can only narrow this capability; the manager still enforces every
  // declared path and argv independently at execution time.
  return { write_paths: writePaths, command_argv: commandArgv };
}

/** ADR-119: a `command_argv` entry is either a literal argv array of strings, or an intent (`argv_prefix`/`purpose`) entry. */
function isNormalizedCommandArgvEntry(entry: unknown): boolean {
  if (Array.isArray(entry)) return entry.every((part) => typeof part === "string");
  if (typeof entry !== "object" || entry === null) return false;
  const intent = entry as Record<string, unknown>;
  return Array.isArray(intent.argv_prefix) && intent.argv_prefix.every((part) => typeof part === "string") && typeof intent.purpose === "string";
}

function hasDeclaredHighRiskEffect(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const scope = value as Record<string, unknown>;
  return (Array.isArray(scope.write_paths) && scope.write_paths.length > 0)
    || (Array.isArray(scope.command_argv) && scope.command_argv.length > 0);
}

export function normalizeProviderPlan(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  const proposal = value as Record<string, unknown>;
  const action = (candidate: unknown): unknown => {
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) return candidate;
    const neutralized = neutralizeInitialDecompositionDepth(candidate as Record<string, unknown>);
    const stripped = Object.fromEntries(Object.entries(neutralized).filter(([, field]) => field !== null));
    if ("delegate_to" in stripped) stripped.delegate_to = normalizeDelegate(stripped.delegate_to);
    if ("high_risk_tool_scope" in stripped) stripped.high_risk_tool_scope = normalizeHighRiskScope(stripped.high_risk_tool_scope);
    // Provider job-title vocabulary (for example "developer" or
    // "implementer") is not an execution capability. Unknown values select
    // the ordinary Specialist profile; exact write/command scope below
    // remains the sole effect authority.
    if ("execution_role" in stripped && stripped.execution_role !== "architect" && stripped.execution_role !== "documentation-writer") delete stripped.execution_role;
    // Architect is a read-only planning profile. Providers sometimes use the
    // everyday job-title meaning for implementation/design work; if the same
    // action declares an effect, that label is mechanically contradictory.
    // Removing the optional restriction selects the ordinary Specialist, but
    // does not grant an effect: the manager-owned exact scope remains the sole
    // write/command authority at execution.
    if (stripped.execution_role === "architect" && hasDeclaredHighRiskEffect(stripped.high_risk_tool_scope)) delete stripped.execution_role;
    return stripped;
  };
  const normalizedActions = Array.isArray(proposal.actions) ? proposal.actions.map(action) : proposal.actions;
  let normalizedRoot = action(proposal.root_action);
  // Root recovery copies root_action after a failed prerequisite. Give that
  // fallback exactly the union of authority already admitted on child
  // actions: enough to recover, but never a path or command the plan did not
  // already authorize. This closes the fail-closed-but-powerless recovery
  // state observed in Campaign L.
  if (typeof normalizedRoot === "object" && normalizedRoot !== null && !Array.isArray(normalizedRoot) && Array.isArray(normalizedActions)) {
    const root = normalizedRoot as Record<string, unknown>;
    const scopes = [root, ...normalizedActions]
      .map((candidate) => typeof candidate === "object" && candidate !== null && !Array.isArray(candidate)
        ? (candidate as Record<string, unknown>).high_risk_tool_scope
        : undefined)
      .filter((candidate): candidate is { write_paths: string[]; command_argv: (string[] | { argv_prefix: string[]; purpose: string })[] } => typeof candidate === "object" && candidate !== null && !Array.isArray(candidate));
    const writePaths = [...new Set(scopes.flatMap((scope) => scope.write_paths))];
    const commands = new Map<string, string[] | { argv_prefix: string[]; purpose: string }>();
    for (const argv of scopes.flatMap((scope) => scope.command_argv)) commands.set(JSON.stringify(argv), argv);
    if (writePaths.length > 0 || commands.size > 0) {
      normalizedRoot = { ...root, high_risk_tool_scope: { write_paths: writePaths, command_argv: [...commands.values()] } };
      if ((normalizedRoot as Record<string, unknown>).execution_role === "architect") delete (normalizedRoot as Record<string, unknown>).execution_role;
    }
  }
  return { ...proposal, root_action: normalizedRoot, actions: normalizedActions };
}
