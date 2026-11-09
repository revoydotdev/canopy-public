/**
 * Y-3 (ADR-066, sibling-scoped inverted regression oracle): generated-test
 * evidence for the sibling-site scan (`arbor-opencode/src/sibling-scan.ts`).
 *
 * `sibling-scan.ts` gives the loop a cheap, advisory PROSE note when a diff
 * modified a pattern that still occurs elsewhere in the tracked tree -- it
 * never asserts the remaining sites are actually bugs, only points at them.
 * This module goes one step further, but stays in the same evidence class:
 * given the flagged sites, ask a single-call native model to write ONE
 * inverted regression test per site (max 2) -- a test asserting the
 * KNOWN-GOOD post-fix behavior at the unfixed sibling location -- then
 * COMPILE/EXECUTE-GATE it through the sandboxed verification command port
 * before trusting anything it says. A generated test that cannot even load
 * is discarded silently; the pipeline must never be able to see garbage. A
 * generated test that runs and FAILS is evidence only: a critic-note string
 * plus a ledger-shaped evidence record, never a verification outcome. It is
 * a MINED-class oracle exactly like the sibling-scan note itself -- never
 * operator authority, never fed into `recordResult`.
 *
 * Composition mirrors `native-critic-transport.ts`'s `createNativeCriticPort`
 * PATTERN (readiness gate, credential overlay, one non-streaming chat-
 * completion call, no agent harness, no session/tool machinery) rather than
 * reusing that function directly: a critic call is schema-locked to a
 * verdict contract, and this call must return free-form test-file source.
 *
 * Off by default (`ARBOR_TEST_AMPLIFIER=native` opts in). Exports one pure
 * entry point, `amplifySiblingSites`, for a future loop-integration pass to
 * call after the sibling scan -- this module does NOT wire `loop.ts` itself
 * (out of this workstream's file scope; see ADR-066's documented contract
 * point).
 */
import { randomUUID } from "node:crypto";
import { unlinkSync, writeFileSync } from "node:fs";
import {
  createReferenceNativeModelAdapterRegistry,
  type NativeModelAdapterRegistry,
  type NativeModelPort,
  type OpenAICompatibleFetch,
} from "@arbor/harness";
import {
  loadNativeProviderSecretOverlay,
  resolveNativeProviderSelection,
  type ArborConfig,
  type NativeProviderSecretOverlay,
} from "@arbor/config";
import { resolveNativeHarnessExecutionReadiness } from "./native-harness-readiness.js";
import type {
  MachineVerificationCommandPort,
  VerificationNetworkPolicy,
} from "./worktree-machine-verifier.js";

/** Set to "native" to opt into generated-oracle evidence. Absent/anything else: disabled, zero calls made. */
export const ARBOR_TEST_AMPLIFIER_ENV = "ARBOR_TEST_AMPLIFIER";

/** Bounded per invocation regardless of how many sites the caller passes -- one native call and one sandboxed run per site, at most this many sites. */
export const TEST_AMPLIFIER_MAX_SITES = 2;

/** One sibling-scan-flagged location: the pattern that recurs, and where. Mirrors `sibling-scan.ts`'s internal shape without depending on that module (out of this workstream's file scope). */
export interface FlaggedSiblingSite {
  readonly pattern: string;
  readonly file: string;
  readonly line: number;
}

/** Evidence-only result for one site whose generated test ran and failed. Never accepted by any `recordResult` field. */
export interface AmplifierFinding {
  readonly site: FlaggedSiblingSite;
  readonly note: string;
  readonly evidence: {
    readonly test_file: string;
    readonly exit_code: number;
    readonly output_excerpt: string;
  };
}

/** The narrow slice of `NativeCriticPort`'s shape this module needs -- a single prompt-in/text-out call, injectable for tests. */
export interface AmplifierModelPort {
  readonly ready: boolean;
  call(prompt: string, signal?: AbortSignal): Promise<{ readonly ok: true; readonly text: string } | { readonly ok: false; readonly error: string }>;
}

export interface AmplifierModelPortDeps {
  readonly config: Pick<ArborConfig, "native">;
  readonly credential?: NativeProviderSecretOverlay;
  readonly adapters?: Pick<NativeModelAdapterRegistry, "inspect" | "create">;
  readonly fetch?: OpenAICompatibleFetch;
  readonly env?: NodeJS.ProcessEnv;
}

