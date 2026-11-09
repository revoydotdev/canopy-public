#!/usr/bin/env node
/**
 * scripts/completion-depth.mjs — code that is reachable, tested, and never runs.
 *
 *   bun scripts/completion-depth.mjs             # gate  (bun run gate:completion-depth)
 *   bun scripts/completion-depth.mjs --refresh   # rewrite the findings store
 *   bun scripts/completion-depth.mjs --triage <id> --verdict <v> --reason "..." [--expires <ISO>]
 *   ... --json
 *
 * THE TRIAGE SURFACE. Mirrors vi-findings.mjs's `--triage` exactly: same flag
 * names, same "missing arg -> usage, exit 2" / "unknown verdict -> exit 2" /
 * "unknown id -> exit 2" shape, same "verdict+reason are a human act, never
 * inferred" posture. It does NOT mirror vi-findings' `--rewrite-ids`,
 * `--prune-orphans`, or `--rehash`, and that is a considered omission, not a
 * gap:
 *   - `--rewrite-ids` exists because vi's ids can drift from the current id
 *     formula after a formula change. Here `extract()` recomputes every id
 *     fresh on every run from `[site.file, site.symbol, key]` and `main()`
 *     writes exactly that recomputed id on `--refresh` — there is no stale-id
 *     state to rewrite into alignment; it is already current by construction.
 *   - `--prune-orphans` exists because vi keeps verdicts in a SEPARATE
 *     `triage.jsonl` keyed by finding id, so a rotated id stands up a new row
 *     and stray the old one forever. Here the verdict lives INSIDE the same
 *     `findings.jsonl` row as the fact it triages — when a finding's id
 *     rotates, `main()`'s `priorByGatingKey` fallback (below) re-attaches the
 *     verdict to the new row by `gating_key`, and when the underlying
 *     condition disappears entirely the row is simply not re-emitted by
 *     `--refresh`. There is no second table to go stale, so nothing to prune.
 *   - `--rehash` migrates triage rows whose content-hash formula changed
 *     class-wide. Verdicts here are carried forward by id/gating_key alone
 *     (see the ADR-035 note below on why a content_hash change never reopens
 *     a verdict) — there is no hash-gated reopening to migrate.
 *
 * THE SHAPE THIS TARGETS. `gate:reachability` answers "can execution get here".
 * It cannot answer "and then does anything happen". A branch guarded on an
 * optional config key that no production composer ever sets is reachable,
 * covered by tests, exercised by a demo, and permanently dead in the real
 * process. `.visual-intelligence/README.md` names this the Hollow shape and
 * states plainly that it is **not structurally detectable**, that two instances
 * existed in this repository, and that no gate caught either.
 *
 * A third is live and confirmed at the time of writing:
 *
 *   packages/arbor-opencode/src/loop.ts:555
 *       const cardSelection = config.task_skills && config.task_skills.length > 0 ? … : …
 *
 *   `task_skills` is set in exactly two places — packages/arbor-mcp/src/demo.ts
 *   and packages/arbor-opencode/tests/loop.test.ts. `createProductionCampaignRunner`
 *   (packages/arbor-mcp/src/cli.ts:345-362) composes the production config from
 *   DEFAULT_LOOP_CONFIG plus eight explicit overrides and never sets it. So the
 *   branch is false on every real run of `arbor run`.
 *
 * WHAT THIS IS NOT. This does not detect Hollow in general, and it must not be
 * described as if it does — `.visual-intelligence/README.md`'s statement still
 * holds outside the two narrow shapes below. It detects TWO structurally-
 * decidable subsets, both keyed on the same guard/setter extraction:
 *
 *   SHAPE A — "no_production_setter": a guard on `<obj>.<KEY>` where every
 *   assignment of KEY in the repository lives in a test file or a demo file,
 *   and none in ordinary source. Unaffected by entrypoint-reachability; a key
 *   with zero production setters is dead on every root by definition.
 *
 *   SHAPE B — "root_partial": a guard on `<obj>.<KEY>` that DOES have a
 *   production setter, but the guard is reachable (per
 *   scripts/entrypoint-reachability.mjs's per-root partition of the committed
 *   graph) from at least one declared composition root whose own reachable
 *   set contains none of KEY's production setters. This is the case the old
 *   predicate (`if (prod.length > 0) continue`) could not see: "set by three
 *   long-lived roots, omitted by a fourth" looks identical to "set by the
 *   only root that matters" once you only ask "does ANY production setter
 *   exist". Consumes entrypoint-reachability.mjs's exported primitives
 *   (`loadGraph`, `declaredRoots`, `buildAdjacency`, `reachableFrom`,
 *   `analyzeEntrypointReachability`) rather than re-walking the graph itself.
 *   When that module's graph is absent or its own self-check disagrees with
 *   the committed graph, Shape B is silently unavailable (`shape: "unknown"`,
 *   never reported) rather than guessed at from stale data.
 *
 * SHAPE B'S TWO METHODOLOGY NARROWINGS (a live investigation, on the exact
 * commit that added Shape B, found six `root_partial` findings on this
 * repository's own tree and traced all six to two distinct weaknesses — both
 * now narrowed here, not merely triaged away):
 *
 *   NARROWING 1 — barrel/registry-mediated reachability is not genuine
 *   reachability. The vendored extractor records one file->file `exports`
 *   edge per barrel re-export line, independent of which symbol a consumer
 *   actually imports — so a root importing ONE symbol from a package looked
 *   reachable-to EVERY file the package's barrel re-exports. classifyRootCoverage
 *   now requires a GENUINE, symbol-precise invoking edge
 *   (`calls`/`instantiates`/`extends`/`implements`, landing on the guard's OWN
 *   enclosing symbol specifically, not merely somewhere in its file) before
 *   crediting a root with reaching the guard at all — see
 *   genuineInvokedRootsForFile's doc comment for the barrel case AND the
 *   closely-related "stored-but-uncalled" case (a function stored in a lookup
 *   object like `AGENT_PROMPTS`/`HOOK_HANDLERS` and only ever `references`-d,
 *   with no static evidence it was ever called). This check is deliberately
 *   GUARD-SIDE ONLY: the setter/coverage side stays permissive (any relation,
 *   still symbol-precise — see genuineRootsForFile) because this repository's
 *   genuine dispatch-table pattern is graph-shaped identically to the
 *   stored-but-uncalled false positive, and this module has no dataflow
 *   analysis to tell them apart (see SYNTAX ONLY below). Residual blind spot:
 *   a file with literally zero symbol/type nodes recorded anywhere in the
 *   graph (an extraction gap) falls back to the old, coarser file-level
 *   signal rather than reporting no root ever reaches it.
 *
 *   NARROWING 2 — a setter is paired to a guard BY KEY NAME ALONE
 *   (collectSetters and collectGuards never resolved which object shape a
 *   key belongs to), so a same-named property on an unrelated type — e.g.
 *   `BaselineResult.taskDescription` vs `PromptContext.taskDescription` —
 *   could stand in as "the" production setter, both wrongly crediting a root
 *   as covered and wrongly flagging another as partial. Each guard and setter
 *   site now also carries a `hint`: a container type NAME, recovered
 *   syntactically where possible (a parameter or `const`/`let`'s type
 *   annotation, unwrapping `Readonly<T>`/`Partial<T>`/arrays/non-null unions;
 *   or, for an object literal, the type of the variable/return it flows into
 *   directly — see namedTypeHint/scopeTypeHint/literalContainerHint). When a
 *   guard's hint is known and at least one apparent production setter's hint
 *   is ALSO known and DISAGREES, that is direct evidence the plain key-name
 *   pairing is unsafe for this key: Shape B then trusts only the setters whose
 *   hint explicitly agrees, dropping the rest (including ones with no
 *   recoverable hint) rather than keep guessing. Deliberately conservative in
 *   the other direction: this repository's real production setters are
 *   mostly deep in untyped JSON-schema/validated-record construction with no
 *   recoverable hint at all, so for MOST keys no collision is ever observed
 *   and Shape B's original name-only pairing is unchanged — a same-key,
 *   different-type collision this heuristic cannot syntactically SEE (no
 *   named type on either side) remains a real, named blind spot, not a
 *   solved problem.
 *
 * WHAT SHAPE B STILL CANNOT SEE, NAMED PRECISELY SO THIS IS NOT OVERCLAIMED:
 * the a2a defect that motivated building entrypoint-reachability.mjs is NOT
 * caught by Shape B either. `a2a-bridge.ts` is reachable from the production
 * CLI root; the two behaviors live inside ONE root file and differ by an
 * options object passed at a branch point, not by which root can reach which
 * FILE. Shape B partitions reachability per FILE (now per SYMBOL on the guard
 * side); distinguishing two branches inside the same reachable file/symbol
 * still needs dataflow analysis on which value reaches which call, a
 * different capability not built here or in entrypoint-reachability.mjs.
 * Shape B catches the case one level up: a key genuinely unset on some root's
 * composition path while set on another's — and, as of the two narrowings
 * above, only when that "genuinely" is itself backed by symbol-precise,
 * invocation-shaped, type-hint-consistent evidence rather than a bare
 * file-level or same-named edge.
 *
 * Everything else is invisible to it: a key set to a falsy value, a key set
 * behind another dormant branch, a mocked-but-present dependency, a guard on
 * something other than a property access. A finding here is a LEAD REQUIRING
 * HUMAN TRIAGE — the convention `gate:anti-stub` established, whose own first
 * run produced 10 findings of which 9 were false positives. The initial
 * completion-depth baseline is now triaged, so a new untriaged lead fails the
 * gate; a finding never forces a fix, only a recorded verdict.
 *
 * SYNTAX ONLY, ON PURPOSE. `ts.createSourceFile`, not a type-checked
 * `ts.Program`: the same scoping `anti-stub.mjs` chose, which keeps this cheap
 * enough to run at pre-push. It also means no cross-file type resolution
 * (`confidence` is never `authoritative` here) and no dataflow/binder-level
 * scope resolution — the type `hint`s above are a best-effort textual walk
 * that a same-named shadow in an unrelated scope can fool, and the
 * reachability narrowing above is confined to what the committed graph
 * already records, never a fresh dataflow pass of its own.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { computeEvidenceContentHashForStore, readGraphInputBinding } from "./lib/store-provenance.mjs";
import { assertEvidenceProducerAuthority } from "./evidence-transaction.mjs";
import { loadGraph, declaredRoots, buildAdjacency, reachableFrom, analyzeEntrypointReachability } from "./entrypoint-reachability.mjs";

function argValue(argv, flag) {
  const index = argv.indexOf(flag);
  return index === -1 ? undefined : argv[index + 1];
}

const REPO_ROOT = resolve(argValue(process.argv, "--repo") ?? join(dirname(fileURLToPath(import.meta.url)), ".."));
/** Overridable for fixture-based failure tests — see claim-ledger.ts's note. */
const STORE_DIR = process.env.REVOY2_COMPLETION_DEPTH_DIR
  ? resolve(process.env.REVOY2_COMPLETION_DEPTH_DIR)
  : join(REPO_ROOT, ".completion-depth");
