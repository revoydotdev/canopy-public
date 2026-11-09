import { NATIVE_SUBAGENT_TOOL_RISKS } from "./native-agent-executor.js";
import { NATIVE_IMAGE_TOOL_RISKS, NATIVE_SKILL_TOOL_RISKS, NATIVE_USERINPUT_TOOL_RISKS } from "./native-tool-host.js";
import { NATIVE_WEB_TOOL_RISKS } from "./native-web-tools.js";
import { NATIVE_BROWSER_TOOL_RISKS } from "./native-browser-tools.js";
import { NATIVE_TOOL_RISK_MANIFEST } from "./native-capability-manifest.js";
import { NATIVE_MODEL_TOOL_IDS } from "@arbor/core";
import type { NativeModelAdapterToolDefinition } from "@arbor/harness";

export const NATIVE_REPOSITORY_MODEL_TOOLS: readonly NativeModelAdapterToolDefinition[] = [
  { name: "repository.search", description: "Search bounded repository text under the admitted workspace. `path` is optional and may be a directory or a single file; omit it to search the whole workspace. `query` is a literal substring by default; set `regex: true` to compile it as a bounded regular expression instead. `case_sensitive` defaults to true. `context_lines` returns up to 5 lines on either side of each match. Large files are searched (streamed line by line) up to bounded byte budgets; when any bound stops the search short, result.truncated=true and result.truncation_reasons and result.skipped_files name what was not searched (path, size, bytes scanned, reason). An empty result with truncated=false means every listed file was searched completely.", parameters: { type: "object", properties: { query: { type: "string" }, path: { type: "string" }, regex: { type: "boolean" }, case_sensitive: { type: "boolean" }, context_lines: { type: "integer", minimum: 0, maximum: 5 } }, required: ["query"], additionalProperties: false }, risk: NATIVE_TOOL_RISK_MANIFEST.repository["repository.search"] },
  { name: "repository.graph", description: "Query the cached TypeScript/JavaScript import and top-level symbol graph. Supply exactly one of `path` or `symbol`; `depth` (1-3) includes importing and imported neighbors. Prefer this before broad search/read when locating an implementation in a large repository.", parameters: { type: "object", properties: { path: { type: "string" }, symbol: { type: "string" }, depth: { type: "integer" } }, required: [], additionalProperties: false }, risk: NATIVE_TOOL_RISK_MANIFEST.repository["repository.graph"] },
  { name: "repository.list", description: "List the direct entries of one bounded workspace directory (non-recursive). `path` is optional; omit it or use an empty string to list the workspace root. Each entry has name, kind (file|directory|other), and bytes for files. Use this to discover what exists before reading — do not guess paths.", parameters: { type: "object", properties: { path: { type: "string" } }, required: [], additionalProperties: false }, risk: NATIVE_TOOL_RISK_MANIFEST.repository["repository.list"] },
  { name: "repository.glob", description: "Find files by name pattern recursively under the workspace (e.g. `**/*.test.ts`, `src/**/config.*`). `path` optionally roots the search at a subdirectory. Returns bounded matching file paths; `.git`/`node_modules` and symlinks are excluded. Use this to locate files by name when you don't know their directory — repository.search is for file contents, not names.", parameters: { type: "object", properties: { pattern: { type: "string" }, path: { type: "string" } }, required: ["pattern"], additionalProperties: false }, risk: NATIVE_TOOL_RISK_MANIFEST.repository["repository.glob"] },
  { name: "file.read", description: "Read one bounded window of a non-sensitive repository file; the host bounds the bytes of every call. With no window arguments it returns the head. Page through a larger file with `start_line` (1-based) and optional `max_lines`, or with a byte `offset`; `max_bytes` shortens any window. Send `start_line` or `offset`, not both. Each result states the window it returned (offset, end_offset, start_line, end_line), total_bytes, remaining_bytes, and, when more remains, next_window: the exact arguments for the next page — send them as-is rather than repeating the same read. truncated=true means the result is not the whole file. A complete (truncated=false) read also returns content_sha256 for a guarded file.write update; a partial read returns content_sha256=null and cannot authorize an update (use file.patch to edit a large file).", parameters: { type: "object", properties: { path: { type: "string" }, start_line: { type: "integer", minimum: 1 }, max_lines: { type: "integer", minimum: 1 }, offset: { type: "integer", minimum: 0 }, max_bytes: { type: "integer", minimum: 1 } }, required: ["path"], additionalProperties: false }, risk: NATIVE_TOOL_RISK_MANIFEST.repository["file.read"] },
  // The create-XOR-update precondition (never both create:true and
  // expected_sha256; always at least one) is NOT expressed here as a
  // top-level oneOf/allOf/anyOf: Anthropic's tool `input_schema` rejects a
  // schema with a root-level combinator ("tools.N.custom.input_schema:
  // input_schema does not support oneOf, allOf, or anyOf at the top
  // level" -- confirmed live against anthropic/claude-haiku-4.5). The
  // precondition is genuinely enforced at runtime regardless of what the
  // model sends: `native-tool-host.ts`'s `write()` throws
  // write_mode_invalid when both are present, expected_sha256_required
  // when neither is, file_exists on a colliding create, and stale_write on
  // a hash mismatch (see native-tool-host.test.ts) -- so this schema is an
  // LLM-facing strictness aid only, never the enforcement point, and
  // dropping the oneOf loses no safety invariant.
  { name: "file.write", description: "Write a complete file inside the admitted worktree using exactly one optimistic-concurrency mode. To create an absent file, send create:true and OMIT expected_sha256; an existing path is refused as file_exists. To update an existing file, first file.read it without truncation, then send its exact sha256:<64 lowercase hex> content_sha256 as expected_sha256 and omit create (or use create:false). Never send both create:true and expected_sha256; writes without one of these preconditions are refused and never silently overwrite.", parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" }, create: { type: "boolean" }, expected_sha256: { type: "string", pattern: "^sha256:[a-f0-9]{64}$", minLength: 71, maxLength: 71 } }, required: ["path", "content"], additionalProperties: false }, risk: NATIVE_TOOL_RISK_MANIFEST.repository["file.write"] },
  { name: "file.patch", description: "Replace one exact, unique text occurrence inside an admitted file.", parameters: { type: "object", properties: { path: { type: "string" }, expected: { type: "string" }, replacement: { type: "string" } }, required: ["path", "expected", "replacement"], additionalProperties: false }, risk: NATIVE_TOOL_RISK_MANIFEST.repository["file.patch"] },
  // `argv`/`cwd`/`timeout_ms` are exactly what native-tool-host.ts's `command()`
  // reads from `request.input` (see `argvField`, `optionalString(value, "cwd")`,
  // `optionalPositive(value, "timeout_ms")`); the executable named by `argv[0]`
  // must already be on the host's own `allowed_commands` allowlist, refused
  // otherwise (`command_not_allowlisted`) — advertising this schema cannot
  // widen that allowlist. There is no model-settable `network_allowed`
  // field: network reachability is an immutable session policy fact
  // (`request.network_allowed`, see `NativeToolRequest`), never something a
  // tool call can request.
  { name: "shell.execute", description: "Run one host-allowlisted, sandboxed command as an argv array (never a shell string) under the admitted workspace. `cwd` is optional and must resolve inside the workspace root; `timeout_ms` is optional and capped by the host's own command timeout. Network reachability is governed by session policy, not by this call; a session without network authorization refuses a command outright rather than silently running it without network. Set `background: true` to start the command as a tracked job and return a `job_id` immediately instead of blocking — read it with shell.poll and cancel it with shell.stop. A background job never outlives the session that started it.", parameters: { type: "object", properties: { argv: { type: "array", items: { type: "string", minLength: 1 }, minItems: 1, maxItems: 32 }, cwd: { type: "string" }, timeout_ms: { type: "integer" }, background: { type: "boolean" } }, required: ["argv"], additionalProperties: false }, risk: NATIVE_TOOL_RISK_MANIFEST.repository["shell.execute"] },
  { name: "shell.poll", description: "Read the status and bounded output of a background job started by shell.execute with `background: true`. Returns the job's running/terminal status and whatever output it has produced so far; polling never blocks and never starts work.", parameters: { type: "object", properties: { job_id: { type: "string", minLength: 1, maxLength: 128 } }, required: ["job_id"], additionalProperties: false }, risk: NATIVE_TOOL_RISK_MANIFEST.repository["shell.poll"] },
  { name: "shell.stop", description: "Cancel a running background job started by shell.execute. Terminating an already-finished job is not an error; its recorded result is preserved.", parameters: { type: "object", properties: { job_id: { type: "string", minLength: 1, maxLength: 128 } }, required: ["job_id"], additionalProperties: false }, risk: NATIVE_TOOL_RISK_MANIFEST.repository["shell.stop"] },
  { name: "todo.write", description: "Replace the session's task list in full. Use it to plan multi-step work and to keep the operator informed of progress: write the whole ordered list every time, marking exactly what is done, in progress, and still pending. The list is session-scoped working state — it is never repository content and produces no repository effect.", parameters: { type: "object", properties: { items: { type: "array", maxItems: 200, items: { type: "object", properties: { id: { type: "string", minLength: 1, maxLength: 128 }, text: { type: "string", minLength: 1, maxLength: 2000 }, status: { type: "string", enum: ["pending", "in_progress", "completed"] } }, required: ["id", "text", "status"], additionalProperties: false } } }, required: ["items"], additionalProperties: false }, risk: NATIVE_TOOL_RISK_MANIFEST.repository["todo.write"] },
  { name: "todo.read", description: "Read back the session's current task list as last written by todo.write.", parameters: { type: "object", properties: {}, additionalProperties: false }, risk: NATIVE_TOOL_RISK_MANIFEST.repository["todo.read"] },
  { name: "git.status", description: "Inspect bounded git status for the admitted worktree.", parameters: { type: "object", properties: {}, additionalProperties: false }, risk: NATIVE_TOOL_RISK_MANIFEST.repository["git.status"] },
  { name: "git.diff", description: "Inspect the current bounded worktree diff.", parameters: { type: "object", properties: {}, additionalProperties: false }, risk: NATIVE_TOOL_RISK_MANIFEST.repository["git.diff"] },
  { name: "verification.run", description: "Run one host-allowlisted, sandboxed verification command (e.g. the project's test runner) as an argv array (never a shell string) under the admitted workspace — identical in shape and sandboxing to shell.execute, but its result is reported as verification evidence rather than a generic command result. `cwd` is optional and must resolve inside the workspace root; `timeout_ms` is optional and capped by the host's own command timeout.", parameters: { type: "object", properties: { argv: { type: "array", items: { type: "string", minLength: 1 }, minItems: 1, maxItems: 32 }, cwd: { type: "string" }, timeout_ms: { type: "integer" } }, required: ["argv"], additionalProperties: false }, risk: NATIVE_TOOL_RISK_MANIFEST.repository["verification.run"] },
  {
    name: "evidence.refresh",
    description:
      "Refresh the repository's committed evidence stores (claim-ledger, completion-depth, vi-observed, determinism-baseline) via their own refresh scripts. " +
      "`scope` defaults to \"auto\" (reads current staleness from store-freshness-gate.mjs --json and refreshes only stale stores); pass \"all\" or an explicit array of store names to override. " +
      "Set `dry_run` to report the exact plan without running anything. " +
      "Refuses to refresh determinism-baseline unless a single-pass suite run just observed the suite green, to avoid baking a red test in as a recorded flake. " +
      "Never commits — gate:store-freshness compares against COMMITTED stores, so a refreshed store still reports stale until it is committed.",
    parameters: {
      type: "object",
      properties: {
        scope: { anyOf: [{ type: "string", enum: ["auto", "all"] }, { type: "array", items: { type: "string", enum: ["claim-ledger", "completion-depth", "vi-observed", "determinism-baseline"] }, minItems: 1 }] },
        dry_run: { type: "boolean" },
      },
      required: [],
      additionalProperties: false,
    },
    risk: NATIVE_TOOL_RISK_MANIFEST.repository["evidence.refresh"],
  },
];

// The Taproot planning session hosts only read-only discovery ports
// (`native-agent-executor.ts` `planningTools`: repository.search/file.read/
// git.status/git.diff). Advertising the write tools to that session lets the
// model request a `file.write`/`file.patch` that has no hosted port, failing
// planning with "requested tool has no native port". The advertised set must
// match the hosted set: planning is read-only by design.
const NATIVE_PLANNING_DISCOVERY_TOOLS = new Set(["repository.search", "repository.graph", "repository.list", "repository.glob", "file.read", "git.status", "git.diff"]);
// Exported (read-only) alongside NATIVE_REPOSITORY_MODEL_TOOLS/
// NATIVE_BUS_THREAD_MODEL_TOOLS purely so the model-tool-catalog parity test
// can compute the full advertised-tool union without duplicating this
// filter; nothing outside this module widens or otherwise mutates it.
export const NATIVE_PLANNING_MODEL_TOOLS: readonly NativeModelAdapterToolDefinition[] =
  NATIVE_REPOSITORY_MODEL_TOOLS.filter((tool) => NATIVE_PLANNING_DISCOVERY_TOOLS.has(tool.name));

/**
 * Declared model-facing schemas for the child→parent bus ports
 * (`createNativeBusThreadToolPorts` in native-tool-host.ts). Hosting the
 * ports alone is not enough: a native tool is only ever advertised to the
 * model via this static definition list (matched by name against
 * `role.profile.allowed_tools`), never derived from the port itself — see
 * `NATIVE_REPOSITORY_MODEL_TOOLS` above for the same pattern. Field shapes
 * mirror exactly what `busThreadSend`/`busThreadAck`/`siblingStatus` parse;
 * `campaign_id`/`parent_node_id`/`child_node_id` are deliberately not
 * exposed here even though the host will accept and cross-check them — the
 * scope is a trusted host fact, not something to prompt the model to supply.
 */
export const NATIVE_BUS_THREAD_MODEL_TOOLS: readonly NativeModelAdapterToolDefinition[] = [
  {
    name: "bus.thread.send",
    description: "Send a message on this session's own dispatched parent-edge thread. `expected_thread_version` must be the version most recently observed for this thread (start with \"origin\" if none has been read yet); a stale version is refused so a concurrent write is never silently overwritten.",
    parameters: {
      type: "object",
      properties: {
        message_kind: { type: "string", enum: ["delegate", "report", "retract", "steer", "reply", "clarify", "promote"] },
        content: { type: "string" },
        expected_thread_version: { type: "string" },
        intent: { type: "string", enum: ["request", "response", "notify", "needs_attention"] },
        ack_required: { type: "boolean" },
        deadline_at: { type: "string" },
        evidence_refs: { type: "array", items: { type: "string" } },
        acknowledges_communication_id: { type: "string" },
        retracts_communication_id: { type: "string" },
        parent_communication_id: { type: "string" },
        reply_to_communication_id: { type: "string" },
      },
      required: ["message_kind", "content", "expected_thread_version"],
      additionalProperties: false,
    },
    risk: NATIVE_TOOL_RISK_MANIFEST.bus["bus.thread.send"],
  },
  {
    name: "bus.thread.ack",
    description: "Acknowledge one message on this session's own dispatched parent-edge thread. `expected_thread_version` must be the version most recently observed for this thread.",
    parameters: {
      type: "object",
      properties: { message_id: { type: "string" }, expected_thread_version: { type: "string" } },
      required: ["message_id", "expected_thread_version"],
      additionalProperties: false,
    },
    risk: NATIVE_TOOL_RISK_MANIFEST.bus["bus.thread.ack"],
  },
  {
    name: "sibling.status",
    description: "Read this session's own dispatched node status on the campaign graph.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    risk: NATIVE_TOOL_RISK_MANIFEST.bus["sibling.status"],
  },
  // `subagent.execute`, `userinput.ask`, and `skill.load`/`skill.list` are
  // not child→parent bus ports (they carry no parent edge), but they are
  // hosted the same way: a trusted host-resolved scope/catalog
  // native-agent-executor.ts composes per session, advertised here rather
  // than derived from the port. Grouped in this list because, like the
  // three tools above, none is part of `NativeRepositoryToolHost` and so is
  // absent from `NATIVE_REPOSITORY_TOOL_RISKS`.
  {
    name: "subagent.execute",
    description: "Dispatch a bounded, read-only native subagent to investigate or draft an answer for a sub-task, then return its output. The subagent gets no write/shell/further-dispatch tools and works in the same repository context as this session; it cannot modify files or run commands. Use it to parallelize research or drafting inside one turn, not to make changes — apply any resulting edit yourself.",
    parameters: {
      type: "object",
      properties: {
        role: { type: "string", enum: ["seed", "heartwood", "architect", "documentation-writer"] },
        objective: { type: "string" },
      },
      required: ["role", "objective"],
      additionalProperties: false,
    },
    // One authoritative source for the risk fact: the executor's own map,
    // not a literal the parity test would merely mirror.
    risk: NATIVE_SUBAGENT_TOOL_RISKS["subagent.execute"],
  },
  {
    name: "userinput.ask",
    description: "Post a durable, asynchronous question to the operator and keep working; this does not end the turn or wait for an answer. Returns the ledger record id so the answer can be found later (via the operator's attention feed) — it never returns an in-session answer. Supply `options` to ask a MULTIPLE-CHOICE question: the operator answers by typing an option id, optionally followed by a note (`renew, until the audit lands`). Give each option a short stable id and text stating what that choice actually does; a question whose options the operator cannot choose between from their text alone is a lookup request, not a question. Mark at most one option `is_other: true` to allow a free-text answer — without one, a typed answer that matches no option id is refused. Omit `options` entirely for a plain free-text question. Use `request_human_input` instead when the session genuinely cannot proceed without an answer right now.",
    parameters: {
      type: "object",
      properties: {
        question: { type: "string" },
        options: {
          type: "array",
          minItems: 1,
          maxItems: 12,
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              text: { type: "string" },
              is_other: { type: "boolean" },
            },
            required: ["id", "text"],
            additionalProperties: false,
          },
        },
      },
      required: ["question"],
      additionalProperties: false,
    },
    risk: NATIVE_USERINPUT_TOOL_RISKS["userinput.ask"],
  },
  {
    name: "skill.load",
    description: "Load one governed skill pack from the immutable native catalog by exact skill_id and version, returning its instructions as this call's result for you to follow for the rest of the session. Loading a skill never changes your available tools or write paths — those are already fixed for this session; a skill can only ever narrow them further, and only at dispatch, never mid-session. An unknown skill_id/version is refused with the list of currently loadable names.",
    parameters: {
      type: "object",
      properties: { skill_id: { type: "string" }, version: { type: "string" } },
      required: ["skill_id", "version"],
      additionalProperties: false,
    },
    // One authoritative source for the risk fact, same discipline as
    // subagent.execute/userinput.ask above (commit a8733329).
    risk: NATIVE_SKILL_TOOL_RISKS["skill.load"],
  },
  {
    name: "skill.list",
    description: "List the governed skill packs currently loadable via skill.load, bounded to their skill_id, version, and base role. Use this before skill.load when you don't already know the exact skill_id/version to request.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    risk: NATIVE_SKILL_TOOL_RISKS["skill.list"],
  },
  // `web.fetch`/`web.search` (see native-web-tools.ts) are only ever
  // composed as real host ports when `native.capabilities.web_fetch`/
  // `.web_search` are explicitly granted (deny-by-default, mirroring
  // `image_input`'s admission-layer capability gate). They are advertised
  // here unconditionally, same as every other bus-hosted tool: an
  // un-granted session simply never sees the port among its candidate
  // tools, so `native-role-composer.ts`'s intersection excludes it
  // regardless of what this static catalog lists.
  {
    name: "web.fetch",
    description: "Fetch one HTTPS URL and return its content reduced to readable text. Refuses non-https schemes, private/loopback/link-local addresses (SSRF guard), disallowed content-types (only text/html, application/json, text/markdown, text/plain), and truncates oversized bodies with a typed marker. This is network egress this repository cannot OS-sandbox (LR-NH-07): treat it as high risk.",
    parameters: {
      type: "object",
      properties: { url: { type: "string", description: "Absolute https:// URL." } },
      required: ["url"],
      additionalProperties: false,
    },
    risk: NATIVE_WEB_TOOL_RISKS["web.fetch"],
  },
  {
    name: "web.search",
    description: "Run a web search through this deployment's configured governed provider and return bounded title/url/snippet results. SearXNG is supported through native.web_search.provider plus ARBOR_WEB_SEARCH_ENDPOINT; absent composition is a typed provider_unconfigured refusal.",
    parameters: {
      type: "object",
      properties: { query: { type: "string", description: "Search query text." } },
      required: ["query"],
      additionalProperties: false,
    },
    risk: NATIVE_WEB_TOOL_RISKS["web.search"],
  },
  {
    name: "browser.observe",
    description: "Observe one page through an explicitly composed governed browser provider. No ambient browser is available; an uncomposed provider returns a typed browser_uncomposed refusal. Navigation is subject to the same request network, domain, and approval policy as web tools.",
    parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"], additionalProperties: false },
    risk: NATIVE_BROWSER_TOOL_RISKS["browser.observe"],
  },
  {
    name: "browser.interact",
    description: "Perform one bounded browser interaction through an explicitly composed governed browser provider. Requires request-specific authority; it is unavailable when no provider is composed.",
    parameters: { type: "object", properties: { action: { type: "string", enum: ["click", "type", "select"] }, target: { type: "string" }, value: { type: "string" } }, required: ["action", "target"], additionalProperties: false },
    risk: NATIVE_BROWSER_TOOL_RISKS["browser.interact"],
  },
  // `image.attach`/`image.list` (see native-tool-host.ts) are only ever
  // composed as real host ports when BOTH `governed_artifacts_allowed` and
  // `image_attach_allowed` hold (deny-by-default, the same shape as
  // `web.fetch`/`web.search` above and `image_input`'s own admission-layer
  // capability gate). Advertised here unconditionally like every other
  // bus-hosted tool: an un-granted or non-image-capable session simply never
  // sees the port among its candidate tools, so `native-role-composer.ts`'s
  // intersection excludes it regardless of what this static catalog lists.
  {
    name: "image.list",
    description: "List the governed images this campaign already holds and that image.attach can pull into this conversation, bounded to their artifact_id, media_type, and byte_length. This never returns arbitrary URLs, filesystem paths, or raw image bytes — only images the campaign already authorized.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    risk: NATIVE_IMAGE_TOOL_RISKS["image.list"],
  },
  {
    name: "image.attach",
    description: "Attach one governed image this campaign already holds (by its exact artifact_id from image.list) so you can see it starting on your next turn. This can only reference an image the campaign has already authorized — it cannot fetch an arbitrary URL or filesystem path as an image. An unknown artifact_id, or attaching beyond the per-session limit, is refused with the list of currently attachable images.",
    parameters: {
      type: "object",
      properties: { artifact_id: { type: "string" } },
      required: ["artifact_id"],
      additionalProperties: false,
    },
    risk: NATIVE_IMAGE_TOOL_RISKS["image.attach"],
  },
];

