/**
 * DecomposerPort implementation: turns one over-large Action into a small set
 * of children a single specialist can finish and have verified in one
 * dispatch. See packages/arbor-prompts/src/decomposition-prompt.ts for the
 * WHY and the actual scope-bounding design.
 *
 * TRANSPORT + PARSING STRATEGY. This repository already has two proven
 * "get structured data out of a model" strategies:
 *   - opencode-server-executor.ts's critic path: `opencode serve` over HTTP
 *     with `format: {type:"json_schema", schema}`, read off `info.structured`
 *     (server-validated).
 *   - opencode-executor.ts's critic path (`parseCriticVerdict`): shell out to
 *     `opencode run`, scrape the first `{`..last `}` out of stdout, `JSON.parse`.
 *
 * This module reuses the SECOND strategy (subprocess + scrape), extended from
 * a single JSON object to a top-level JSON array, for one concrete reason:
 * every low-level primitive the subprocess path needs (`runOpenCode`,
 * `buildOpenCodeArgs`, `classifyOpenCodeError`, `resolveConfiguredModel`,
 * `stripAnsi`, `rawResponseHash`) is already exported from
 * opencode-executor.ts and reusable as-is. The HTTP-server path's spawn/
 * session/postJson plumbing that the critic verdict route depends on is
 * NOT exported from opencode-server-executor.ts (private to that module,
 * which this lane's file-ownership boundary does not allow modifying to
 * export it) — reusing it here would mean either editing that file (out of
 * scope) or re-deriving a second copy of server lifecycle management, which
 * is a materially bigger duplication than reusing five already-exported pure
 * functions. This is "follow whichever is already proven" applied to what is
 * actually reachable without violating the ownership split between the two
 * concurrent lanes.
 *
 * PARSE DEFENSIVELY (see parseDecompositionResponse below): prose with no
 * brackets, a truncated array, a single object instead of an array, or an
 * array whose elements don't structurally match an Action all resolve to
 * `{ ok: false, reason }` — never a fabricated child. An unparseable response
 * is a typed absence, not a default.
 */
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Action } from "@arbor/core";
import { AGENT_PROMPTS, cambiumDecompositionPrompt, type DecompositionReason } from "@arbor/prompts";
import {
  runOpenCode,
  buildOpenCodeArgs,
  classifyOpenCodeError,
  resolveConfiguredModel,
  stripAnsi,
  rawResponseHash,
  DEFAULT_CRITIC_MODEL,
} from "./opencode-executor.js";

// ============================================================
// CONTRACT — mirrors the DecomposerPort shape Lane A is landing in
// @arbor/core/src/types.ts (packages/arbor-core/src/types.ts, alongside
// `Action` at ~line 228) as part of this same migration. Declared locally,
// not imported, because that file is out of this lane's ownership until Lane
// A lands it; field names and shapes here are verified against the exact
// contract text this lane was briefed with. Once arbor-core exports these,
// replace this block with `import type {...} from "@arbor/core"` — no other
// change in this file should be required, since every field name already
// matches.
// ============================================================

export interface DecompositionRequest {
  readonly campaign_id: string;
  readonly node_id: string;
  readonly action: Action;
  readonly reason: DecompositionReason;
  readonly depth: number;
  readonly signal?: AbortSignal;
}

export type DecompositionResult =
  | { readonly ok: true; readonly children: readonly Action[] }
  | { readonly ok: false; readonly reason: string };

export interface DecomposerPort {
  decompose(request: DecompositionRequest): Promise<DecompositionResult>;
}

// ============================================================
// MODEL DEFAULT — decomposition is a judgment call over a short, bounded
// prompt (like Lenticel's critic verdict), not a code-writing dispatch, so it
// defaults to the critic model rather than the specialist model.
// ============================================================
export const DEFAULT_DECOMPOSER_MODEL = DEFAULT_CRITIC_MODEL;

export interface OpenCodeDecomposerOptions {
  /** Decomposer model. Explicit value wins; otherwise resolves `arbor.jsonc`'s `agents.cambium.model`, falling back to DEFAULT_DECOMPOSER_MODEL. */
  model?: string;
  /** Path to the opencode binary. Default "opencode". */
  opencodeBin?: string;
  /** Per-call timeout in ms. Default 120_000. */
  timeoutMs?: number;
  /** Directory `arbor.jsonc` is read from for `agents.cambium.model`. Default `process.cwd()`. */
  configDir?: string;
}

// ============================================================
// PARSING — bracket-scrape + structural validation. Mirrors
// opencode-executor.ts's `parseCriticVerdict` exactly (same technique,
// `[`/`]` instead of `{`/`}`), so this is the same proven strategy applied to
// an array instead of a single object, not a third parsing strategy.
// ============================================================

export type ParsedDecomposition =
  | { readonly kind: "children"; readonly children: readonly Action[] }
  | { readonly kind: "unparseable"; readonly detail: string; readonly raw_hash: string };

/**
 * Structurally validate one candidate child against `Action`'s shape.
 * Returns `undefined` (not a partial/best-effort object) on any mismatch —
 * the caller treats one bad element as poisoning the whole response, since
 * silently dropping malformed elements would silently shrink scope without
 * anyone deciding to.
 */