const FINDINGS = join(STORE_DIR, "findings.jsonl");
const MANIFEST = join(STORE_DIR, "manifest.json");
const argv = process.argv.slice(2);
const REFRESH = argv.includes("--refresh");
const JSON_OUT = argv.includes("--json");
const TRIAGE_INDEX = argv.indexOf("--triage");

/**
 * completion-depth's own vocabulary, deliberately NOT identical to
 * vi-findings' `{false_positive, accepted_tradeoff, fixed, superseded}`:
 *
 *   - `false_positive` / `accepted_tradeoff` carry over unchanged — same
 *     meaning, same gate-closing effect (see ADR-035 O4).
 *   - `confirmed_hollow` replaces vi-findings' vocabulary entirely for the
 *     "yes, this branch really is dead" case — ADR-035 names it explicitly
 *     and the report already counts it (see `confirmed` below).
 *   - no `fixed`: fixing the underlying condition (adding a real production
 *     setter, or removing the guard) makes `extract()` stop reproducing the
 *     finding on the very next `--refresh` — there is no state left to mark
 *     "fixed" once that happens, unlike a vi-findings visual finding, which
 *     can persist as a structural fact even after its cause is addressed.
 *   - no `superseded`: each finding is 1:1 with one `gating_key`; nothing here
 *     is ever replaced by a sibling finding covering the same defect.
 */
const VALID_VERDICTS = new Set(["false_positive", "accepted_tradeoff", "confirmed_hollow"]);

function flagValue(name) {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

const require_ = createRequire(import.meta.url);
let ts;
try {
  ts = require_("typescript");
} catch {
  console.error("completion-depth: cannot resolve 'typescript' from this repository.");
  process.exitCode = 2;
}

const sha = (s) => createHash("sha256").update(s).digest("hex").slice(0, 16);
function canonical(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  const e = Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1));
  return `{${e.map(([k, x]) => `${JSON.stringify(k)}:${canonical(x)}`).join(",")}}`;
}

const FINDING_KEYS = [
  "id", "guard_file", "guard_line", "guard_symbol", "gating_expression", "gating_key",
  "setters", "production_setter_count", "test_setter_count", "demo_setter_count",
  "production_reachable_unset", "shape", "missing_from_roots", "confidence", "verdict", "verdict_reason",
  "first_seen", "first_seen_date", "triage_expires", "last_verified", "content_hash",
];

