import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { profileOrDefaults } from "./project-profile.mjs";
import { STORE_REGENERATION_MARKER } from "./store-budgets.mjs";
import { targetInput, toolInput } from "./vi-input-binding.mjs";

// WHY THE GRAPH IS NOT HASHED AS BYTES. `completion-depth` and `vi-observed`
// genuinely read `.visual-intelligence/graph/` (see their STORE_SCOPES
// entries), so a change to the graph must invalidate them. ADR-169 first met
// that by walking the gitignored graph directory from disk and hashing its
// bytes. Those bytes are not a function of the source tree: every record is
// stamped with the revision it was built at (`first_seen`, `last_verified`,
// `established_at_revision`), `first_seen` is carried forward from whatever
// prior graph happened to sit on that disk, and a fresh checkout has no graph
// at all. A store bound in one checkout therefore could not be reproduced in
// any other — and the evidence commit that records the store necessarily
// moves HEAD past the revision the graph was stamped with. The pre-push
// candidate is exactly such a checkout: a fresh detached worktree where
// `gate:vi-prepush-policy` either only checks the input binding or runs
// `vi-refresh --check`, which leaves no graph behind. The two stores failed
// there on every push, with no changed path to name.
//
// What determines the graph is its declared input closure — the same
// predicate `computeViInputBinding` hashes and `gate:vi-freshness` holds
// blocking against the committed manifest. Hashing that closure instead of
// the graph's bytes invalidates on every change that can move the graph
// (it is wider than the bytes, never narrower: every input of the graph is
// hashed, including ones that happen to leave the graph unchanged), and it
// is the same value in every checkout of the same tree. What it cannot see —
// a graph that differs from what its inputs produce — is the reproducibility
// question `gate:vi-reproducible` answers by regenerating from these inputs,
// not a freshness question.
const GRAPH_CONSUMING_STORES = new Set(["completion-depth", "vi-observed"]);

/** True for a store that reads the graph and therefore records the graph binding it consumed. */
export function isGraphConsumingStore(storeName) {
  return GRAPH_CONSUMING_STORES.has(storeName);
}

/**
 * ADR-183 follow-up. The graph's committed manifest (`.visual-intelligence/
 * manifest.json`, present in every checkout, unlike the gitignored graph)
 * carries `input_binding`: a digest of the graph's declared input closure at
 * the time it was built. A graph-consuming store records that digest as
 * `graph_input_binding` when it is written, so a store produced against a stale
 * local graph is distinguishable from one produced against the current graph
 * without ever reading graph bytes. Returns null when the manifest or the
 * binding is absent; callers must treat null as UNMEASURED, never as a match.
 */
export function readGraphInputBinding(repo) {
  try {
    const manifest = JSON.parse(readFileSync(join(repo, ".visual-intelligence", "manifest.json"), "utf8"));
    const digest = manifest?.input_binding?.content_hash;
    return typeof digest === "string" && digest.length > 0 ? digest : null;
  } catch {
    return null;
  }
}

function graphInputPredicate(repo) {
  const profile = profileOrDefaults(repo);
  return (path) => targetInput(path, profile) || toolInput(path);
}

/** The single input predicate for one store: its declared scope, plus the graph's input closure when it reads the graph. */
function storeInputPredicate(repo, storeName) {
  const scope = STORE_SCOPES[storeName];
  if (!scope) throw new Error(`store-provenance: no STORE_SCOPES entry for "${storeName}"`);
  const graphInput = GRAPH_CONSUMING_STORES.has(storeName) ? graphInputPredicate(repo) : null;
  return (path) => scopeMatches(path, scope) || (graphInput !== null && graphInput(path));
}

function walkDiskFiles(repo, relativeDir, acc = []) {
  const absoluteDir = join(repo, relativeDir);
  if (!existsSync(absoluteDir)) return acc;
  for (const entry of readdirSync(absoluteDir, { withFileTypes: true })) {
    const relativePath = `${relativeDir}/${entry.name}`;
    if (entry.isDirectory()) walkDiskFiles(repo, relativePath, acc);
    else if (entry.isFile()) acc.push(relativePath);
  }
  return acc;
}

