/**
 * decomposition-prompt.ts — the prompt Cambium is dispatched with when an
 * action in the tree is too large for a single specialist to finish.
 *
 * WHY THIS EXISTS. Real campaigns against GLM-5.2 never verified a node.
 * The model, the KB loop, the halt condition, and the dispatch timeout (120s
 * -> 900s) were all eliminated as causes. What remained: the demo's candidate
 * actions were epics ("Bring repo-wide branch coverage to >=85%", "C2 true
 * decoupling: separate opencode run driver + arbor tui observer") seeded as
 * LEAF actions. A specialist given 900 seconds still timed out, because
 * nothing was left for the tree search to decompose — every leaf was already
 * too big to finish. This prompt is Cambium's decomposition pass: it turns
 * one over-large action into a small set of children a single specialist can
 * actually finish and have verified in one dispatch.
 *
 * The caller (packages/arbor-mcp/src/opencode-decomposer.ts) validates and
 * bounds whatever comes back (fanout 2..6, depth bound, shape checks, rejects
 * children identical to the parent) — this prompt's job is to make the MODEL
 * produce genuinely useful output before any of that runs, not to encode the
 * bounds itself.
 */

/**
 * Structural shape of the parent action being decomposed. Deliberately NOT
 * `@arbor/core`'s `Action` type: this package has zero dependencies today
 * (see package.json) and every caller's real `Action` already satisfies this
 * shape structurally, so importing `@arbor/core` here would add a dependency
 * this prompt does not otherwise need.
 */
export interface DecompositionPromptAction {
  readonly description: string;
  readonly estimated_gain: number;
  readonly estimated_cost: number;
  readonly category: string;
  readonly delegate_to: string;
  readonly constraints?: readonly string[];
}

/** Why this action is being decomposed — mirrors `DecompositionRequest.reason`. */
export type DecompositionReason = "timeout" | "operator";

export interface DecompositionPromptContext {
  readonly reason: DecompositionReason;
  readonly depth: number;
}

function reasonLine(reason: DecompositionReason): string {
  return reason === "timeout"
    ? "A specialist was dispatched against this exact action and ran for its full time budget without finishing. That is the signal, not a fluke: the action itself is too large for one dispatch."
    : "An operator has flagged this action as too large and asked for it to be broken down before dispatch.";
}

function constraintsBlock(action: DecompositionPromptAction): string {
  if (!action.constraints || action.constraints.length === 0) return "";
  return `\nParent constraints (MUST DO / MUST NOT DO — every child inherits these unless a child narrows them further):\n${action.constraints.map((c) => `- ${c}`).join("\n")}`;
}

/**
 * Build the decomposition task prompt for a single parent action. Callers
 * prepend `AGENT_PROMPTS.cambium()` (Cambium's identity block) so the model
 * knows it is Cambium, then send this as the task body.
 */
export function cambiumDecompositionPrompt(action: DecompositionPromptAction, ctx: DecompositionPromptContext): string {
  return `DECOMPOSITION TASK (depth ${ctx.depth}).

${reasonLine(ctx.reason)}

Parent action:
- description: ${action.description}
- category: ${action.category}
- delegate_to: ${action.delegate_to}
- estimated_gain: ${action.estimated_gain}
- estimated_cost: ${action.estimated_cost}${constraintsBlock(action)}

Your job is to split this ONE action into 2 to 6 child actions. Every child must pass ALL of these:

1. INDEPENDENTLY COMPLETABLE. A single specialist, dispatched with only that child's description and constraints, can finish it in one dispatch. Do not write "step 1 of 5" children where step 2 cannot even start until step 1 lands — if the parent's work is genuinely sequential, still make each child a complete, mergeable unit of work in its own right, not a fragment.

2. INDEPENDENTLY VERIFIABLE. This repository promotes provenance to \`!verified\` only when a real command exits 0 in the worktree — a test run, a build, a lint pass, a targeted grep/diff check. A child no command can check can never verify, so it can never be trusted. Every child's description must make the verifying command obvious (name the test file, the package, the build target — do not leave it to be inferred).

3. CONCRETE, NOT ASPIRATIONAL. "Improve coverage" or "make X more robust" is banned. Name the exact file, function, module, or test to add or change. "Add tests for packages/arbor-kb/src/sqlite.ts's error paths" is a valid child; "improve arbor-kb reliability" is not.

4. COVERS THE PARENT WITHOUT INVENTING SCOPE. Together, the children should account for what the parent action described — no more, no less. Do not add goals, files, or behavior the parent never asked for, and do not silently drop part of the parent's intent.

5. delegate_to and category should normally match the parent's, since the parent's specialist assignment was presumably already correct for this class of work — change a child's delegate_to only when that specific child's nature clearly calls for a different specialist (e.g. a research/discovery sub-step going to a research agent instead of a code-writing one).

6. estimated_gain and estimated_cost should be a plausible partition of the parent's — each child's estimated_cost should be small enough to plausibly finish in one bounded dispatch, and the children's estimated_gain should not sum to more than the parent's.

If, on reflection, this action is already minimal and cannot be honestly split into 2+ independently-verifiable children, output an empty JSON array (\`[]\`) rather than inventing filler children to hit a count. An honest "cannot decompose" is worth more than manufactured busywork.

OUTPUT FORMAT — read this carefully, it will be parsed by a machine, not a human:

Respond with ONLY a raw JSON array. No prose before or after it. No markdown code fences. No explanation. The array's elements must each be an object with exactly these fields:

[
  {
    "description": "<concrete, verifiable task description>",
    "estimated_gain": <number>,
    "estimated_cost": <number>,
    "category": "<category string>",
    "delegate_to": "<agent name>",
    "constraints": ["<optional MUST DO / MUST NOT DO strings>"]
  }
]

"constraints" may be omitted if there are none. Nothing else may appear in your response.`;
}
