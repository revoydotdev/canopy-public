/**
 * `veto.claim-completeness-guard` — the native replacement for the deleted
 * `.claim-ledger/claim-guard.sh`.
 *
 * WHAT IT IS. A nudge at the moment of writing, not authority: writing an
 * unbacked completeness claim takes a deliberate second action instead of
 * being the path of least resistance. It sees one edit fragment — never the
 * file, never the section, never the repository — so it CANNOT tell a genuinely
 * unproven claim from one whose proof sits three lines above the edit window,
 * and it fails OPEN on every such ambiguity. The real enforcement is
 * `bun run gate:claim-ledger`, which parses the whole tree at pre-push and in
 * CI and is fail-closed. That asymmetry is deliberate: a guard that tried to be
 * authoritative on partial context would produce false denials, and a guard
 * people learn to work around is worse than no guard.
 *
 * MARKERS ARE SCOPED PER FILE, because the same glyph means different things in
 * different documents. In ROADMAP.md a `\u2705` asserts a tranche is complete; in
 * an ADR the completion vocabulary is `**Status:** Accepted` and a `\u2705` is
 * almost always prose — a table describing markers, a comparison, a quoted
 * example. The first version of the shell guard matched the glyph everywhere and
 * denied the very ADR documenting this ledger, whose Context section tabulates
 * the marker surface. Scoping is the fix; loosening the guard to warn-only would
 * have been the wrong one.
 *
 * THE DISCHARGE ORDER IS LOAD-BEARING and runs exactly as it did:
 *   (a) no marker in the ADDED text           -> allow, the edit asserts nothing
 *   (b) marker already in the REMOVED text    -> allow, this edit did not introduce it
 *   (c) `<!-- proof:` anywhere in the added text -> allow, presence not resolution
 *   otherwise                                  -> refuse
 * (b) in particular is what keeps a guard from blocking every re-save of a line
 * that was already claimed, and it is unreachable without `removed_text`: a
 * `file.write` displaces no located span, so that field is `""` for it and step
 * (b) is skipped rather than answered from a copy of what is being added.
 *
 * WHY THE TEXT BOUND IS 128 KiB AND NOT THE BUS DEFAULT. The bus hands a veto
 * handler a HEAD slice, and a head slice that falls short of a marker turns a
 * refusal into a SILENT ALLOW — measured before this was written: a 5,031-byte
 * ROADMAP.md write reached the handler as 1,024 bytes with its `**CLOSED**` row
 * invisible, which the shell guard had refused. The fix is to size the guard to
 * what the TOOL admits rather than to what is cheap: `cli.ts` composes the
 * repository tools with `max_read_bytes: 128 * 1024`, and `native-tool-host`
 * bounds `content`, `expected` and `replacement` at exactly that, so at this
 * bound the bus never truncates a single call the tool would have accepted.
 *
 * Measured against the real targets, and this is why the bound is not a guess:
 * `decisions/README.md` is 23,754 bytes and the largest of 167 ADRs is 26,589 (sur-05:historical, the count when this was measured) —
 * both writable whole and both read whole here. `ROADMAP.md` is 192,920, which
 * EXCEEDS the bound, so it cannot be written whole at all and must be patched
 * with a bounded `replacement` this guard also sees whole. No real target can
 * reach the unread-in-full refusal below; it exists so that raising a bound
 * later produces a visible refusal rather than a quietly unguarded guard.
 */
import { sep } from "node:path";
import type { HookVetoDecision, HookVetoHandler } from "./contracts.js";
import { currentGovernedRoot } from "./governance-tropisms.js";

/** `DEFAULT_READ_BYTES` is 64 KiB; the production composition raises it to 128 KiB. */
export const CLAIM_TEXT_BOUND_BYTES = 128 * 1024;

const PROOF_OPEN = "<!-- proof:";

type ClaimDocument = "roadmap" | "adr" | "index";

/** The whitelist, and the marker class that belongs to each member of it. */
const claimDocument = (relativePath: string): ClaimDocument | null => {
  if (relativePath === "ROADMAP.md") return "roadmap";
  if (relativePath === "decisions/README.md") return "index";
  return /^decisions\/ADR-[^/]*\.md$/.test(relativePath) ? "adr" : null;
};

