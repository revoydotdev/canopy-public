#!/usr/bin/env node
/**
 * scripts/vi-source-readers.mjs — ONE reader, and an honest account of each.
 *
 *   bun scripts/vi-source-readers.mjs census  --root DIR --edges FILE [--json]
 *   bun scripts/vi-source-readers.mjs readers
 *   bun scripts/vi-source-readers.mjs selfcheck
 *
 * WHY THIS FILE EXISTS (CD-CD-03)
 * --------------------------------
 * Seven tracked sources carry NUL (0x00) bytes — bedrock-messages.ts,
 * webui.ts, ledger-audit-sweep.ts, canonical-collisions.test.ts, mentions.ts,
 * identity.ts, legacy.test.ts — carrying 733 cited edges across 518 distinct
 * `path:line` citations and 6 relation kinds.
 *
 * The DATA IS FINE. Every byte-level reader sees it. The defect is that the
 * toolchain held readers with different notions of "is this file text?", and on
 * these seven they disagreed. The consequence: the census's coverage FLIPS
 * depending on which search implementation runs, and it flips at the two files
 * with the corpus's tightest cited-line margins.
 *
 * The fix is READER SEMANTICS, NOT DATA. The NUL bytes are evidence of what the
 * corpus contains; stripping them would be remediation, would change the
 * census, and is explicitly forbidden. Nothing in this file writes to a source.
 *
 * TWO AXES, because conflating them is what made the first draft of this
 * script vacuous
 * ------------------------------------------------------------------
 * A reader answers one of two questions, and readers differ on WHICH they can
 * answer. Reporting them as one number is how a reader ends up reporting a
 * count while being unable to see the lines the count came from.
 *
 *   EXISTENCE  "does this file contain N matching lines?"  — a COUNT.
 *              Every reader answers it, including the blind ones: `grep -c`
 *              and `rg -c` both return 4 for a NUL-bearing file while `grep -n`
 *              and `rg -n` return zero lines. Agreement here is NOT evidence of
 *              agreement overall and must never be reported as if it were.
 *
 *   RESOLUTION "give me line L of this file, so I can follow a path:line."
 *              — the question a citation is actually made of. THIS is the axis
 *              on which the toolchain disagreed, and the axis the fix is about.
 *
 * A reader blind on RESOLUTION is DECLARED blind, not silently dropped. A reader
 * declared resolving that misses is a FAILURE. Dropping a disagreeing reader
 * from the comparison is the CD-H-01 shape: a green obtained by narrowing the
 * set of things looked at.
 *
 * MEASURED, NOT ASSUMED
 * ---------------------
 * On a NUL-bearing file, pattern `nonEmpty` in bedrock-messages.ts:
 *   grep -n    -> stderr "binary file matches", stdout ZERO lines   (BLIND)
 *   rg -n      -> stdout "binary file matches (found \0 byte …)", 0 lines (BLIND)
 *   grep -c -> 4     grep -a -c -> 4     rg -c -> 4
 *   grep -a -n -> 4 lines     git grep -n -> 4 lines     node -> 4 lines
 *
 * ripgrep is the reader CD-CD-03 does not name, and it is blind by default for
 * the same reason GNU grep is — the unenumerated reader the brief warns about,
 * found by measurement rather than by argument.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * A NUL byte is a BYTE, not an encoding error. Node's utf8 decoder maps it to
 * U+0000 and preserves the line structure, which is all a `path:line` citation
 * needs. This is the entire node-side fix: do not screen, do not skip, do not
 * substitute.
 */
export function readSourceLines(absPath) {
  return readFileSync(absPath, "utf8").split("\n");
}

/** Byte-level NUL census. Independent of every reader, by construction. */
export function nulByteCount(absPath) {
  const buf = readFileSync(absPath);
  let n = 0;
  for (const b of buf) if (b === 0) n += 1;
  return n;
}

/**
 * THE READER SET. A declared literal, not a discovered list: a discovered list
 * reports whatever the machine happens to have installed, so the census would
 * change shape on another host and no gate would notice.
 *
 *   resolves  — can return the CONTENT of a named line (the citation axis).
 *   exists    — can return a match COUNT (the existence axis).
 *   needs     — the flag that makes it see a NUL-bearing file, or null when the
 *               reader is unconditional. Recorded so the reason a reader is
 *               blind is legible from the table rather than re-derived.
 */
