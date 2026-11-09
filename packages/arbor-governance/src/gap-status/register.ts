/**
 * register.ts — parse ROADMAP.md's "Verified gap register" section into the
 * declared status of every G-NN row.
 *
 * This intentionally re-derives the same row shape `scripts/docs-truth.mjs`
 * already parses for its own citation/duplicate/reachability checks (Check
 * 1-3 in that file's header comment), narrowed to the one fact this module
 * needs: a row's declared status bucket. It is a separate, independent
 * parser rather than an import from `docs-truth.mjs` because that script is
 * a plain top-level `.mjs` outside this package's boundary and its own
 * register-row logic is unexported, untested in isolation, and threaded
 * through three unrelated checks (path citations, duplicate IDs,
 * reachability) that this module has no need to touch. Duplicating ~20
 * lines of well-understood regex is preferable here to coupling this
 * package to a script's internal shape for a change neither one requires
 * (AHA: duplication over the wrong abstraction).
 *
 * Purity: a pure function of `roadmapText`. No fs, no clock, no network —
 * matches counts/derive.ts's guarantee so callers can unit test against
 * fixture strings without touching disk.
 */

/** Two buckets only. NARROWED/RESOLVED-AS-NON-GOAL and everything else that
 * is not CLOSED/RESOLVED/RATIFIED is "open" for this module's purposes — the
 * register still tracks it as unfinished, even where a NARROWED verdict has
 * partially resolved it. This mirrors `scripts/docs-truth.mjs`'s own
 * `isClosed` regex (Check 3, reachability-consistency) so the two modules
 * agree on what "closed" means for a register row. */
export type GapStatus = "closed" | "open";

export interface GapRegisterRow {
  readonly id: number;
  readonly status: GapStatus;
  /** The row's raw Gap-cell status prefix, e.g. `CLOSED (2026-08-08).` — kept for finding detail text. */
  readonly statusRaw: string;
  /** 1-based line number of the row in `roadmapText`. */
  readonly line: number;
}

export interface GapRegister {
  readonly rows: readonly GapRegisterRow[];
  /** 1-based [start, end) line range spanning the register table body (heading's next line through the line before the next `##` heading, or EOF). Empty ([0, 0]) when no register heading was found. Callers scanning ROADMAP.md itself for OTHER mentions should exclude this range — it is the ground truth, not a mention of itself. */
  readonly bodyRange: readonly [number, number];
}

const REGISTER_HEADING_RE = /^##\s+Verified gap register\s*$/;
const NEXT_TOP_HEADING_RE = /^##\s+/;
const ROW_RE = /^\|\s*(\*\*G-(\d+)\*\*|—)\s*\|(.*)\|\s*$/;
const CLOSED_STATUS_RE = /^\*\*(?:CLOSED|RESOLVED|RATIFIED)\b/i;

/** Parse the "Verified gap register" section, if present. A row whose ID cell is the `—` sentinel (the documented G-20 never-allocated row) carries no status and is omitted — it has nothing to be consistent or inconsistent with. */
export function parseGapRegister(roadmapText: string): GapRegister {
  const lines = roadmapText.split("\n");

  let start = -1;
  let end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    if (REGISTER_HEADING_RE.test(lines[i])) {
      start = i + 1;
      for (let j = start; j < lines.length; j++) {
        if (NEXT_TOP_HEADING_RE.test(lines[j])) {
          end = j;
          break;
        }
      }
      break;
    }
  }

  const rows: GapRegisterRow[] = [];
  if (start >= 0) {
    for (let i = start; i < end; i++) {
      const m = ROW_RE.exec(lines[i]);
      if (!m) continue;
      const rest = m[3];
      if (/^\s*---/.test(rest)) continue; // markdown table separator row
      if (m[1] === "—") continue; // sentinel row, no real status
      const cells = rest.split("|").map((c) => c.trim());
      const statusRaw = (cells[0] ?? "").trim();
      const status: GapStatus = CLOSED_STATUS_RE.test(statusRaw) ? "closed" : "open";
      rows.push({ id: Number(m[2]), status, statusRaw, line: i + 1 });
    }
  }

  return { rows, bodyRange: start < 0 ? [0, 0] : [start + 1, end + 1] };
}

/** Convenience index: register rows keyed by gap id. A duplicate id (already a `docs-truth.mjs` violation on its own) keeps whichever row was parsed last — this module reports contradictions against the register, it does not re-litigate register-internal duplication. */
export function gapRegisterMap(register: GapRegister): Map<number, GapRegisterRow> {
  return new Map(register.rows.map((row) => [row.id, row]));
}