export const GENERATED_EVIDENCE_PREFIXES = [
  ".claim-ledger/",
  ".determinism-baseline/",
  ".completion-depth/",
  ".visual-intelligence/observed/",
  // Both are themselves generated outputs (the static graph plane and the
  // human-triage log), not inputs any store's own extraction logic reads.
  // Excluding them here is what stops a triage verdict or a graph rebuild
  // from invalidating claim-ledger/completion-depth/determinism-baseline —
  // none of which read either directory. vi-observed DOES read the graph
  // (`.visual-intelligence/graph/evidence.jsonl` and `nodes.jsonl`, to
  // resolve a covered offset to its enclosing symbol — see vi-observe.mjs),
  // so it declares the graph a dependency through the graph's input closure
  // (GRAPH_CONSUMING_STORES); this list only governs the legacy whole-repo path.
  ".visual-intelligence/graph/",
  ".visual-intelligence/findings/",
];

/**
 * Per-store input scope. Each entry is a repo-relative path: a bare path
 * matches that one file exactly; a path ending in `/` matches everything
 * under that directory; a `*` path segment matches any single directory
 * component (no recursive glob — `packages/*\/src/` means "each package's
 * own src/", not an arbitrary depth). Verified against each producer's own
 * reads (scripts/claim-ledger.ts, scripts/completion-depth.mjs,
 * scripts/determinism-baseline.ts, scripts/vi-observe.mjs) — see
 * scripts/tests/store-scoped-provenance.test.mjs and the implementation
 * report for the trace. Err wide: an unlisted dependency under-invalidates,
 * which this repository's own design note calls "far worse than an
 * unnecessary refresh" — so a store's own producer file(s) and every
 * subprocess it spawns are included, not just its prose/data sources.
 */
export const STORE_SCOPES = {
  // Extracts claims from ROADMAP.md and decisions/*.md directly, but also
  // spawns `docs-truth.mjs` (which itself spawns `reachability.mjs`, walking
  // every packages/*\/src/**\/*.ts) and imports `buildObligationCoverageReport`
  // from @arbor/governance, whose proof resolution
  // (packages/arbor-governance/src/obligation/proof.ts) resolves `symbol=`
  // and `file=` proof fields by searching packages/*\/src for declarations.
  // A symbol rename with no ROADMAP/ADR edit therefore changes discharge
  // status and must invalidate this store — packages/*\/src/ is a real input,
  // not just prose, contradicting the brief's proposed prose-only scope.
  "claim-ledger": [
    "decisions/",
    "ROADMAP.md",
    "packages/*/src/",
    "scripts/claim-ledger.ts",
    "scripts/docs-truth.mjs",
    "scripts/reachability.mjs",
  ],
  // walkFiles() (scripts/completion-depth.mjs) recurses the entire
  // `packages/` tree for every *.ts(x) file except node_modules/dist/dot-dirs
  // — test and demo files included, since the whole algorithm's verdict
  // turns on whether a key is ever assigned OUTSIDE a test/demo file. Scoping
  // to `packages/*\/src/` as first proposed would miss every test/demo file
  // whose presence or absence is the actual signal this store measures.
  "completion-depth": [
    "packages/",
    "scripts/completion-depth.mjs",
    // Added 2026-08-19: completion-depth now consumes per-entry-point
    // reachability, so the derived graph is a genuine input. Omitting it
    // UNDER-invalidates — a graph-only change (no packages/ edit) would leave
    // the store reporting fresh while its root-coverage classification had
    // silently moved. Under-invalidation is the dangerous direction: a store
    // wrongly reported fresh is stale evidence presented as verified. The
    // graph is covered by its input closure (GRAPH_CONSUMING_STORES), not by
    // its revision-stamped, uncommitted bytes.
    "scripts/entrypoint-reachability.mjs",
  ],
  // Measures flake rate for whatever test files are cited by a `roundtrip=`
  // proof anywhere in ROADMAP.md/decisions/*.md, so citations are a real
  // input in principle — but the gate (non-refresh mode) recomputes
  // citedSeams() live from those files on every run regardless of this
  // store's manifest hash (scripts/determinism-baseline.ts:294), so an
  // under-invalidation here can never hide an unmeasured new citation; the
  // gate itself always catches it (DB-R). What store-freshness genuinely
  // needs to track is the code a measured seam executes, which is anywhere
  // under packages/** or scripts/** (a seam can be a scripts/tests/*.test.mjs
  // file). Prose truly cannot change flakiness, matching the brief.
  "determinism-baseline": [
    "packages/",
    "scripts/",
  ],
  // Runs each scenario's packages/*\/dist/**.js entry (gitignored, so never
  // hashable directly) and resolves covered offsets back through its
  // sourcemap to a packages/*\/src/*.ts position, then to a symbol via
  // `.visual-intelligence/graph/{evidence,nodes}.jsonl` (covered by the
  // graph's input closure — GRAPH_CONSUMING_STORES). Catalog and hook
  // files live under scripts/observation/. Test files are never executed by
  // this producer, so — unlike completion-depth — src-only is correct here.
  "vi-observed": [
    "packages/*/src/",
    "scripts/observation/",
    "scripts/vi-observe.mjs",
  ],
};

