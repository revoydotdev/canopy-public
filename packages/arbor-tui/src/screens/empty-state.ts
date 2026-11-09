/**
 * Typed-empty-state caption contract for every screen's zero-rows fallback
 * (WA-59). `registry.ts`'s `buildScreenPipeline` collapses two genuinely
 * different `project()` outcomes into the same fallback slot: a `null`/
 * not-yet-issued query result (nothing to show, possibly because the
 * operator hasn't taken the action that would populate it), and a non-null
 * result that matched none of the screen's own recognized shapes (a real
 * wire/contract mismatch — a bug, not an empty list). Rendering both as the
 * bare "No data" made them indistinguishable: an operator had no way to
 * tell "genuinely nothing here yet" from "something is broken".
 *
 * `emptyCaption` covers the first case: state what's absent and how the
 * operator gets data into it. `unrecognisedCaption` covers the second: it
 * never guesses at content, and always points at Diagnostics (6), the one
 * screen built to surface malformed/unexpected runtime traffic.
 */

/** Every screen caption stays within one terminal line at a typical pane width. */
const MAX_CAPTION_CHARS = 100;

function clampCaption(caption: string): string {
  return caption.length <= MAX_CAPTION_CHARS ? caption : `${caption.slice(0, MAX_CAPTION_CHARS - 1)}…`;
}

/** What a genuinely-empty screen is missing, and the concrete action that populates it. */
export interface EmptyStateDetail {
  /** What's absent, e.g. "No jobs queued". */
  readonly what: string;
  /** How the operator gets data here — a real CLI verb or keybinding, never invented. */
  readonly how: string;
}

/** A `null`/not-yet-loaded query result: state what's absent and how to populate it. */
export function emptyCaption(detail: EmptyStateDetail): string {
  return clampCaption(`${detail.what} — ${detail.how}`);
}

/** A non-null result matching none of the screen's recognized shapes — a contract mismatch, not an empty list. */
export function unrecognisedCaption(screenTitle: string): string {
  return clampCaption(`${screenTitle}: query returned an unrecognised shape; see Diagnostics (6)`);
}