/**
 * Days from a finding's first appearance to its recorded `triage_expires`
 * date. NOT a grace period before the gate starts failing — see the
 * "post-adoption ratchet" correction below, and do not restore language that
 * implies otherwise; that exact framing was audited and found to
 * contradict `main()`'s actual `ok` computation (`untriaged.length === 0`,
 * never gated on `expired`).
 *
 * WHY IT EXISTS ANYWAY. Before the baseline was fully triaged, this WAS a
 * grace period, deliberately modeled on `scripts/reachability/allowlist.json`
 * (a dated waiver that only fails once `expires` passes) — see ADR-035
 * decision point 4: "Blocking on new high/medium untriaged findings is a
 * later decision, to be taken only with triage evidence in hand." That
 * decision was taken 2026-08-08 (the "post-adoption ratchet"): once the
 * complete baseline had a reasoned verdict, `gate:completion-depth` was
 * switched to fail on ANY untriaged finding immediately, not merely an
 * expired one. Nothing in `main()`'s `ok` computation was changed to keep
 * honoring `triage_expires` as a deadline; it is why `expired_untriaged` in
 * the `--json` report is informational only.
 *
 * WHAT triage_expires IS FOR NOW: a target date surfaced in the report
 * (`triage by <date>`, `** EXPIRED **`) so a human can see how overdue an
 * unanswered finding already is. It carries no gating effect of its own —
 * the gate already blocked on day one.
 */
const TRIAGE_WINDOW_DAYS = 30;
const DAY_MS = 86_400_000;

const isTestPath = (p) => /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[cm]?[jt]sx?$/.test(p);
const isDemoPath = (p) => /(^|\/)demo(\.[cm]?ts|\/)/.test(p);

/** Keys too generic to reason about from syntax alone; a guard on them says nothing. */
const IGNORED_KEYS = new Set([
  "length", "name", "type", "kind", "id", "value", "data", "message", "error",
  "status", "code", "path", "file", "line", "size", "index", "key", "url",
  "connected",
]);

/**
 * Per-file root membership, built from entrypoint-reachability.mjs's own
 * exported primitives (never re-walked here). Mirrors the loop
 * `analyzeEntrypointReachability` runs internally to build `rootsByNode`,
 * which that module does not export — its own report strips `reached` before
 * returning (see its "roots: perRoot.map(({reached, ...rest}) => rest)").
 *
 * `available` is false — and callers must then treat Shape B as undecidable,
 * never absent-therefore-fine — whenever: the graph has not been built, no
 * roots are declared, or entrypoint-reachability's own self-check disagrees
 * with the committed graph (a stale mirror must not silently back a claim).
 */
/**
 * Relations trusted as evidence of a genuine, invoking path into a symbol —
 * as opposed to `imports`/`exports` (barrel re-export plumbing) and
 * `references` (can mean "took a pointer to it", e.g. storing a function in
 * a lookup table, with no evidence it was ever CALLED). See
 * classifyRootCoverage's doc comment for why this matters only on the GUARD
 * side of the coverage question, never the setter side.
 */
const INVOKING_RELATIONS = new Set(["calls", "instantiates", "extends", "implements"]);

export function computeRootsByFile({ repo = REPO_ROOT } = {}) {
  const unavailable = {
    available: false, rootsByNode: new Map(), allRootIds: [],
    symbolNodesByFile: new Map(), invocationSourcesBySymbol: new Map(), filesWithSymbols: new Set(),
  };
  let graph;
  try {
    graph = loadGraph(repo);
  } catch {
    return unavailable;
  }
  if (!graph.nodes.length) return unavailable;
  const roots = declaredRoots(repo);
  if (roots.length === 0) return unavailable;

  const adjacency = buildAdjacency(graph.edges);
  const rootsByNode = new Map();
  for (const root of roots) {
    const reached = reachableFrom(root.node, adjacency);
    for (const id of reached) {
      if (!rootsByNode.has(id)) rootsByNode.set(id, new Set());
      rootsByNode.get(id).add(root.id);
    }
  }

  // Symbol/type node ids per file (PERMISSIVE — every symbol/type node, reached
  // via ANY relation) and, separately, per SPECIFIC symbol/type node the
  // SOURCES of edges that genuinely INVOKE it (calls/instantiates/extends/
  // implements, never merely imports/exports/references) (STRICT — see
  // genuineInvokedRootsForFile, which needs the guard's OWN enclosing symbol
  // to be the invoked one, not just some other, unrelated symbol in the same
  // file: a file-wide OR-across-all-symbols version of this check let one
  // genuinely-called helper in a file vouch for an entirely different,
  // merely-referenced sibling in the same file — see the file header's
  // account of `foregroundBlock` vouching for `crownPrompt`). fileOfNode and
  // filesWithSymbols distinguish "genuinely unreached" from "extraction never
  // recorded this file's symbols at all" — see genuineRootsForFile's FALLBACK
  // note.
  const fileOfNode = new Map();
  const symbolNodesByFile = new Map();
  const filesWithSymbols = new Set();
  for (const node of graph.nodes) {
    if (node.kind !== "symbol" && node.kind !== "type") continue;
    if (!node.repository_path) continue;
    fileOfNode.set(node.id, node.repository_path);
    filesWithSymbols.add(node.repository_path);
    if (!symbolNodesByFile.has(node.repository_path)) symbolNodesByFile.set(node.repository_path, []);
    symbolNodesByFile.get(node.repository_path).push(node.id);
  }

  const invocationSourcesBySymbol = new Map();
  for (const edge of graph.edges) {
    if (!INVOKING_RELATIONS.has(edge.relation)) continue;
    if (!fileOfNode.has(edge.target)) continue;
    if (!invocationSourcesBySymbol.has(edge.target)) invocationSourcesBySymbol.set(edge.target, []);
    invocationSourcesBySymbol.get(edge.target).push(edge.source);
  }

  const filePathByNode = new Map(graph.nodes
    .filter((node) => node.kind === "file" && node.repository_path)
    .map((node) => [node.id, node.repository_path]));
  const directImportsByFile = new Map();
  for (const edge of graph.edges) {
    if (edge.relation !== "imports") continue;
    const source = filePathByNode.get(edge.source);
    const target = filePathByNode.get(edge.target);
    if (!source || !target) continue;
    if (!directImportsByFile.has(source)) directImportsByFile.set(source, new Set());
    directImportsByFile.get(source).add(target);
  }

  const check = analyzeEntrypointReachability({ repo });
  return {
    available: check.ok, rootsByNode, allRootIds: roots.map((r) => r.id),
    symbolNodesByFile, invocationSourcesBySymbol, filesWithSymbols, directImportsByFile,
  };
}