function notReadyPort(reason: string): AmplifierModelPort {
  return Object.freeze({
    ready: false,
    async call(): Promise<{ readonly ok: false; readonly error: string }> {
      return { ok: false, error: reason };
    },
  });
}

/**
 * Composes an `AmplifierModelPort` from config/credential/adapter inputs.
 * Same readiness/credential/adapter machinery `createNativeCriticPort` uses,
 * with its own instruction (free-form test source, not a verdict schema) and
 * no `structured_output` contract -- construction performs no network I/O.
 */
export function createNativeTestAmplifierPort(deps: AmplifierModelPortDeps): AmplifierModelPort {
  const env = deps.env ?? process.env;
  const credential = deps.credential ?? loadNativeProviderSecretOverlay(env, deps.config.native.provider_id);
  const adapters = deps.adapters ?? createReferenceNativeModelAdapterRegistry(deps.fetch ?? fetch);
  const readiness = resolveNativeHarnessExecutionReadiness(deps.config.native, credential, adapters);
  if (readiness.kind !== "direct_native") {
    return notReadyPort(`native test amplifier transport is not ready: ${readiness.kind}${"reason" in readiness ? `/${readiness.reason}` : ""}`);
  }
  const selection = resolveNativeProviderSelection(deps.config.native);
  if (selection.kind !== "native") {
    return notReadyPort("native readiness disagreed with provider selection");
  }
  const modelId = selection.model;
  const observedAt = new Date().toISOString();
  let port: NativeModelPort;
  try {
    port = adapters.create({
      adapter_id: selection.adapter_id,
      provider_id: selection.provider_id,
      base_url: selection.base_url,
      model_id: modelId,
      ...(selection.revision !== null ? { revision: selection.revision } : {}),
      observed_at: observedAt,
      structured_schemas: [],
      credential_required: true,
      // A single test file is at most a few hundred lines; this ceiling
      // bounds wall time and cost the same way the critic transport's does.
      max_output_tokens: 4_000,
    });
  } catch (error) {
    return notReadyPort(error instanceof Error ? error.message : "native test amplifier adapter composition failed");
  }
  return Object.freeze({
    ready: true,
    async call(prompt: string, signal?: AbortSignal): Promise<{ readonly ok: true; readonly text: string } | { readonly ok: false; readonly error: string }> {
      const abortSignal = signal ?? new AbortController().signal;
      try {
        const response = await credential.inject((apiKey) => port.run(
          {
            session_id: `native-test-amplifier:${randomUUID()}`,
            turn: 1,
            prompt,
            history: [],
            profile: null,
            governed_context: { instructions: [], artifacts: [] },
            context: null,
            structured_output: null,
          },
          apiKey,
          abortSignal,
        ));
        if (response === undefined) return { ok: false, error: "native test amplifier credential was not available at dispatch" };
        if (response.final_message === null || response.final_message.trim().length === 0) {
          return { ok: false, error: "native test amplifier call returned no final message" };
        }
        return { ok: true, text: response.final_message };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : "native test amplifier call failed" };
      }
    },
  });
}

/** Prompt guidance only -- the compile/execute gate remains the real trust boundary, not this instruction. */
export function amplifierPromptFor(site: FlaggedSiblingSite): string {
  return [
    `A code change modified this pattern, which still appears unchanged elsewhere in the tracked tree:`,
    `  pattern: ${site.pattern}`,
    `  remaining occurrence: ${site.file}:${site.line}`,
    ``,
    `Write exactly ONE test file that asserts the KNOWN-GOOD (post-fix) behavior applies at this exact remaining site.`,
    `The test should FAIL if this site still has the old, unfixed behavior, and PASS once it is fixed the same way the original change fixed its own site.`,
    `Return only the test file's source code. No prose, no markdown code fences, no explanation.`,
  ].join("\n");
}

/** Strips a markdown code fence when the model wraps its answer in one, otherwise returns the text unchanged (trimmed). Never throws. */
export function extractGeneratedTestSource(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  const fenced = /^```[^\n]*\n([\s\S]*?)\n?```$/.exec(trimmed);
  const source = fenced ? fenced[1] : trimmed;
  return source.trim().length === 0 ? null : source;
}

