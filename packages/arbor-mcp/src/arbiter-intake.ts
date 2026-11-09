import type { NativeStructuredOutputContract, NativeStructuredOutputValidation, OpenAICompatibleStructuredSchema } from "@arbor/harness";
import type { Action, ArbiterDecision, GovernanceTier, TokenUsageResult } from "@arbor/core";

/**
 * ADR-062 — the ARBITER intake classifier. A cheap, bounded, single-turn
 * structured-output call (mirrors `native-task-plan-contract.ts`'s own
 * pattern) that decides, BEFORE the expensive multi-action planner ever
 * runs, whether a task needs the full `governed` tree-search-plus-critic
 * pipeline or can run with a narrower, cheaper governance tier:
 *
 *   - `direct`:   one specialist dispatch, no critic, no decomposition.
 *   - `reviewed`: one specialist dispatch + critic, no decomposition.
 *   - `governed`: today's unchanged full path (planner decomposition +
 *                 tree search + critic on every node). Default whenever the
 *                 arbiter is unavailable, errors, or returns malformed
 *                 output — see `classifyGovernanceTier`'s fallback.
 *
 * This module owns ONLY the classification contract and its safe-fallback
 * wrapper. It never itself talks to a provider — `ArbiterIntakePort` is the
 * seam a composition root supplies (an OpenCode/native single-turn call),
 * exactly the way `TaskComposerPlannerPort` is supplied for the full planner.
 */

export const ARBITER_DECISION_SCHEMA_ID = "revoy.native.arbiter-decision.v1";

export const ARBITER_DECISION_SCHEMA: OpenAICompatibleStructuredSchema = Object.freeze({
  schema_id: ARBITER_DECISION_SCHEMA_ID,
  name: "revoy_native_arbiter_decision",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["tier", "rationale", "category", "blast_radius"],
    properties: {
      tier: { type: "string", enum: ["direct", "reviewed", "governed"] },
      rationale: { type: "string", minLength: 1, maxLength: 4_096 },
      /** Cheap UCT category for the single root action this decision seeds. */
      category: { type: "string", minLength: 1, maxLength: 256 },
      blast_radius: {
        type: "object",
        additionalProperties: false,
        required: ["reversibility", "write_paths", "command_argv"],
        properties: {
          write_paths: { type: ["array", "null"], items: { type: "string", minLength: 1 }, maxItems: 32 },
          command_argv: { type: ["array", "null"], items: { type: "array", minItems: 1, maxItems: 32, items: { type: "string", minLength: 1 } }, maxItems: 32 },
          reversibility: { type: "string", enum: ["reversible", "irreversible", "unknown"] },
        },
      },
    },
  },
});

/** Parsed, schema-valid arbiter output before it is turned into a durable `ArbiterDecision`. */
export interface ArbiterDecisionOutput {
  readonly tier: GovernanceTier;
  readonly rationale: string;
  readonly category: string;
  readonly blast_radius: {
    readonly write_paths?: readonly string[];
    readonly command_argv?: readonly (readonly string[])[];
    readonly reversibility: "reversible" | "irreversible" | "unknown";
  };
}

export type ArbiterDecisionValidation =
  | { readonly ok: true; readonly value: ArbiterDecisionOutput }
  | { readonly ok: false; readonly error: string };

/** Parse only a single JSON object; markdown fences and prose are deliberately invalid. */
export function parseArbiterDecisionOutput(raw: string): ArbiterDecisionValidation {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return { ok: false, error: "arbiter output is not a single JSON object" }; }
  return validateArbiterDecisionOutput(value);
}

