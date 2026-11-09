import { spawnSync } from "node:child_process";
import { basename } from "node:path";

// claim-ledger.ts remains an executable gate. This explicit, process-local
// import mode lets this gate reuse its canonical parser without running the
// whole claim extraction pipeline as an import side effect.
const CLAIM_LEDGER_LIBRARY_IMPORT = Symbol.for("revoy2.claim-ledger.library-import");
globalThis[CLAIM_LEDGER_LIBRARY_IMPORT] = true;
const { findAdrIndexDefectsFromEntries, leadingAdrStatus } = await import("../claim-ledger.ts");
delete globalThis[CLAIM_LEDGER_LIBRARY_IMPORT];

const ADR_PATH = /^decisions\/ADR-(?:\d+|PENDING-[a-z0-9][a-z0-9-]*)-?.*\.md$/;

function git(repo, args, allowFailure = false) {
  const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  if (result.status !== 0 && !allowFailure) throw new Error(`git ${args.join(" ")} failed: ${(result.stderr || result.stdout).trim()}`);
  return { ok: result.status === 0, stdout: (result.stdout ?? "").trimEnd(), stderr: (result.stderr ?? "").trimEnd() };
}

function statusOf(text) {
  const raw = (/^\*\*Status:\*\*\s*(.+)$/m.exec(text) ?? [])[1]?.trim() ?? "";
  return { raw, leading: leadingAdrStatus(raw) };
}

function withoutStatus(text) {
  return text.replace(/^\*\*Status:\*\*[^\n]*(?:\n|$)/m, "");
}

function show(repo, spec) {
  const result = git(repo, ["show", spec], true);
  return result.ok ? result.stdout + (result.stdout && !result.stdout.endsWith("\n") ? "\n" : "") : null;
}

function changedInCommit(repo, commit) {
  return git(repo, ["diff-tree", "--root", "--no-commit-id", "--name-status", "-r", "-M", commit]).stdout
    .split(/\r?\n/).filter(Boolean).map((line) => {
      const [status, first, second] = line.split("\t");
      return { status, before: status.startsWith("R") ? first : first, after: status.startsWith("R") ? second : first };
    });
}

function changedInIndex(repo) {
  return git(repo, ["diff", "--cached", "--name-status", "-M", "HEAD", "--"]).stdout
    .split(/\r?\n/).filter(Boolean).map((line) => {
      const [status, first, second] = line.split("\t");
      return { status, before: status.startsWith("R") ? first : first, after: status.startsWith("R") ? second : first };
    });
}

function snapshot(repo, revision) {
  const indexText = show(repo, `${revision}:decisions/README.md`) ?? "";
  const names = git(repo, ["ls-tree", "-r", "--name-only", revision, "--", "decisions"]).stdout.split(/\r?\n/).filter((path) => /^decisions\/ADR-\d+.*\.md$/.test(path));
  return { indexText, adrFiles: new Map(names.map((path) => [basename(path), show(repo, `${revision}:${path}`) ?? ""])) };
}

function indexSnapshot(repo) {
  const indexText = show(repo, ":decisions/README.md") ?? "";
  const names = git(repo, ["ls-files", "--cached", "decisions/ADR-*.md"]).stdout.split(/\r?\n/).filter((path) => /^decisions\/ADR-\d+.*\.md$/.test(path));
  return { indexText, adrFiles: new Map(names.map((path) => [basename(path), show(repo, `:${path}`) ?? ""])) };
}

function evaluateChanges(repo, label, changes, readBefore, readAfter, snapshotValue) {
  const violations = [];
  for (const change of changes) {
    if (!ADR_PATH.test(change.after ?? "")) continue;
    const before = change.status.startsWith("A") ? null : readBefore(change.before);
    const after = readAfter(change.after);
    if (after === null) continue;
    const nextStatus = statusOf(after);
    if (before === null) {
      if (nextStatus.leading !== "proposed") violations.push({ commit: label, path: change.after, code: "new_adr_not_proposed", message: "a newly-authored ADR must be Proposed in the same commit; only a later, separate commit may accept it" });
      continue;
    }
    const priorStatus = statusOf(before);
    if (priorStatus.leading !== "accepted" && nextStatus.leading === "accepted" && withoutStatus(before) !== withoutStatus(after)) {
      violations.push({ commit: label, path: change.after, code: "acceptance_bundles_content", message: "an ADR acceptance commit must be status-only; acceptance cannot be bundled with authorship or substantive content changes — use `bun run adr:accept <number> [--reject]`, which carries a status-only change through by construction" });
    }
  }
  // A status-word mismatch between the file and its index row is exactly the
  // defect `bun run adr:accept` fixes by construction (it writes both in the
  // same status-only commit) — every OTHER index defect here (a missing row,
  // a wrong file link) is not, so the remedy is named only for that one shape.
  const STATUS_MISMATCH_RE = /: index says "[^"]*", the file says "[^"]*"$/;
  for (const defect of findAdrIndexDefectsFromEntries(snapshotValue.indexText, snapshotValue.adrFiles)) {
    const remedy = STATUS_MISMATCH_RE.test(defect.detail) ? " — reconcile with `bun run adr:accept <number> [--reject]`" : "";
    violations.push({ commit: label, path: "decisions/README.md", code: "index_status_contradiction", message: `${defect.detail}${remedy}` });
  }
  return violations;
}

function revisions(repo, revisionOrRange) {
  if (!revisionOrRange.includes("..")) return [git(repo, ["rev-parse", revisionOrRange]).stdout];
  return git(repo, ["rev-list", "--reverse", revisionOrRange]).stdout.split(/\r?\n/).filter(Boolean);
}

export function checkAdrAcceptance({ repo, revision = "HEAD", staged = false }) {
  const violations = [];
  const inspected = [];
  if (staged) {
    const label = "staged changes";
    inspected.push(label);
    violations.push(...evaluateChanges(repo, label, changedInIndex(repo),
      (path) => show(repo, `HEAD:${path}`), (path) => show(repo, `:${path}`), indexSnapshot(repo)));
  } else {
    for (const commit of revisions(repo, revision)) {
      inspected.push(commit);
      violations.push(...evaluateChanges(repo, commit, changedInCommit(repo, commit),
        (path) => show(repo, `${commit}^:${path}`), (path) => show(repo, `${commit}:${path}`), snapshot(repo, commit)));
    }
  }
  return { ok: violations.length === 0, inspected, violations };
}
