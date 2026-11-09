/**
 * exit-codes.ts — the single authoritative process exit-code registry for
 * `arbor-mcp`'s CLI (`cli.ts`). Every `return <n>` / `process.exitCode = <n>`
 * site in that file reads its number from `EXIT_CODES` (or one of the
 * derivation helpers below); none is ever a bare numeric literal.
 *
 * Adopts revoy-spec's ADR-054 CLI grammar wholesale — see
 * `docs/adr-governance-audit/09-prior-art-and-self-hosting-roadmap.md`
 * §24.2 (P6) and §24.6 Track C (C2). ADR-054 itself only *adds* 3/4/5 to an
 * existing 0/1/2 it doesn't redefine ("`revoy-guard`'s own... codes are
 * unchanged; they were never part of the 0-3 contract"); this file states
 * revoy2's own meaning for the conventional low end (success / unexpected
 * failure / usage error) alongside ADR-054's three semantically-loaded ones,
 * so the full registry lives in exactly one place.
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE: a governance run that found a real
 * violation must never exit with the code a crash would use. Conflating
 * "the system worked and the answer is bad" with "the system failed" is the
 * exact fail-open collapse `AuthorityVerdict` in
 * `packages/arbor-governance/src/contracts.ts` refuses to make at the
 * authority boundary (`unknown`/`unverifiable` kept distinct from `denied`
 * — see that file's own doc comment). This is that same discipline applied
 * one layer up, at the process boundary.
 */
import type { GovernanceErrorCode, PolicyFinding } from "@arbor/governance";

/** The complete, ordered exit-code registry. */
export const EXIT_CODES = {
  /** Command completed; no violation, conflict, or partial failure to report. */
  SUCCESS: 0,
  /** Unexpected/internal failure — a crash or unhandled exception, not a reported result. */
  FAILURE: 1,
  /** Caller misused the CLI grammar: unknown command, malformed/unrecognized argument. */
  USAGE: 2,
  /** ADR-054 `EXIT_PARTIAL`: a multi-target run where some targets failed and others succeeded. */
  PARTIAL: 3,
  /** ADR-054 `EXIT_CONFLICT`: the action was refused because of a cross-session/state conflict. */
  CONFLICT: 4,
  /** ADR-054 `EXIT_VIOLATION`: the command ran to completion and reported a real governance/hygiene violation. */
  VIOLATION: 5,
} as const;

export type ExitCodeName = keyof typeof EXIT_CODES;
export type ExitCode = (typeof EXIT_CODES)[ExitCodeName];

/**
 * Escalation order when a single command outcome could honestly be
 * described by more than one code at once (e.g. a corpus scan that hit both
 * an unparseable record — PARTIAL — and a blocker finding — VIOLATION). The
 * highest-priority applicable code wins; a caller testing `$?` needs exactly
 * one number, never a bitmask or an arbitrary pick. `SUCCESS` is the floor:
 * `escalate([])` and `escalate([EXIT_CODES.SUCCESS])` both return it.
 */
const ESCALATION_ORDER: readonly ExitCode[] = [
  EXIT_CODES.VIOLATION,
  EXIT_CODES.CONFLICT,
  EXIT_CODES.PARTIAL,
  EXIT_CODES.SUCCESS,
];

export function escalate(candidates: readonly ExitCode[]): ExitCode {
  for (const code of ESCALATION_ORDER) {
    if (candidates.includes(code)) return code;
  }
  return EXIT_CODES.SUCCESS;
}

/**
 * Derives an exit code from a `GovernanceError.code` (the closed union
 * `contracts.ts` defines and states "mirrors `RuntimeError.code` in
 * arbor-mcp so the MCP surface is consistent").
 *
 * `"conflict"` -> `CONFLICT` and `"permission"` -> `VIOLATION` are both
 * *correctly wired but not yet reachable* from any real invocation this
 * lane's file scope can produce today: every real `GovernanceError`
 * construction site in `@arbor/governance` and `governance-projection.ts`
 * (verified by reading `record/corpus.ts`, `obligation/report.ts`, and this
 * package's own `internalError`) only ever returns `"validation"` or
 * `"internal"`/`"unavailable"`. Recorded here rather than silently omitted,
 * so the day a write-capable governance command produces a real conflict or
 * permission denial, it gets the right code for free instead of collapsing
 * into `FAILURE` — see this repo's own `AuthorityVerdict` discipline this
 * file's header cites: `unknown`/`unverifiable` outcomes still get a named,
 * intentional branch even before they're reachable, rather than being
 * folded into the nearest reachable case.
 */
export function exitCodeForGovernanceError(code: GovernanceErrorCode): ExitCode {
  switch (code) {
    case "validation":
      return EXIT_CODES.USAGE;
    case "conflict":
      return EXIT_CODES.CONFLICT;
    case "permission":
      return EXIT_CODES.VIOLATION;
    case "unavailable":
      return EXIT_CODES.FAILURE;
    case "internal":
      return EXIT_CODES.FAILURE;
  }
}

/**
 * Derives an exit code from a set of findings using `contracts.ts`'s own
 * `Severity` vocabulary (`"blocker" | "warning" | "informational"`) — the
 * only severity vocabulary this CLI speaks. Only `"blocker"` escalates past
 * `SUCCESS`: a `"warning"`/`"informational"` finding is real, printed
 * output, but does not by itself make the run a reportable violation
 * (matching how most lint-style CLIs treat warnings-only as a clean exit
 * unless a caller opts into stricter behavior — no such flag exists on this
 * CLI today, so there is nothing stricter to opt into).
 */
export function exitCodeForFindings(findings: readonly Pick<PolicyFinding, "severity">[]): ExitCode {
  return findings.some((finding) => finding.severity === "blocker") ? EXIT_CODES.VIOLATION : EXIT_CODES.SUCCESS;
}
