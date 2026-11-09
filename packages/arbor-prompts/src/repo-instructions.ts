import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * ADR-022 (G-10): checked-in repo instructions are a read-only,
 * filesystem-sourced context scope resolved at prompt-composition time —
 * never a ledger-witnessed `MemoryFact`. `AGENTS.md`/`CLAUDE.md` content is
 * operator-authored configuration with its own provenance (the repo's git
 * history), not campaign-produced evidence, so it never touches
 * `EvidenceLedger` and is never assigned a `record_id`/`content_hash`.
 *
 * Resolution convention mirrors the field-study harnesses (opencode/Codex
 * read `AGENTS.md`; Claude Code reads `CLAUDE.md`) so a repo's existing
 * files work unmodified: both are checked for, in that precedence order,
 * at exactly the node's worktree root — never above it (a Seed's worktree
 * is the isolation boundary ADR-001 already draws; instruction resolution
 * must not cross it).
 */
export const REPO_INSTRUCTIONS_FILENAMES = ["AGENTS.md", "CLAUDE.md"] as const;

/**
 * Byte budget for the composed repo-instructions section, mirroring Phase
 * 6.4's context-economy discipline for memory injection — a large
 * `AGENTS.md` cannot silently blow the token budget for every dispatch.
 */
export const REPO_INSTRUCTIONS_BYTE_BUDGET = 8_000;

export interface RepoInstructionsScope {
  /** Absolute paths of files that contributed content, in precedence order. Empty when neither file exists. */
  source_paths: readonly string[];
  /** Composed, labeled, budget-truncated content. Empty string when no source file exists. */
  content: string;
  /** Whether the byte budget forced truncation. */
  truncated: boolean;
}

const EMPTY_SCOPE: RepoInstructionsScope = { source_paths: [], content: "", truncated: false };

/**
 * Resolves the `AGENTS.md`/`CLAUDE.md` repo-instructions scope for a single
 * worktree root. Pure and deterministic for a fixed worktree state; absence
 * of either file is a no-op, not an error. Never walks parent directories.
 */
export function resolveRepoInstructions(
  worktreePath: string,
  byteBudget: number = REPO_INSTRUCTIONS_BYTE_BUDGET,
): RepoInstructionsScope {
  if (!worktreePath || !worktreePath.trim()) return EMPTY_SCOPE;
  if (!Number.isSafeInteger(byteBudget) || byteBudget <= 0) throw new Error("byteBudget must be a positive integer");
  const root = resolve(worktreePath);

  const sections: { path: string; label: string; text: string }[] = [];
  for (const filename of REPO_INSTRUCTIONS_FILENAMES) {
    const candidate = join(root, filename);
    if (!existsSync(candidate) || !statSync(candidate).isFile()) continue;
    sections.push({ path: candidate, label: filename, text: readFileSync(candidate, "utf-8") });
  }
  if (sections.length === 0) return EMPTY_SCOPE;

  let budget = byteBudget;
  let truncated = false;
  const parts: string[] = [];
  const sourcePaths: string[] = [];
  for (const section of sections) {
    const header = `--- ${section.label} ---\n`;
    const headerBytes = Buffer.byteLength(header, "utf-8");
    if (budget <= headerBytes) {
      truncated = true;
      break;
    }
    sourcePaths.push(section.path);
    budget -= headerBytes;
    const bodyBytes = Buffer.byteLength(section.text, "utf-8");
    if (bodyBytes > budget) {
      parts.push(header + truncateToByteBudget(section.text, budget));
      truncated = true;
      budget = 0;
      break;
    }
    parts.push(header + section.text);
    budget -= bodyBytes;
  }
  return { source_paths: sourcePaths, content: parts.join("\n"), truncated };
}

function truncateToByteBudget(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, "utf-8");
  return `${buf.subarray(0, maxBytes).toString("utf-8")}\n[repo instructions truncated at ${maxBytes} bytes]`;
}