export function validateArbiterDecisionOutput(value: unknown): ArbiterDecisionValidation {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { ok: false, error: "arbiter output must be a JSON object" };
  const record = value as Record<string, unknown>;
  if (record.tier !== "direct" && record.tier !== "reviewed" && record.tier !== "governed") return { ok: false, error: "arbiter tier must be direct, reviewed, or governed" };
  if (typeof record.rationale !== "string" || record.rationale.trim().length === 0 || record.rationale.length > 4_096) return { ok: false, error: "arbiter rationale must be a non-empty bounded string" };
  if (typeof record.category !== "string" || record.category.trim().length === 0 || record.category.length > 256) return { ok: false, error: "arbiter category must be a non-empty bounded string" };
  const blast = record.blast_radius;
  if (typeof blast !== "object" || blast === null || Array.isArray(blast)) return { ok: false, error: "arbiter blast_radius must be an object" };
  const blastRecord = blast as Record<string, unknown>;
  const reversibility = blastRecord.reversibility;
  if (reversibility !== "reversible" && reversibility !== "irreversible" && reversibility !== "unknown") return { ok: false, error: "arbiter blast_radius.reversibility must be reversible, irreversible, or unknown" };
  const writePaths = blastRecord.write_paths;
  if (writePaths !== null && writePaths !== undefined && (!Array.isArray(writePaths) || !writePaths.every((p) => typeof p === "string" && p.length > 0))) return { ok: false, error: "arbiter blast_radius.write_paths must be a string array or null" };
  const commandArgv = blastRecord.command_argv;
  if (commandArgv !== null && commandArgv !== undefined && (!Array.isArray(commandArgv) || !commandArgv.every((argv) => Array.isArray(argv) && argv.length > 0 && argv.every((part) => typeof part === "string" && part.length > 0)))) return { ok: false, error: "arbiter blast_radius.command_argv must be an array of argv arrays or null" };
  return {
    ok: true,
    value: {
      tier: record.tier,
      rationale: record.rationale,
      category: record.category,
      blast_radius: {
        ...(writePaths ? { write_paths: [...writePaths] } : {}),
        ...(commandArgv ? { command_argv: commandArgv.map((argv: string[]) => [...argv]) } : {}),
        reversibility,
      },
    },
  };
}

export const ARBITER_DECISION_CONTRACT: NativeStructuredOutputContract = Object.freeze({
  schema_id: ARBITER_DECISION_SCHEMA_ID,
  validate(value: unknown): NativeStructuredOutputValidation {
    const result = validateArbiterDecisionOutput(value);
    return result.ok ? { valid: true } : { valid: false, reason: result.error };
  },
});

/**
 * A composition root's cheap classifier call. Deliberately narrow compared
 * to `TaskComposerPlannerPort`: one shot, no session/patch machinery, no
 * clarification round trip — the arbiter either answers now or the caller
 * falls back to `governed`.
 */
export interface ArbiterIntakePort {
  classify(input: { readonly task: string; readonly evidence_ids: readonly string[]; readonly signal?: AbortSignal }): Promise<{
    readonly raw_decision: string;
    readonly session_id: string | null;
    readonly model_identity: string | null;
    readonly usage: TokenUsageResult;
  }>;
}

/**
 * E-2 (arXiv 2607.13034, manifest item E3) turn-budget heuristic: a cheap,
 * scope-proportional starting estimate for the specialist's max-turns
 * ceiling. `governed`'s value is a literal, not an import of the
 * connector's own default (`claude-code-campaign.ts`'s
 * `SPECIALIST_MAX_TURNS_DEFAULT`) -- this classification module has no
 * dependency on any specific connector's turn-cap policy. If the connector
 * default ever changes, update both constants together.
 */
export const DIRECT_TURN_BUDGET_ESTIMATE = 12;
export const REVIEWED_TURN_BUDGET_ESTIMATE = 16;
export const GOVERNED_TURN_BUDGET_ESTIMATE = 32;

export function turnBudgetEstimateForTier(tier: GovernanceTier): number {
  return tier === "direct" ? DIRECT_TURN_BUDGET_ESTIMATE : tier === "reviewed" ? REVIEWED_TURN_BUDGET_ESTIMATE : GOVERNED_TURN_BUDGET_ESTIMATE;
}

/**
 * Preserve an admitted planner's explicit file list in the arbiter record.
 * The arbiter necessarily runs before a governed planner, so it cannot use
 * that list to choose the initial tier. Once the plan exists, however, its
 * typed `high_risk_tool_scope.write_paths` is stronger evidence than text
 * mining and should become part of the durable blast-radius projection. This
 * does not grant any new runtime authority: execution still reads the action
 * declarations themselves. It only keeps the decision and the plan from
 * drifting into two incompatible scope narratives.
 */
