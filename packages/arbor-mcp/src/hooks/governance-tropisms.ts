/**
 * The three SessionStart `inject` handlers that replace the deleted shell
 * orientation hooks, and the single state read they share.
 *
 * These are the weakest of the four hook kinds on purpose: each returns a
 * `Tropism | null`, which the bus validates against the §5.3 lints and
 * renders as bounded prompt text under a `context-only` trust label. None of
 * them can deny a tool call, start or stop a session, or grant authority —
 * which is exactly the property the shell hooks had, and the reason
 * deleting them in favour of these is a like-for-like substitution rather
 * than a weakening.
 *
 * All three are state-derived, never a constant banner. `gate:hook-liveness`
 * exists because hooks here once emitted a confident fixed verdict for
 * dozens of sessions after they stopped measuring anything; a tropism whose
 * `derived_from` does not move is deduped by the bus, so a handler that
 * stopped reading state would go *silent* rather than lie.
 *
 * Deliberate non-duplication, carried over from the shell hooks' own
 * headers: orientation owns the ordering index, isolation owns checkout
 * sharing, and owed-decisions owns the operator's proposed records. None of
 * the three restates another's signal.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Tropism } from "@arbor/prompts";
import { GitAdapter } from "../git-workspace-projection.js";

/** Long enough that a model which ignores the first read still has it in context. */
const ORIENTATION_TTL_TURNS = 3;

export interface GovernedPosture {
  readonly governed_dirty: number;
  readonly dirty: number;
  readonly branch: string | null;
  readonly linked_worktree: boolean;
  readonly evidence_lease: boolean;
  /** Short graph revision when the committed VI graph is not an ancestor of HEAD. */
  readonly diverged_graph_revision: string | null;
}

/**
 * Read the repository's live posture once per injection. Everything comes
 * from the existing `GitAdapter` (structured argv reads, no shell) plus two
 * bounded filesystem reads, so this is the same data the shell hooks read
 * from the same working tree.
 *
 * Throws rather than guessing: a `GitAdapter` failure means the caller's
 * handler turns it into `null`, which is the shell hooks' `quiet` path — an
 * orientation block that cannot be measured is not one worth injecting.
 *
 * The evidence lease is read from the *common* git dir rather than
 * `<root>/.git`, because in a linked worktree `.git` is a file. A worktree
 * session must see the lease the main checkout's rebind took.
 */
export function readGovernedPosture(root: string): GovernedPosture {
  const git = new GitAdapter(root);
  const status = git.status();
  const changes = status.changes.map((change) => change.path);
  const graphRevision = committedGraphRevision(root);
  return Object.freeze({
    governed_dirty: changes.filter((path) => path.startsWith("packages/") || path.startsWith("decisions/")).length,
    dirty: changes.length,
    branch: status.branch,
    linked_worktree: git.common_dir !== join(git.repository_root, ".git"),
    evidence_lease: existsSync(join(git.common_dir, "arbor", "evidence-refresh", "lock")),
    diverged_graph_revision: graphRevision === null || git.run(["-C", root, "merge-base", "--is-ancestor", graphRevision, "HEAD"]).ok
      ? null
      : graphRevision.slice(0, 12),
  });
}

function committedGraphRevision(root: string): string | null {
  const manifest = join(root, ".visual-intelligence", "manifest.json");
  if (!existsSync(manifest)) return null;
  const parsed: unknown = JSON.parse(readFileSync(manifest, "utf8"));
  if (typeof parsed !== "object" || parsed === null) return null;
  const revision = (parsed as Record<string, unknown>).repo_revision;
  return typeof revision === "string" && revision.trim() !== "" ? revision : null;
}

/**
 * The ordering index plus live posture. Plain commit distance from the graph
 * is deliberately not reported: the healthy state directly after a rebind is
 * already graph=N, HEAD=N+1, so reporting distance cries wolf against a fully
 * green battery on every correctly finished cycle. Divergence (a reworded or
 * rebased history) is the condition with no partial repair, so only that is
 * named.
 */