/**
 * Roots that GENUINELY reach `file` — roots whose reachable set (the
 * unmodified, vendored-mirroring BFS in `rootsByNode`) contains the SOURCE of
 * at least one `calls`/`instantiates`/`extends`/`implements` edge landing on
 * a symbol or type declared IN `file`. Plain file-level reachability is not
 * enough, and neither is `imports`/`exports`/`references` alone.
 *
 * WHY NOT FILE-LEVEL. The vendored extractor emits one file->file `exports`
 * edge per re-export line in a barrel (e.g.
 * `packages/arbor-core/src/index.ts`), independent of which named symbol a
 * consumer actually imports — so a root that imports ONE symbol from a
 * package is credited with file-level reachability of EVERY file the
 * package's barrel re-exports. That inflated file-level edge produced five of
 * the six false `root_partial` findings the barrel-reachability
 * investigation traced (see the file header's WEAKNESS 1 note):
 * `arbor-opencode-plugin` reaches
 * `operation-registry.ts`/`surveillance.ts`/`decomposition-prompt.ts` purely
 * through `@arbor/core`'s and `@arbor/prompts`' barrels, landing on zero
 * symbol/type nodes inside any of them (verified live against this
 * repository's own graph).
 *
 * FALLBACK (both variants below): a file with zero symbol/type nodes recorded
 * anywhere in the graph (`!filesWithSymbols.has(file)`) is a real, if rare,
 * extraction gap — not "genuinely unreached" — and falls back to the coarse
 * file-level signal rather than pretending no root ever reaches it.
 */
function genuineRootsForFile(file, { rootsByNode, symbolNodesByFile, filesWithSymbols }) {
  if (!filesWithSymbols.has(file)) return rootsByNode.get(`file:${file}`) ?? new Set();
  const roots = new Set();
  for (const symId of symbolNodesByFile.get(file) ?? []) {
    const owners = rootsByNode.get(symId);
    if (owners) for (const id of owners) roots.add(id);
  }
  return roots;
}

/**
 * STRICTER than genuineRootsForFile: requires the root to reach a SOURCE that
 * genuinely INVOKES (`calls`/`instantiates`/`extends`/`implements`) the
 * guard's OWN enclosing symbol (`guardSymbol`, e.g. `crownPrompt`) — not
 * merely reference it, and not merely invoke some OTHER, unrelated symbol
 * that happens to live in the same file. A `references` edge only means a
 * symbol was NAMED somewhere reachable — including being stored as a value in
 * a lookup object, e.g. `const AGENT_PROMPTS = { crown: crownPrompt, ... }`
 * — with no evidence it was ever CALLED. Using the permissive
 * genuineRootsForFile for the GUARD side reproduced the exact same shape of
 * false positive one level down from the barrel case:
 * `packages/arbor-opencode/src/agents.ts`'s `buildAllAgents` references
 * `AGENT_PROMPTS` (to read its keys, never call its values) and that
 * reference alone made every prompt function, including ones reading
 * `ctx?.campaignId`, look genuinely reachable. And checking the whole FILE for
 * ANY invoked symbol is not enough either: `crownPrompt` itself calls a
 * genuinely-invoked sibling, `foregroundBlock`, in the SAME file — a
 * file-wide check would have let that internal call vouch for `crownPrompt`
 * even though nothing outside the file ever calls `crownPrompt` itself. Hence
 * `guardSymbol` precision: this asks whether the guard's OWN function was
 * called, not whether ANYTHING in its file was.
 *
 * WHY THIS IS GUARD-SIDE ONLY, NEVER SETTER-SIDE. Tightening the SETTER side
 * the same way regresses real coverage: this repository's dispatch-table
 * pattern (`HOOK_HANDLERS`, a `{ tool_audit: toolAuditNotes, ... }` map
 * invoked as `HOOK_HANDLERS[key](...)`) is graph-shaped identically to
 * `AGENT_PROMPTS` — a registry object `references`-ing its own function
 * values — yet its handlers ARE the genuine production setters. Distinguishing
 * "dispatched by a runtime key" from "enumerated but never invoked" needs
 * dataflow analysis this module does not have (see the file header's SYNTAX
 * ONLY note); the asymmetry below is deliberate, not an oversight. A false
 * REACHABLE-guard signal manufactures a finding (this module's over-firing
 * problem); a false UNREACHED-setter signal ALSO manufactures a finding, so
 * the safe default for the setter side stays permissive.
 */
function genuineInvokedRootsForFile(file, guardSymbol, info) {
  const { rootsByNode, symbolNodesByFile, invocationSourcesBySymbol, filesWithSymbols } = info;
  if (!filesWithSymbols.has(file)) return rootsByNode.get(`file:${file}`) ?? new Set();

  const candidates = (symbolNodesByFile.get(file) ?? []).filter((id) => id.endsWith(`::${guardSymbol}`));
  // No precise symbol id to key off — e.g. "(module scope)"/"(anonymous)", or
  // this repository's extractor never recorded that exact name. Falls back to
  // "was ANYTHING in this file genuinely invoked", the same permissive
  // per-file signal genuineRootsForFile uses, rather than reporting no root
  // ever reaches it.
  if (candidates.length === 0) return genuineRootsForFile(file, info);

  const roots = new Set();
  for (const symId of candidates) {
    for (const source of invocationSourcesBySymbol.get(symId) ?? []) {
      const owners = rootsByNode.get(source);
      if (owners) for (const id of owners) roots.add(id);
    }
  }
  return roots;
}

/**
 * Shape B's decision: is `guardFile` reachable from a declared root that no
 * production setter of the same key can also reach?
 *
 * Returns `"unknown"` (never a finding) whenever reachability data is
 * unavailable, or the guard file itself is not GENUINELY, INVOKING-ly reached
 * by any root (a file outside `packages/` — e.g. a script — cannot be judged
 * this way; neither can a file reached only through a barrel or a
 * stored-but-uncalled reference, per genuineInvokedRootsForFile). Returns
 * `"fully_covered"` when every root that genuinely invokes the guard also
 * genuinely reaches (invocation OR reference — see genuineRootsForFile) at
 * least one production setter. Returns `"root_partial"` with the offending
 * root ids otherwise — this is the real finding.
 */
export function classifyRootCoverage({ guardFile, guardSymbol, prodSetterFiles }, rootsInfo) {
  const { available, allRootIds } = rootsInfo;
  if (!available || allRootIds.length === 0) return { shape: "unknown", missingFromRoots: [] };
  const guardRoots = genuineInvokedRootsForFile(guardFile, guardSymbol, rootsInfo);
  if (guardRoots.size === 0) return { shape: "unknown", missingFromRoots: [] };

  const coveredRoots = new Set();
  for (const file of prodSetterFiles) {
    for (const id of genuineRootsForFile(file, rootsInfo)) coveredRoots.add(id);
    if (rootsInfo.directImportsByFile?.get(guardFile)?.has(file)) {
      for (const id of guardRoots) coveredRoots.add(id);
    }
  }

  const missingFromRoots = [...guardRoots].filter((id) => !coveredRoots.has(id)).sort();
  return missingFromRoots.length > 0
    ? { shape: "root_partial", missingFromRoots }
    : { shape: "fully_covered", missingFromRoots: [] };
}