/**
 * Where each store's OWN generated bytes live, relative to the repo root.
 *
 * WHY THIS EXISTS. `content_hash` measures a store's INPUTS — the producers'
 * source and prose. The generated bytes themselves (`.claim-ledger/claims.jsonl`,
 * `.completion-depth/findings.jsonl`, …) are excluded from that digest BY
 * CONSTRUCTION: `GENERATED_EVIDENCE_PREFIXES` above removes them, and
 * `STORE_SCOPES` lists no store's own output directory. A consequence that was
 * proved, not argued: flipping `claim_text` on 347 committed rows of the
 * claim-ledger left `gate:store-freshness` reporting
 * `ok claim-ledger [blocking] content hash matches; 0 commit(s) behind HEAD`.
 * A store whose every byte is fabricated was reported as fully measured,
 * because nothing was ever measuring its bytes.
 *
 * `manifest.store_digest` (written by the producer at publication time and
 * recomputed here on every gate run) is that missing measurement. These are
 * the same directories `GENERATED_EVIDENCE_PREFIXES` already names, kept
 * together here so the exclusion list and the store-identity map cannot drift
 * apart into "hashed as an input" and "digest of the store itself" disagreeing
 * about the same path.
 */
export const STORE_GENERATED_DIRS = {
  "claim-ledger": ".claim-ledger",
  "determinism-baseline": ".determinism-baseline",
  "completion-depth": ".completion-depth",
  "vi-observed": ".visual-intelligence/observed",
};

function git(repo, args) {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
}

function allRepoPaths(repo) {
  const output = execFileSync("git", ["ls-files", "-co", "--exclude-standard", "-z"], {
    cwd: repo,
    encoding: "utf8",
  });
  return output.split("\0").filter(Boolean).sort();
}

/**
 * Does `path` fall under one of `scope`'s patterns? A trailing `/` on a
 * pattern matches anything strictly under that directory; otherwise the
 * pattern must match the whole path exactly. A `*` segment (in either form)
 * matches exactly one path component.
 */
function scopeMatches(path, scope) {
  const segments = path.split("/");
  return scope.some((pattern) => {
    const isDir = pattern.endsWith("/");
    const patternSegments = (isDir ? pattern.slice(0, -1) : pattern).split("/");
    if (isDir ? segments.length <= patternSegments.length : segments.length !== patternSegments.length) return false;
    return patternSegments.every((seg, i) => seg === "*" || seg === segments[i]);
  });
}

export function evidenceInputPaths(repo) {
  return allRepoPaths(repo).filter((path) => !GENERATED_EVIDENCE_PREFIXES.some((prefix) => path.startsWith(prefix)));
}

/**
 * Same shape as `evidenceInputPaths`, but restricted to one store's declared
 * STORE_SCOPES entry — plus, for a store that reads the graph, the graph's own
 * input closure (GRAPH_CONSUMING_STORES). Every path is repo-relative and every
 * byte is committed or committable, so the same tree yields the same list in
 * any checkout, with or without a local graph.
 */
export function evidenceInputPathsForStore(repo, storeName) {
  const isInput = storeInputPredicate(repo, storeName);
  return allRepoPaths(repo).filter(isInput);
}