export function governanceOrientTropism(root: string): Tropism | null {
  const posture = readGovernedPosture(root);
  const notes: string[] = [];
  if (posture.governed_dirty > 0) {
    notes.push(`${posture.governed_dirty} uncommitted path(s) under packages/ or decisions/. Commits are deferred to the session close (ADR-160): \`arbor repo-session open\`, commit by concern with the \`ADR: NNN\` trailer, then \`arbor repo-session close\`.`);
  }
  if (posture.evidence_lease) {
    notes.push("an evidence transaction lease is present. While it is LIVE, the gates that read derived evidence fail meaning 'wait', not 'broken'. Status: `bun run evidence:status`; an orphaned lease is recovered with `bun run evidence:recover`, never by deleting the lock by hand.");
  }
  if (posture.diverged_graph_revision !== null) {
    notes.push(`the committed VI graph names revision ${posture.diverged_graph_revision}, which is NOT an ancestor of HEAD — a commit was reworded, amended, or rebased after the graph was bound. Only a full \`bun run evidence:rebind\` repairs this; there is no partial repair.`);
  }
  if (posture.branch !== null && ["master", "main"].includes(posture.branch)) {
    notes.push(`HEAD is on ${posture.branch} (trunk). Branch before committing code; \`evidence:rebind\` requires committed inputs, so trunk commits happen sooner here than expected.`);
  } else if (posture.branch !== null) {
    notes.push(`HEAD is on branch ${posture.branch} (trunk is master; prefer merge over rebase when integrating).`);
  }

  const body = [
    "revoy2 governance orientation — `.claude/skills/revoy2-governance/SKILL.md` is the ordering index: the chains for a source change, decision authoring, supersession, file moves, and pre-push, plus the commit and waiver conventions and the hard invariants. `revoy2-procedure` remains the action-time authority.",
    "Three invariants that are expensive to relearn: never self-accept a decision or write the interview ledger for the operator; never hand-run the four evidence store scripts (route through `evidence:rebind`, which enforces graph-before-stores); `accepted->rejected` is invalid — an accepted decision is superseded, which requires a successor record and an interview.",
    `Repository posture right now:\n${notes.map((note) => `  - ${note}`).join("\n")}`,
  ].join("\n\n");
  return tropism("governance-orient", body, posture);
}

/**
 * Whether this checkout is shared, and what is already in it. OBSERVE-only:
 * the gate that actually refuses the damaging act is
 * `scripts/evidence-rebind.mjs`'s own isolation check, and a warning nobody
 * is obliged to act on is how two sessions once shared this checkout for six
 * hours. This reports; it never denies.
 *
 * KNOWN GAP — the peer-holder signal is not reproduced. The shell hook's
 * first signal was `scripts/lib/tree-holders.sh`, which scans the process
 * table for another `claude` process whose resolved cwd is this tree. Nothing
 * in `packages/` can answer that: `LiveNativeSessionRegistry` is
 * process-local by design and the worktree leases are one per campaign
 * worker, not per editor, so neither can report an unrelated editor. The
 * remaining two signals are reproduced exactly.
 */
export function sessionIsolationTropism(root: string): Tropism | null {
  const posture = readGovernedPosture(root);
  const notes: string[] = [];
  if (posture.dirty > 0) {
    notes.push(`the tree already has ${posture.dirty} uncommitted path(s) — none of them yours yet. Their owner is unknown to you: establish whose they are before committing or reverting anything, and stage explicit paths rather than \`git add -A\`.`);
  }
  if (posture.linked_worktree) {
    notes.push(`this session is in a linked worktree on ${posture.branch ?? "a detached head"} — isolated from the shared checkout, which is the safe place to be. Commits land here, then the branch is fast-forwarded from the main checkout.`);
  } else if (posture.branch !== null && ["master", "main"].includes(posture.branch)) {
    notes.push(`this session is on ${posture.branch} in the shared checkout. Branch before committing code.`);
  }
  if (notes.length === 0) return null;
  return tropism("session-isolation", `Session isolation:\n${notes.map((note) => `  - ${note}`).join("\n")}`, posture);
}