function walkFiles(dir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith(".")) continue;
      walkFiles(p, acc);
    } else if (/\.[cm]?tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
      acc.push(p);
    }
  }
  return acc;
}

const isFunctionLikeNode = (n) =>
  !!n && (ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n) || ts.isMethodDeclaration(n) || ts.isConstructorDeclaration(n));

/**
 * Unwraps a type annotation down to a stable NAME — `Readonly<Foo>`,
 * `Partial<Foo>[]`, `Foo | undefined` all resolve to `"Foo"` — and returns
 * null for anything without one (inline object types, keyword types like
 * `never`/`unknown`, ambiguous unions). Null means "no hint", never a
 * spurious one: an inline type literal's raw text is not a name two
 * independent sites would ever coincidentally share, so treating it as one
 * would manufacture false mismatches instead of avoiding them.
 */
function namedTypeHint(typeNode) {
  if (!typeNode) return null;
  if (ts.isParenthesizedTypeNode(typeNode)) return namedTypeHint(typeNode.type);
  if (ts.isArrayTypeNode(typeNode)) return namedTypeHint(typeNode.elementType);
  if (ts.isUnionTypeNode(typeNode)) {
    const named = [...new Set(typeNode.types.map(namedTypeHint).filter(Boolean))];
    return named.length === 1 ? named[0] : null;
  }
  if (ts.isTypeReferenceNode(typeNode)) {
    const name = typeNode.typeName.getText();
    const TRANSPARENT = new Set(["Readonly", "Partial", "Required", "Pick", "Omit", "Array", "ReadonlyArray"]);
    if (TRANSPARENT.has(name) && typeNode.typeArguments?.length === 1) return namedTypeHint(typeNode.typeArguments[0]);
    return name;
  }
  return null;
}

/**
 * The nearest declared type of identifier `name` in scope above `useNode`: a
 * function parameter, or a `const`/`let` with an explicit annotation.
 * SYNTAX ONLY, like the rest of this module (see the file header) — this
 * walks lexical scopes textually, not through the binder, so a same-named
 * shadow in an unrelated scope can fool it. That is an accepted, narrow risk:
 * it only ever produces a HINT consulted for a mismatch signal, never treated
 * as authoritative on its own (see classifyRootCoverage's caller in extract()).
 */
function scopeTypeHint(name, useNode) {
  let cur = useNode;
  while (cur) {
    if (isFunctionLikeNode(cur)) {
      for (const param of cur.parameters ?? []) {
        if (ts.isIdentifier(param.name) && param.name.text === name && param.type) return namedTypeHint(param.type);
      }
    }
    if (ts.isBlock(cur) || ts.isSourceFile(cur)) {
      for (const stmt of cur.statements) {
        if (!ts.isVariableStatement(stmt)) continue;
        for (const decl of stmt.declarationList.declarations) {
          if (ts.isIdentifier(decl.name) && decl.name.text === name && decl.type) return namedTypeHint(decl.type);
        }
      }
    }
    cur = cur.parent;
  }
  return null;
}

/**
 * The declared type, if any, that object literal `node` is being assigned
 * into: a typed variable, an `as T` assertion, or the enclosing function's
 * declared return type when the literal is a direct `return` value.
 * Everything else — a call argument, an array element, a nested property
 * value — is unknown: resolving those needs the callee's own signature,
 * which is exactly the type-checking `ts.createSourceFile` deliberately does
 * not do here (see the file header's SYNTAX ONLY note).
 */
function literalContainerHint(node) {
  const parent = node.parent;
  if (!parent) return null;
  if (ts.isAsExpression(parent)) return namedTypeHint(parent.type);
  if (ts.isVariableDeclaration(parent) && parent.type) return namedTypeHint(parent.type);
  if (ts.isArrowFunction(parent) && parent.body === node) {
    return parent.type ? namedTypeHint(parent.type) : null;
  }
  if (ts.isReturnStatement(parent)) {
    let f = parent.parent;
    while (f && !isFunctionLikeNode(f)) f = f.parent;
    return f?.type ? namedTypeHint(f.type) : null;
  }
  return null;
}

function enclosingSymbol(node) {
  let cur = node;
  while (cur) {
    if (ts.isConstructorDeclaration(cur)) {
      const owner = cur.parent;
      return (ts.isClassDeclaration(owner) || ts.isClassExpression(owner))
        ? owner.name?.getText() ?? "(anonymous)"
        : "(anonymous)";
    }
    if (ts.isFunctionDeclaration(cur) || ts.isMethodDeclaration(cur)) return cur.name?.getText() ?? "(anonymous)";
    if (ts.isVariableDeclaration(cur) && cur.initializer &&
        (ts.isArrowFunction(cur.initializer) || ts.isFunctionExpression(cur.initializer))) {
      return cur.name?.getText() ?? "(anonymous)";
    }
    cur = cur.parent;
  }
  return "(module scope)";
}

function expressionRoot(expression) {
  let root = expression;
  while (ts.isPropertyAccessExpression(root) || ts.isElementAccessExpression(root) || ts.isParenthesizedExpression(root)
    || ts.isAsExpression(root) || ts.isTypeAssertionExpression(root) || ts.isNonNullExpression(root) || ts.isSatisfiesExpression(root)) {
    root = root.expression;
  }
  return root;
}

/**
 * Resolve an identifier to its nearest lexical origin. This deliberately
 * follows only initialized `const` bindings: an immutable alias preserves an
 * input's provenance, while a mutable/reassigned value is ambiguous and must
 * remain eligible for analysis.
 */
function nearestLexicalOrigin(name, useNode) {
  const usePosition = useNode.getStart();
  let current = useNode;
  while (current) {
    if (ts.isBlock(current) || ts.isSourceFile(current)) {
      for (const statement of current.statements) {
        if (!ts.isVariableStatement(statement)) continue;
        for (const declaration of statement.declarationList.declarations) {
          if (!ts.isIdentifier(declaration.name) || declaration.name.text !== name) continue;
          // Any nearer declaration shadows an outer parameter, including one
          // declared later (TDZ). Only a preceding initialized const is a
          // provenance-preserving alias; every other binding is unknown.
          if (statement.getStart() >= usePosition) return { kind: "unknown" };
          const isConst = (statement.declarationList.flags & ts.NodeFlags.Const) !== 0;
          if (!isConst || !declaration.initializer) return { kind: "unknown" };
          return { kind: "alias", initializer: declaration.initializer, declaration };
        }
      }
    }
    if (isFunctionLikeNode(current)) {
      if ((current.parameters ?? []).some((parameter) => ts.isIdentifier(parameter.name) && parameter.name.text === name)) {
        return { kind: "parameter" };
      }
    }
    current = current.parent;
  }
  return null;
}