// These arrays retain their historic public grouping, but their membership is
// checked against the revision-bound core groups. `bus` historically carries
// the adjacent hosted extensions too; those are checked against `extensions`.
assertExactModelToolNames("repository", NATIVE_MODEL_TOOL_IDS.repository, NATIVE_REPOSITORY_MODEL_TOOLS.map((tool) => tool.name));
assertExactModelToolNames("planning", NATIVE_MODEL_TOOL_IDS.planning, NATIVE_PLANNING_MODEL_TOOLS.map((tool) => tool.name));
assertExactModelToolNames("bus", NATIVE_MODEL_TOOL_IDS.bus, NATIVE_BUS_THREAD_MODEL_TOOLS.map((tool) => tool.name).filter((name) => (NATIVE_MODEL_TOOL_IDS.bus as readonly string[]).includes(name)));
assertExactModelToolNames("extensions", NATIVE_MODEL_TOOL_IDS.extensions, NATIVE_BUS_THREAD_MODEL_TOOLS.map((tool) => tool.name).filter((name) => (NATIVE_MODEL_TOOL_IDS.extensions as readonly string[]).includes(name)));
assertExactModelToolNames(
  "static catalog",
  [...NATIVE_MODEL_TOOL_IDS.repository, ...NATIVE_MODEL_TOOL_IDS.bus, ...NATIVE_MODEL_TOOL_IDS.extensions],
  [...NATIVE_REPOSITORY_MODEL_TOOLS, ...NATIVE_BUS_THREAD_MODEL_TOOLS].map((tool) => tool.name),
);

function assertExactModelToolNames(group: string, expected: readonly string[], actual: readonly string[]): void {
  const wanted = new Set(expected);
  const found = new Set(actual);
  if (wanted.size !== found.size || [...wanted].some((name) => !found.has(name))) {
    throw new Error(`native ${group} model schemas do not match the revision-bound core tool IDs`);
  }
}
