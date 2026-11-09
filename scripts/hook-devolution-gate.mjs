#!/usr/bin/env node
/**
 * scripts/hook-devolution-gate.mjs — is every host hook's native replacement
 * ACTIVATED, or only registered?
 *
 *   node scripts/hook-devolution-gate.mjs [--repo <path>] [--json]
 *
 * THE OPERATOR INVARIANT THIS MAKES CHECKABLE
 *   "All gates proven effective must be proven to be fully transitioned to
 *    native source level before they are deprecated."
 *
 * WHY PROSE WAS NOT ENOUGH, WITH THE THREE GREEN LIGHTS THAT SHOWED FOR IT.
 * Four host hooks were deleted and replaced with native handlers in
 * `packages/arbor-mcp/src/hooks/handlers.ts` (`veto.git-write-guard`,
 * `inject.governance-orient`, `inject.session-isolation`,
 * `inject.owed-decisions`). Those handlers are INERT: nothing activates them.
 * Three checks that could not fail said everything was fine.
 *
 *   1. `arbor hook validate` printed "All hook descriptors are valid." and
 *      exited 0 over ZERO descriptors. The catalog it validates is
 *      `HookCatalog.fromDirectory(join(cwd, ".arbor", "hooks"))`
 *      (`native-executor-composition.ts:141`) and that directory does not
 *      exist. A green over an empty set.
 *   2. `scripts/hook-liveness-gate.mjs` asks only whether a hook's OUTPUT
 *      stopped varying, over `.hook-liveness/invocations.jsonl`. Deleting a
 *      hook removes it from the manifest it walks, so it went green across all
 *      four deletions. It never touches the disk and cannot see a handler.
 *   3. `HookBus.wrapToolPort` is `if (vetoHooks.length === 0) return port;`
 *      (`bus.ts:154-155`). A veto that never wraps is indistinguishable from a
 *      veto that approved everything.
 *
 * THE DISTINCTION THIS GATE ENFORCES, because it is the whole defect:
 *   REGISTRATION is not ACTIVATION. Adding a key to `HOOK_HANDLERS` makes a
 *   handler selectable. Activating it needs a descriptor in `DEFAULT_HOOK_SET`
 *   (`hooks/catalog.ts:70-81`) naming that `handler_ref`, which
 *   `enrollProject` materializes per clone as `.arbor/hooks/<id>@<ver>.json`.
 *   `.arbor/` is gitignored (`.gitignore:29`), so activation has to be SOURCE,
 *   and per-clone materialization is legitimately local.
 *
 * AND THE THREE HALVES MUST BE THE SAME HOOK, which is the defect this file
 * reproduced one level down. It certifies `handler_ref`, `descriptor` and
 * `seam` INDEPENDENTLY — a key in the closed registry, an id in
 * `DEFAULT_HOOK_SET`, a public method name — and independence certified two
 * claims that are each true and jointly false: a row whose `handler_ref` is a
 * real key NO descriptor binds, and whose `seam` is a real method that
 * dispatches a different event. Both passed with sixteen devolved rows, which
 * is the same shape as the incident (a handler nothing dispatches, declared
 * devolved) wearing a green gate written to prevent it. So the descriptor is
 * resolved to the handler and event it ACTUALLY binds and the row must name
 * those: `descriptor_handler_mismatch` and `seam_does_not_dispatch_event`. The
 * event→seam relation is DERIVED from `bus.ts` (with `contracts.ts` for the
 * event sets its parameters are typed with) rather than typed out here, because
 * a hand-written second table in this file is precisely the drift class it
 * exists to catch.
 *
 * AND A SEAM'S LANE IS PART OF WHAT IT CLAIMS, because an event name alone
 * does not identify a lane. `turn_end` is in BOTH `HOOK_OBSERVE_EVENTS` and
 * `HOOK_INJECT_EVENTS`, so `observeTurnEnd` and `injectTurnEnd` derive the same
 * event set — while `fireObserve` filters `hook.kind === "observe"` and
 * `TropismInjector.inject` filters `hook.kind === "inject"`. A row whose
 * descriptor is `kind: "inject"` could therefore name `observeTurnEnd`, satisfy
 * an event-only check, and describe a seam that at runtime can never fire it:
 * the hole this check exists to close, reopened through the derivation. So each
 * seam derives the hook KINDS it dispatches for, from the same source and by
 * the same means, and the descriptor's own `kind` must be among them.
 *
 * HENCE THE ONE DELIBERATELY NON-BLOCKING FINDING. A descriptor that is
 * shipped in source but absent from this clone's `.arbor/hooks` is
 * materialization drift, not a governance failure: `arbor project repair
 * --apply` writes it, and the fix is per-clone by construction. It is reported
 * with its remedy and never blocks. Everything else blocks, including the case
 * where the walk itself observed nothing.
 *
 * FAILS CLOSED. If the gate cannot enumerate the registrations, it has
 * measured nothing, and a check that measured nothing is not a pass — that is
 * the defect class above, reproduced in a new gate. `--repo` is a fixture seam
 * only (`guard-canaries`); absent the flag the root is the checkout.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** `--repo` exists so `guard-canaries` can drive this gate against a fixture. */
function argValue(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : null;
}
const REPO_ROOT = resolve(argValue("--repo") ?? join(dirname(fileURLToPath(import.meta.url)), ".."));
const JSON_OUT = process.argv.includes("--json");

const LEDGER = join(REPO_ROOT, "scripts", "hook-devolution.json");
const HANDLERS_TS = join(REPO_ROOT, "packages", "arbor-mcp", "src", "hooks", "handlers.ts");
const CATALOG_TS = join(REPO_ROOT, "packages", "arbor-mcp", "src", "hooks", "catalog.ts");
const BUS_TS = join(REPO_ROOT, "packages", "arbor-mcp", "src", "hooks", "bus.ts");
const CONTRACTS_TS = join(REPO_ROOT, "packages", "arbor-mcp", "src", "hooks", "contracts.ts");
const INJECT_TS = join(REPO_ROOT, "packages", "arbor-mcp", "src", "hooks", "inject.ts");