export const READERS = [
  {
    id: "node",
    label: "node readSourceLines (this module)",
    resolves: true,
    exists: true,
    needs: null,
    note: "Byte-level. The reader the census itself uses.",
  },
  {
    id: "grep-a",
    label: "GNU grep -a -n",
    resolves: true,
    exists: true,
    needs: "-a",
    note: "Sees NUL-bearing files. Reference resolving reader.",
  },
  {
    id: "git-grep",
    label: "git grep -n",
    resolves: false,
    exists: true,
    needs: "-I",
    note:
      "BLIND, AND THE REGISTER SAYS IT IS NOT. CD-CD-03 asserts git grep -n sees " +
      "them. Measured: git applies an 8000-byte binary sniff to the blob, so it refuses " +
      "a file whose FIRST NUL falls inside that window and accepts one whose first NUL " +
      "falls outside it. 4 of the 7 resolve, 3 do not. This is the sharpest form of the " +
      "defect: the same reader disagrees with itself across the same corpus based on " +
      "WHERE the byte is, so a spot check on a well-behaved file reports the reader as " +
      "correct. -I is not a text flag and does not help; --text does.",
  },
  {
    id: "rg-a",
    label: "ripgrep --text -n",
    resolves: true,
    exists: true,
    needs: "--text",
    note: "Sees NUL-bearing files ONLY with --text. Blind by default.",
  },
  {
    id: "git-grep-a",
    label: "git grep --text -n",
    resolves: true,
    exists: true,
    needs: "--text",
    note:
      "Sees every NUL-bearing file. The FIX for git-grep, and the demonstration that " +
      "the defect was the reader's flags rather than the data.",
  },
  {
    id: "grep-c",
    label: "GNU grep -c",
    resolves: false,
    exists: true,
    needs: null,
    note:
      "Not blind and NOT resolving. Count-only by construction: it can say a " +
      "symbol occurs 4 times but cannot return the line, so it cannot follow a citation.",
  },
  {
    id: "rg-c",
    label: "ripgrep -c",
    resolves: false,
    exists: true,
    needs: null,
    note: "Same shape as grep -c: exists, cannot resolve.",
  },
  {
    id: "grep-plain",
    label: "GNU grep -n (no -a)",
    resolves: false,
    exists: true,
    needs: null,
    note:
      "BLIND on resolution. stderr 'binary file matches', zero stdout lines. " +
      "This is the invocation a human uses to follow a path:line citation.",
  },
  {
    id: "rg-plain",
    label: "ripgrep -n (no --text)",
    resolves: false,
    exists: true,
    needs: null,
    note:
      "BLIND on resolution, same as grep-plain. NOT named by CD-CD-03 — " +
      "found by measuring every reader the toolchain can invoke.",
  },
];

/** Readers a `path:line` citation may be RESOLVED with. */
export const RESOLVING_READERS = READERS.filter((r) => r.resolves).map((r) => r.id);

/** Readers declared NOT able to resolve. Kept in the comparison, not dropped. */
export const NON_RESOLVING_READERS = READERS.filter((r) => !r.resolves).map((r) => r.id);