function parameterRooted(expression, useNode, seen = new Set()) {
  const root = expressionRoot(expression);
  if (!ts.isIdentifier(root)) return false;
  const origin = nearestLexicalOrigin(root.text, useNode);
  if (!origin) return false;
  if (origin.kind === "parameter") return true;
  if (origin.kind === "unknown") return false;
  if (seen.has(origin.declaration)) return false;
  seen.add(origin.declaration);
  return parameterRooted(origin.initializer, origin.declaration, seen);
}

/**
 * A guard site: `<obj>.<KEY>` appearing as the condition of an `if`, a ternary,
 * or the left operand of `&&`/`||`. Those are the positions where the property's
 * absence changes control flow — which is the whole question.
 */
export function collectGuards(sourceFile, rel) {
  const guards = [];
  const consider = (expr, host) => {
    if (!expr) return;
    let e = expr;
    while (ts.isParenthesizedExpression(e) || ts.isPrefixUnaryExpression(e)) {
      e = ts.isParenthesizedExpression(e) ? e.expression : e.operand;
    }
    const candidates = [];
    if (ts.isBinaryExpression(e) &&
        (e.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
         e.operatorToken.kind === ts.SyntaxKind.BarBarToken)) {
      candidates.push(e.left);
    } else {
      candidates.push(e);
    }
    for (let c of candidates) {
      while (ts.isParenthesizedExpression(c) || ts.isPrefixUnaryExpression(c)) {
        c = ts.isParenthesizedExpression(c) ? c.expression : c.operand;
      }
      if (!ts.isPropertyAccessExpression(c)) continue;
      const key = c.name.getText();
      if (IGNORED_KEYS.has(key)) continue;
      const { line } = sourceFile.getLineAndCharacterOfPosition(host.getStart(sourceFile));
      guards.push({
        file: rel, line: line + 1, key,
        expression: e.getText(sourceFile).replace(/\s+/g, " ").slice(0, 120),
        symbol: enclosingSymbol(host),
        // Object's declared type, when a simple `<identifier>.<key>` guard's
        // identifier resolves to one syntactically — see scopeTypeHint. Used
        // only as a mismatch signal against setters, never on its own.
        hint: ts.isIdentifier(c.expression) ? scopeTypeHint(c.expression.text, c) : null,
        parameter_rooted: parameterRooted(c.expression, c),
      });
    }
  };

  const visit = (node) => {
    if (ts.isIfStatement(node)) consider(node.expression, node);
    else if (ts.isConditionalExpression(node)) consider(node.condition, node);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return guards;
}

/**
 * Every place a key is ASSIGNED: object-literal property, or `x.KEY = ...`.
 *
 * `sink` is a Map, not a plain object: a source key named `constructor`,
 * `toString`, or `__proto__` resolves to Object.prototype's member on a bare
 * `{}`, so `sink[key] ??= []` silently does not fire and the push explodes.
 * Real code in this repository has such keys.
 */
export function collectSetters(sourceFile, rel, sink) {
  const push = (key, entry) => {
    if (!sink.has(key)) sink.set(key, []);
    sink.get(key).push(entry);
  };
  const visit = (node) => {
    if (ts.isPropertyAssignment(node) && (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name))) {
      const key = node.name.text;
      const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      push(key, { file: rel, line: line + 1, hint: literalContainerHint(node.parent) });
    } else if (ts.isShorthandPropertyAssignment(node)) {
      const key = node.name.text;
      const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      push(key, { file: rel, line: line + 1, hint: literalContainerHint(node.parent) });
    } else if ((ts.isMethodDeclaration(node) || ts.isPropertyDeclaration(node)) &&
               (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name))) {
      // A class member satisfies an interface key just as an object literal's
      // property does. Without this branch the walk sees only `{ key: ... }`
      // and `obj.key = ...`, so a port implemented as a class — the dominant
      // shape in packages/arbor-mcp — reads as having no production setter at
      // all. That produced three standing false positives:
      // CampaignManager.persistRetryTransition and .persistAbandonment
      // (manager.ts:1273,1359) and WorktreeMachineVerifier.verifyOutcome
      // (worktree-machine-verifier.ts:250), each satisfied by a real method.
      //
      // This can only ever REMOVE false positives, never suppress a true one:
      // Shape A fires when a key has ZERO recognised setters, so widening what
      // counts as a setter is strictly one-directional. It cannot cause this
      // detector to under-fire.
      const key = node.name.text;
      const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      const owner = node.parent;
      const hint = owner && ts.isClassDeclaration(owner) && owner.name ? owner.name.text : null;
      push(key, { file: rel, line: line + 1, hint });
    } else if (ts.isBinaryExpression(node) &&
               node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
               ts.isPropertyAccessExpression(node.left)) {
      const key = node.left.name.getText();
      const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      const obj = node.left.expression;
      push(key, { file: rel, line: line + 1, hint: ts.isIdentifier(obj) ? scopeTypeHint(obj.text, node) : null });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
}

function extract({ rootsInfo = computeRootsByFile() } = {}) {
  const roots = [join(REPO_ROOT, "packages")];
  const files = [];
  for (const r of roots) if (existsSync(r) && statSync(r).isDirectory()) walkFiles(r, files);
  const sourceFiles = new Set(files.map((file) => relative(REPO_ROOT, file)));
  const directImportsByFile = new Map(rootsInfo.directImportsByFile ?? []);

  const guards = [];
  const setters = new Map();
  for (const abs of files) {
    const rel = relative(REPO_ROOT, abs);
    const text = readFileSync(abs, "utf8");
    const sf = ts.createSourceFile(abs, text, ts.ScriptTarget.Latest, true);
    for (const statement of sf.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
      const specifier = statement.moduleSpecifier.text;
      if (!specifier.startsWith(".")) continue;
      const imported = resolve(dirname(rel), specifier).replace(/\.(?:mjs|cjs|js)$/, ".ts");
      if (!sourceFiles.has(imported)) continue;
      if (!directImportsByFile.has(rel)) directImportsByFile.set(rel, new Set());
      directImportsByFile.get(rel).add(imported);
    }
    collectSetters(sf, rel, setters);
    // Guards in tests/demos are not the finding — a dormant branch inside a test
    // is a test detail. Only production source can host a Hollow branch.
    if (!isTestPath(rel) && !isDemoPath(rel)) guards.push(...collectGuards(sf, rel));
  }
  rootsInfo.directImportsByFile = directImportsByFile;

  const byKey = new Map();
  for (const g of guards) {
    if (!byKey.has(g.key)) byKey.set(g.key, []);
    byKey.get(g.key).push(g);
  }

  const findings = [];
  for (const [key, sites] of byKey) {
    const all = setters.get(key) ?? [];
    const prod = all.filter((s) => !isTestPath(s.file) && !isDemoPath(s.file));
    const test = all.filter((s) => isTestPath(s.file));
    const demo = all.filter((s) => isDemoPath(s.file));
    // Zero setters anywhere is a different thing (an external/injected value)
    // and is deliberately not reported — it would be mostly noise.
    if (all.length === 0) continue;

    // Filesystem traversal order differs across worktrees. One finding exists
    // per gating key, so choose its representative site deterministically.
    const site = [...sites].sort((a, b) =>
      a.file.localeCompare(b.file) || a.line - b.line || a.symbol.localeCompare(b.symbol)
    )[0];
    // Function parameters are host/injection inputs. Shape A already ignores
    // them when no repository setter exists; unrelated setters elsewhere must
    // not turn the same external-input shape into a Shape B finding.
    if (site.parameter_rooted) continue;

    let shape;
    let missingFromRoots = [];
    let confidence;
    if (prod.length === 0) {
      // SHAPE A: guarded in production source, assigned ONLY by tests/demos.
      shape = "no_production_setter";
      // Demo-only assignment is the stronger signal: someone wired the branch
      // for a demonstration and never for the real path. Test-only alone is
      // weaker — the value may legitimately arrive from outside this repository.
      confidence = demo.length > 0 ? "high" : "medium";
    } else {
      // SHAPE B: a production setter exists SOMEWHERE, but does it cover
      // every declared root that can reach this guard? See classifyRootCoverage.
      //
      // Setter/guard pairing is still by KEY NAME ALONE — collectSetters
      // records every `{ key: ... }` and `x.key = ...` in the repository
      // under one name, with no notion of which object shape it belongs to.
      // Before trusting that pairing, look for direct evidence it is wrong:
      // a production setter whose OWN syntactically-recovered container type
      // (see literalContainerHint/scopeTypeHint) is a different named type
      // than the guard's. Finding even one is a same-key, different-type
      // collision — e.g. `BaselineResult.taskDescription` vs
      // `PromptContext.taskDescription` — and it means the setter list this
      // key collected is not trustworthy as-is. When that happens, keep only
      // the setters whose hint explicitly AGREES with the guard's; a setter
      // with no recoverable hint is dropped too rather than given the
      // benefit of the doubt, because the whole reason to distrust the list
      // is that "no evidence either way" is exactly what let the collision
      // through unnoticed. Most real code in this repository has no
      // syntactically-recoverable hint at all (JSON-schema construction,
      // validated `unknown` records, call-argument object literals) — for
      // THOSE keys no collision is ever observed, so this never fires and
      // Shape B's original name-only pairing is unchanged.
      const guardHint = site.hint;
      let evidence = prod;
      if (guardHint && prod.some((s) => s.hint && s.hint !== guardHint)) {
        evidence = prod.filter((s) => s.hint === guardHint);
      }
      if (evidence.length === 0) continue; // every apparent setter was a same-key, different-type collision

      const coverage = classifyRootCoverage(
        { guardFile: site.file, guardSymbol: site.symbol, prodSetterFiles: evidence.map((s) => s.file) },
        rootsInfo,
      );
      if (coverage.shape !== "root_partial") continue; // fully_covered or unknown — not a finding
      shape = "root_partial";
      missingFromRoots = coverage.missingFromRoots;
      confidence = "medium"; // graph-derived, but same key-name-pairing risk as Shape A
    }

    const base = {
      guard_file: site.file, guard_line: site.line, guard_symbol: site.symbol,
      gating_expression: site.expression, gating_key: key,
      setters: all.map((s) => `${s.file}:${s.line}`).sort(),
      production_setter_count: prod.length,
      test_setter_count: test.length, demo_setter_count: demo.length,
      production_reachable_unset: true,
      shape, missing_from_roots: missingFromRoots,
      confidence,
    };
    findings.push({
      id: `hollow:${sha(canonical([site.file, site.symbol, key]))}`,
      ...base,
      verdict: "untriaged", verdict_reason: "",
      first_seen: "", first_seen_date: "", triage_expires: "", last_verified: "",
      content_hash: sha(canonical([site.file, site.symbol, key, base.setters, shape, missingFromRoots])),
    });
  }
  return findings.sort((a, b) => (a.id < b.id ? -1 : 1));
}

function readStore() {
  const map = new Map();
  if (!existsSync(FINDINGS)) return map;
  for (const line of readFileSync(FINDINGS, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try { const r = JSON.parse(line); map.set(r.id, r); } catch { /* skip */ }
  }
  return map;
}

/** Same rows as readStore(), as an array preserving on-disk order — what --triage edits. */
function readStoreArray() {
  if (!existsSync(FINDINGS)) return [];
  return readFileSync(FINDINGS, "utf8").split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l));
}