function hashPaths(repo, paths) {
  const hash = createHash("sha256");
  for (const path of paths) {
    // A path git still lists but the working tree no longer has: a DELETION
    // that is staged or unstaged but not yet committed. `git ls-files -co`
    // reports it because it is still in the index, and reading it throws
    // ENOENT — which crashed this function outright, so `--json` emitted a
    // stack trace instead of a report and every caller parsing it failed with
    // "Unexpected token" rather than anything naming the real cause.
    //
    // Skipping is not merely defensive, it is correct: a file that is gone
    // contributes no bytes, so the digest legitimately differs from when it
    // existed. That is the change being detected, not an error.
    //
    // Latent since before the per-store scoping refactor — the original
    // whole-repo hash had the identical unguarded read. It took deleting a
    // tracked file (the taxonomy move) to surface it.
    //
    // A tracked path can also be a DIRECTORY on disk rather than a file: a
    // submodule gitlink (mode 160000) checks out to a directory at its
    // tracked path, and a tracked file can be replaced in-place by a
    // directory in the working tree without ever being staged. `existsSync`
    // is true for both, so it did not catch this — `readFileSync` on a
    // directory throws EISDIR, crashing the gate the same way the missing-file
    // case used to (`--json` emitting a stack trace instead of a report). A
    // path that is not a regular file contributes no evidence bytes, same as
    // a missing one: skip it, do not fail the whole hash over it.
    const absolute = join(repo, path);
    let stat;
    try {
      stat = statSync(absolute);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    const bytes = readFileSync(absolute);
    hash.update(path);
    hash.update("\0");
    hash.update(String(bytes.byteLength));
    hash.update("\0");
    hash.update(bytes);
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}

/** Rebase-stable digest of the bytes evidence producers can observe. */
export function computeEvidenceContentHash(repo) {
  return hashPaths(repo, evidenceInputPaths(repo));
}

/** Same digest shape, restricted to one store's declared input scope (see STORE_SCOPES). */
export function computeEvidenceContentHashForStore(repo, storeName) {
  return hashPaths(repo, evidenceInputPathsForStore(repo, storeName));
}

/**
 * The digest of a store's OWN bytes — every regular file inside `storeDir`
 * except its own `manifest.json`, hashed in sorted relative-path order with
 * the same framing `hashPaths` uses.
 *
 * The producer calls this over its staging directory immediately before
 * writing the manifest (so the manifest is not yet on disk and cannot hash
 * itself); `assessEvidenceProvenance` calls it over the committed directory on
 * every gate run. The two must agree byte for byte or the gate fails.
 *
 * `manifest.json` is excluded, not ignored by accident: it is the file that
 * CARRIES the digest, so including it would make the digest a function of
 * itself. Every other file in the store — including any ancillary operator
 * policy kept beside it — is included, because "the store's own bytes" means
 * all of them. Deleting an ancillary file therefore changes the live digest and
 * invalidates the recorded one, which is why the refresh path that rewrites
 * `manifest.json` exists.
 */
export function computeStoreDigest(storeDir) {
  const files = walkDiskFiles(storeDir, ".", [])
    .map((path) => path.replace(/^\.\//, ""))
    .filter((path) => path !== "manifest.json")
    .sort();
  return hashPaths(storeDir, files);
}

/**
 * Best-effort list of the input paths responsible for a store's content-hash
 * mismatch, within that store's own STORE_SCOPES entry. The manifest records
 * only a single aggregate `content_hash`, not a hash per input path, so this
 * cannot report the exact culprit with certainty — it is the union of:
 *
 *   1. every path committed between `sinceRevision` (the manifest's recorded
 *      `scanned_up_to_revision`, when it names a real ancestor of HEAD) and
 *      HEAD, and
 *   2. every dirty or untracked path in the working tree right now,
 *
 * restricted to the store's scope. Either source alone can miss the real
 * cause (a rebase can change HEAD without changing `git diff --name-only`'s
 * two-dot form; a working tree can be clean while HEAD moved) — the union
 * errs toward naming a few paths that turn out unrelated, never toward
 * naming none. An operator staring at a bare "content hash differs" with no
 * further clue was the actual failure mode this exists to fix.
 */
export function changedInputPaths(repo, storeName, sinceRevision) {
  const isInput = storeInputPredicate(repo, storeName);
  const changed = new Set();

  const status = execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: repo, encoding: "utf8" });
  for (const line of status.split("\n")) {
    if (line.length < 4) continue;
    const path = line.slice(3);
    if (isInput(path)) changed.add(path);
  }

  if (sinceRevision) {
    try {
      git(repo, ["cat-file", "-e", `${sinceRevision}^{commit}`]);
      const diffOut = execFileSync("git", ["diff", "--name-only", sinceRevision, "HEAD"], { cwd: repo, encoding: "utf8" });
      for (const path of diffOut.split("\n")) {
        if (path && isInput(path)) changed.add(path);
      }
    } catch {
      // Revision unreadable or not a commit — fall back to working-tree
      // status alone, already collected above.
    }
  }

  return [...changed].sort();
}

export function regenerationMarkerPath(repo) {
  return join(git(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"]), STORE_REGENERATION_MARKER);
}

export function hasRegenerationMarker(repo) {
  const marker = regenerationMarkerPath(repo);
  return existsSync(marker);
}

/**
 * The single remedy command an operator should run for any stale store. Not
 * the bare per-store script: `arbor evidence refresh` is the one mechanism
 * that encodes the graph-before-stores ordering and the
 * red-suite-poisons-the-baseline rule (see
 * packages/arbor-mcp/src/native-tools/evidence-refresh.ts) — naming the bare
 * script here taught operators to run refreshes out of order. `--scope auto`
 * refreshes exactly the stores this gate reports stale, nothing more.
 */
const REMEDY_COMMAND = "arbor evidence refresh --scope auto";

function remedyText() {
  return `run \`${REMEDY_COMMAND}\``;
}

export function assessEvidenceProvenance({ repo, manifest, currentContentHash, head, regenerationInFlight = false, storeName, storeDir }) {
  const revision = manifest.scanned_up_to_revision;
  const contentHash = manifest.content_hash;
  if (regenerationInFlight) {
    return {
      state: "fail",
      revision,
      content_hash: contentHash,
      detail: "a regeneration transaction marker exists — evidence is unavailable until that transaction succeeds or is explicitly recovered",
    };
  }
  if (!contentHash) return { state: "fail", revision, detail: `manifest records no content_hash — ${remedyText()}` };
  if (contentHash !== currentContentHash) {
    // Best-effort: name the paths responsible, not just the fact of a
    // mismatch — see changedInputPaths for why this is a union, not a proof.
    let changedPaths = [];
    if (storeName) {
      try {
        changedPaths = changedInputPaths(repo, storeName, revision);
      } catch {
        changedPaths = [];
      }
    }
    const CHANGED_PATHS_PREVIEW = 20;
    const shown = changedPaths.slice(0, CHANGED_PATHS_PREVIEW);
    const overflow = changedPaths.length - shown.length;
    const changedDetail = changedPaths.length > 0
      ? ` — changed input(s): ${shown.join(", ")}${overflow > 0 ? `, and ${overflow} more` : ""}`
      : " (no dirty/untracked/committed-since input identified in this store's scope; the mismatch may predate the manifest's recorded revision)";
    return {
      state: "fail",
      revision,
      content_hash: contentHash,
      changed_paths: changedPaths,
      detail: `content hash differs from the working tree${changedDetail} — ${remedyText()}`,
    };
  }

  // --- the graph this store consumed (ADR-183 follow-up) ----------------------
  // The content hash above covers the graph's INPUTS, so it cannot tell a store
  // refreshed against a stale local graph from one refreshed against the
  // current graph. Compare the binding the producer recorded to the committed
  // graph manifest's. Both sides must exist: a missing record or a missing
  // graph manifest is unmeasured, which this gate never reads as clean.
  if (storeName && GRAPH_CONSUMING_STORES.has(storeName)) {
    const consumed = manifest.graph_input_binding;
    const current = readGraphInputBinding(repo);
    if (!consumed) {
      return {
        state: "fail", revision, content_hash: contentHash,
        detail: `manifest records no graph_input_binding, so which graph this store consumed is UNMEASURED, not current — ${remedyText()}`,
      };
    }
    if (!current) {
      return {
        state: "fail", revision, content_hash: contentHash, graph_input_binding: consumed,
        detail: "the graph manifest (.visual-intelligence/manifest.json) records no input_binding to compare "
          + `against, so which graph this store consumed is UNMEASURED, not current — ${remedyText()}`,
      };
    }
    if (consumed !== current) {
      return {
        state: "fail", revision, content_hash: contentHash, graph_input_binding: consumed, current_graph_input_binding: current,
        detail: `this store was built against a different graph than the current one (store consumed ${consumed}, `
          + `graph manifest binds ${current}) — it was refreshed against a stale graph, or the graph was rebuilt after it — ${remedyText()}`,
      };
    }
  }

  // --- the store's OWN bytes (defect B) --------------------------------------
  // `content_hash` above is a digest of the store's INPUTS. It says nothing
  // about whether the bytes the store committed are still the bytes its
  // producer wrote. Those are different files, and only the second one is the
  // evidence a reviewer actually reads.
  //
  // `store_bytes` is reported as DATA on every outcome, not folded into the
  // pass/fail state, and the reason is deliberately narrow: a manifest written
  // before its producer recorded `store_digest` has nothing to compare against,
  // and inventing a failure for it would be a red this gate cannot honestly
  // clear on the store's behalf. What it must never do is read as VERIFIED —
  // so the fact travels as `store_bytes: "unmeasured"` plus an explicit clause
  // in `detail`, where no consumer parsing `--json` can mistake it for
  // "content hash matches" having covered the store itself. Once a producer
  // records the digest, `store_bytes` becomes "measured" and a mismatch is a
  // hard failure.
  const declaredStoreDigest = manifest.store_digest;
  const ownDir = storeDir ?? (storeName && STORE_GENERATED_DIRS[storeName] ? join(repo, STORE_GENERATED_DIRS[storeName]) : null);
  let storeBytes = "unmeasured";
  let storeBytesDetail = "";
  if (declaredStoreDigest && ownDir) {
    const actualStoreDigest = computeStoreDigest(ownDir);
    if (actualStoreDigest !== declaredStoreDigest) {
      return {
        state: "fail",
        revision,
        content_hash: contentHash,
        store_bytes: "mismatched",
        store_digest: declaredStoreDigest,
        observed_store_digest: actualStoreDigest,
        detail: `the store's own bytes in ${ownDir} do not match the digest its own manifest records `
          + `(manifest ${declaredStoreDigest}, on disk ${actualStoreDigest}) — the store was altered after its producer published it, `
          + "so the store's inputs verify while the store itself does not — " + remedyText(),
      };
    }
    storeBytes = "measured";
  } else if (!declaredStoreDigest) {
    storeBytesDetail = "; the store's own bytes are UNMEASURED (this manifest records no store_digest), "
      + "so altering them is currently undetectable — only the store's INPUTS are verified";
  } else if (!ownDir) {
    storeBytesDetail = "; the store's own bytes are UNMEASURED (this store has no known directory), "
      + "so altering them is currently undetectable — only the store's INPUTS are verified";
  }

  // --- the recorded revision (defect C) --------------------------------------
  // UNMEASURED, NOT ZERO. A revision that is not a commit in this repository,
  // or that is not an ancestor of HEAD, makes the store's distance UNDEFINED —
  // not zero, and not "close enough". Both cases used to be swallowed by a
  // `catch` that kept `state: "ok"` and moved the problem into a prose
  // `advisory`, so `scanned_up_to_revision: "0000…0001"` read as a healthy
  // store. `scripts/vi-freshness-gate.mjs` has always failed for exactly these
  // two cases; two sibling gates disagreeing about one invariant is how each
  // of them came to believe its own behaviour was the careful one.
  if (!revision) {
    return {
      state: "fail", revision, content_hash: contentHash, store_bytes: storeBytes,
      detail: `manifest records no scanned_up_to_revision, so the store's distance from HEAD is UNMEASURED, not zero — ${remedyText()}`,
    };
  }
  try {
    git(repo, ["cat-file", "-e", `${revision}^{commit}`]);
  } catch {
    return {
      state: "fail", revision, content_hash: contentHash, store_bytes: storeBytes,
      detail: `recorded revision ${String(revision).slice(0, 12)} is not a commit in this repository, so the store's distance from HEAD is UNMEASURED, not zero — ${remedyText()}`,
    };
  }
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", revision, head], { cwd: repo });
  } catch {
    return {
      state: "fail", revision, content_hash: contentHash, store_bytes: storeBytes,
      detail: "recorded revision is not an ancestor of HEAD — it describes a tree not in this history "
        + "(built on an unmerged branch, or rebased away), so its distance from HEAD is UNDEFINED, not zero — " + remedyText(),
    };
  }
  const behind = Number.parseInt(git(repo, ["rev-list", "--count", `${revision}..${head}`]), 10);
  return { state: "ok", revision, behind, content_hash: contentHash, store_bytes: storeBytes, detail: `content hash matches; ${behind} commit(s) behind HEAD${storeBytesDetail}` };
}