/**
 * Y-1 (BLINDSPOT-MANIFEST class 5, applicability signal): cli.ts wires
 * `run_generated_test` to `["node", "--test", testFilePath]` -- this
 * module's actual deployed shape is a Node/JS test runner over a generated
 * `.test.ts`/`.test.js` file, not a language-agnostic oracle. Mirrors
 * `mutation-probe.ts`'s `MUTATION_OPERATOR_APPLICABLE_EXTENSIONS` set
 * exactly (kept as a separate constant rather than a shared import so each
 * module's applicability reasoning stays independently auditable, matching
 * this file's existing "mirrors the pattern, does not import it" posture).
 */
const AMPLIFIER_APPLICABLE_EXTENSIONS = new Set([".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".mts", ".cts"]);

/** Result shape for an analyzer applicability check: additive alongside `amplifySiblingSites`' existing finding-array return value, never a replacement for it. */
export interface AnalyzerApplicability {
  readonly applicable: boolean;
  /** Present only when `applicable` is `false` -- explains WHY, so a caller can tell "not analyzed" from "analyzed, found nothing." */
  readonly reason?: string;
}

/**
 * Whether the generated-oracle amplifier can structurally apply to ANY of
 * the given flagged sibling sites, purely by file extension -- cheap,
 * synchronous, makes no model or command-port call, and is independent of
 * `ARBOR_TEST_AMPLIFIER`'s own gate.
 */
export function assessAmplifierApplicability(sites: readonly FlaggedSiblingSite[]): AnalyzerApplicability {
  if (sites.length === 0) return { applicable: false, reason: "no flagged sibling sites to assess" };
  const extensionOf = (file: string): string => {
    const dot = file.lastIndexOf(".");
    return dot === -1 ? "" : file.slice(dot).toLowerCase();
  };
  const hasApplicableSite = sites.some((site) => AMPLIFIER_APPLICABLE_EXTENSIONS.has(extensionOf(site.file)));
  if (hasApplicableSite) return { applicable: true };
  const observedExtensions = [...new Set(sites.map((site) => extensionOf(site.file) || "(no extension)"))].sort();
  return {
    applicable: false,
    reason: `the generated-oracle amplifier's deployed test runner is Node/JS-shaped and none of the ${sites.length} flagged site(s) match a JS/TS extension -- observed: ${observedExtensions.join(", ")}`,
  };
}

export interface AmplifySiblingSitesInput {
  readonly worktree_path: string;
  /** Flagged sites from the sibling scan; only the first `TEST_AMPLIFIER_MAX_SITES` are used. */
  readonly flagged_sites: readonly FlaggedSiblingSite[];
  readonly model_port: AmplifierModelPort;
  readonly command_port: MachineVerificationCommandPort;
  /**
   * Builds the argv used to run one generated test file. Given the absolute
   * path this module wrote the generated source to, must return the
   * command that compiles/loads AND executes it (e.g. `["bunx", "vitest",
   * "run", testFilePath]`) -- there is no separate compile-only phase this
   * module can construct generically across test runners, so a runner whose
   * process never reaches `"exited"` (spawn failure, timeout, cancellation)
   * is this gate's "cannot even load" case; see `run_generated_test`'s
   * result handling below.
   */
  readonly run_generated_test: (testFilePath: string) => { readonly argv: readonly [string, ...string[]]; readonly network: VerificationNetworkPolicy; readonly timeout_ms?: number; readonly context_root?: string };
  /** Writes the generated test source to disk. Defaults to `node:fs`'s `writeFileSync`; injectable so tests never touch the real filesystem. */
  readonly write_file?: (path: string, content: string) => void;
  /** Where to write the generated test, given the site and its index (0/1). Defaults to a bounded, collision-resistant path under the worktree. */
  readonly test_file_path?: (worktreePath: string, site: FlaggedSiblingSite, index: number) => string;
  readonly env?: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
  readonly max_output_bytes?: number;
  /** Best-effort deletion of a generated test file once it is no longer needed (discarded, or the run could not be judged). Defaults to `node:fs`'s `unlinkSync`; injectable so tests never touch the real filesystem. Failures are swallowed. A file that becomes a `finding` is kept on disk -- its path is the evidence's `test_file`. */
  readonly delete_file?: (path: string) => void;
}

const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;

/**
 * Generates and evidence-gates an inverted regression test per flagged
 * sibling site (bounded to `TEST_AMPLIFIER_MAX_SITES`). Returns `[]`
 * immediately, with zero model or command-port calls, unless
 * `ARBOR_TEST_AMPLIFIER=native` is set -- see `ARBOR_TEST_AMPLIFIER_ENV`.
 */
export async function amplifySiblingSites(input: AmplifySiblingSitesInput): Promise<readonly AmplifierFinding[]> {
  const env = input.env ?? process.env;
  if (env[ARBOR_TEST_AMPLIFIER_ENV] !== "native") return [];
  if (!input.model_port.ready) return [];
  const sites = input.flagged_sites.slice(0, TEST_AMPLIFIER_MAX_SITES);
  const findings: AmplifierFinding[] = [];
  for (let index = 0; index < sites.length; index++) {
    const site = sites[index]!;
    const generated = await input.model_port.call(amplifierPromptFor(site), input.signal);
    if (!generated.ok) continue;
    const source = extractGeneratedTestSource(generated.text);
    if (source === null) continue;
    const testFilePath = (input.test_file_path ?? defaultTestFilePath)(input.worktree_path, site, index);
    try {
      (input.write_file ?? defaultWriteFile)(testFilePath, source);
    } catch {
      continue; // could not even be written to disk -- discard, per the compile-gate posture
    }
    const command = input.run_generated_test(testFilePath);
    const deleteFile = input.delete_file ?? defaultDeleteFile;
    let result: Awaited<ReturnType<MachineVerificationCommandPort["run"]>> | null;
    try {
      result = await input.command_port.run({
        argv: command.argv,
        cwd: input.worktree_path,
        timeout_ms: command.timeout_ms ?? 60_000,
        max_output_bytes: input.max_output_bytes ?? DEFAULT_MAX_OUTPUT_BYTES,
        network: command.network,
        signal: input.signal ?? new AbortController().signal,
        ...(command.context_root === undefined ? {} : { context_root: command.context_root }),
      });
    } catch {
      // The command port itself throwing -- including an abort racing the
      // run to cancellation -- is indistinguishable from "could not even
      // load" for evidence purposes. Previously this propagated out of
      // `amplifySiblingSites` entirely, losing every finding already
      // collected for earlier sites AND leaving this site's generated test
      // file on disk forever; both are defects fixed here (Y-1).
      result = null;
    }
    // Anything that never reached a real exit (spawn failure, timeout,
    // cancellation, output cap) is "could not even load" -- discarded
    // silently, no finding, no evidence, exactly like the sibling-scan
    // note's own degrade-to-nothing posture. The generated file is disposable
    // in this case -- it is not evidence of anything, so it must not survive.
    if (result === null || result.kind !== "exited") {
      try { deleteFile(testFilePath); } catch { /* best-effort cleanup -- the generated test file is disposable. */ }
      continue;
    }
    // A clean exit means the site already behaves correctly, or the
    // generated oracle was too weak to catch anything -- never itself
    // evidence that the site IS broken, so no finding either way. Same
    // disposability as above.
    if (result.exit === 0) {
      try { deleteFile(testFilePath); } catch { /* best-effort cleanup -- the generated test file is disposable. */ }
      continue;
    }
    findings.push({
      site,
      note: `Generated inverted regression test for the sibling pattern at ${site.file}:${site.line} FAILED (exit ${result.exit}) -- the known-good post-fix behavior does not hold there yet. Evidence only; verify whether this site needs the same fix.`,
      evidence: {
        test_file: testFilePath,
        exit_code: result.exit,
        output_excerpt: Buffer.concat([result.stdout, result.stderr]).subarray(0, 2_000).toString("utf-8"),
      },
    });
  }
  return findings;
}

function defaultTestFilePath(worktreePath: string, site: FlaggedSiblingSite, index: number): string {
  const safeName = site.file.replace(/[^a-zA-Z0-9]+/g, "_").slice(0, 64);
  return `${worktreePath}/.arbor-amplifier-${index}-${safeName}-${site.line}.generated.test.ts`;
}

function defaultWriteFile(path: string, content: string): void {
  writeFileSync(path, content, "utf-8");
}

function defaultDeleteFile(path: string): void {
  unlinkSync(path);
}
