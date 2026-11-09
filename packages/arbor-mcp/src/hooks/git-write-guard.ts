/**
 * `veto.git-write-guard` — the native replacement for the deleted
 * `scripts/hooks/git-write-guard.sh`.
 *
 * WHY IT EXISTS. Five subagents ran forbidden `git` writes (stash, reset,
 * checkout --, rebase, commit, add, worktree add) across five briefs that
 * explicitly prohibited them — a ~25% violation rate on a rule that is
 * regex-decidable. A subagent that stashes, resets, or rebases can silently
 * destroy a peer's uncommitted work in a shared checkout.
 *
 * WHY IT ONLY EVALUATES SUBCONTEXT. The shell hook keyed on Claude Code's
 * `agent_id`, documented by the host as present only inside a subagent. The
 * native equivalent is `HookVetoContext.subagent`, fed by the composition
 * site from the repo's own `nodeId.startsWith("subagent-")` discriminator —
 * a fact the executor already holds, rather than one parsed out of an opaque
 * session id. The property the shell hook said it must never trade away is
 * preserved exactly: an orchestrator call is never blocked by this hook.
 *
 * WHAT IT DOES NOT DO. It is not authoritative enforcement. A guard sees one
 * command string, not history or intent, and a `git commit` reached through
 * an indirection this regex does not recognise sails through — the same
 * limitation the shell hook documented, carried over unchanged. The
 * backstop remains the git-write prohibition being restated in every
 * subagent brief and reviewed before integration.
 *
 * KNOWN GAP — the orchestrator sweep branch is not reproduced. The shell
 * hook's second branch refused `git add -A` / `reset --hard` /
 * `checkout -- .` / `clean -f` from the *main thread*, but only while
 * `scripts/lib/tree-holders.sh` reported another agent process holding the
 * same working tree. No native equivalent of that predicate exists: nothing
 * in `packages/` can map a live pid to a working-tree path, so
 * `LiveNativeSessionRegistry` (process-local) and the worktree leases
 * (one per campaign worker, not per editor) cannot answer it, and
 * `scripts/lib/tree-holders.sh` is the only implementation of that predicate.
 * A native re-derivation of the scan is deferred, not forbidden:
 * `gate:package-boundaries` reads IMPORT SPECIFIERS only —
 * `package-boundary-gate.mjs` collects `@arbor/` and relative module
 * specifiers, then checks the non-`@arbor/` ones against `forbidden_source_roots`
 * — and never inspects a spawn argv, so a subprocess route is neither forbidden
 * by the gate nor un-precedented in this package: `cli.ts`,
 * `native-tools/evidence-refresh.ts` and `repo-session-close.ts` each spawn
 * `scripts/`, the last required to by `gate:repo-session-conformance`. What is
 * missing is the predicate, not permission to reach for it. Rather than deny
 * the orchestrator unconditionally — which would wedge the one party that is
 * allowed to
 * commit, the exact failure the shell hook called worse than no hook — this
 * handler reproduces the subagent branch only.
 */
import type { HookVetoDecision, HookVetoHandler } from "./contracts.js";

const COMMAND_CARRYING_TOOLS: ReadonlySet<string> = new Set(["shell.execute", "verification.run"]);

/**
 * A `git` token at a command boundary, optionally preceded by global flags
 * like `-C <dir>`. Anchoring on the `git` token first is what keeps
 * `gitignore` or a package named `add` from matching.
 */
const GIT = String.raw`(?:^|[;&|\s])git(?:\s+(?:-[A-Za-z][A-Za-z-]*|--[A-Za-z-]+)(?:\s+[^ ;&|]+)?)*\s+`;

const FORBIDDEN: readonly Readonly<{ label: string; shape: RegExp }>[] = Object.freeze([
  Object.freeze({ label: "write subcommand (add/commit/stash/reset/rebase)", shape: new RegExp(`${GIT}(?:add|commit|stash|reset|rebase)\\b`) }),
  Object.freeze({ label: "checkout --", shape: new RegExp(`${GIT}checkout(?:\\s+[^ ;&|]+)*\\s+--(?:\\s|$)`) }),
  Object.freeze({ label: "worktree add", shape: new RegExp(`${GIT}worktree\\s+add\\b`) }),
]);

const SUBAGENT_DENIAL = (matched: string): string =>
  `git-write-guard: this command runs a forbidden git write operation (${matched}) from subagent context.

Subagents in this repository never run git writes — add, commit, stash, reset, checkout --, rebase,
or worktree add. The orchestrator is the only party that commits, and a git write from a subagent
in a shared checkout can silently destroy another agent's uncommitted work.

To inspect committed state instead, use:
    git show <rev>:<path>
    git log -p [-- <path>]

If this command genuinely needs a git write, that is an orchestrator action — report back and let
the orchestrator run it, rather than running it from this subagent.`;

export const gitWriteGuard: HookVetoHandler = (context): HookVetoDecision => {
  if (!context.subagent) return { allow: true };
  if (!COMMAND_CARRYING_TOOLS.has(context.tool)) return { allow: true };
  const command = context.tool_input.command;
  if (command.length === 0) return { allow: true };
  const forbidden = FORBIDDEN.find((candidate) => candidate.shape.test(command));
  return forbidden === undefined ? { allow: true } : { allow: false, reason: SUBAGENT_DENIAL(forbidden.label) };
};