// ---------------------------------------------------------------------------
// ASSERTED SET — a declared literal, NOT derived from the census above.
//
// WHY IT IS HERE AND WHY IT IS SEPARATE
// -------------------------------------
// Three mutations of the census logic leave it reporting a clean bill of health:
// widening the scope, neutering the blindness gate, and dropping a disagreeing
// reader from the comparison all produce "no failures" — because a control that
// stopped discriminating produces no disagreement. That is CD-H-01's exact
// shape, and it appeared in the fix written for CD-H-01. The census therefore
// CANNOT be its own control: it can only report what it is currently looking at.
//
// So the expectation is stated here as literals, transcribed from the plan
// (`:330`) and the register row (CD-CD-03, `findings-register.md:222`), which
// were produced by a DIFFERENT agent from a DIFFERENT artifact (todo-15's
// byte-wise line count). Nothing in this file computes them, and a mutation
// that changes what the census SEES cannot change what it is CHECKED against.
// A membership test would not do: `x in EXPECTED` survives deletion from
// EXPECTED, so the counts are pinned as well as the membership — set equality
// in both directions, with the numbers attached.
export const ASSERTED = {
  // §3a of todo-15-verifierD.md. Order is that document's.
  nul_files: [
    { path: "packages/arbor-harness/src/bedrock-messages.ts", nul_bytes: 1, cited: 227 },
    { path: "packages/arbor-mcp/src/webui.ts", nul_bytes: 1, cited: 161 },
    { path: "packages/arbor-audit/src/ledger-audit-sweep.ts", nul_bytes: 3, cited: 112 },
    {
      path: "packages/arbor-governance/tests/redteam/canonical-collisions.test.ts",
      nul_bytes: 2,
      cited: 100,
    },
    { path: "packages/arbor-governance/src/gap-status/mentions.ts", nul_bytes: 2, cited: 76 },
    { path: "packages/arbor-governance/src/artifact/identity.ts", nul_bytes: 1, cited: 42 },
    { path: "packages/arbor-governance/tests/record/legacy.test.ts", nul_bytes: 1, cited: 15 },
  ],
  // The 8th NUL-bearing tracked source the register does not name. Carries 0
  // cited edges, so it is counted separately rather than folded into the 733 —
  // asserting 7 when the sweep finds 8 is a discrepancy to report, not a
  // discrepancy to hide by narrowing the sweep.
  additional_nul_sources_expected: 1,
  cited_edges_total: 733,
  distinct_citations: 518,
  relation_kinds: 6,
  relations: {
    contains: 268,
    calls: 125,
    references: 274,
    tests: 37,
    instantiates: 11,
    imports: 18,
  },
  // Every reader that declares it can resolve must resolve EVERY citation.
  // Set equality, both directions, count pinned: a reader silently demoted to
  // non-resolving would otherwise remove the requirement rather than fail it.
  resolving_readers: ["node", "grep-a", "rg-a", "git-grep-a"],
  // Counted by running assertAgreement, not derived by hand: 7 named files, 1
  // unnamed-source count, 1 named-source count, 3 headline totals, 6 relation
  // counts, 1 resolving-set size, 4 membership (asserted side), 4 membership
  // (declared side), 4 per-reader coverage = 31. Pinned so a stubbed or
  // deleted assertAgreement is distinguishable from one that agreed — the only
  // difference between the two is how much it checked.
  minimum_checks: 31,
};

/**
 * The census's own self-check: BLIND by construction to any change in what it
 * looks at, so it is a statement about the instrument, not about the corpus.
 * The asserted-set check below is the layer that can fail on coverage.
 */
export function assertAgreement(c) {
  const fail = [];
  const push = (m) => fail.push(m);
  // Every independent fact this function actually asserts, counted. A caller
  // that replaces the call with `[]` (mutation M5) therefore reports 0 checks
  // and the census refuses to report OK — which is the only way a deleted
  // control is distinguishable from a control that passed.
  let checks = 0;
  const check = (m) => {
    checks += 1;
    if (m) push(m);
  };

  const named = new Set(ASSERTED.nul_files.map((f) => f.path));
  const found = c.nul_files.map((f) => f.path);
  const foundNamed = found.filter((p) => named.has(p));

  // set equality both ways, plus the count
  for (const f of ASSERTED.nul_files) {
    const got = c.nul_files.find((x) => x.path === f.path);
    checks += 1;
    if (!got) {
      push(`asserted NUL source not found: ${f.path}`);
      continue;
    }
    if (got.nul_bytes !== f.nul_bytes)
      push(`${f.path}: NUL bytes ${got.nul_bytes} != asserted ${f.nul_bytes} — DATA CHANGED`);
    if ((c.per_file_cited[f.path] ?? -1) !== f.cited)
      push(`${f.path}: cited edges ${c.per_file_cited[f.path] ?? 0} != asserted ${f.cited}`);
  }
  const extra = found.filter((p) => !named.has(p));
  check(
    extra.length !== ASSERTED.additional_nul_sources_expected
      ? `${extra.length} unnamed NUL-bearing tracked sources, asserted ${ASSERTED.additional_nul_sources_expected}: ${extra.join(", ") || "none"}`
      : undefined,
  );
  check(
    foundNamed.length !== ASSERTED.nul_files.length
      ? `named NUL sources found ${foundNamed.length} != asserted ${ASSERTED.nul_files.length}`
      : undefined,
  );

  check(
    c.cited_edges !== ASSERTED.cited_edges_total
      ? `cited edges ${c.cited_edges} != asserted ${ASSERTED.cited_edges_total}`
      : undefined,
  );
  check(
    c.distinct_citations !== ASSERTED.distinct_citations
      ? `distinct citations ${c.distinct_citations} != asserted ${ASSERTED.distinct_citations}`
      : undefined,
  );
  check(
    c.relation_kinds !== ASSERTED.relation_kinds
      ? `relation kinds ${c.relation_kinds} != asserted ${ASSERTED.relation_kinds}`
      : undefined,
  );
  for (const [k, v] of Object.entries(ASSERTED.relations))
    check(
      (c.relations[k] ?? 0) !== v ? `relation ${k}: ${c.relations[k] ?? 0} != asserted ${v}` : undefined,
    );

  // The acceptance criterion, stated as a set the census cannot shrink: the
  // readers that must resolve. Declared here, not read from READERS, so
  // demoting a reader to non-resolving fails instead of quietly removing the
  // requirement. SET EQUALITY both ways with the count pinned: a one-sided
  // membership test survives deletion from this list, which is redemption #6
  // in this plan, and a reader added to READERS without being asserted here is
  // a reader nobody is holding to full coverage.
  const declaredResolving = c.per_reader.filter((r) => r.declared_resolving).map((r) => r.id).sort();
  check(
    declaredResolving.length !== ASSERTED.resolving_readers.length
      ? `resolving reader count ${declaredResolving.length} [${declaredResolving.join(", ")}] != asserted ${ASSERTED.resolving_readers.length} [${ASSERTED.resolving_readers.join(", ")}]`
      : undefined,
  );
  for (const id of ASSERTED.resolving_readers) {
    checks += 1;
    if (!declaredResolving.includes(id))
      push(`reader ${id} must resolve citations but is declared resolves:false`);
  }
  for (const id of declaredResolving) {
    checks += 1;
    if (!ASSERTED.resolving_readers.includes(id))
      push(`reader ${id} declares it resolves but is not in the asserted resolving set — a reader nobody is holding to full coverage`);
  }
  for (const r of c.per_reader) {
    if (!ASSERTED.resolving_readers.includes(r.id)) continue;
    checks += 1;
    if (r.resolved_observed !== ASSERTED.distinct_citations)
      push(
        `reader ${r.id} resolved ${r.resolved_observed}/${ASSERTED.distinct_citations} — COVERAGE IS READER-DEPENDENT`,
      );
  }
  return { failures: fail, checks };
}

