import { createHash } from "node:crypto";
import { ADR_COUNT_DOCUMENTS, renderGovernanceCounts } from "../render-governance-counts.mjs";
import { closeSync, existsSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { git } from "./conductor/git.mjs";
import { coverageIndex, interviewAttestation, readInterviews } from "../decision-queue.mjs";
import { validateTransition } from "../../packages/arbor-governance/src/record/status.ts";
import { deriveRecordId, parseObligationsFromText } from "../../packages/arbor-governance/src/obligation/parse.ts";

const PENDING_PATTERN = /^ADR-PENDING-([a-z0-9][a-z0-9-]*)\.md$/;
const NUMBERED_PATTERN = /^ADR-(\d+)-(.+)\.md$/;

function registryPath(repo) { return join(repo, "decisions", "registry.json"); }
function indexPath(repo) { return join(repo, "decisions", "README.md"); }

export function contentId({ title, createdAt, authoringRevision }) {
  const canonical = JSON.stringify({ title, created_at: createdAt, authoring_revision: authoringRevision });
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

export function readRegistry(repo) {
  const parsed = JSON.parse(readFileSync(registryPath(repo), "utf8"));
  if (parsed.schema_version !== 1 || !Number.isSafeInteger(parsed.next_available) || !Array.isArray(parsed.reserved) || !Array.isArray(parsed.allocations)) {
    throw new Error("decisions/registry.json has an unsupported or incomplete shape");
  }
  return parsed;
}

/**
 * Numbers already claimed by an IN-FLIGHT allocation in a sibling worktree of
 * this same clone. See `readSharedReservations` for why the tracked registry
 * alone cannot answer this.
 */
export function nextAllocation(registry, sharedReserved = []) {
  const used = new Set([...registry.allocations.map((entry) => entry.number), ...sharedReserved]);
  const reserved = new Set(registry.reserved);
  const skipped = [];
  let number = registry.next_available;
  while (used.has(number) || reserved.has(number)) {
    skipped.push(number);
    number += 1;
  }
  let next = number + 1;
  while (used.has(next) || reserved.has(next)) {
    skipped.push(next);
    next += 1;
  }
  return { number, next_available: next, skipped };
}

/**
 * Shared, UNTRACKED in-flight allocation ledger, stored beside the allocator's
 * lock in the git common directory.
 *
 * WHY THIS EXISTS. `git worktree add` gives every worktree its own working copy
 * of `decisions/registry.json`, but all of them share one `--git-common-dir`.
 * The allocator's lock therefore serialized EXECUTION against UNSHARED state:
 * two worktrees each read `next_available: N` from their own copy and both
 * allocated N. That is mutual exclusion over a mutex guarding nothing, and it
 * is the mechanism behind four duplicate-ADR collisions on 2026-08-15 — the
 * lock was never the missing piece.
 *
 * A reservation is recorded under the existing lock BEFORE any working-tree
 * mutation, so a sibling worktree that acquires the lock next sees the number
 * as taken even though nothing is committed anywhere yet. Entries are pruned
 * once the number appears in this worktree's own tracked registry (it landed
 * here), and bounded by age and count so an abandoned draft cannot grow the
 * file without limit.
 *
 * HONEST LIMIT: this coordinates worktrees of ONE clone, because that is
 * exactly the scope of a shared common dir. Two separate clones share no such
 * directory, and their numbering still reconciles at merge — see ADR-072.
 */
const RESERVATION_MAX_ENTRIES = 512;
const RESERVATION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export function reservationsPath(repo) {
  const raw = git(repo, ["rev-parse", "--git-common-dir"]).stdout;
  const common = isAbsolute(raw) ? raw : resolve(repo, raw);
  return join(common, "adr-reservations.json");
}

/** Never throws: a missing, unreadable, or corrupt ledger is an empty ledger. */
export function readSharedReservations(repo) {
  try {
    const parsed = JSON.parse(readFileSync(reservationsPath(repo), "utf8"));
    if (parsed?.schema_version !== 1 || !Array.isArray(parsed.entries)) return [];
    return parsed.entries.filter((entry) => Number.isSafeInteger(entry?.number));
  } catch {
    return [];
  }
}

/**
 * Records `number` as in flight and returns the pruned entry list. Best effort
 * by construction: a filesystem that refuses the write must not fail an
 * otherwise-valid allocation, it only loses cross-worktree protection.
 */
export function recordSharedReservation(repo, { number, slug, registry }) {
  try {
    const landed = new Set((registry?.allocations ?? []).map((entry) => entry.number));
    const now = Date.now();
    const kept = readSharedReservations(repo)
      .filter((entry) => !landed.has(entry.number))
      .filter((entry) => !Number.isSafeInteger(entry.at) || now - entry.at < RESERVATION_MAX_AGE_MS)
      .filter((entry) => entry.number !== number);
    const entries = [...kept, { number, slug, worktree: repo, at: now }].slice(-RESERVATION_MAX_ENTRIES);
    writeFileSync(reservationsPath(repo), `${JSON.stringify({ schema_version: 1, entries }, null, 2)}\n`);
    return entries;
  } catch {
    return readSharedReservations(repo);
  }
}

function crossNamespaceCitations(decisionsDir) {
  const found = new Map();
  for (const name of readdirSync(decisionsDir).filter((entry) => /^ADR-(?:\d+|PENDING)-.*\.md$/.test(entry)).sort()) {
    const text = readFileSync(join(decisionsDir, name), "utf8");
    for (const match of text.matchAll(/revoy-spec(?:'s)?[^\n]{0,120}?ADR-(\d+)/gi)) {
      found.set(Number(match[1]), `${name} cites revoy-spec ADR-${match[1]}`);
    }
    for (const match of text.matchAll(/ADR-(045)-tier\b/g)) {
      found.set(Number(match[1]), `${name} cites the cross-namespace ADR-${match[1]} tier convention`);
    }
  }
  return found;
}

export function verifyRegistry(repo) {
  const registry = readRegistry(repo);
  const errors = [];
  const numbers = registry.allocations.map((entry) => entry.number);
  const ids = registry.allocations.map((entry) => entry.placeholder_id);
  if (new Set(numbers).size !== numbers.length) errors.push("allocation numbers are not unique");
  if (new Set(ids).size !== ids.length) errors.push("allocation placeholder_id values are not unique");
  for (const number of registry.reserved) {
    if (!registry.reserved_reason?.[String(number)]) errors.push(`reserved ADR-${String(number).padStart(3, "0")} has no reason`);
  }
  const citations = crossNamespaceCitations(join(repo, "decisions"));
  for (const [number, detail] of citations) {
    if (!registry.reserved.includes(number)) errors.push(`${detail}, but ${number} is absent from registry.reserved`);
  }
  const files = readdirSync(join(repo, "decisions"));
  const numbered = files.map((name) => name.match(NUMBERED_PATTERN)).filter(Boolean).map((match) => ({ number: Number(match[1]), slug: match[2] }));
  for (const file of numbered) {
    if (!registry.allocations.some((entry) => entry.number === file.number && entry.slug === file.slug)) errors.push(`ADR-${String(file.number).padStart(3, "0")}-${file.slug}.md has no matching allocation`);
  }
  for (const allocation of registry.allocations) {
    const expected = `ADR-${String(allocation.number).padStart(3, "0")}-${allocation.slug}.md`;
    if (!files.includes(expected)) errors.push(`allocation ${allocation.number}/${allocation.slug} has no ${expected}`);
  }
  if (registry.reserved.includes(registry.next_available) || numbers.includes(registry.next_available)) errors.push("next_available is already reserved or allocated");
  return { ok: errors.length === 0, errors, allocation_count: registry.allocations.length, pending_count: files.filter((name) => PENDING_PATTERN.test(name)).length, citations: [...citations.keys()].sort((a, b) => a - b) };
}

function lockPath(repo) {
  const raw = git(repo, ["rev-parse", "--git-common-dir"]).stdout;
  const common = isAbsolute(raw) ? raw : resolve(repo, raw);
  return join(common, "adr-registry.lock");
}

function acquireLock(repo) {
  const path = lockPath(repo);
  let fd;
  try {
    fd = openSync(path, "wx", 0o600);
    writeFileSync(fd, `${process.pid}\n`);
  } catch (error) {
    throw new Error(`decision registry is locked by another allocator: ${error.message}`);
  }
  return () => { closeSync(fd); rmSync(path, { force: true }); };
}

function parsePending(text, slug) {
  const title = text.match(/^#\s+(?:ADR-PENDING(?::|-)|)(.+)$/m)?.[1]?.trim();
  const createdAt = text.match(/^\*\*Date:\*\*\s*(\d{4}-\d{2}-\d{2})\s*$/m)?.[1];
  const authoringRevision = text.match(/^\*\*Authoring Revision:\*\*\s*([0-9a-f]{7,64})\s*$/m)?.[1];
  const id = text.match(/^\*\*Content ID:\*\*\s*(sha256:[0-9a-f]{64})\s*$/m)?.[1];
  const status = text.match(/^\*\*Status:\*\*\s*([^\n]+)$/m)?.[1]?.trim();
  if (!title || !createdAt || !authoringRevision || !id || !status) throw new Error(`ADR-PENDING-${slug}.md lacks title, Date, Authoring Revision, Content ID, or Status metadata`);
  if (!status.startsWith("Proposed")) throw new Error("a pending ADR must be Proposed");
  const expected = contentId({ title, createdAt, authoringRevision });
  if (id !== expected) throw new Error(`content_id mismatch: expected ${expected}`);
  return { title, createdAt, authoringRevision, id, status };
}

function appendIndex(text, { number, slug, title, status }) {
  const row = `| [${String(number).padStart(3, "0")}](ADR-${String(number).padStart(3, "0")}-${slug}.md) | ${title} | ${status.split(/\s|\(/)[0]} |`;
  if (text.includes(row)) throw new Error("decision index already contains this allocation");
  return `${text.trimEnd()}\n${row}\n`;
}

/**
 * Author a new pending decision draft (fixes D1 — no scaffold command). This
 * NEVER touches the registry, the index, or git: authoring is not allocation.
 * The draft's Content ID is always computed via `contentId()` — never
 * re-derived by hand — so `allocate` accepts it unmodified.
 */
export function newPendingDecision({ repo, slug, title, status = "Proposed" }) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) throw new Error("slug must be lowercase kebab-case");
  if (!title || !title.trim()) throw new Error("title is required (--title \"…\")");
  if (!status.startsWith("Proposed")) throw new Error("a pending ADR must be Proposed");
  const path = join(repo, "decisions", `ADR-PENDING-${slug}.md`);
  if (existsSync(path)) throw new Error(`decisions/ADR-PENDING-${slug}.md already exists`);
  const authoringRevision = git(repo, ["rev-parse", "HEAD"]).stdout.trim();
  const createdAt = new Date().toISOString().slice(0, 10);
  const id = contentId({ title, createdAt, authoringRevision });
  const text = `# ADR-PENDING: ${title}

**Status:** ${status}
**Date:** ${createdAt}
**Authoring Revision:** ${authoringRevision}
**Content ID:** ${id}

## Context

<!-- What forces make this decision necessary? -->

## Decision

<!-- What is being decided, and by what mechanism? -->

## Consequences

<!-- What becomes easier or harder as a result? -->

## Alternatives / Roads not taken

<!-- What other approaches were considered, and why were they rejected? -->

## Obligations

### O1 — <the durable, checkable claim this obligation upholds>

<!-- One sentence: what does this obligation prove, and how is it demonstrated? -->

<!--
proof: symbol= file= roundtrip=
The referenced symbol MUST be a top-level EXPORTED symbol: a proof against an
internal/unexported symbol cannot be verified by an external reader. Run
\`bun run proof <symbol> [--file <path>] [--test <path>]\` to resolve this
field set against the real repository and emit the comment ready to paste.
-->
`;
  writeFileSync(path, text);
  return { ok: true, file: path.slice(repo.length + 1), content_id: id, next_step: `bun scripts/adr-registry.mjs allocate ${slug}` };
}

export function allocateDecision({ repo, slug, commit = true }) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) throw new Error("slug must be lowercase kebab-case");
  const release = acquireLock(repo);
  const pending = join(repo, "decisions", `ADR-PENDING-${slug}.md`);
  const pendingRelative = pending.slice(repo.length + 1);
  let numbered = null;
  let originalIndex;
  let originalRegistry;
  let originalCountDocs;
  let originalPendingText;
  try {
    if (!existsSync(pending)) throw new Error(`missing decisions/ADR-PENDING-${slug}.md`);
    // D2: the pending file is almost never tracked (authoring via `new` never
    // git-adds it). Stage its removal ONLY if it was a real tracked deletion —
    // otherwise `git add` on a path that never existed in the index fails with
    // "did not match any files".
    const pendingWasTracked = git(repo, ["ls-files", "--error-unmatch", "--", pendingRelative], { allowFailure: true }).ok;
    const registry = readRegistry(repo);
    originalRegistry = readFileSync(registryPath(repo), "utf8");
    originalIndex = readFileSync(indexPath(repo), "utf8");
    const metadata = parsePending(readFileSync(pending, "utf8"), slug);
    if (registry.allocations.some((entry) => entry.placeholder_id === metadata.id)) throw new Error(`content_id ${metadata.id} is already allocated`);
    const allocation = nextAllocation(registry, readSharedReservations(repo).map((entry) => entry.number));
    // Claim the number in the shared ledger BEFORE touching the working tree,
    // so a sibling worktree taking the lock next cannot pick the same one.
    recordSharedReservation(repo, { number: allocation.number, slug, registry });
    const padded = String(allocation.number).padStart(3, "0");
    numbered = join(repo, "decisions", `ADR-${padded}-${slug}.md`);
    if (existsSync(numbered)) throw new Error(`ADR-${padded}-${slug}.md already exists`);
    originalPendingText = readFileSync(pending, "utf8");
    const finalText = originalPendingText.replaceAll(`ADR-PENDING-${slug}`, `ADR-${padded}-${slug}`).replace(/^#\s+ADR-PENDING(?::|-)?/m, `# ADR-${padded}:`);
    renameSync(pending, numbered);
    writeFileSync(numbered, finalText);
    writeFileSync(indexPath(repo), appendIndex(originalIndex, { number: allocation.number, slug, title: metadata.title, status: metadata.status }));
    registry.allocations.push({ number: allocation.number, slug, placeholder_id: metadata.id });
    registry.next_available = allocation.next_available;
    const temporary = `${registryPath(repo)}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(registry, null, 2)}\n`);
    renameSync(temporary, registryPath(repo));
    const hasRenderedCountDocs = ADR_COUNT_DOCUMENTS.every((path) => existsSync(join(repo, path)));
    if (hasRenderedCountDocs) {
      // D3: capture every rendered document BEFORE mutating it so a failure in
      // the (later) git step can be fully undone, not just the registry/index.
      originalCountDocs = new Map(ADR_COUNT_DOCUMENTS.map((path) => [path, readFileSync(join(repo, path), "utf8")]));
      renderGovernanceCounts(repo);
    }
    if (commit) {
      const paths = [numbered, indexPath(repo), registryPath(repo)].map((path) => path.slice(repo.length + 1));
      if (pendingWasTracked) paths.unshift(pendingRelative);
      if (hasRenderedCountDocs) paths.push(...ADR_COUNT_DOCUMENTS);
      git(repo, ["add", "--", ...paths]);
      git(repo, ["commit", "--only", "-m", `docs: allocate ADR-${padded} ${slug}\n\nADR: ${padded}`, "--", ...paths]);
    }
    return { ok: true, number: allocation.number, next_available: allocation.next_available, skipped: allocation.skipped, file: numbered.slice(repo.length + 1), content_id: metadata.id };
  } catch (error) {
    if (originalCountDocs) for (const [path, text] of originalCountDocs) writeFileSync(join(repo, path), text);
    if (originalIndex !== undefined) writeFileSync(indexPath(repo), originalIndex);
    if (originalRegistry !== undefined) writeFileSync(registryPath(repo), originalRegistry);
    if (numbered && existsSync(numbered)) {
      if (!existsSync(pending)) {
        // The numbered file's content was already rewritten (title, internal
        // self-references) before the rename — restore the ORIGINAL pending
        // text, not the rewritten one, or a retried allocation would fail
        // parsePending's content_id check against its own prior mutation.
        renameSync(numbered, pending);
        if (originalPendingText !== undefined) writeFileSync(pending, originalPendingText);
      } else {
        rmSync(numbered, { force: true });
      }
    }
    throw error;
  } finally {
    release();
  }
}

/**
 * Carry a recorded operator decision through to the record's status (the
 * missing verb in this registry's CRUD surface — allocate creates, verify
 * reads, nothing wrote status until this). Acceptance stays a witnessed human
 * act: this refuses any ADR the interview ledger does not currently cover, so
 * it can only ever execute a decision, never make one (ADR-059/072/085). The
 * change is status-only by construction — record status line plus index row —
 * which is exactly the shape gate:adr-acceptance-staged demands and the
 * claim-ledger PreToolUse guard cannot express in a single hand edit.
 *
 * OBLIGATIONS ARE CHECKED, NEVER BLOCKED ON (2026-08-24). Reproduced live: a
 * record accepted here with no "## Obligations" section passes cleanly, then
 * fails `gate:obligations` (POL-04) minutes later at the next stop battery —
 * a surprise the operator had no way to see at the moment they made the
 * decision. Acceptance stays unblocked (the decision is the operator's and
 * already recorded; refusing to carry it through would just re-litigate a
 * human verdict), but the result carries a `followup_required` warning naming
 * the exact gate and the exact fix, reusing `@arbor/governance`'s own
 * obligations parser (the same one `scripts/obligations-gate.ts` calls)
 * rather than re-deriving the "## Obligations" heading grammar here.
 */
/**
 * Carry a recorded operator decision through to a record's status and its
 * index row, together, in a status-only commit.
 *
 * `supersededBy` retires an Accepted record. LEGAL_TRANSITIONS has always
 * permitted accepted->superseded, but nothing performed it: the only status
 * verb was accept/reject, so retiring a record meant hand-editing it, which
 * gate:adr-acceptance-staged then rejected for disagreeing with the index --
 * while advising `adr:accept`, which cannot express supersession. A legal
 * transition no tool can make is the same documented-but-unwired shape this
 * repository keeps finding.
 */
export function acceptDecision({ repo, number, reject = false, supersededBy = null, commit = true, today = new Date().toISOString().slice(0, 10) }) {
  const parsed = String(number ?? "").match(/^(?:ADR-)?(\d{1,3})$/i)?.[1];
  if (!parsed) throw new Error("accept requires an ADR number (e.g. 084 or ADR-084)");
  const padded = parsed.padStart(3, "0");
  const id = `ADR-${padded}`;
  const entries = readdirSync(join(repo, "decisions")).filter((name) => name.startsWith(`ADR-${padded}-`) && name.endsWith(".md"));
  if (entries.length !== 1) throw new Error(entries.length === 0 ? `no decisions/ADR-${padded}-*.md exists` : `ambiguous: ${entries.join(", ")}`);
  // ADR-158: coverage here is what makes an acceptance legal, so it must be
  // the same attested coverage `deriveDecisionQueue` uses — a hand-appended
  // ledger line must not be able to authorise a status flip. `isAttested` is
  // `null` when this clone has no receipt store (fresh checkout, CI), which
  // keeps every record counting; only a PRESENT store can reject one.
  const interviews = readInterviews(repo);
  const attestation = interviewAttestation(repo, interviews);
  const covered = coverageIndex(interviews, today, { isAttested: attestation.isAttested });
  const interview = covered.get(id);
  if (!interview) throw new Error(`no standing interview covers ${id} — acceptance is a witnessed human decision; ask it through the native question tool and record it with \`bun run interview:record\` first (ADR-059/085/178). This command carries a recorded decision through; it never makes one.`);
  if (interview.deferred_to && interview.deferred_to >= today) throw new Error(`${id} is deferred to ${interview.deferred_to} by the ${interview.held_at} interview; a deferral is a considered "not yet"`);
  const release = acquireLock(repo);
  const recordPath = join(repo, "decisions", entries[0]);
  let originalRecord;
  let originalIndex;
  try {
    originalRecord = readFileSync(recordPath, "utf8");
    originalIndex = readFileSync(indexPath(repo), "utf8");
    const from = originalRecord.match(/^\*\*Status:\*\*\s*(\S+)\s*$/m)?.[1];
    if (!from) throw new Error(`${entries[0]} has no parseable **Status:** line`);
    const supersededById = supersededBy === null || supersededBy === undefined
      ? null
      : `ADR-${String(supersededBy).match(/^(?:ADR-)?(\d{1,3})$/i)?.[1]?.padStart(3, "0") ?? ""}`;
    if (supersededBy !== null && supersededBy !== undefined && supersededById === "ADR-") {
      throw new Error("--by requires the ADR number that supersedes this one (e.g. 142 or ADR-142)");
    }
    const to = supersededById ? "Superseded" : reject ? "Rejected" : "Accepted";
    const transition = validateTransition(from.toLowerCase(), to.toLowerCase());
    if (!transition.ok) throw new Error(`illegal transition ${from} -> ${to}: ${transition.error.message}`);
    writeFileSync(recordPath, originalRecord.replace(/^\*\*Status:\*\*\s*\S+\s*$/m, `**Status:** ${to}`));
    const rowPattern = new RegExp(`^(\\|\\s*\\[${padded}\\]\\([^)]*\\)\\s*\\|.*\\|\\s*)${from}(\\s*\\|.*)$`, "m");
    if (!rowPattern.test(originalIndex)) throw new Error(`decisions/README.md has no ${id} index row at status ${from}`);
    writeFileSync(indexPath(repo), originalIndex.replace(rowPattern, `$1${to}$2`));
    const paths = [recordPath.slice(repo.length + 1), indexPath(repo).slice(repo.length + 1)];
    if (commit) {
      git(repo, ["add", "--", ...paths]);
      const verb = supersededById ? "supersede" : reject ? "reject" : "accept";
      const trailer = supersededById
        ? `\n\nSuperseded by ${supersededById}. The retiring record must also declare the\nsupersession in prose and the retired one must carry a back-reference;\ngate:adr-retirement-integrity checks both directions.`
        : "";
      git(repo, ["commit", "--only", "-m", `docs(decisions): ${verb} ${id}\n\nStatus-only per ADR-059, carrying through the ${interview.held_at} operator\ninterview (decisions/interviews.jsonl). gate:adr-decision-followthrough\nreconciles coverage against this status.${trailer}\n\nADR: ${padded}`, "--", ...paths]);
    }
    const result = { ok: true, id, file: paths[0], from, to, interview_held_at: interview.held_at, committed: commit };
    if (supersededById) result.superseded_by = supersededById;
    if (to === "Accepted") {
      const recordId = deriveRecordId(entries[0]) ?? id;
      const parsed = parseObligationsFromText(recordId, paths[0], originalRecord);
      const hasObligations = parsed.ok && parsed.value.has_obligations_section && parsed.value.obligations.length > 0;
      if (!hasObligations) {
        result.followup_required = "record declares no Obligations; gate:obligations POL-04 will fail at the next stop battery — add an Obligations section with resolving proofs, or the documented exemption";
      }
    }
    return result;
  } catch (error) {
    if (originalIndex !== undefined) writeFileSync(indexPath(repo), originalIndex);
    if (originalRecord !== undefined) writeFileSync(recordPath, originalRecord);
    throw error;
  } finally {
    release();
  }
}