function validateActionShape(item: unknown): Action | undefined {
  if (typeof item !== "object" || item === null) return undefined;
  const o = item as Record<string, unknown>;
  if (typeof o.description !== "string" || o.description.trim().length === 0) return undefined;
  if (typeof o.estimated_gain !== "number" || !Number.isFinite(o.estimated_gain)) return undefined;
  if (typeof o.estimated_cost !== "number" || !Number.isFinite(o.estimated_cost)) return undefined;
  if (typeof o.category !== "string" || o.category.trim().length === 0) return undefined;
  if (typeof o.delegate_to !== "string" || o.delegate_to.trim().length === 0) return undefined;
  let constraints: string[] | undefined;
  if (o.constraints !== undefined) {
    if (!Array.isArray(o.constraints) || !o.constraints.every((c) => typeof c === "string")) return undefined;
    constraints = o.constraints as string[];
  }
  return {
    description: o.description,
    estimated_gain: o.estimated_gain,
    estimated_cost: o.estimated_cost,
    category: o.category,
    delegate_to: o.delegate_to,
    ...(constraints ? { constraints } : {}),
  };
}

/**
 * Parse a decomposer response into children, or a typed absence. Handles the
 * three malformed shapes called out by the brief:
 *   - prose / no JSON array at all             -> "no JSON array found"
 *   - truncated JSON (no closing bracket)       -> "truncated" / JSON.parse failure
 *   - a single object instead of an array       -> no top-level `[`, or the
 *     scraped value parses but is not an array / its elements aren't
 *     Action-shaped
 */
export function parseDecompositionResponse(raw: string): ParsedDecomposition {
  const cleaned = stripAnsi(raw);
  const start = cleaned.indexOf("[");
  if (start < 0) {
    return { kind: "unparseable", detail: "no JSON array found in response", raw_hash: rawResponseHash(raw) };
  }
  const end = cleaned.lastIndexOf("]");
  if (end <= start) {
    return { kind: "unparseable", detail: "no closing bracket for the JSON array (response may be truncated)", raw_hash: rawResponseHash(raw) };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return { kind: "unparseable", detail: "scraped text between [ and ] did not parse as JSON", raw_hash: rawResponseHash(raw) };
  }
  if (!Array.isArray(parsed)) {
    return { kind: "unparseable", detail: "parsed value is not a JSON array", raw_hash: rawResponseHash(raw) };
  }
  const children: Action[] = [];
  for (const item of parsed) {
    const validated = validateActionShape(item);
    if (!validated) {
      return { kind: "unparseable", detail: "one or more array elements is not a valid Action (missing/mistyped field)", raw_hash: rawResponseHash(raw) };
    }
    children.push(validated);
  }
  return { kind: "children", children };
}

/** Write the prompt to a temp file; returns { path, cleanup }. Mirrors opencode-executor.ts's private `tempPromptFile` (not exported there, so re-declared here). */
function tempPromptFile(prompt: string): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "arbor-decomposer-prompt-"));
  const path = join(dir, "prompt.txt");
  writeFileSync(path, prompt, "utf8");
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/**
 * Build a DecomposerPort that dispatches `opencode run` once per
 * `decompose()` call and parses a JSON array of children out of stdout.
 */
export function createOpenCodeDecomposer(options: OpenCodeDecomposerOptions = {}): DecomposerPort {
  const opencodeBin = options.opencodeBin ?? "opencode";
  const configDir = options.configDir ?? process.cwd();
  const timeoutMs = options.timeoutMs ?? 120_000;

  return {
    async decompose(request: DecompositionRequest): Promise<DecompositionResult> {
      if (request.signal?.aborted) {
        return { ok: false, reason: "decomposition aborted before dispatch" };
      }

      const model = options.model ?? resolveConfiguredModel("cambium", configDir, DEFAULT_DECOMPOSER_MODEL);
      const promptBody = `${AGENT_PROMPTS.cambium()}\n\n${cambiumDecompositionPrompt(request.action, { reason: request.reason, depth: request.depth })}`;
      const { path, cleanup } = tempPromptFile(promptBody);
      try {
        const args = buildOpenCodeArgs({
          model,
          worktree: undefined,
          promptFile: path,
          instruction:
            "Decompose the parent action described in the attached file into child actions, following the rules " +
            "and output format given there. Respond with ONLY a raw JSON array — no prose, no markdown fences, nothing else.",
          opencodeBin,
          pure: true,
        });
        const res = await runOpenCode({ opencodeBin, args, signal: request.signal, timeoutMs });

        if (!res.ok) {
          if (res.error === "opencode run aborted") {
            return { ok: false, reason: "decomposition aborted" };
          }
          const classified = classifyOpenCodeError(res.error, Boolean(request.signal?.aborted));
          return {
            ok: false,
            reason: classified
              ? `opencode dispatch failed (${classified.kind}): ${classified.message}`
              : `opencode dispatch failed: ${res.error}`,
          };
        }

        const parsed = parseDecompositionResponse(res.stdout);
        if (parsed.kind === "unparseable") {
          return { ok: false, reason: `decomposer response unparseable (${parsed.detail}; raw response ${parsed.raw_hash})` };
        }
        if (parsed.children.length === 0) {
          // An honest "cannot decompose" (the prompt explicitly permits `[]`
          // over manufactured filler children) is still not a usable
          // decomposition — the node still needs children to make progress,
          // so this is reported as a typed failure rather than success with
          // zero children.
          return { ok: false, reason: "decomposer returned zero children — action may already be atomic, or the model declined to decompose it" };
        }
        return { ok: true, children: parsed.children };
      } finally {
        cleanup();
      }
    },
  };
}