/** How many probes the asserted-set self-test is pinned to run. */
const ASSERTED_SELF_TEST_PROBES = 11;

/**
 * SELF-TEST OF THE ASSERTED LAYER. A control that has never been shown to fail
 * is not a control — and `assertAgreement` is the only layer that can fail on
 * coverage, so removing it must be detectable. Deleting the call site (M5) is
 * invisible from inside the function, so the function proves it can fail by
 * being fed a census that violates each pinned fact, and `selfcheck` requires
 * every probe to be caught.
 *
 * The probes are hand-built deltas, not a copy of a real census, so this
 * cannot flatter itself by agreeing with whatever the census happens to say.
 */
export function assertAgreementSelfTest() {
  // The baseline must itself be a census assertAgreement ACCEPTS, or every
  // probe below "fails" for the wrong reason and the self-test approves nothing.
  // The 8th, unnamed NUL-bearing tracked source is included — that is what
  // `additional_nul_sources_expected` is counting.
  const extra = {
    path: "synthetic/unnamed-nul-source.ts",
    nul_bytes: 1,
    nul_offset: 0,
    lines: 10,
  };
  const baseFiles = [...ASSERTED.nul_files.map((f) => ({ ...f })), extra];

  const base = (over = {}) => ({
    nul_files: baseFiles,
    nul_bytes_total: 12,
    cited_edges: ASSERTED.cited_edges_total,
    distinct_citations: ASSERTED.distinct_citations,
    relation_kinds: ASSERTED.relation_kinds,
    relations: { ...ASSERTED.relations },
    per_file_cited: Object.fromEntries(ASSERTED.nul_files.map((f) => [f.path, f.cited])),
    per_reader: ASSERTED.resolving_readers.map((id) => ({
      id,
      declared_resolving: true,
      resolved_observed: ASSERTED.distinct_citations,
      citations_probed: ASSERTED.distinct_citations,
    })),
    ...over,
  });

  const probes = [
    ["an unmodified census passes", base(), 0],
    [
      "a stripped NUL byte",
      base({ nul_files: baseFiles.map((f, i) => (i === 0 ? { ...f, nul_bytes: 0 } : f)) }),
      1,
    ],
    [
      "a vanished NUL-bearing source",
      base({ nul_files: baseFiles.slice(1) }),
      1,
    ],
    [
      "a second unnamed NUL-bearing source",
      base({ nul_files: [...baseFiles, { ...extra, path: "synthetic/another.ts" }] }),
      1,
    ],
    ["a dropped cited edge", base({ cited_edges: 700 }), 1],
    ["a dropped distinct citation", base({ distinct_citations: 500 }), 1],
    ["a dropped relation kind", base({ relation_kinds: 5 }), 1],
    ["a reshuffled relation count", base({ relations: { ...ASSERTED.relations, references: 200 } }), 1],
    [
      "a demoted resolving reader",
      base({
        per_reader: base().per_reader.map((r) =>
          r.id === "node" ? { ...r, declared_resolving: false } : r,
        ),
      }),
      1,
    ],
    [
      "an unasserted extra resolving reader",
      base({
        per_reader: [
          ...base().per_reader,
          { id: "rogue", declared_resolving: true, resolved_observed: 518, citations_probed: 518 },
        ],
      }),
      1,
    ],
    [
      "a resolving reader that misses a citation",
      base({
        per_reader: base().per_reader.map((r) =>
          r.id === "grep-a" ? { ...r, resolved_observed: 400 } : r,
        ),
      }),
      1,
    ],
  ];

  const failures = [];
  for (const [name, census, expectFail] of probes) {
    const failed = assertAgreement(census).failures.length > 0;
    if (failed !== Boolean(expectFail))
      failures.push(
        `${name}: expected ${expectFail ? "a failure" : "no failure"}, got ${failed ? "a failure" : "no failure"}`,
      );
  }
  if (probes.length !== ASSERTED_SELF_TEST_PROBES)
    failures.push(`self-test ran ${probes.length} probes, pinned ${ASSERTED_SELF_TEST_PROBES}`);
  // M19: the pinned check floor is a literal, so lowering it is invisible to
  // itself. Recomputed here against the same baseline the probes use, so the
  // floor is checked rather than trusted.
  const observedChecks = assertAgreement(base()).checks;
  if (observedChecks !== ASSERTED.minimum_checks)
    failures.push(
      `assertAgreement performs ${observedChecks} checks, pinned minimum ${ASSERTED.minimum_checks}`,
    );
  // M17: a comparator that can never fire makes every probe vacuously pass.
  // Only a DIRECT broken input, checked here rather than through the probe
  // table, distinguishes "the self-test proved the control fails" from "the
  // self-test was silenced".
  if (assertAgreement(base({ cited_edges: 1 })).failures.length === 0)
    failures.push("assertAgreement accepted a census with 1 cited edge — the control cannot fail");
  return failures;
}