function writeFindingsOnly(findings) {
  mkdirSync(STORE_DIR, { recursive: true });
  const body = findings
    .map((f) => `{${FINDING_KEYS.map((k) => `${JSON.stringify(k)}:${canonical(f[k])}`).join(",")}}`)
    .join("\n");
  writeFileSync(FINDINGS, findings.length ? `${body}\n` : "", "utf8");
}

function writeStore(findings, rev) {
  mkdirSync(STORE_DIR, { recursive: true });
  // See gate:store-freshness: a manual producer with no revision marker is a
  // store that quietly stops describing the repository.
  writeFileSync(MANIFEST, `${JSON.stringify({
    schema_version: 1,
    scanned_up_to_revision: rev,
    content_hash: computeEvidenceContentHashForStore(REPO_ROOT, "completion-depth"),
    // ADR-183: the graph this scan consumed, by input binding (null = none).
    graph_input_binding: readGraphInputBinding(REPO_ROOT),
    scanned_at: new Date().toISOString(),
    finding_count: findings.length,
  }, null, 2)}\n`, "utf8");
  writeFindingsOnly(findings);
}

// ---------------------------------------------------------------------------
// --triage
// ---------------------------------------------------------------------------

/**
 * Unlike vi-findings' triageOne(), this never invents first_seen/first_seen_date
 * /triage_expires — main()'s extract-merge loop already stamps those onto
 * EVERY finding (triaged or not) the moment it first appears (see below), so
 * by the time a human runs --triage the row already carries them. This only
 * ever touches verdict/verdict_reason, and triage_expires when --expires is
 * explicitly passed to extend or shorten the deadline.
 */
function triageOne() {
  const findingId = argv[TRIAGE_INDEX + 1];
  const verdict = flagValue("--verdict");
  const reason = flagValue("--reason");
  const expiresOverride = flagValue("--expires");
  if (!findingId || !verdict || !reason) {
    console.error("Usage: completion-depth.mjs --triage <finding_id> --verdict <false_positive|accepted_tradeoff|confirmed_hollow> --reason \"...\" [--expires <ISO date>]");
    return 2;
  }
  if (!VALID_VERDICTS.has(verdict)) {
    console.error(`completion-depth --triage: invalid verdict '${verdict}' — must be one of ${[...VALID_VERDICTS].join(", ")}`);
    return 2;
  }
  const findings = readStoreArray();
  const finding = findings.find((f) => f.id === findingId);
  if (!finding) {
    console.error(`completion-depth --triage: no finding with id '${findingId}' in ${FINDINGS}`);
    return 2;
  }
  finding.verdict = verdict;
  finding.verdict_reason = reason;
  if (expiresOverride) finding.triage_expires = expiresOverride;
  writeFindingsOnly(findings);
  console.log(`completion-depth --triage — ${findingId}: ${verdict} (expires ${finding.triage_expires})`);
  return 0;
}

