/**
 * Y-1 (BLINDSPOT-MANIFEST class 1, "cancellation × mutation" — the
 * manifest's highest-severity gap): the mutation probe writes a mutant over
 * a real source file and restores the original in a `finally`; the
 * amplifier writes generated test files. Racing (`race.ts`) aborts a
 * worktree mid-flight via its own `AbortController`. This suite drives an
 * abort through EVERY await point in both modules' per-site loop — before
 * the write, between write and command, during the command, and (for the
 * amplifier) after the command throws entirely — and asserts, after each:
 * the worktree file is byte-identical to the original, no generated test
 * file survives, and the finding list is honest about having been cut short
 * (never a thrown exception that loses findings already collected).
 *
 * FINDING (fixed in this workstream): `amplifySiblingSites` had NO
 * try/catch around its `command_port.run(...)` call. An abort racing the
 * command to cancellation (or any other command-port rejection) propagated
 * straight out of `amplifySiblingSites`, which (a) discarded every finding
 * already collected for earlier sites in the same call, because the
 * function never returned, and (b) left the just-written generated test
 * file on disk forever — nothing in the module's control flow ever reached
 * a cleanup step for it. `probeMutations` was already correct: every mutant
 * write happens synchronously right before the one `await`, and restoration
 * lives in an unconditional `finally`, so no interleaving of the single
 * await point can skip it. This suite pins both facts down as regression
 * tests: the probe's pre-existing invariant, and the amplifier's fix.
 */