/**
 * The three line-anchored tests, plus ROADMAP.md's plain substring. `[[:space:]]`
 * in the shell versions is `[ \t]` here because the anchor is a line start, so
 * the class can only ever match horizontal whitespace; `.` matches neither flag
 * nor newline, exactly as in grep.
 */
const hasMarker = (document: ClaimDocument, text: string): boolean => {
  if (document === "roadmap") {
    return text.includes("\u2705") || text.includes("\ud83d\udfe2") || /^\|[ \t]*\*\*G-[0-9]+\*\*.*\*\*(?:CLOSED|RESOLVED|RATIFIED)/m.test(text);
  }
  return document === "adr"
    ? /^\*\*Status:\*\*[ \t]*Accepted/m.test(text)
    : /^\|[ \t]*\[[0-9]+\]\([^)]*\).*\|[ \t]*Accepted[ \t]*\|/m.test(text);
};

/**
 * Deliberately weaker than the VI guard's containment, and so on purpose: the
 * repository prefix is stripped TEXTUALLY, with no resolution, so an absolute
 * path that does not begin with it stays absolute, misses the whitelist, and is
 * allowed. That is the script's behaviour, it fails toward allowing, and a
 * stricter version here would refuse edits the deleted guard waved through.
 */
const relativeTo = (root: string, path: string): string => {
  const prefix = `${root}${sep}`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
};

const AUTHORITY = "`gate:claim-ledger` is the authority: it reads the whole tree at pre-push and CI, and is fail-closed. ";

/**
 * An ADR status flip has a dedicated remedy, and the generic advice is a trap
 * for it: adding the proof comment to the flip satisfies this guard and then
 * fails `gate:adr-acceptance-staged`, which demands a status-only commit. Name
 * the mechanism instead of the two-gate collision.
 */
const ACCEPT_HINT = "For an ADR **Status:** flip, use `bun run adr:accept <number>` \u2014 it commits status-only, as `gate:adr-acceptance-staged` requires. ";

/**
 * `HOOK_MAX_REASON_BYTES` truncates this from the END, so the only part of
 * variable width — the path — goes LAST. That makes the budget deterministic
 * rather than dependent on how long a decision record's title happens to be:
 * measured at the longest of 167 real ADRs (ADR-153, 105 characters) this lands
 * at 488 of 512. The first draft led with the remedy and tailed with the path,
 * and the authority citation was cut off for exactly the documents that need it
 * most, which is the failure a fixed ORDER prevents and a shorter string does
 * not.
 */
const refusal = (rel: string): string =>
  `claim-ledger: this edit adds a completeness marker with no \`${PROOF_OPEN} ... -->\` in the same change. ${AUTHORITY}`
  + (rel.startsWith(`decisions${sep}`) ? ACCEPT_HINT : "")
  + "No proof? State why in the text (ADR-008). "
  + `File: ${rel}`;

const UNREADABLE = (bound: number): string =>
  `claim-ledger: this edit is at least ${bound} bytes, so the completeness scan read only its head and cannot prove `
  + "no marker is present. Absence of a marker in a truncated edit is not absence of a marker, and allowing here is "
  + "how this guard would silently stop guarding. Split the change, or raise this guard's declared text_bytes to "
  + "match the tool's own max_read_bytes.";

export const claimCompletenessGuard: HookVetoHandler = (context): HookVetoDecision => {
  const rel = relativeTo(currentGovernedRoot(), context.tool_input.path);
  const document = claimDocument(rel);
  if (document === null) return { allow: true };
  const { added_text: added, removed_text: removed } = context.tool_input;
  if (added === "") return { allow: true };
  if (added.length >= CLAIM_TEXT_BOUND_BYTES || removed.length >= CLAIM_TEXT_BOUND_BYTES) {
    return { allow: false, reason: UNREADABLE(CLAIM_TEXT_BOUND_BYTES) };
  }
  if (!hasMarker(document, added)) return { allow: true };
  if (removed !== "" && hasMarker(document, removed)) return { allow: true };
  if (added.includes(PROOF_OPEN)) return { allow: true };
  return { allow: false, reason: refusal(rel) };
};