export function incorporatePlannerWritePaths(
  decision: ArbiterDecision,
  actions: readonly Pick<Action, "high_risk_tool_scope">[],
): ArbiterDecision {
  const plannerPaths = actions.flatMap((action) => action.high_risk_tool_scope?.write_paths ?? []);
  if (plannerPaths.length === 0) return decision;
  const merged = [...new Set([...(decision.blast_radius.write_paths ?? []), ...plannerPaths])];
  if (merged.length === (decision.blast_radius.write_paths?.length ?? 0)) return decision;
  return {
    ...decision,
    blast_radius: { ...decision.blast_radius, write_paths: merged },
    rationale: `${decision.rationale}; planner-declared write paths recorded in the arbiter scope`,
  };
}

/** Governed fallback used whenever the arbiter is absent, errors, or returns malformed output. */
function governedFallback(reason: string, source: ArbiterDecision["source"] = "arbiter"): ArbiterDecision {
  return {
    tier: "governed",
    rationale: reason,
    blast_radius: { reversibility: "unknown" },
    source,
    decided_at: new Date().toISOString(),
    turn_budget_estimate: GOVERNED_TURN_BUDGET_ESTIMATE,
  };
}

/**
 * A real, deterministic, zero-cost `ArbiterIntakePort`: cheap repo/task-text
 * signals only, no model call. This is option (b) from ADR-062's brief
 * ("heuristics + LLM only when ambiguous") taken to its cheapest extreme —
 * the LLM-escalation-when-ambiguous half is a deliberate, disclosed scope
 * cut (see the ADR); `ArbiterIntakePort` is the seam a later composition
 * root can point at a real single-turn structured-output call instead,
 * without touching any caller of `classifyGovernanceTier`.
 *
 * Signal design (conservative — false "direct" is the only unsafe error
 * class, so risk keywords always win):
 *   - Any risk/irreversibility keyword anywhere in the task text ->
 *     `governed`. This is the fail-safe default class.
 *   - A short (<= 24 word), narrow-verb task ("fix", "rename", "typo",
 *     "add test", "update", "correct") with no risk keyword -> `direct`.
 *   - Everything else -> `reviewed`: a single action still gets a real
 *     critic gate, without paying for multi-action decomposition.
 */
const RISK_KEYWORDS = [
  "delete", "drop table", "drop database", "rm -rf", "force push", "--force",
  "production", "prod ", "deploy", "migrate", "migration", "credential",
  "secret", "payment", "billing", "security", "auth", "permission",
  "irreversible", "destroy", "wipe", "revoke", "rotate key",
] as const;
const NARROW_VERBS = ["fix", "repair", "rename", "typo", "add test", "update comment", "correct", "adjust", "small"] as const;
/** Verbs that imply the task must WRITE something to succeed. */
const MUTATING_VERBS = ["fix", "repair", "add", "write", "update", "rename", "correct", "adjust", "change", "implement", "refactor", "create", "apply", "make", "improve", "ensure", "build", "replace", "remove", "optimize", "simplify", "support", "enable", "disable"] as const;
const READ_ONLY_INTENTS = ["explain", "investigate", "inspect", "review", "audit", "analyze", "analyse", "summarize", "summarise", "find", "list", "show", "compare", "research", "report"] as const;

/**
 * The single source of truth for `Action.mutating` classification, reused by
 * both this module's own heuristic tier classifier (below, over the whole
 * task text) and `task-composer.ts`'s per-action classification at plan-
 * materialization time (over each action's own `description`). Conservative
 * by design: text that names no clear read-only intent is presumed
 * mutating, so the only unsafe error class (a mutating action wrongly
 * classified read-only, which would skip the composer's scope requirement)
 * cannot happen from an absent keyword.
 */
export function classifyActionMutation(text: string): "read_only" | "mutating" {
  const lower = text.toLowerCase();
  const explicitlyReadOnly = READ_ONLY_INTENTS.some((verb) => lower.includes(verb));
  const isMutating = MUTATING_VERBS.some((verb) => lower.includes(verb)) || !explicitlyReadOnly;
  return isMutating ? "mutating" : "read_only";
}