// ---------------------------------------------------------------------------
// probes — one per axis
// ---------------------------------------------------------------------------

const run = (cmd, args, opts) =>
  execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts });

/**
 * EXISTENCE axis: how many lines of `abs` match `pattern`.
 * A reader that refuses returns 0, which for a matching pattern is a
 * disagreement, not a quiet success.
 */
export function probeExists(readerId, root, relPath, pattern) {
  const abs = join(root, relPath);
  try {
    switch (readerId) {
      case "node":
        return readSourceLines(abs).filter((l) => l.includes(pattern)).length;
      case "grep-a":
        return Number(run("grep", ["-a", "-c", pattern, abs]).trim() || 0);
      case "grep-c":
      case "grep-plain":
        return Number(run("grep", ["-c", pattern, abs]).trim() || 0);
      case "rg-a":
        return Number(run("rg", ["--text", "-c", pattern, abs]).trim() || 0);
      case "rg-c":
      case "rg-plain":
        return Number(run("rg", ["-c", pattern, abs]).trim() || 0);
      case "git-grep":
        return Number(
          run("git", ["grep", "-c", pattern, "--", relPath], { cwd: root }).trim().split(":").pop() || 0,
        );
      case "git-grep-a":
        return Number(
          run("git", ["grep", "--text", "-c", pattern, "--", relPath], { cwd: root }).trim().split(":").pop() || 0,
        );
      default:
        throw new Error(`undeclared reader: ${readerId}`);
    }
  } catch (err) {
    if (err && typeof err.status === "number") return 0;
    throw err;
  }
}

/**
 * `grep`/`rg` emit `<line>:<content>`; `git grep` emits `<path>:<line>:<content>`.
 * Both forms are anchored on the line number, so both are tried. Anchoring on
 * ONE of them reports a working reader as blind — which is the exact shape of
 * failure this census exists to detect, produced by its own parser.
 */
