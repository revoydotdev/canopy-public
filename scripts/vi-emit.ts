#!/usr/bin/env -S node
/**
 * scripts/vi-emit.ts — write the intent plane and the exception store from
 * `@arbor/governance`'s typed extractors.
 *
 * This is the half the port deliberately left undone. `vi/intent.ts` and
 * `vi/exceptions.ts` compute typed reports and touch no disk, which is what
 * makes them testable; this turns those reports into the graph's on-disk
 * JSONL. Keeping the split means the domain logic is unit-testable and only
 * the serialization depends on the vendored graph library.
 *
 * WHY IT EXISTS AT ALL. `extract-intent.mjs` and `extract-exceptions.mjs`
 * carried their own ADR filename regex, status parsing, and counts probes
 * while `@arbor/governance` already owned all three
 * (`scanDecisionsCorpus`/`parseRecord`, `deriveRepositoryCounts`). Two ADR
 * parsers and two counts derivers in one repository is the duplication this
 * whole exercise exists to remove, and it will not be removed until nothing
 * calls the `.mjs` any more — which is what this file achieves.
 *
 * WHAT CHANGES IN THE GRAPH, and why it is not a regression. The canonical
 * reader is stricter than the regex it replaces: a record whose H1 is missing,
 * whose status is outside the closed `DecisionStatus` set, or whose number
 * disagrees between filename and heading is `unparseable` and is EXCLUDED,
 * where the old script emitted a degraded node with `lifecycle: "unknown"`. A
 * degraded node asserts a record exists and is governed; excluding it asserts
 * nothing. The second is the honest reading of an unparseable file, and it is
 * why the emitted graph may legitimately differ from the one the `.mjs`
 * produced.
 *
 * The vendored library is used for writing (`makeNode`/`writeNodes`/…) so the
 * on-disk schema stays exactly one implementation. Resolved from the
 * repository, never `homedir()` — `extract-intent.mjs` resolved its library
 * from `~/.claude/skills/` even after vendoring, so the "vendored" pipeline was
 * still half-running on a copy nothing in this repository checks.
 *
 * THE --root SEAM (Roadmap 23 B2, ADR-073's named follow-up, last of the
 * eight scripts). `--root <path>` (default: this checkout, byte-identical to
 * prior behavior) names the project whose intent plane and exception store
 * this writes. Every path this file resolves — the decisions corpus (via
 * `buildIntentGraph(root, { decisionsDir })`), the waiver input (via
 * `extractExceptions(root, { decisionsDir, allowlistPath, ... })`), the
 * ADR-citation authority sources (`ROADMAP.md`, the profile's
 * `decisions_dir`, both resolved inside the governance package from the
 * `repoRoot` it is given), the graph/exceptions/manifest OUTPUT paths, and
 * the git revision stamped on every emitted record — is now derived from
 * `root`, not from this module's own `REPO_ROOT`. Before this, `REPO_ROOT`
 * was hardcoded with no override of any kind, so feeding `vi-refresh.mjs
 * --root <foreign>` through this step would have silently merged THIS
 * repository's own `decisions/` corpus into the foreign project's graph —
 * the exact §5 failure this roadmap names. That is why `vi-refresh.mjs`
 * stopped before reaching this file at all until now.
 *
 * `governance.decisions_dir` and `governance.allowlist_path`
 * (`arbor.profile.jsonc`, `scripts/lib/project-profile.mjs`) are read here
 * and threaded into both `buildIntentGraph` and `extractExceptions` — the
 * last two hardcodings ADR-073's follow-up named (`@arbor/governance`'s
 * `vi/intent.ts`, `vi/exceptions.ts`, `vi/baseline.ts`, `counts/derive.ts`
 * all now accept these as options, defaulting to revoy2's own conventional
 * values so this repository's behavior is byte-identical). A foreign
 * project whose profile names a different decisions directory or waiver
 * store is now honored through this step, closing the boundary this
 * module's header used to document as open — see
 * `scripts/tests/vi-decisions-dir-portability.test.mjs` for the acceptance
 * test (same shape as the cross-contamination test above it).
 *
 * `source_roots` (Roadmap 23 B2's remaining consumer gap) is threaded into
 * `buildIntentGraph` too, so a foreign project whose sources live outside
 * `packages/` has its citation scan walk its own declared roots instead of
 * silently walking a `packages/` directory that does not exist for it and
 * finding nothing — see `scripts/tests/vi-emit-source-roots.test.mjs`.
 * `extractExceptions` needs no such option: it never scans source files,
 * only the waiver store and ROADMAP.md.
 *
 * `LIB` (the vendored graph-writing primitives under
 * `.claude/skills/repository-visual-intelligence/scripts/lib/graph.mjs`)
 * stays anchored to THIS checkout's own `REPO_ROOT`, exactly like
 * `vi-refresh.mjs`'s `SKILL_DIR`: the tool lives with the script that
 * invokes it, regardless of which project's tree `root` names.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildIntentGraph, extractExceptions } from "@arbor/governance";
import { resolveRootArg } from "./vi-refresh.mjs";
import { profileOrDefaults } from "./lib/project-profile.mjs";

const REPO_ROOT = resolve(join(dirname(fileURLToPath(import.meta.url)), ".."));
const LIB = join(REPO_ROOT, ".claude/skills/repository-visual-intelligence/scripts/lib/graph.mjs");

const EXTRACTOR = "revoy2-extract-intent";
const EXTRACTOR_VERSION = "2.0.0";

/** The vendored graph primitives. Untyped by nature — it is plain `.mjs`. */
interface GraphLib {
  id: { rec(ns: string, name: string): string; file(path: string): string };
  makeNode(input: Record<string, unknown>): Record<string, unknown>;
  makeEdge(input: Record<string, unknown>): Record<string, unknown>;
  makeEvidence(input: Record<string, unknown>): Record<string, unknown>;
  writeNodes(path: string, nodes: unknown[]): number;
  writeEdges(path: string, edges: unknown[]): number;
  writeEvidence(path: string, evidence: unknown[]): number;
  loadGraph(dir: string): {
    nodes: { id: string }[];
    edges: { id: string }[];
    evidence: { id: string }[];
  };
}