/**
 * Derive concrete write/command authority from paths and commands the task
 * text itself names. An action with no `high_risk_tool_scope` dispatches
 * read-only (the executor contract), so a `direct`/`reviewed` tier without
 * derived authority can only produce reports — observed live in the first
 * arbiter bench run, where all three tasks were classified `reviewed`,
 * granted no scope, and the specialists correctly refused to edit anything.
 * Only authority the operator literally wrote into the task is granted;
 * nothing is inferred.
 */
function extractPathMentions(task: string): string[] {
  const paths: string[] = [];
  // Path-like tokens: contain a slash and an extension, e.g. test/decorator.test.js
  for (const match of task.matchAll(/(?<![\w.])((?:[\w.\-\[\]]+\/)+[\w.\-\[\]]+\.\w{1,8})(?![\w/])/g)) {
    if (!paths.includes(match[1]!)) paths.push(match[1]!);
  }
  // ab3 bench T6: a task naming a bare repo-root file ("add a script to
  // package.json") derived no write authority because the path regex
  // requires a slash. Bare names are admitted only for data/doc extensions
  // that cannot be confused with code identifiers or method calls
  // ("fastify.decorate()" must never match), and never when followed by "(".
  for (const match of task.matchAll(/(?<![\w./-])([\w-]+(?:\.[\w-]+)*\.(?:json|jsonc|md|ya?ml|toml|txt|cfg|ini|lock|env))(?![\w/(])/gi)) {
    if (!paths.includes(match[1]!)) paths.push(match[1]!);
  }
  return paths;
}

/**
 * Return the operator's closed write allowlist when they use an explicit
 * "create/edit/modify/write/change exactly ..." clause. Paths elsewhere in
 * the request can be read-only fixtures, validation inputs, or explicit
 * exclusions; treating every mention as writable defeats the word
 * "exactly" and was observed granting authority over an acceptance test.
 */
export function extractExactWritePaths(task: string): string[] {
  const paths: string[] = [];
  // A period cannot delimit this clause because every filename contains
  // one; use the operator's semicolon/newline boundary instead.
  const EXACT_WRITE_CLAUSE = /\b(?:create|edit|modify|write|change)\s+exactly\b([^;\n]*)(?:;|\n|$)/gi;
  for (const match of task.matchAll(EXACT_WRITE_CLAUSE)) {
    // Inside an explicit exact-write clause, bare code filenames are
    // unambiguous authority declarations too (`index.html`, `app.js`). The
    // `(?![\w/(])` guard still excludes method calls such as `api.render()`.
    for (const pathMatch of match[1]!.matchAll(/(?<![\w./-])([\w-]+(?:\.[\w-]+)*\.[A-Za-z0-9]{1,8})(?![\w/(])/g)) {
      if (!paths.includes(pathMatch[1]!)) paths.push(pathMatch[1]!);
    }
  }
  return paths;
}

export function extractDeclaredScope(task: string): { write_paths: string[]; command_argv: string[][] } {
  const exactWritePaths = extractExactWritePaths(task);
  const write_paths = exactWritePaths.length > 0 ? exactWritePaths : extractPathMentions(task);
  const command_argv: string[][] = [];
  // Commands the operator spelled out. This is a LAST-RESORT text-mining
  // fallback -- the primary, structured source of command authority is
  // `Action.high_risk_tool_scope.command_argv` (typed, planner/operator
  // authored; see manager.ts's `deriveNativeHighRiskToolScope`, which only
  // calls into this function when that structured field is absent). Prose
  // is inherently open-ended, so the phrase list below is broadened on a
  // best-effort basis, not exhaustively: "running:"/"run:", "verify"/
  // "verify by running:"/"verify with:"/"verify using:", "check"/"check
  // with:", "to verify run", "build with:", "test with:" -- colon- or
  // space-separated, backticked or bare.
  const CMD_TOKEN = "(?:node|npm|npx|bun|bunx|yarn|pnpm|make|cargo|go|pytest|python3?)";
  const VERIFY_COMMAND_RE = new RegExp(
    "(?:verify(?:\\s+by\\s+running|\\s+with|\\s+using)?|run(?:ning)?|check(?:\\s+with)?|to\\s+verify\\s+run|build\\s+with|test\\s+with)[:\\s]+`?(" +
      CMD_TOKEN + "\\s[^`\\n]*(?:\\n\\s*`?" + CMD_TOKEN + "\\s[^`\\n]*)*)",
    "gi",
  );
  for (const match of task.matchAll(VERIFY_COMMAND_RE)) {
    // A declared verification step is sometimes a COMPOUND command
    // ("A && B", "A ; B", "A || B", or one command per line): each
    // sub-command names an independently authorized invocation, so it
    // becomes its own argv -- never one argv containing a shell operator,
    // which the native tool host's exact argv match could never satisfy.
    for (const part of match[1]!.split(/\s*(?:&&|\|\||;)\s*|\n+/)) {
      // A sentence-ending period (dot followed by whitespace) ends the
      // command: file extensions never precede a space, but task prose
      // after the command does ("… test/decorator.test.js. Verify by
      // running: …"), and capturing it produced a garbage argv.
      const cleaned = part.split(/\.\s/)[0]!.trim().replace(/[.;,]$/, "");
      if (!cleaned) continue;
      const argv = cleaned.split(/\s+/);
      if (!command_argv.some((existing) => existing.join(" ") === argv.join(" "))) command_argv.push(argv);
    }
  }
  return { write_paths, command_argv };
}

/** Matches a mined write_path that names a test file: a `test`/`tests` directory segment, or a `.test.`/`.spec.` filename marker. */
const TEST_PATH_PATTERN = /(^|\/)tests?\//i;
const TEST_FILENAME_PATTERN = /\.(test|spec)\.[^./]+$/i;
function looksLikeTestPath(path: string): boolean {
  return TEST_PATH_PATTERN.test(path) || TEST_FILENAME_PATTERN.test(path);
}

/** Y-2 bound: at most this many structurally-derived paths are appended to a mined scope in total, across every test-file seed. */
export const STRUCTURAL_SCOPE_WIDENING_MAX_ADDED = 8;

export interface HeuristicArbiterIntakePortOptions {
  /**
   * Y-2 (least-privilege #3, MiniScope): a best-effort resolver from a path
   * to its direct non-test import paths (e.g. `RepositoryGraphIndex`-backed,
   * supplied by the composition root). Invoked only for mined write_paths
   * that look like a test file -- ab3 bench T2's root cause was a mined
   * scope naming only `test/throw.test.js` while the real fix lived in
   * `lib/`. Absent, throwing, or returning nothing -> no widening (silent):
   * this can only ADD write authority, never remove it, so a resolver
   * failure is never a safety regression, only a missed opportunity.
   */
  readonly structural_paths?: (path: string) => readonly string[];
}

/**
 * Append each test-file seed's direct non-test imports (from `resolver`) to
 * `writePaths`, deduped, bounded to `STRUCTURAL_SCOPE_WIDENING_MAX_ADDED`
 * total additions across the whole call. `extractDeclaredScope` stays pure
 * (text-mining only); this is the separate, optional widening step the
 * composition root opts into by supplying a resolver.
 */
function widenMinedScopeForTestFiles(writePaths: readonly string[], resolver?: (path: string) => readonly string[]): string[] {
  const widened = [...writePaths];
  if (!resolver) return widened;
  for (const path of writePaths) {
    if (widened.length - writePaths.length >= STRUCTURAL_SCOPE_WIDENING_MAX_ADDED) break;
    if (!looksLikeTestPath(path)) continue;
    let imports: readonly string[];
    try { imports = resolver(path); } catch { continue; }
    for (const imported of imports) {
      if (widened.length - writePaths.length >= STRUCTURAL_SCOPE_WIDENING_MAX_ADDED) break;
      if (looksLikeTestPath(imported) || widened.includes(imported)) continue;
      widened.push(imported);
    }
  }
  return widened;
}

export function createHeuristicArbiterIntakePort(options?: HeuristicArbiterIntakePortOptions): ArbiterIntakePort {
  return {
    async classify(input) {
      const text = input.task.toLowerCase();
      const wordCount = input.task.trim().split(/\s+/).filter(Boolean).length;
      const hasRisk = RISK_KEYWORDS.some((keyword) => text.includes(keyword));
      const hasNarrowVerb = NARROW_VERBS.some((verb) => text.includes(verb));
      // Ordinary editing language is open-ended. Treat a request as mutating
      // unless it clearly asks only for observation; this avoids granting a
      // scope-less reviewed dispatch merely because a user's verb was absent
      // from a brittle vocabulary list.
      const isMutating = classifyActionMutation(input.task) === "mutating";
      const minedScope = extractDeclaredScope(input.task);
      const scope = { ...minedScope, write_paths: widenMinedScopeForTestFiles(minedScope.write_paths, options?.structural_paths) };
      let tier: GovernanceTier;
      let rationale: string;
      if (hasRisk) {
        tier = "governed";
        rationale = "heuristic arbiter: task text names a risk/irreversibility keyword; defaulting to the full governed path";
      } else if (isMutating && scope.write_paths.length === 0) {
        // A mutating task whose text names no concrete file leaves the
        // heuristic with no authority to grant; only the governed planner
        // can author a write scope. Escalate rather than dispatch a
        // specialist that will be read-only by construction.
        tier = "governed";
        rationale = "heuristic arbiter: task implies edits but names no concrete file path, so write authority cannot be derived from the text; the governed planner must author the scope";
      } else if (wordCount <= 24 && hasNarrowVerb) {
        tier = "direct";
        rationale = `heuristic arbiter: short (${wordCount}-word), narrow-verb task with no risk keyword; a single specialist dispatch suffices`;
      } else {
        tier = "reviewed";
        rationale = "heuristic arbiter: task is neither clearly narrow nor clearly risky; a single reviewed action balances cost and safety";
      }
      const decision: ArbiterDecisionOutput = {
        tier,
        rationale,
        category: hasRisk ? "high-risk" : hasNarrowVerb ? "maintenance" : "general",
        blast_radius: {
          reversibility: hasRisk ? "unknown" : "reversible",
          // Only for tiers that will actually dispatch on this scope; the
          // governed planner authors its own.
          ...(tier !== "governed" && isMutating && scope.write_paths.length > 0 ? { write_paths: scope.write_paths } : {}),
          ...(tier !== "governed" && scope.command_argv.length > 0 ? { command_argv: scope.command_argv } : {}),
        },
      };
      return {
        raw_decision: JSON.stringify(decision),
        session_id: null,
        model_identity: null,
        usage: { kind: "unavailable", reason: "heuristic classification performs no model call" },
      };
    },
  };
}

/**
 * Classify a task's governance tier, or fall back to `governed` on any
 * failure to classify (absent port, transport error, or malformed output —
 * ADR-062's honesty requirement: "default remains governed when arbiter
 * errors"). Never throws.
 */
export async function classifyGovernanceTier(
  port: ArbiterIntakePort | null,
  input: { readonly task: string; readonly evidence_ids: readonly string[]; readonly signal?: AbortSignal },
  clock: () => string = () => new Date().toISOString(),
): Promise<{ readonly decision: ArbiterDecision; readonly category: string | null; readonly usage: TokenUsageResult }> {
  if (port === null) {
    return { decision: governedFallback("no arbiter intake port is configured; defaulting to the full governed path"), category: null, usage: { kind: "unavailable", reason: "arbiter intake was not configured for this call" } };
  }
  let result: Awaited<ReturnType<ArbiterIntakePort["classify"]>>;
  try {
    result = await port.classify(input);
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 1_024) : "arbiter intake call failed";
    return { decision: governedFallback(`arbiter intake call failed (${message}); defaulting to the full governed path`), category: null, usage: { kind: "unavailable", reason: "arbiter intake call rejected before producing usage" } };
  }
  const parsed = parseArbiterDecisionOutput(result.raw_decision);
  if (!parsed.ok) {
    return { decision: governedFallback(`arbiter intake output failed validation (${parsed.error}); defaulting to the full governed path`), category: null, usage: result.usage };
  }
  return {
    decision: {
      tier: parsed.value.tier,
      rationale: parsed.value.rationale,
      blast_radius: parsed.value.blast_radius,
      source: "arbiter",
      decided_at: clock(),
      turn_budget_estimate: turnBudgetEstimateForTier(parsed.value.tier),
    },
    category: parsed.value.category,
    usage: result.usage,
  };
}