export interface ProposedRecord {
  readonly id: string;
  readonly title: string;
  readonly age_days: number | null;
}

/**
 * Every Proposed or Draft ADR, with its age, plus the remedy. This replaces
 * the shell hook's silent grace period for proposed records: they are
 * surfaced from day 0 so the operator green/redlights them definitively
 * rather than letting them linger. `gate:adr-decision-followthrough` supplies
 * the teeth once a decision is recorded.
 *
 * The status line is read the same way the shell hook read it — a grep for
 * the first `**Status:**` line — rather than through the full record parser,
 * because this runs on every session start and a parse failure on one
 * malformed file must not cost the other 166 rows their reminder.
 */
export function proposedRecords(root: string, today: Date): readonly ProposedRecord[] {
  const decisions = join(root, "decisions");
  if (!existsSync(decisions)) return [];
  const records: ProposedRecord[] = [];
  for (const name of readdirSync(decisions).sort()) {
    if (!name.startsWith("ADR-") || !name.endsWith(".md")) continue;
    const text = readFileSync(join(decisions, name), "utf8");
    const state = firstField(text, "Status")?.toLowerCase();
    if (state !== "proposed" && state !== "draft") continue;
    const date = firstField(text, "Date");
    records.push(Object.freeze({
      id: name.match(/^ADR-[0-9]+/)?.[0] ?? name.replace(/\.md$/, ""),
      title: text.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? name,
      age_days: date === null ? null : daysSince(date, today),
    }));
  }
  return Object.freeze(records);
}

export function owedDecisionsTropism(root: string, today: Date = new Date()): Tropism | null {
  const records = proposedRecords(root, today);
  if (records.length === 0) return null;
  const rows = records.map((record) => `  - ${record.id}${record.age_days === null ? "" : ` (${record.age_days}d old)`}: ${record.title}`);
  const body = [
    `repository ADR queue — ${records.length} proposed ADR(s) awaiting a definitive green/redlight:`,
    rows.join("\n"),
    "Each needs a definitive operator decision: greenlight (accept) or redlight (reject/supersede). Ask it through the host's native question tool and record it (ADR-178): `bun run interview:pack` → AskUserQuestion, or `arbor interview` → `bun run interview:record`. A recorded 'accept' is carried through to Status: Accepted, or `gate:adr-decision-followthrough` re-flags it.",
  ].join("\n\n");
  return tropism("owed-decisions", body, records);
}

function firstField(text: string, field: string): string | null {
  const match = text.match(new RegExp(`^\\*\\*${field}:\\*\\*\\s*(.+)$`, "m"));
  return match?.[1]?.trim() ?? null;
}

function daysSince(isoDate: string, today: Date): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) return null;
  const then = Date.parse(`${isoDate}T00:00:00Z`);
  return Number.isNaN(then) ? null : Math.floor((today.getTime() - then) / 86_400_000);
}

/**
 * `derived_from` is a hash of the exact state this body is a function of, so
 * the bus's §5.3 rule-2 dedupe suppresses a re-render when nothing moved
 * without any of these handlers having to know about the rule.
 */
function tropism(id: string, body: string, derivation: unknown): Tropism {
  return Object.freeze({
    id, trigger: "session_start", lane: "ADVISORY", provenance: "generated",
    derived_from: Object.freeze([`posture:${createHash("sha256").update(JSON.stringify(derivation)).digest("hex").slice(0, 16)}`]),
    body, expires_after_turns: ORIENTATION_TTL_TURNS, enforcing_ref: null,
  });
}

/**
 * The root these handlers read. The native executor runs in the session's
 * working directory, which is the same fact the shell hooks took from their
 * `cwd` payload field; the exported factories above take it as an argument
 * so a test can point them at a fixture.
 */
export const currentGovernedRoot = (): string => process.cwd();