function revision(root: string): string {
  return execFileSync("git", ["rev-parse", "--short=8", "HEAD"], { cwd: root }).toString().trim();
}

async function main(): Promise<number> {
  let root: string;
  try {
    root = resolveRootArg(process.argv, REPO_ROOT);
  } catch (error) {
    console.error(`vi-emit — ${(error as Error).message}`);
    return 1;
  }

  // `profileOrDefaults`, never the strict loader: emitting the intent plane
  // from a repo with no (or a broken) `arbor.profile.jsonc` must degrade to
  // `DEFAULT_PROFILE` exactly like `vi-refresh.mjs`'s own step 1 does, not
  // abort — a missing profile is not a reason to refuse to write the
  // intended plane, only a reason to fall back to the documented defaults.
  const profile = profileOrDefaults(root);
  // The id namespace embedded in every emitted `rec:<ns>:...` id and
  // `attributes.namespace`. For revoy2 itself, `arbor.profile.jsonc`
  // declares `project_id: "revoy2"`, so this is byte-identical to the prior
  // hardcoded literal. For a foreign root with no declared `project_id`,
  // falling back to the literal `"revoy2"` would stamp this repository's own
  // name onto another project's records — exactly the class of bug this
  // seam exists to remove — so the fallback is the target directory's own
  // basename instead.
  const NS = profile.project_id ?? basename(root);
  // Same derivation `vi-refresh.mjs` uses for the evidence-store directory
  // name, so both scripts agree on where a given root's graph lives.
  const viDirName = profile.governance.evidence_stores.find((s) => s.endsWith("visual-intelligence")) ?? ".visual-intelligence";
  const GRAPH_DIR = join(root, viDirName, "graph");

  if (!existsSync(LIB)) {
    console.error(
      `vi-emit — FAILED: graph library missing at ${LIB}\n` +
      "  The working tree is incomplete; restore it with `git checkout -- .claude/skills/`.\n" +
      "  This deliberately does not fall back to ~/.claude/skills: the skill is\n" +
      "  first-party source of this repository (ADR-176), and a pipeline that\n" +
      "  silently uses an out-of-tree copy is not reproducible from a checkout.",
    );
    return 1;
  }

  const lib = (await import(pathToFileURL(LIB).href)) as unknown as GraphLib;
  const { id, makeNode, makeEdge, makeEvidence, writeNodes, writeEdges, writeEvidence, loadGraph } = lib;

  const rev = revision(root);
  const REV = { first_seen: rev, last_verified: rev };

  const intent = buildIntentGraph(root, {
    decisionsDir: profile.governance.decisions_dir,
    sourceRoots: profile.source_roots,
    // Separate from source_roots on purpose — see BuildIntentGraphOptions.
    citationRoots: profile.citation_roots,
  });
  if (!intent.ok) {
    console.error(`vi-emit — FAILED building the intent graph: ${intent.error.message}`);
    return 1;
  }
  const now = new Date();
  const exceptions = extractExceptions(root, {
    today: now.toISOString().slice(0, 10),
    at: now.toISOString(),
    decisionsDir: profile.governance.decisions_dir,
    allowlistPath: profile.governance.allowlist_path,
  });
  if (!exceptions.ok) {
    console.error(`vi-emit — FAILED extracting exceptions: ${exceptions.error.message}`);
    return 1;
  }

  // MERGE, never replace. This adapter contributes the INTENDED plane to a
  // graph whose DERIVED plane `vi-extract-ts` already wrote; writing only its
  // own records would silently delete ~8,200 nodes and leave a graph that
  // looks internally consistent and describes almost nothing. The first draft
  // of this file did exactly that, and it was caught by the node count rather
  // than by anything structural — which is precisely why `gate:vi-reproducible`
  // and the committed-artifact diff both exist.
  const existing = loadGraph(GRAPH_DIR);
  const nodeById = new Map<string, Record<string, unknown>>(
    existing.nodes.map((n) => [n.id, n as Record<string, unknown>]),
  );
  const edgeById = new Map<string, Record<string, unknown>>(
    existing.edges.map((e) => [e.id, e as Record<string, unknown>]),
  );
  const evidenceById = new Map<string, Record<string, unknown>>(
    existing.evidence.map((e) => [e.id, e as Record<string, unknown>]),
  );
  const emittedNodeIds: string[] = [];

  for (const record of intent.value.records) {
    const recId = id.rec(NS, `ADR-${String(record.recordNumber).padStart(3, "0")}`);
    const ev = makeEvidence({
      discovery: "declared",
      confidence: "authoritative",
      repository_path: record.sourcePath,
      // A canonical ADR always begins with its required H1, so the record's
      // source evidence is anchored at the first line. Leaving this null
      // violates the evidence schema's declared-evidence contract and made a
      // freshly regenerated graph fail validation.
      line_start: 1,
      extractor: EXTRACTOR,
      extractor_version: EXTRACTOR_VERSION,
      established_at_revision: rev,
    });
    evidenceById.set((ev as { id: string }).id, ev);

    const node = makeNode({
      id: recId,
      kind: "record",
      name: `ADR-${String(record.recordNumber).padStart(3, "0")}`,
      qualified_name: record.title,
      repository_path: record.sourcePath,
      lifecycle: record.lifecycle,
      // Upgraded to `implemented` below iff something in packages/ cites it.
      implementation_status: "declared_only",
      defect_shape: "unwitnessed_claim",
      confidence: "authoritative",
      source_evidence: [(ev as { id?: string }).id],
      attributes: { decision_status: record.decisionStatus, namespace: NS },
      ...REV,
    });
    nodeById.set((node as { id: string }).id, node);
    emittedNodeIds.push((node as { id: string }).id);

    for (const superseded of record.supersedes) {
      const edge = makeEdge({
        source: recId,
        // `extractSupersedes` already returns the complete ADR-NNN id.
        // Prefixing it again emitted rec:revoy2:ADR-ADR-NNN dangling edges.
        target: id.rec(NS, superseded),
        relation: "supersedes",
        discovery: "declared",
        evidence_type: "prose_reference",
        evidence_location: record.sourcePath,
        confidence: "high",
        ...REV,
      });
      edgeById.set((edge as { id: string }).id, edge);
    }
  }

  // A citation is a CLAIM that code is governed by a record, never authority.
  // Recorded as an edge from the record to the citing file so the graph can
  // answer "what does this ADR actually govern" — the question that turns an
  // unwitnessed claim into a witnessed one.
  const governed = new Map<string, number>();
  for (const citation of intent.value.citations) {
    const recId = id.rec(NS, citation.recordId.replace(new RegExp(`^${NS}:`), ""));
    const target = id.file(citation.citingPath);
    // The derived TypeScript extractor intentionally excludes non-code files
    // such as tsconfig and markdown. A governance citation in one of those
    // files is nevertheless a real graph target, so create a minimal file
    // node rather than emitting an integrity-breaking dangling edge.
    if (!nodeById.has(target)) {
      const fileNode = makeNode({
        id: target,
        kind: "file",
        name: basename(citation.citingPath),
        qualified_name: citation.citingPath,
        repository_path: citation.citingPath,
        confidence: "high",
        source_evidence: [],
        attributes: { is_test: citation.isTest, added_by: EXTRACTOR },
        ...REV,
      });
      nodeById.set((fileNode as { id: string }).id, fileNode);
    }
    const edge = makeEdge({
      source: recId,
      target,
      relation: "justifies",
      discovery: "declared",
      evidence_type: "code_comment",
      evidence_location: `${citation.citingPath}:${citation.line}`,
      confidence: citation.isTest ? "medium" : "high",
      ...REV,
    });
    edgeById.set((edge as { id: string }).id, edge);
    governed.set(recId, (governed.get(recId) ?? 0) + 1);
  }

  for (const nodeId of emittedNodeIds) {
    const node = nodeById.get(nodeId);
    if (node && (governed.get(nodeId) ?? 0) > 0) {
      node.implementation_status = "implemented";
      node.defect_shape = null;
    }
  }

  const nodeCount = writeNodes(join(GRAPH_DIR, "nodes.jsonl"), [...nodeById.values()]);
  const edgeCount = writeEdges(join(GRAPH_DIR, "edges.jsonl"), [...edgeById.values()]);
  const evidenceCount = writeEvidence(join(GRAPH_DIR, "evidence.jsonl"), [...evidenceById.values()]);

  // Record this adapter and mark the planes it establishes. Without it, two
  // graphs built by different pipelines compare as if built by the same one,
  // and `vi-diff` reports a missing plane as repository drift rather than as a
  // changed measuring instrument.
  const manifestPath = join(GRAPH_DIR, "..", "manifest.json");
  if (existsSync(manifestPath)) {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
    const extractors = ((manifest.extractors as { name: string }[]) ?? []).filter((e) => e.name !== EXTRACTOR);
    extractors.push({
      name: EXTRACTOR,
      version: EXTRACTOR_VERSION,
      languages: ["markdown"],
      invocation: "vi-emit (@arbor/governance vi/intent + vi/exceptions)",
    } as never);
    extractors.sort((a, b) => (a.name < b.name ? -1 : 1));
    manifest.extractors = extractors;

    const planes = (manifest.planes as Record<string, unknown>) ?? {};
    planes.intended = {
      status: "current",
      sources: ["decisions/ADR-*.md", "decisions/README.md"],
      last_verified_revision: rev,
    };
    planes.declared = {
      status: "partial",
      sources: ["ROADMAP.md proof comments", "ADR citations in packages/", "package manifests"],
      reason: "obligations exist only where a proof comment declares one; ADRs carry none",
    };
    manifest.planes = planes;
    manifest.counts = { ...((manifest.counts as object) ?? {}), nodes: nodeCount, edges: edgeCount, evidence: evidenceCount };
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  }

  // `vi/exceptions.ts` is computation-only by design, so the store is written
  // here alongside the graph rather than inside the extractor.
  const exceptionsPath = join(GRAPH_DIR, "..", "exceptions", "exceptions.jsonl");
  mkdirSync(dirname(exceptionsPath), { recursive: true });
  writeFileSync(
    exceptionsPath,
    exceptions.value.records.map((record) => JSON.stringify(record)).join("\n") + "\n",
  );

  const summary = exceptions.value.summary;
  console.log(
    `vi-emit: ${intent.value.records.length} record(s), ${intent.value.citations.length} citation(s), ` +
    `${intent.value.danglingCitations.length} dangling, ${intent.value.findings.length} finding(s)`,
  );
  console.log(`  exceptions: ${summary.total} waiver(s) ingested, ${exceptions.value.findings.length} policy finding(s)`);
  console.log(`  wrote nodes=${nodeCount} edges=${edgeCount} evidence=${evidenceCount}`);
  return 0;
}

main().then((code) => process.exit(code));