export function evaluateCompletionDepthGate(found, today = new Date()) {
  const untriaged = found.filter((f) => f.verdict === "untriaged");
  const confirmed = found.filter((f) => f.verdict === "confirmed_hollow");
  // String comparison is safe on fixed-width ISO dates, and is what
  // `reachability.mjs` already does for allowlist expiry.
  const todayISO = today.toISOString().slice(0, 10);
  const expired = untriaged.filter((f) => f.triage_expires && f.triage_expires < todayISO);
  return {
    untriaged,
    confirmed,
    expired,
    todayISO,
    report: {
      ok: untriaged.length === 0, findings: found.length, untriaged: untriaged.length,
      confirmed_hollow: confirmed.length, expired_untriaged: expired.length,
      triage_window_days: TRIAGE_WINDOW_DAYS,
      mode: "blocking-on-untriaged",
    },
  };
}

export function completionDepthGateRationale() {
  return [
    "  Strength: DETECTED for one narrow shape, and REPORT-ONLY. This finds a guard on a",
    "  property whose every assignment in this repository lives in a test or a demo. It is",
    "  NOT a general Hollow detector — .visual-intelligence/README.md's statement that the",
    "  shape is not structurally detectable still holds outside this subset. A finding is a",
    "  LEAD REQUIRING TRIAGE, the convention gate:anti-stub established after its own first",
    "  run produced 10 findings of which 9 were false positives. The first full scan is now",
    "  triaged, so any new untriaged finding blocks until it receives a verdict — see ADR-035.",
    "  Every untriaged finding fails this gate immediately, not just an expired one — the",
    `  \`triage_expires\` date below (${TRIAGE_WINDOW_DAYS} days from first appearance) is informational only,`,
    "  showing how overdue an unanswered finding is. That forces a VERDICT, never a fix —",
    "  `false_positive` or `accepted_tradeoff` with a reason closes it permanently.",
  ];
}

function main() {
  if (REFRESH) assertEvidenceProducerAuthority(REPO_ROOT);
  if (!ts) return 2;
  const found = extract();
  const prior = readStore();
  const priorByGatingKey = new Map([...prior.values()].map((finding) => [finding.gating_key, finding]));
  const rev = (() => {
    try {
      return require_("node:child_process").execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf-8" }).trim();
    } catch { return "unknown"; }
  })();

  const today = new Date();
  for (const f of found) {
    // The representative source site was historically filesystem-order
    // dependent. Preserve a human verdict by the one-finding-per-key identity
    // when a deterministic site correction changes the legacy hash id.
    const was = prior.get(f.id) ?? priorByGatingKey.get(f.gating_key);
    f.first_seen = was?.first_seen || rev;
    // The clock starts when the finding first appeared and never restarts — a
    // re-run must not silently buy another 30 days.
    f.first_seen_date = was?.first_seen_date || today.toISOString().slice(0, 10);
    f.triage_expires = was?.triage_expires
      || new Date(Date.parse(f.first_seen_date) + TRIAGE_WINDOW_DAYS * DAY_MS).toISOString().slice(0, 10);
    f.last_verified = was && was.content_hash === f.content_hash ? (was.last_verified || rev) : rev;
    // Triage verdicts are HUMAN judgements and must survive a refresh. Losing
    // them would make every refresh re-open every closed finding, which is how a
    // report-only signal becomes noise nobody reads.
    if (was?.verdict && was.verdict !== "untriaged") {
      f.verdict = was.verdict;
      f.verdict_reason = was.verdict_reason ?? "";
    }
  }

  if (REFRESH) {
    writeStore(found, rev);
    console.log(`completion-depth — wrote ${found.length} finding(s) to .completion-depth/findings.jsonl`);
    for (const f of found) console.log(`  ${f.verdict.padEnd(16)} ${f.confidence.padEnd(6)} ${f.guard_file}:${f.guard_line}  ${f.gating_key}`);
    return 0;
  }

  const { untriaged, confirmed, expired, todayISO, report } = evaluateCompletionDepthGate(found, today);
  if (JSON_OUT) { console.log(JSON.stringify(report, null, 2)); return report.ok ? 0 : 1; }

  console.log(`completion-depth gate — BLOCKING ON UNTRIAGED — ${found.length} finding(s) over packages/*/src`);
  console.log("");
  for (const f of found) {
    console.log(`  ${f.verdict.padEnd(16)} ${f.confidence.padEnd(6)} ${f.guard_file}:${f.guard_line}  [${f.shape}]`);
    console.log(`  ${" ".repeat(24)} guard: ${f.gating_expression}`);
    console.log(`  ${" ".repeat(24)} '${f.gating_key}' assigned only in: ${f.setters.join(", ")}`);
    if (f.shape === "root_partial") {
      console.log(`  ${" ".repeat(24)} set on some root(s) but NOT reachable-from-root(s): ${f.missing_from_roots.join(", ")}`);
    }
    if (f.verdict === "untriaged" && f.triage_expires) {
      console.log(`  ${" ".repeat(24)} triage by ${f.triage_expires}${f.triage_expires < todayISO ? "  ** EXPIRED **" : ""}`);
    }
    if (f.verdict_reason) console.log(`  ${" ".repeat(24)} triage: ${f.verdict_reason}`);
  }
  if (found.length === 0) console.log("  (none)");
  console.log("");
  console.log(`  untriaged: ${untriaged.length}   confirmed_hollow: ${confirmed.length}   expired untriaged: ${expired.length}`);
  console.log("");
  for (const line of completionDepthGateRationale()) console.log(line);
  console.log("");
  if (untriaged.length === 0) { console.log("PASS — no untriaged findings"); return 0; }
  console.log(`FAIL — CD-X: ${untriaged.length} finding(s) require a triage verdict:`);
  for (const f of untriaged) console.log(`         ${f.guard_file}:${f.guard_line}  ${f.gating_key}  (due ${f.triage_expires})`);
  return 1;
}

// Guarded like entrypoint-reachability.mjs's own `main` dispatch: importing
// this module (as the tests do, for computeRootsByFile/classifyRootCoverage)
// must never run the CLI body or set process.exitCode as a side effect of
// module load.
if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try {
    if (TRIAGE_INDEX >= 0) process.exitCode = triageOne();
    else process.exitCode = main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