const LINE_FORMS = [/^(\d+):/, /^(?:[^\s:]*\/)?(?:[^\s:]*):(\d+):/];

const splitLine = (l) => {
  for (const rx of LINE_FORMS) {
    const m = rx.exec(l);
    if (m) return { n: Number(m[1]), rest: l.slice(m[0].length) };
  }
  return null;
};

const pickLine = (out, lineNo) => {
  for (const l of out.split("\n")) {
    const p = splitLine(l);
    if (p && p.n === lineNo) return p.rest;
  }
  return null;
};

/**
 * The whole line-listing form of a file, parsed once. Same reader invocations as
 * `probeResolve`, batched per FILE rather than per line: 518 citations × 8
 * readers is 4,144 process spawns for the same 64 reads. A probe that cannot be
 * run is a probe that does not get run.
 */
export function readAllLines(readerId, root, relPath) {
  const abs = join(root, relPath);
  const map = new Map();
  const add = (out) => {
    for (const l of out.split("\n")) {
      const p = splitLine(l);
      if (p) map.set(p.n, p.rest);
    }
  };
  try {
    switch (readerId) {
      case "node": {
        const lines = readSourceLines(abs);
        lines.forEach((l, i) => {
          map.set(i + 1, l);
        });
        return map;
      }
      case "grep-a":
        add(run("grep", ["-a", "-n", "", abs]));
        return map;
      case "grep-plain":
        add(run("grep", ["-n", "", abs]));
        return map;
      case "rg-a":
        add(run("rg", ["--text", "-n", "--no-heading", "", abs]));
        return map;
      case "rg-plain":
        add(run("rg", ["-n", "--no-heading", "", abs]));
        return map;
      case "git-grep":
        add(run("git", ["grep", "-n", "-e", "", "--", relPath], { cwd: root }));
        return map;
      case "git-grep-a":
        add(run("git", ["grep", "--text", "-n", "-e", "", "--", relPath], { cwd: root }));
        return map;
      case "grep-c":
      case "rg-c":
        // Count-only by construction. Declared; excluded from RESOLVING_READERS.
        return map;
      default:
        throw new Error(`undeclared reader: ${readerId}`);
    }
  } catch (err) {
    if (err && typeof err.status === "number") return map;
    throw err;
  }
}

/**
 * RESOLUTION axis: the CONTENT of line `lineNo` (1-based) of `relPath`, or null
 * when the reader cannot produce it. This is the axis a `path:line` citation
 * needs, and the axis on which the toolchain disagreed.
 *
 * The pattern is the empty string: every reader's line-listing form, so the
 * probe asks for line N and nothing else. A blind reader returns nothing at all,
 * which is exactly the reported failure.
 */