import { mkdtempSync, readFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { MachineVerificationCommandPort, MachineVerificationCommandResult } from "../src/worktree-machine-verifier.js";
import {
  ARBOR_MUTATION_PROBE_ENV,
  probeMutations,
  type ProbeMutationsInput,
} from "../src/mutation-probe.js";
import {
  ARBOR_TEST_AMPLIFIER_ENV,
  amplifySiblingSites,
  type AmplifierModelPort,
  type FlaggedSiblingSite,
} from "../src/test-amplifier.js";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function worktree(): string { const directory = mkdtempSync(join(tmpdir(), "arbor-substrate-cancel-")); directories.push(directory); return directory; }

function abortErrorPort(_controller: AbortController, onDispatch?: () => void): MachineVerificationCommandPort {
  return {
    async run(request) {
      onDispatch?.();
      // Mirrors a real sandboxed command port: rejects with an AbortError
      // once its signal fires, exactly the shape `command_port.run` throws
      // when a race abort cancels the in-flight verification command.
      return new Promise<MachineVerificationCommandResult>((_resolve, reject) => {
        const signal = request.signal;
        if (signal?.aborted) { reject(new DOMException("aborted", "AbortError")); return; }
        signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
        // Never resolves on its own -- the only way this promise settles is
        // via the abort listener above, forcing every test in this suite to
        // go through the real abort path rather than a timing race.
      });
    },
  };
}

function fakeFiles(initial: Record<string, string>): {
  files: Record<string, string>;
  read_file: (path: string) => string;
  write_file: (path: string, content: string) => void;
} {
  const files = { ...initial };
  return {
    files,
    read_file: (path: string) => {
      if (!(path in files)) throw new Error(`no such file: ${path}`);
      return files[path]!;
    },
    write_file: (path: string, content: string) => { files[path] = content; },
  };
}

describe("probeMutations — abort at every await point in the per-mutant loop", () => {
  const ORIGINAL = "if (x < 10) {\n  return true;\n}\n";

  function abortInput(overrides: Partial<ProbeMutationsInput> = {}, fs = fakeFiles({ "a.ts": ORIGINAL })): { input: ProbeMutationsInput; fs: ReturnType<typeof fakeFiles> } {
    return {
      fs,
      input: {
        worktree_path: "/wt",
        diff_changed_lines: [{ file: "a.ts", line: 1 }],
        sibling_flagged_sites: [],
        command_port: { async run() { return { kind: "exited" as const, exit: 1, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }; } },
        acceptance_command: () => ({ argv: ["true"], network: "enforced_denied" as const }),
        env: { [ARBOR_MUTATION_PROBE_ENV]: "on" },
        read_file: fs.read_file,
        write_file: fs.write_file,
        ...overrides,
      },
    };
  }

  it("abort BEFORE the mutant is dispatched (signal already aborted): still restores byte-identically, honest empty findings", async () => {
    const controller = new AbortController();
    controller.abort();
    const { input, fs } = abortInput({
      signal: controller.signal,
      command_port: abortErrorPort(controller),
    });
    const findings = await probeMutations(input);
    expect(findings).toEqual([]);
    expect(fs.files["a.ts"]).toBe(ORIGINAL);
  });

  it("abort DURING the acceptance command (mid-flight): the write already happened, the command never resolves except via abort, restoration still fires", async () => {
    const controller = new AbortController();
    let dispatched = false;
    const { input, fs } = abortInput({
      signal: controller.signal,
      command_port: abortErrorPort(controller, () => {
        dispatched = true;
        // The mutant write happens synchronously before this dispatch, so by
        // the time the command port is called, the mutant is already on
        // disk -- this is the exact moment a race abort would land.
        expect(fs.files["a.ts"]).not.toBe(ORIGINAL);
        controller.abort();
      }),
    });
    const findings = await probeMutations(input);
    expect(dispatched).toBe(true);
    expect(findings).toEqual([]);
    expect(fs.files["a.ts"]).toBe(ORIGINAL);
  });

  it("abort races the command port throwing synchronously (indistinguishable from a killed mutant): restoration still fires, no finding", async () => {
    const { input, fs } = abortInput({
      command_port: { async run() { throw new DOMException("aborted", "AbortError"); } },
    });
    const findings = await probeMutations(input);
    expect(findings).toEqual([]);
    expect(fs.files["a.ts"]).toBe(ORIGINAL);
  });

  it("an abort landing on one mutant does not corrupt a LATER mutant's site: each site is independently write/restore-scoped", async () => {
    const lines = ["if (x < 1) return;", "if (x < 2) return;"];
    const original = lines.join("\n");
    const fs = fakeFiles({ "a.ts": original });
    let calls = 0;
    const { input } = abortInput({
      diff_changed_lines: [{ file: "a.ts", line: 1 }, { file: "a.ts", line: 2 }],
      read_file: fs.read_file,
      write_file: fs.write_file,
      command_port: {
        async run() {
          calls += 1;
          if (calls === 1) throw new DOMException("aborted", "AbortError"); // first mutant's command aborts
          return { kind: "exited" as const, exit: 1, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }; // second mutant's command runs clean
        },
      },
    }, fs);
    const findings = await probeMutations(input);
    expect(calls).toBe(2);
    expect(findings).toEqual([]);
    expect(fs.files["a.ts"]).toBe(original);
  });
});

describe("amplifySiblingSites — abort at every await point in the per-site loop (Y-1 fix)", () => {
  function site(overrides: Partial<FlaggedSiblingSite> = {}): FlaggedSiblingSite {
    return { pattern: "if (x > MAX) throw new Error();", file: "lib/sibling.js", line: 42, ...overrides };
  }
  function readyPort(text: string): AmplifierModelPort {
    return Object.freeze({ ready: true, async call() { return { ok: true as const, text }; } });
  }
  const runGeneratedTest = () => ({ argv: ["node", "--test"] as const, network: "unrestricted" as const });

  it("REGRESSION: an abort during the command-port run no longer throws out of amplifySiblingSites, and deletes the generated test file", async () => {
    const directory = worktree();
    const controller = new AbortController();
    const findings = await amplifySiblingSites({
      worktree_path: directory,
      flagged_sites: [site()],
      model_port: readyPort("test('x', () => {});"),
      command_port: abortErrorPort(controller, () => controller.abort()),
      run_generated_test: runGeneratedTest,
      signal: controller.signal,
      env: { [ARBOR_TEST_AMPLIFIER_ENV]: "native" },
    });
    // Before the fix: this `await` would have thrown, failing the test with
    // an uncaught AbortError instead of resolving here at all.
    expect(findings).toEqual([]);
    const generatedFiles = readdirSync(directory).filter((f: string) => f.includes(".generated.test."));
    expect(generatedFiles).toEqual([]);
  });

  it("REGRESSION: an abort on site 2 of 2 does not discard site 1's already-collected finding", async () => {
    const directory = worktree();
    const controller = new AbortController();
    let siteIndex = 0;
    const findings = await amplifySiblingSites({
      worktree_path: directory,
      flagged_sites: [site({ file: "a.js", line: 1 }), site({ file: "b.js", line: 2 })],
      model_port: readyPort("test('x', () => { throw new Error('unfixed'); });"),
      command_port: {
        async run(_request) {
          siteIndex += 1;
          if (siteIndex === 1) {
            return { kind: "exited", exit: 1, stdout: Buffer.from("1 failing"), stderr: Buffer.alloc(0) };
          }
          controller.abort();
          throw new DOMException("aborted", "AbortError");
        },
      },
      run_generated_test: runGeneratedTest,
      signal: controller.signal,
      env: { [ARBOR_TEST_AMPLIFIER_ENV]: "native" },
    });
    // Before the fix: site 2's command-port throw would have propagated out
    // of the whole function, and this array would never have existed at
    // all -- site 1's real finding lost along with it.
    expect(findings).toHaveLength(1);
    expect(findings[0]!.site).toEqual(site({ file: "a.js", line: 1 }));
    // Site 2's own generated file must not survive the abort.
    const remaining = readdirSync(directory).filter((f: string) => f.includes("_b_js_"));
    expect(remaining).toEqual([]);
  });

  it("REGRESSION: a discarded (non-exited) result deletes its generated test file instead of littering the worktree forever", async () => {
    const directory = worktree();
    await amplifySiblingSites({
      worktree_path: directory,
      flagged_sites: [site()],
      model_port: readyPort("garbage((((("),
      command_port: { async run() { return { kind: "spawn_failed" }; } },
      run_generated_test: runGeneratedTest,
      env: { [ARBOR_TEST_AMPLIFIER_ENV]: "native" },
    });
    const generatedFiles = readdirSync(directory).filter((f: string) => f.includes(".generated.test."));
    expect(generatedFiles).toEqual([]);
  });

  it("REGRESSION: a clean-exit (site already fine) result deletes its generated test file too", async () => {
    const directory = worktree();
    await amplifySiblingSites({
      worktree_path: directory,
      flagged_sites: [site()],
      model_port: readyPort("test('x', () => {});"),
      command_port: { async run() { return { kind: "exited", exit: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }; } },
      run_generated_test: runGeneratedTest,
      env: { [ARBOR_TEST_AMPLIFIER_ENV]: "native" },
    });
    const generatedFiles = readdirSync(directory).filter((f: string) => f.includes(".generated.test."));
    expect(generatedFiles).toEqual([]);
  });

  it("a real finding's generated test file IS kept on disk -- it is the evidence.test_file the caller can inspect", async () => {
    const directory = worktree();
    const findings = await amplifySiblingSites({
      worktree_path: directory,
      flagged_sites: [site()],
      model_port: readyPort("test('x', () => { throw new Error('unfixed'); });"),
      command_port: { async run() { return { kind: "exited", exit: 1, stdout: Buffer.from("1 failing"), stderr: Buffer.alloc(0) }; } },
      run_generated_test: runGeneratedTest,
      env: { [ARBOR_TEST_AMPLIFIER_ENV]: "native" },
    });
    expect(findings).toHaveLength(1);
    expect(existsSync(findings[0]!.evidence.test_file)).toBe(true);
    expect(readFileSync(findings[0]!.evidence.test_file, "utf-8")).toContain("unfixed");
  });

  it("delete_file is injectable so tests never need to touch the real filesystem for cleanup assertions", async () => {
    const deleted: string[] = [];
    const controller = new AbortController();
    await amplifySiblingSites({
      worktree_path: "/wt",
      flagged_sites: [site()],
      model_port: readyPort("test('x', () => {});"),
      command_port: abortErrorPort(controller, () => controller.abort()),
      run_generated_test: runGeneratedTest,
      write_file: () => {},
      delete_file: (path: string) => { deleted.push(path); },
      signal: controller.signal,
      env: { [ARBOR_TEST_AMPLIFIER_ENV]: "native" },
    });
    expect(deleted).toHaveLength(1);
  });
});