/** The three places a host hook can be registered. All three are walked. */
const REGISTRATION_SOURCES = [
  { label: "scripts/host-controls.json", path: join("scripts", "host-controls.json") },
  { label: ".claude/settings.json", path: join(".claude", "settings.json") },
  { label: ".codex/hooks.json", path: join(".codex", "hooks.json") },
];

/**
 * The only statuses a REGISTERED host hook may hold.
 *
 * `retained` is deliberately absent, and the schema below accepts it only for a
 * row that is not a live registration. The operator ruled zero retentions: every
 * registered host hook must end devolved-and-deleted, or replaced by a new
 * native equivalent. A status vocabulary that offered `retained` to a live
 * registration would make the quiet third option — the one this whole gate
 * exists to close — expressible in the ledger.
 */
const REGISTERED_STATUSES = new Set(["pending_activation", "devolved"]);
const ANY_STATUS = new Set([...REGISTERED_STATUSES, "retained"]);

const RERUN = "bun run gate:hook-devolution";
const MATERIALIZE_REMEDY = "bun packages/arbor-mcp/src/cli.ts project repair . --apply";

function readTextOrNull(path) {
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

/**
 * The script a registration actually runs.
 *
 * Both a Claude Code command and a Codex command name more than one path-shaped
 * token — a Claude command is `wrap.sh --mode … --log …/invocations.jsonl <SCRIPT>`,
 * so the FIRST `.sh` is the liveness wrapper and the LAST is the hook. Taking
 * the first would audit `wrap.sh` for all nine Claude registrations and report
 * the repository healthy. The `# revoy2-hook:<id>` marker and `$CLAUDE_PROJECT_DIR/`
 * are stripped so the result is a repo-relative path comparable to a ledger row.
 */
export function scriptFromCommand(command) {
  if (typeof command !== "string") return null;
  const withoutMarker = command.replace(/\s*#\s*revoy2-hook:[a-z0-9][a-z0-9._-]*\s*$/u, "");
  const tokens = withoutMarker.split(/\s+/).filter((token) => /\.(?:sh|mjs|cjs|js|ts|py)$/u.test(token) && !token.startsWith("--"));
  const script = tokens.at(-1);
  return script ? script.replace(/^\$CLAUDE_PROJECT_DIR\//u, "").replace(/^["']|["']$/gu, "") : null;
}

/** Keys of the closed `HOOK_HANDLERS` registry, read out of its source. */
export function parseHandlerRefs(text) {
  const refs = new Set();
  for (const match of String(text ?? "").matchAll(/^\s*"([A-Za-z][\w.-]*)":\s*Object\.freeze\(\{\s*kind:/gmu)) refs.add(match[1]);
  return refs;
}

/**
 * `DEFAULT_HOOK_SET` as `hook_id -> { event, handler_ref }`, read out of its
 * source. The slice stops at `DEFAULT_HOOK_DESCRIPTORS`, the derived projection
 * that re-lists the same set, so a projection change cannot read as an
 * activation.
 *
 * `handler_ref` and `event` are read alongside the id because the gate has to
 * say WHICH handler a descriptor activates, WHICH event it rides, and WHICH
 * hook KIND it is — the last because a name alone does not identify a lane, so
 * `turn_end` under an `observe` seam and under an `inject` seam are different
 * claims about different code paths. Each
 * descriptor's slice runs to the NEXT `hook_id:` rather than to the next brace,
 * because a `why:` is free text and one containing `})` would otherwise truncate
 * the slice and take the next descriptor's `handler_ref` with it.
 */
export function parseDefaultHookDescriptors(text) {
  const source = String(text ?? "");
  const start = source.indexOf("DEFAULT_HOOK_SET");
  if (start < 0) return new Map();
  const end = source.indexOf("DEFAULT_HOOK_DESCRIPTORS", start);
  const body = source.slice(start, end < 0 ? undefined : end);
  const hits = [...body.matchAll(/hook_id:\s*"([a-z0-9][a-z0-9-]*)"/gu)];
  const descriptors = new Map();
  for (const [index, hit] of hits.entries()) {
    const slice = body.slice(hit.index, hits[index + 1]?.index ?? body.length);
    descriptors.set(hit[1], {
      event: /event:\s*"([a-z_]+)"/u.exec(slice)?.[1] ?? null,
      handler_ref: /handler_ref:\s*"([\w.-]+)"/u.exec(slice)?.[1] ?? null,
      kind: /kind:\s*"([a-z_]+)"/u.exec(slice)?.[1] ?? null,
    });
  }
  return descriptors;
}

/** The `hook_id`s `parseDefaultHookDescriptors` read — the source-level activation list. */
export function parseDefaultHookIds(text) {
  return new Set(parseDefaultHookDescriptors(text).keys());
}

/**
 * The body of one class, or `""` when the class is not there at all.
 *
 * `marker` is the declaration to find (`export class HookBus`,
 * `export class TropismInjector`) rather than a fixed name, because the two
 * dispatch surfaces this gate reads live in different files: the veto/observe/
 * lifecycle lanes are methods of `HookBus`, and the `inject` lane is a method
 * of `TropismInjector`, which `HookBus` holds as a field and delegates to.
 */
export function classBody(text, marker) {
  const source = String(text ?? "");
  const start = source.indexOf(marker);
  if (start < 0) return "";
  const end = source.indexOf("\n}", start);
  return source.slice(start, end < 0 ? undefined : end);
}

/**
 * Every method declared directly in a class body, as its own source slice.
 *
 * The slice runs to the NEXT method rather than to the next brace, because a
 * JSDoc comment between two methods is free text and one containing `)` or a
 * call expression would otherwise truncate a slice and take the neighbour's
 * dispatch with it.
 *
 * `async` is part of the pattern because a method's visibility does not depend
 * on whether it returns a Promise. Excluding it reported `seam_unknown` —
 * "this hook's dispatch method does not exist" — for a method that was present
 * and public, which is the one thing this gate must never say falsely.
 */
export function methodSlices(body) {
  const starts = [...String(body ?? "").matchAll(/^ {2}((?:private|protected|static)\s+)?(?:async\s+)?([A-Za-z_][\w]*)\s*(?:<[^>]*>)?\(/gmu)];
  return starts.map((match, index) => ({
    name: match[2],
    private: match[1] !== undefined,
    text: String(body ?? "").slice(match.index, starts[index + 1]?.index ?? body.length),
  }));
}

/** Public instance methods of `HookBus`: the dispatch seams a hook can ride. */
export function parseHookBusMethods(text) {
  const methods = new Set();
  for (const method of methodSlices(classBody(text, "export class HookBus"))) {
    if (!method.private) methods.add(method.name);
  }
  return methods;
}

/** The `Hook*Event` parameter types, and the `contracts.ts` set each one names. */
const EVENT_TYPE_SETS = {
  HookVetoEvent: "HOOK_VETO_EVENTS",
  HookObserveEvent: "HOOK_OBSERVE_EVENTS",
  HookLifecycleEvent: "HOOK_LIFECYCLE_EVENTS",
  HookInjectEvent: "HOOK_INJECT_EVENTS",
  HookEvent: "HOOK_ALL_EVENTS",
};

/**
 * The event name sets and event constants `contracts.ts` declares.
 *
 * This is the one file read that is not a hook surface, and it is needed
 * because a seam that dispatches whatever event it is handed —
 * `injectForSession(event: HookLifecycleEvent)`,
 * `lifecycleObserve(event: Exclude<HookLifecycleEvent, "session_start">)` —
 * can only be resolved against the set those parameters are typed with.
 * `HOOK_INJECT_EVENTS` spreads `HOOK_LIFECYCLE_EVENTS`, and the spread is
 * resolved, so the relation stops being derived at the one set that composes
 * another.
 *
 * `HookKind` is read too, and it is what makes the KIND derivation closed rather
 * than open-ended: a dispatch site's own `hook.kind === "..."` literal is only a
 * descriptor kind if `HookKind` names it. `bus.ts` also compares `entry.kind`
 * against a HANDLER kind, and `"plugin"` is one of those — a registry-entry
 * kind, not a descriptor kind, and a seam admitting it admits no descriptor.
 */
export function parseEventContracts(text) {
  const source = String(text ?? "");
  const sets = new Map();
  for (const match of source.matchAll(/export const (HOOK_[A-Z_]+) = Object\.freeze\(\[([\s\S]*?)\] as const\)/gu)) {
    const values = new Set();
    for (const part of match[2].split(",")) {
      const token = part.trim();
      if (token === "") continue;
      if (token.startsWith("...")) {
        for (const value of sets.get(token.slice(3)) ?? []) values.add(value);
        continue;
      }
      const literal = /"([a-z_]+)"/u.exec(token);
      if (literal) values.add(literal[1]);
    }
    sets.set(match[1], values);
  }
  const constants = new Map();
  for (const match of source.matchAll(/export const ([A-Z][A-Z0-9_]+)[^=]*=\s*"([a-z_]+)"/gu)) constants.set(match[1], match[2]);
  const kinds = new Set([...(/export type HookKind\s*=\s*([^;]+);/u.exec(source)?.[1] ?? "").matchAll(/"([a-z_]+)"/gu)].map((match) => match[1]));
  return { sets, constants, kinds };
}

/**
 * `seam -> the events and the hook KINDS that seam actually dispatches for`,
 * DERIVED from `bus.ts` (plus `inject.ts` and `contracts.ts`).
 *
 * A hand-typed table here would be the drift class this file exists to catch: a
 * second list, living in the gate, able to disagree with the one `HookBus`
 * implements — and it would disagree in the direction that makes a gate green.
 * So each public method is read for the three shapes dispatch actually takes:
 *
 *   - an event LITERAL handed to a fire/inject call (`fireObserve("turn_end")`,
 *     `this.injector.inject("turn_end")`);
 *   - an event literal it FILTERS on (`hook.event === "tool_preflight"`), which
 *     is the veto lane selecting what it will fire;
 *   - an `event` PARAMETER typed with one of `contracts.ts`'s event sets, less
 *     any `Exclude<…>` name — the method dispatches whatever it is handed.
 *
 * AND THE KIND, because the event does not identify the lane. `turn_end` is in
 * both the observe and the inject event sets, so the two seams that fire it
 * derive identical events and differ only in the `hook.kind` each dispatch site
 * filters on — `fireObserve` admits `"observe"`, `TropismInjector.inject` admits
 * `"inject"`. A check that stopped at the event would pass a `kind: "inject"`
 * row naming `observeTurnEnd`, which at runtime fires nothing.
 *
 * THE KIND IS RESOLVED, NEVER LISTED, and it is resolved the same way the events
 * are — by reading a `hook.kind === "…"` literal out of the code that performs
 * the dispatch. Three sources, in the order they apply:
 *
 *   1. the seam's OWN slice, which is where the `lifecycle` and the veto/observe
 *      `catalog.list().filter(...)` lanes live;
 *   2. a method of `HookBus` the seam CALLS, recursively — `observeTurnEnd`
 *      calls `fireObserve`, and `fireObserve`'s own body is where
 *      `hook.kind === "observe"` is written. Matching on the callee's NAME
 *      rather than on `this.` is deliberate: `wrapToolPortWithAudit` reaches the
 *      same private helper through a captured `bus` alias.
 *   3. a method of `TropismInjector` the seam calls — the `inject` lane lives in
 *      a different file, and this is the only reason `inject.ts` is read. Its
 *      kinds are resolved from ITS OWN slice for the same reason (1) applies:
 *      taking the whole class body would union in whatever a future second
 *      method filtered for.
 *
 * So there is no table here to drift. If `fireObserve` stops admitting
 * `observe`, or `TropismInjector.inject` stops admitting `inject`, the derived
 * kinds change with the source and the affected rows fail — which is the
 * direction a hand-typed table would have failed in.
 *
 * WHAT "UNDERVIVABLE" MEANS. A slice matching no event shape AND no kind shape
 * yields two EMPTY sets, and the two are not the same claim. A seam that fires a
 * kind it can also name from a helper is genuinely dispatching; one that matches
 * nothing may be `diagnostics()`, or may be a seam whose dispatch was moved into
 * a helper this derivation cannot follow. Reporting the second as the first —
 * "dispatches no hook event" — is the same false-negative class as the earlier
 * `async` regex that reported `seam_unknown` for methods that existed and were
 * public, so `events.size === 0 && kinds.size === 0` is reported as
 * UNDERIVABLE and never as an absence.
 */
export function parseSeamDispatch(busText, contractsText, injectText = null) {
  const { sets, constants, kinds: hookKinds } = parseEventContracts(contractsText);
  const busMethods = methodSlices(classBody(busText, "export class HookBus"));
  const injectorMethods = methodSlices(classBody(injectText, "export class TropismInjector"));

  /** Every `hook.kind === "…"` in a slice, narrowed to the declared `HookKind` union. */
  const kindsIn = (text) => new Set([...String(text ?? "").matchAll(/hook\.kind === ("[a-z_]+"|[A-Z][A-Z0-9_]*)/gu)]
    .map((match) => (match[1].startsWith('"') ? match[1].slice(1, -1) : constants.get(match[1]) ?? ""))
    .filter((kind) => hookKinds.has(kind)));

  /**
   * A seam's kinds, following the dispatch it performs into the method that
   * actually filters. `seen` bounds the walk: two seams calling the same helper
   * are ordinary, a helper cycle would not terminate without it.
   */
  const kindsOf = (slice, seen) => {
    const kinds = kindsIn(slice.text);
    for (const call of slice.text.matchAll(/\.(\w+)\(/gu)) {
      const helper = busMethods.find((method) => method.name === call[1]) ?? injectorMethods.find((method) => method.name === call[1]);
      if (helper === undefined || seen.has(helper.name)) continue;
      seen.add(helper.name);
      for (const kind of kindsOf(helper, seen)) kinds.add(kind);
    }
    return kinds;
  };

  const dispatch = new Map();
  for (const method of busMethods) {
    if (method.private) continue;
    const events = new Set();
    for (const match of method.text.matchAll(/(?:fireObserve|inject)\(\s*"([a-z_]+)"/gu)) events.add(match[1]);
    for (const match of method.text.matchAll(/hook\.event === ("[a-z_]+"|HOOK_[A-Z_]+)/gu)) {
      events.add(match[1].startsWith('"') ? match[1].slice(1, -1) : constants.get(match[1]) ?? "");
    }
    for (const match of method.text.matchAll(/\bevent:\s*([^)]*)/gu)) {
      const allowed = sets.get(EVENT_TYPE_SETS[/Hook[A-Za-z]*Event/u.exec(match[1])?.[0] ?? ""]);
      if (allowed === undefined) continue;
      const excluded = new Set([...match[1].matchAll(/"([a-z_]+)"/gu)].map((literal) => literal[1]));
      for (const value of allowed) if (!excluded.has(value)) events.add(value);
    }
    events.delete("");
    dispatch.set(method.name, { events, kinds: kindsOf(method, new Set([method.name])) });
  }
  return dispatch;
}

function readJson(path, label, findings) {
  if (!existsSync(path)) return { missing: true, value: null };
  try {
    return { missing: false, value: JSON.parse(readFileSync(path, "utf8")) };
  } catch (error) {
    findings.push({
      code: "registration_source_unreadable",
      id: label,
      detail: `${label} could not be read: ${error instanceof Error ? error.message : String(error)}`,
      remedy: `fix the JSON in ${label}, then ${RERUN}`,
    });
    return { missing: false, value: null, unreadable: true };
  }
}

/**
 * Every live registration, unioned across the three sources by id.
 *
 * `host-controls.json` is the reconciled manifest and carries the id; the two
 * host config files carry the same id in their `# revoy2-hook:` marker. Both
 * are walked because a hook installed in a host but absent from the manifest is
 * still running, and a gate that only reads the manifest would not see it.
 */
export function collectRegistrations(root, findings) {
  const found = new Map();
  const add = (id, event, source, origin) => {
    if (typeof id !== "string" || id.length === 0) return;
    if (found.has(id)) {
      const existing = found.get(id);
      if (existing.source === null) existing.source = source;
      existing.origins.push(origin);
      return;
    }
    found.set(id, { id, event: event ?? null, source, origins: [origin] });
  };

  for (const { label, path: relative } of REGISTRATION_SOURCES) {
    const { missing, value } = readJson(join(root, relative), label, findings);
    if (missing || value === null) continue;
    if (label === "scripts/host-controls.json") {
      for (const adapter of value.adapters ?? []) {
        for (const event of adapter.events ?? []) {
          for (const group of event.groups ?? []) {
            for (const hook of group.hooks ?? []) add(hook.id, event.event, scriptFromCommand(hook.command), label);
          }
        }
      }
      continue;
    }
    for (const [event, groups] of Object.entries(value.hooks ?? {})) {
      for (const group of groups ?? []) {
        for (const hook of group.hooks ?? []) {
          const command = typeof hook?.command === "string" ? hook.command : "";
          add(/#\s*revoy2-hook:([a-z0-9][a-z0-9._-]*)\s*$/u.exec(command)?.[1] ?? null, event, scriptFromCommand(command), label);
        }
      }
    }
  }
  return [...found.values()];
}

/** `hook_id`s this clone has actually materialized under `.arbor/hooks`. */
function materializedHookIds(root) {
  const directory = join(root, ".arbor", "hooks");
  if (!existsSync(directory)) return new Set();
  const ids = new Set();
  for (const name of readdirSync(directory)) {
    const match = /^([a-z0-9][a-z0-9-]*)@\d+\.\d+\.\d+.*\.json$/u.exec(name);
    if (match) ids.add(match[1]);
  }
  return ids;
}

function finding(code, id, detail, remedy) {
  return { code, id, detail, remedy };
}

/**
 * The audit. Pure over its inputs so a test can drive every branch, and so the
 * spawned exit-code contract in the test file is testing the same code the CLI
 * runs rather than a parallel path that could agree with it by construction.
 */
export function auditDevolution({ root, registrations, ledgerHooks, handlerRefs, defaultHookIds, busMethods, descriptors = new Map(), seamDispatch = new Map() }) {
  const findings = [];
  const live = new Set(registrations.map((registration) => registration.id));
  const rowsById = new Map();

  for (const row of ledgerHooks) {
    if (typeof row?.id !== "string" || row.id.length === 0) {
      findings.push(finding("ledger_row_malformed", String(row?.id ?? "?"), "a ledger row has no id", `give every row in scripts/hook-devolution.json a non-empty \`id\`, then ${RERUN}`));
      continue;
    }
    if (rowsById.has(row.id)) {
      findings.push(finding("ledger_row_duplicate", row.id, "the ledger declares this id more than once", `keep one row per id in scripts/hook-devolution.json, then ${RERUN}`));
      continue;
    }
    rowsById.set(row.id, row);
  }

  for (const registration of registrations) {
    // (a) The registration points at a file. If the file is gone the host runs
    // nothing, and every other gate that reads the disk sees a clean tree.
    if (registration.source === null) {
      findings.push(finding("script_unresolved", registration.id, "a registration names no script this gate can resolve", `make the registration's command end in a resolvable script path in ${registration.origins.join(", ")}, then ${RERUN}`));
    } else if (!existsSync(join(root, registration.source))) {
      findings.push(finding("script_missing", registration.id, `registered but its script does not exist on disk: ${registration.source}`, `git checkout HEAD -- ${registration.source}`));
    }

    // (g) Every live registration is in the ledger. An unledgered registration
    // is the shape the four deletions left behind: nothing to check it against.
    if (!rowsById.has(registration.id)) {
      findings.push(finding("unledgered_registration", registration.id, "is a live registration with no row in scripts/hook-devolution.json", `add a row for ${registration.id} to scripts/hook-devolution.json — status \`pending_activation\` with a reason, or \`devolved\` with handler_ref, descriptor and seam — then ${RERUN}`));
    }
  }

  for (const [id, row] of rowsById) {
    if (!ANY_STATUS.has(row.status)) {
      findings.push(finding("unknown_status", id, `status ${JSON.stringify(row.status ?? null)} is not one of pending_activation, devolved, retained`, `set \`status\` to \`pending_activation\` or \`devolved\` in scripts/hook-devolution.json, then ${RERUN}`));
      continue;
    }

    // (e) Zero retentions, bound to the live set: `retained` is only legible
    // for a row that is not a live registration.
    if (row.status === "retained" && live.has(id)) {
      findings.push(finding("retained_live_registration", id, "is a live registration with status `retained`; this repository has zero retentions — every registered host hook ends devolved-and-deleted or replaced by a new native equivalent", `replace \`retained\` with \`pending_activation\` (with a reason) or \`devolved\` (with handler_ref, descriptor and seam) in scripts/hook-devolution.json, then ${RERUN}`));
      continue;
    }

    if (row.status !== "devolved" && (typeof row.reason !== "string" || row.reason.trim().length === 0)) {
      findings.push(finding("reason_required", id, `status \`${row.status}\` requires a non-empty reason: a debt with no stated cause is indistinguishable from one that was never examined`, `write the reason this hook has no activated native replacement yet in scripts/hook-devolution.json, then ${RERUN}`));
    }

    // (f) A devolved row is a claim that the native path is fully transitioned.
    // Each of the three halves is what makes it true, and a missing one is the
    // claim without its evidence.
    if (row.status === "devolved") {
      for (const field of ["handler_ref", "descriptor", "seam"]) {
        if (typeof row[field] !== "string" || row[field].trim().length === 0) {
          findings.push(finding("devolved_incomplete", id, `is marked devolved but its \`${field}\` is empty — devolved means a registered handler, a descriptor that activates it, and a seam that dispatches it`, `fill \`${field}\` on the devolved row for ${id} in scripts/hook-devolution.json, or set \`status\` to \`pending_activation\` with a reason, then ${RERUN}`));
        }
      }
    }

    // (b) The handler must be a key in the closed registry. Checked for ANY row
    // that names one, not only devolved ones: a pending row naming a handler
    // that does not exist is naming a replacement that was never written.
    if (typeof row.handler_ref === "string" && row.handler_ref.trim().length > 0 && !handlerRefs.has(row.handler_ref)) {
      findings.push(finding("handler_ref_unknown", id, `handler_ref \`${row.handler_ref}\` is not a key in the closed HOOK_HANDLERS registry`, `add \`${row.handler_ref}\` to HOOK_HANDLERS in packages/arbor-mcp/src/hooks/handlers.ts, or correct the ledger row, then ${RERUN}`));
    }

    // (c) The descriptor must be one DEFAULT_HOOK_SET ships. This is the check
    // the incident needed: a handler in the registry that no descriptor names
    // is an inert handler, which is what `arbor hook validate` reported green.
    if (typeof row.descriptor === "string" && row.descriptor.trim().length > 0 && !defaultHookIds.has(row.descriptor)) {
      findings.push(finding("descriptor_unactivated", id, `is marked devolved but no descriptor activates it: \`${row.descriptor}\` is not in DEFAULT_HOOK_SET in packages/arbor-mcp/src/hooks/catalog.ts, so HookBus never fires this handler`, `add a descriptor with hook_id \`${row.descriptor}\` and handler_ref \`${row.handler_ref ?? "<the handler>"}\` to DEFAULT_HOOK_SET in packages/arbor-mcp/src/hooks/catalog.ts, then ${RERUN}`));
    }

    // (d) The seam must be a method HookBus actually has, or "its seam
    // dispatches today" is an assertion about a method nobody wrote.
    if (typeof row.seam === "string" && row.seam.trim().length > 0 && !busMethods.has(row.seam)) {
      findings.push(finding("seam_unknown", id, `seam \`${row.seam}\` is not a public method of HookBus in packages/arbor-mcp/src/hooks/bus.ts`, `name a real HookBus dispatch method on the row for ${id} in scripts/hook-devolution.json, then ${RERUN}`));
    }

    // (h) AND (i) — THE THREE HALVES MUST BE THE SAME HOOK. Checks (b), (c)
    // and (d) are three INDEPENDENT set-membership tests, and independence is
    // the defect: a row naming a real registry key, a real descriptor id and a
    // real public method satisfies all three while its handler is activated by
    // nothing and its seam fires a different event entirely. That is the F1
    // shape (a handler nothing dispatches, declared devolved) re-created one
    // level down, certified green by the gate written to prevent it. So the
    // descriptor is resolved to the handler, event and KIND it actually binds,
    // and the row's other two fields must name those. The kind is not redundant
    // with the event: `turn_end` is in both the observe and the inject event
    // sets, so `observeTurnEnd` and `injectTurnEnd` are indistinguishable by
    // event and separated only by the `hook.kind` each dispatch site filters
    // on.
    const bound = descriptors.get(row.descriptor);
    if (bound !== undefined) {
      const claimsHandler = typeof row.handler_ref === "string" && row.handler_ref.trim().length > 0;
      if (claimsHandler && bound.handler_ref !== row.handler_ref) {
        findings.push(finding("descriptor_handler_mismatch", id, `is claimed to be devolved onto \`${row.handler_ref}\`, but descriptor \`${row.descriptor}\` binds handler_ref \`${bound.handler_ref ?? "<none>"}\` — the descriptor activates a different handler, so this row's three halves describe three different hooks and the claim is about none of them`, `set \`handler_ref\` to \`${bound.handler_ref ?? "the handler the descriptor binds"}\` to match descriptor \`${row.descriptor}\`, or point \`descriptor\` at the descriptor that binds \`${row.handler_ref}\`, in scripts/hook-devolution.json, then ${RERUN}`));
      }
      if (bound.event !== null && busMethods.has(row.seam)) {
        const seam = seamDispatch.get(row.seam);
        const events = seam?.events ?? new Set();
        const kinds = seam?.kinds ?? new Set();
        if (events.size === 0 && kinds.size === 0) {
          // NOT "dispatches nothing". This gate reads each seam's own source
          // slice, so a seam whose dispatch was factored into a helper derives
          // nothing here — and asserting an absence it did not observe is the
          // same false-negative class as the earlier `async` regex reporting
          // `seam_unknown` for a method that existed and was public. It still
          // blocks: a devolved claim it cannot verify is not a certified claim.
          findings.push(finding("seam_dispatch_underivable", id, `descriptor \`${row.descriptor}\` is bound to event \`${bound.event}\`${bound.kind === null ? "" : ` with kind \`${bound.kind}\``}, but this gate can derive NEITHER the events NOR the hook kinds \`${row.seam}\` dispatches, because its dispatch is not written in that method's own body — it has been factored into a helper this derivation cannot follow. This is not a finding that the seam dispatches nothing; it is a finding that the seam cannot be shown to dispatch anything`, `name on this row the HookBus seam whose own body filters \`hook.kind === "${bound.kind ?? "observe"}"\` for \`${bound.event}\`, or keep the dispatch in the seam's body, then ${RERUN}`));
        } else if (!events.has(bound.event)) {
          findings.push(finding("seam_does_not_dispatch_event", id, `descriptor \`${row.descriptor}\` is bound to event \`${bound.event}\`, but seam \`${row.seam}\` dispatches ${[...events].sort().map((event) => `\`${event}\``).join(", ")} and never \`${bound.event}\` — a seam that exists is not a seam that fires this handler`, `name the HookBus seam that dispatches \`${bound.event}\` on the row for ${id} in scripts/hook-devolution.json, then ${RERUN}`));
        } else if (bound.kind !== null) {
          // The event name does not identify the lane: `turn_end` is in both the
          // observe and the inject event sets, so `observeTurnEnd` and
          // `injectTurnEnd` derive the SAME event. What separates them is the
          // `hook.kind` each dispatch site filters on — `fireObserve` admits
          // `observe`, `TropismInjector.inject` admits `inject` — and without
          // this a `kind: "inject"` row naming `observeTurnEnd` certified a seam
          // that fires nothing.
          if (kinds.size === 0) {
            findings.push(finding("seam_dispatch_underivable", id, `descriptor \`${row.descriptor}\` is bound to event \`${bound.event}\`, which seam \`${row.seam}\` does dispatch, but this gate can derive no hook KIND for it — the \`hook.kind\` filter its dispatch site filters on is not readable from \`${row.seam}\` or anything it calls`, `name on this row the seam whose dispatch site filters \`hook.kind === "${bound.kind}"\`, then ${RERUN}`));
          } else if (!kinds.has(bound.kind)) {
            findings.push(finding("seam_does_not_dispatch_kind", id, `descriptor \`${row.descriptor}\` is bound to event \`${bound.event}\` with kind \`${bound.kind}\`, and seam \`${row.seam}\` does dispatch \`${bound.event}\` — but only for hook kind${kinds.size === 1 ? "" : "s"} ${[...kinds].sort().map((kind) => `\`${kind}\``).join(", ")}. The lane selects on \`hook.kind\` before it selects on \`hook.event\`, so this seam would never fire this handler`, `name the seam that dispatches \`${bound.event}\` for kind \`${bound.kind}\` on the row for ${id} in scripts/hook-devolution.json, then ${RERUN}`));
          }
        }
      }
    }
  }

  return findings;
}

function reportDrift({ defaultHookIds, materializedIds }) {
  const lines = [];
  for (const descriptor of [...defaultHookIds].sort()) {
    if (materializedIds.has(descriptor)) continue;
    lines.push(finding("materialization_drift", descriptor, "is declared in DEFAULT_HOOK_SET in source but is not materialized in this clone's .arbor/hooks", MATERIALIZE_REMEDY));
  }
  return lines;
}

function main() {
  const findings = [];

  const ledgerRaw = readTextOrNull(LEDGER);
  if (ledgerRaw === null) {
    findings.push(finding("ledger_missing", "scripts/hook-devolution.json", "no scripts/hook-devolution.json declares what each host hook is being devolved into, so there is nothing to check a registration against", `create scripts/hook-devolution.json with one row per registered host hook, then ${RERUN}`));
  }
  let ledgerHooks = [];
  if (ledgerRaw !== null) {
    try {
      const parsed = JSON.parse(ledgerRaw);
      ledgerHooks = Array.isArray(parsed.hooks) ? parsed.hooks : [];
      if (!Array.isArray(parsed.hooks)) findings.push(finding("ledger_malformed", "scripts/hook-devolution.json", "the ledger has no `hooks` array", `give scripts/hook-devolution.json a \`hooks\` array of rows, then ${RERUN}`));
    } catch (error) {
      findings.push(finding("ledger_unreadable", "scripts/hook-devolution.json", `the ledger is not valid JSON: ${error instanceof Error ? error.message : String(error)}`, `fix the JSON in scripts/hook-devolution.json, then ${RERUN}`));
    }
  }

  const registrations = collectRegistrations(REPO_ROOT, findings);

  const handlerRefs = parseHandlerRefs(readTextOrNull(HANDLERS_TS));
  const descriptors = parseDefaultHookDescriptors(readTextOrNull(CATALOG_TS));
  const defaultHookIds = new Set(descriptors.keys());
  const busMethods = parseHookBusMethods(readTextOrNull(BUS_TS));
  const contractsText = readTextOrNull(CONTRACTS_TS);
  // `inject.ts` is read because the `inject` lane's `hook.kind` filter is
  // written there and not in `bus.ts` — `HookBus` holds a `TropismInjector` and
  // delegates to it. It is NOT in the unreadable-source census below, because
  // "this file is absent" and "this gate has read no source at all" are
  // different states and conflating them would add a second, unrelated finding
  // to a fixture that is meant to prove one. Absent it, a seam whose dispatch
  // runs through the injector derives no kind and reports
  // `seam_dispatch_underivable`, which is still a block.
  const injectText = readTextOrNull(INJECT_TS);
  const seamDispatch = parseSeamDispatch(readTextOrNull(BUS_TS), contractsText, injectText);
  for (const [path, label, parsed] of [[HANDLERS_TS, "packages/arbor-mcp/src/hooks/handlers.ts", handlerRefs], [CATALOG_TS, "packages/arbor-mcp/src/hooks/catalog.ts", defaultHookIds], [BUS_TS, "packages/arbor-mcp/src/hooks/bus.ts", busMethods], [CONTRACTS_TS, "packages/arbor-mcp/src/hooks/contracts.ts", parseEventContracts(contractsText).sets]]) {
    if (parsed.size === 0) {
      findings.push(finding("native_source_unreadable", label, `read no closed registry, default hook set, dispatch seam or event set out of ${label}; without it every handler_ref, descriptor, seam and event binding is unverifiable`, `confirm ${label} still declares the shapes this gate parses (\`HOOK_HANDLERS\`, \`DEFAULT_HOOK_SET\`, \`class HookBus\`, \`HOOK_*_EVENTS\`), then ${RERUN}`));
    }
  }

  findings.push(...auditDevolution({ root: REPO_ROOT, registrations, ledgerHooks, handlerRefs, defaultHookIds, busMethods, descriptors, seamDispatch }));

  // THE EMPTY WALK IS A STATE, NOT A FAILURE — and saying otherwise made this
  // gate permanently red.
  //
  // This file originally failed whenever the walk enumerated zero
  // registrations, reasoning that "a walk that observes nothing cannot certify
  // anything". That reasoning is right about a walk that BROKE and wrong about
  // a walk that found a genuinely empty surface, and the operator's zero-
  // retentions ruling makes the empty surface this programme's TERMINAL state:
  // every registered host hook ends devolved-and-deleted or replaced by a
  // native equivalent. A gate that can never go green is the mirror of the
  // vacuous green this file was written to end — a check that cannot PASS,
  // reported forever as if it were a finding.
  //
  // What replaces it is not a weaker rule but the requirement the empty state
  // actually creates. Trustworthiness is already enforced separately: a source
  // that is present but unreadable is `registration_source_unreadable`, and a
  // ledger that will not parse is `ledger_unreadable`. What nothing else can
  // catch is a row still marked `pending_activation` once NO host hook is
  // registered: there is then nothing left to activate it and nothing to
  // register it as, so the devolution is permanently owed and permanently
  // invisible — which is the inert-handler defect in its final form. That is
  // the check below, and it is one this state alone can reach.
  const registeredAndPending = registrations.filter((registration) => {
    const row = ledgerHooks.find((candidate) => candidate?.id === registration.id);
    return row === undefined || row.status !== "devolved";
  });
  if (registrations.length === 0) {
    for (const row of ledgerHooks) {
      if (typeof row?.id === "string" && row.status !== "devolved") {
        findings.push(finding("unactivated_after_devolution", row.id, `no host hook is registered anywhere, and this row is still \`${String(row.status)}\`; with nothing registered there is no registration left to activate, so the devolution is owed and nothing would ever report it`, `complete the devolution — a handler in HOOK_HANDLERS, a descriptor in DEFAULT_HOOK_SET, and the seam that dispatches it, recorded on this row — or delete the row if the hook was never activated, then ${RERUN}`));
      }
    }
  }

  const materializedIds = materializedHookIds(REPO_ROOT);
  const drift = reportDrift({ defaultHookIds, materializedIds });
  const ok = findings.length === 0;

  if (JSON_OUT) {
    console.log(JSON.stringify({
      gate: "hook-devolution",
      registrations: registrations.length,
      registered_and_pending: registeredAndPending.length,
      ledger_rows: ledgerHooks.length,
      handler_refs: handlerRefs.size,
      default_hook_ids: [...defaultHookIds].sort(),
      bus_seams: [...busMethods].sort(),
      seam_dispatch: Object.fromEntries([...seamDispatch].sort(([a], [b]) => (a < b ? -1 : 1)).map(([seam, dispatch]) => [seam, { events: [...dispatch.events].sort(), kinds: [...dispatch.kinds].sort(), underivable: dispatch.events.size === 0 && dispatch.kinds.size === 0 }])),
      findings,
      reported_drift: drift,
      ok,
    }, null, 2));
    return ok ? 0 : 1;
  }

  console.log(`gate:hook-devolution — ${registrations.length} live registration(s), ${registeredAndPending.length} registered-and-pending, ${ledgerHooks.length} ledger row(s), ${defaultHookIds.size} descriptor(s) in DEFAULT_HOOK_SET`);
  console.log(`  invariant: a registered host hook counts as devolved only when its native handler exists, a descriptor activates it, and a HookBus seam dispatches it`);
  if (registrations.length === 0) {
    console.log("  no host hook is registered in scripts/host-controls.json, .claude/settings.json or .codex/hooks.json: the host-hook surface is empty, so this invariant is vacuously satisfied for registrations and what remains certified is that every ledger row's devolved claim still resolves.");
  }
  console.log("");

  for (const item of findings) {
    console.log(`  FAIL  [${item.code}] ${item.id}`);
    console.log(`        ${item.detail}`);
    console.log(`        Remedy: ${item.remedy}`);
  }
  if (findings.length > 0) console.log("");

  for (const item of drift) {
    console.log(`  REPORTED-WITH-REMEDY (not blocking)  [${item.code}] ${item.id}`);
    console.log(`        ${item.detail}`);
    console.log(`        Remedy: ${item.remedy}`);
  }
  if (drift.length > 0) {
    console.log("        .arbor/ is gitignored (.gitignore:29) and materialized per clone, so an unmaterialized descriptor here is a LOCAL condition, not a governance failure.");
  }

  const liveIds = new Set(registrations.map((registration) => registration.id));
  const devolved = ledgerHooks.filter((row) => row?.status === "devolved");
  // A devolved row is a three-part CLAIM, and the three parts have to be about
  // the SAME hook. This counts the ones that actually resolve — handler in the
  // closed registry, descriptor in DEFAULT_HOOK_SET, seam a real HookBus
  // method — and not the rows that merely say `devolved`, so the number below
  // falls to zero the moment any of those three sources stops parsing or a
  // claim stops resolving. The three linking conditions count too, because a row
  // whose descriptor binds a different handler, or whose seam dispatches a
  // different event, or dispatches this event for a different hook KIND,
  // resolves all three sets and is certified about nothing.
  // That is what makes it a measurement.
  const certified = devolved.filter((row) => {
    const bound = descriptors.get(row?.descriptor);
    return handlerRefs.has(row?.handler_ref)
      && defaultHookIds.has(row?.descriptor)
      && busMethods.has(row?.seam)
      && bound?.handler_ref === row?.handler_ref
      && bound.event !== null
      && (seamDispatch.get(row?.seam)?.events ?? new Set()).has(bound.event)
      && (bound.kind === null || (seamDispatch.get(row?.seam)?.kinds ?? new Set()).has(bound.kind));
  });
  const livePending = ledgerHooks.filter((row) => row?.status === "pending_activation" && liveIds.has(row?.id));
  const deregisteredPending = ledgerHooks.filter((row) => row?.status === "pending_activation" && !liveIds.has(row?.id));
  if (findings.length === 0) {
    console.log("");
    console.log(`  ${devolved.length} devolved, ${livePending.length} registered-and-pending, ${deregisteredPending.length} already-deregistered-and-pending.`);
    console.log("  A pending row is a named debt, not a pass: a registered host hook whose native replacement is not yet activated.");
    for (const row of deregisteredPending) {
      console.log(`  NOT ACTIVATED  ${row.id} — host hook already deregistered, native replacement still has no DEFAULT_HOOK_SET descriptor, so it fires nowhere.`);
    }
  }

  console.log("");
  // WHAT THIS GATE OBSERVED, and it is deliberately NOT the live-registration
  // count. `scripts/execution-profile.json` declares `observes.min: 1` for this
  // gate so that one which has stopped measuring anything cannot read as a
  // pass — and counting registrations made that floor unsatisfiable in the
  // terminal state, where zero registrations is the operator's ruling made
  // real. The count is therefore the number of devolved claims this run
  // RESOLVED end to end: a handler that is a key in the closed registry, a
  // descriptor in DEFAULT_HOOK_SET, and a seam HookBus actually has. That is
  // what the gate certifies, it is non-zero exactly while the gate can still
  // certify, and it falls to zero if any of those three sources stops parsing
  // — which is the failure the floor was declared to catch.
  console.log(`observed_count: ${certified.length}`);
  console.log(ok ? "PASS" : `FAIL — ${findings.length} problem(s).`);
  return ok ? 0 : 1;
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