export function probeResolve(readerId, root, relPath, lineNo) {
  const abs = join(root, relPath);
  try {
    switch (readerId) {
      case "node": {
        const l = readSourceLines(abs)[lineNo - 1];
        return l === undefined ? null : l;
      }
      case "grep-a":
        return pickLine(run("grep", ["-a", "-n", "", abs]), lineNo);
      case "grep-plain":
        return pickLine(run("grep", ["-n", "", abs]), lineNo);
      case "rg-a":
        return pickLine(run("rg", ["--text", "-n", "--no-heading", "", abs]), lineNo);
      case "rg-plain":
        return pickLine(run("rg", ["-n", "--no-heading", "", abs]), lineNo);
      case "git-grep":
        return pickLine(run("git", ["grep", "-n", "-e", "", "--", relPath], { cwd: root }), lineNo);
      case "git-grep-a":
        return pickLine(
          run("git", ["grep", "--text", "-n", "-e", "", "--", relPath], { cwd: root }),
          lineNo,
        );
      case "grep-c":
      case "rg-c":
        // Count-only by construction. Not a failure: declared, and excluded
        // from RESOLVING_READERS. null is the honest answer.
        return null;
      default:
        throw new Error(`undeclared reader: ${readerId}`);
    }
  } catch (err) {
    if (err && typeof err.status === "number") return null;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// census
// ---------------------------------------------------------------------------

const CITE_RX = /^(?<path>.+):(?<line>\d+)$/;

/** Every tracked, source-extension file carrying at least one NUL byte. */
export function nulBearingSources(root) {
  const paths = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" })
    .split("\0")
    .filter(Boolean);
  const out = [];
  for (const p of paths) {
    if (!/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(p)) continue;
    let n;
    let buf;
    try {
      buf = readFileSync(join(root, p));
    } catch {
      continue;
    }
    n = 0;
    for (const b of buf) if (b === 0) n += 1;
    if (n > 0)
      out.push({
        path: p,
        nul_bytes: n,
        nul_offset: buf.indexOf(0),
        lines: readSourceLines(join(root, p)).length,
      });
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : 1));
}

function citedEdges(edgesPath, scopeSet) {
  const per = new Map();
  const citations = new Set();
  const relations = new Map();
  for (const s of scopeSet) per.set(s, 0);
  for (const line of readFileSync(edgesPath, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    const m = CITE_RX.exec(e.evidence_location ?? "");
    if (!m) continue;
    const p = m.groups.path;
    if (!scopeSet.has(p)) continue;
    per.set(p, per.get(p) + 1);
    citations.add(`${p}:${Number(m.groups.line)}`);
    relations.set(e.relation, (relations.get(e.relation) ?? 0) + 1);
  }
  return { per, citations, relations };
}

function census(root, edgesPath) {
  const nulFiles = nulBearingSources(root);
  const cited = citedEdges(edgesPath, new Set(nulFiles.map((f) => f.path)));

  // The probe is each file's OWN cited lines — pre-existing evidence named by the
  // register, not a fresh convenient example. A pattern chosen from file
  // contents would be a new claim; a cited line is the corpus's own.
  const probeCitations = [...cited.citations]
    .map((c) => {
      const i = c.lastIndexOf(":");
      return { path: c.slice(0, i), line: Number(c.slice(i + 1)) };
    })
    .sort((a, b) => (a.path === b.path ? a.line - b.line : a.path < b.path ? -1 : 1));

  const perReader = [];
  for (const r of READERS) {
    // One listing per FILE, then every cited line is looked up in it. The
    // existence axis still runs per citation, but its readers are count-only
    // invocations on a pattern that appears in every one of the 7 files, so it
    // is batched per file too.
    const listings = new Map();
    for (const f of nulFiles) listings.set(f.path, readAllLines(r.id, root, f.path));
    const existsPerFile = new Map();
    for (const f of nulFiles) existsPerFile.set(f.path, probeExists(r.id, root, f.path, ""));

    let exists = 0;
    let resolved = 0;
    const existsMissed = [];
    const resolveMissed = [];
    for (const c of probeCitations) {
      if ((existsPerFile.get(c.path) ?? 0) > 0) exists += 1;
      else existsMissed.push(`${c.path}:${c.line}`);
      if ((listings.get(c.path)?.get(c.line) ?? null) !== null) resolved += 1;
      else resolveMissed.push(`${c.path}:${c.line}`);
    }
    perReader.push({
      id: r.id,
      label: r.label,
      note: r.note,
      needs: r.needs,
      declared_resolving: r.resolves,
      declared_existing: r.exists,
      citations_probed: probeCitations.length,
      exists_observed: exists,
      resolved_observed: resolved,
      exists_missed_sample: existsMissed.slice(0, 3),
      resolve_missed_sample: resolveMissed.slice(0, 3),
    });
  }

  return {
    nul_files: nulFiles,
    nul_bytes_total: nulFiles.reduce((a, f) => a + f.nul_bytes, 0),
    cited_edges: [...cited.per.values()].reduce((a, b) => a + b, 0),
    distinct_citations: cited.citations.size,
    relation_kinds: cited.relations.size,
    relations: Object.fromEntries([...cited.relations].sort()),
    per_file_cited: Object.fromEntries([...cited.per].sort()),
    per_reader: perReader,
  };
}

/**
 * A DECLARED-RESOLVING reader that misses any citation is the defect.
 * A DECLARED-NON-RESOLVING reader that misses is a documented fact, and its
 * blindness being reproduced is a NEGATIVE CONTROL, not a failure.
 */
export function evaluate(c) {
  const failures = [];
  for (const r of c.per_reader) {
    if (r.declared_resolving && r.resolved_observed !== r.citations_probed)
      failures.push(
        `reader ${r.id} declares it resolves citations but resolved ${r.resolved_observed}/${r.citations_probed} (${r.resolve_missed_sample.join(", ")})`,
      );
    if (r.declared_existing && r.exists_observed !== r.citations_probed)
      failures.push(
        `reader ${r.id} declares existence but observed ${r.exists_observed}/${r.citations_probed}`,
      );
  }
  return failures;
}

function selfcheck() {
  const f = [];
  if (READERS.length === 0) f.push("READERS is empty — the census has nothing to compare");
  const ids = new Set();
  for (const r of READERS) {
    if (ids.has(r.id)) f.push(`duplicate reader id: ${r.id}`);
    ids.add(r.id);
  }
  if (RESOLVING_READERS.length === 0) f.push("RESOLVING_READERS is empty — no reader may resolve a citation");
  if (NON_RESOLVING_READERS.length === 0)
    f.push("NON_RESOLVING_READERS is empty — the blind readers are dropped, which is the CD-H-01 shape");
  for (const id of ["grep-plain", "rg-plain", "grep-c", "rg-c", "git-grep"]) {
    const r = READERS.find((x) => x.id === id);
    if (!r) f.push(`declared reader ${id} is missing from READERS`);
    else if (r.resolves !== false) f.push(`${id} must be declared resolves:false`);
  }
  // The asserted layer must be shown able to fail, or removing it is invisible.
  f.push(...assertAgreementSelfTest().map((x) => `asserted-set self-test: ${x}`));
  return f;
}

// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
const cmd = argv[0] ?? "census";
const argOf = (n, d) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : d;
};

if (cmd === "readers") {
  for (const r of READERS)
    console.log(
      `${r.id.padEnd(12)} resolves=${String(r.resolves).padEnd(5)} exists=${String(r.exists).padEnd(5)} needs=${r.needs ?? "-"}  ${r.label}`,
    );
  process.exit(0);
}

if (cmd === "selfcheck") {
  const f = selfcheck();
  for (const x of f) console.error(`FAIL ${x}`);
  console.log(`selfcheck: ${f.length === 0 ? "OK" : `${f.length} failure(s)`}`);
  process.exit(f.length === 0 ? 0 : 1);
}

if (cmd !== "census") {
  console.error(`unknown command: ${cmd}`);
  process.exit(2);
}

const root = resolve(argOf("--root", process.cwd()));
const edges = resolve(argOf("--edges", join(root, ".visual-intelligence/graph/edges.jsonl")));
const json = argv.includes("--json");

const c = census(root, edges);
const failures = [...evaluate(c)];
// The second, non-derivable layer. The census above is structurally blind to
// any change in WHAT it looks at; this is what fails when that happens.
const asserted = assertAgreement(c);
const assertedFailures = asserted.failures;
// A deleted or stubbed asserted layer reports 0 checks performed, and the
// census refuses to call that a pass. Without this, M5 — replacing the whole
// coverage control with `[]` — is indistinguishable from a control that agreed.
if (asserted.checks < ASSERTED.minimum_checks)
  failures.push(
    `asserted-set layer performed ${asserted.checks} checks, minimum ${ASSERTED.minimum_checks} — the coverage control is not running`,
  );
failures.push(...assertedFailures);
const result = {
  ...c,
  resolving_readers: RESOLVING_READERS,
  non_resolving_readers: NON_RESOLVING_READERS,
  failures,
  census_failures: evaluate(c),
  asserted_failures: assertedFailures,
  asserted_checks: asserted.checks,
  ok: failures.length === 0,
};

if (json) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(`nul-bearing tracked sources: ${c.nul_files.length} (${c.nul_bytes_total} NUL bytes)`);
  for (const f of c.nul_files)
    console.log(
      `  ${String(f.nul_bytes).padStart(2)} NUL @${String(f.nul_offset).padStart(6)}  ${String(f.lines).padStart(5)} lines  ${f.path}`,
    );
  console.log(
    `cited edges: ${c.cited_edges}  distinct path:line: ${c.distinct_citations}  relation kinds: ${c.relation_kinds}`,
  );
  console.log(`resolving readers:            ${RESOLVING_READERS.join(", ")}`);
  console.log(`declared not able to resolve: ${NON_RESOLVING_READERS.join(", ")}`);
  for (const r of c.per_reader)
    console.log(
      `  ${r.id.padEnd(12)} resolved ${String(r.resolved_observed).padStart(4)}/${r.citations_probed}` +
        `${r.declared_resolving ? "" : "   (declared cannot resolve — negative control)"}`,
    );
  for (const x of failures) console.error(`FAIL ${x}`);
  if (failures.length) {
    console.error(
      "remedy: the NUL bytes are NOT the defect and must not be stripped. If a reader " +
        "disagrees, give it the text flag (grep -a, rg --text, git grep --text) or use " +
        "the node reader; see the note on the reader in `readers` output.",
    );
  }
}
process.exit(failures.length === 0 ? 0 : 1);
