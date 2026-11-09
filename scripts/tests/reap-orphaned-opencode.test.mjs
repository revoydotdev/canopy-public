/**
 * scripts/tests/reap-orphaned-opencode.test.mjs — proves the reclamation
 * script's safety gate on REAL processes, not mocks: it must positively
 * attribute a process to revoy2 (reparented to init or a runner subreaper AND cwd under a package.json named
 * "revoy2") before treating it as a kill candidate, and must never touch a
 * process with a live parent regardless of its argv or cwd.
 *
 * Every "orphan" here is synthetic and self-contained: a tiny compiled C
 * binary (ignores argv entirely, just sleeps — no shebang/interpreter layer,
 * so `exec -a` can set its literal argv0/argv1 to "opencode run|serve") is
 * exec'd inside a backgrounded, immediately-exiting bash subshell — the exact
 * "parent dies while child keeps running" mechanism verified against the
 * real leak (see opencode-executor.ts's `activeChildren` registry comment,
 * and the empirical SIGTERM/SIGINT/SIGKILL orphaning tests that motivated
 * this fix). Nothing here is the real `opencode` binary; no network, no API
 * cost. Every spawned pid is force-killed in `afterEach` regardless of test
 * outcome, so a failing assertion can never leave a stray process behind.
 *
 * A shebang script was tried first and rejected: the kernel's binfmt_script
 * handler rewrites argv0 to the interpreter (e.g. "/bin/sh"), silently
 * defeating `exec -a`. A real ELF binary has no such indirection.
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(dirname(__dirname));
const SCRIPT = join(REPO_ROOT, "scripts", "reap-orphaned-opencode.mjs");

const hasCc = (() => {
  try { execFileSync("cc", ["--version"], { stdio: "ignore" }); return true; } catch { return false; }
})();

if (process.platform !== "linux" || !hasCc) {
  describe.skip(`reap-orphaned-opencode (needs Linux + a C compiler; platform=${process.platform} cc=${hasCc})`, () => {
    it("skipped", () => {});
  });
} else {
  describe("reap-orphaned-opencode.mjs — real-process safety gate", () => {
    const buildDir = mkdtempSync(join(tmpdir(), "reap-test-build-"));
    const sleeperSrc = join(buildDir, "sleeper.c");
    const sleeperBin = join(buildDir, "sleeper");
    const subreaperSrc = join(buildDir, "subreaper.c");
    const subreaperBin = join(buildDir, "Runner.Listener");
    writeFileSync(
      sleeperSrc,
      `#include <stdio.h>\n#include <unistd.h>\n#include <stdlib.h>\n` +
        `int main(void) {\n` +
        `  const char *pidfile = getenv("REAP_TEST_PIDFILE");\n` +
        `  if (pidfile) { FILE *f = fopen(pidfile, "w"); if (f) { fprintf(f, "%d\\n", (int)getpid()); fclose(f); } }\n` +
        `  for (;;) sleep(3600);\n` +
        `  return 0;\n` +
        `}\n`,
      "utf8",
    );
    execFileSync("cc", ["-O0", "-o", sleeperBin, sleeperSrc]);
    writeFileSync(
      subreaperSrc,
      `#include <stdlib.h>\n#include <sys/prctl.h>\n#include <sys/types.h>\n#include <sys/wait.h>\n#include <unistd.h>\n` +
        `int main(int argc, char **argv) {\n` +
        `  if (argc != 3 || prctl(PR_SET_CHILD_SUBREAPER, 1) != 0) return 2;\n` +
        `  pid_t middle = fork(); if (middle < 0) return 3;\n` +
        `  if (middle == 0) {\n` +
        `    pid_t leaf = fork(); if (leaf < 0) _exit(4);\n` +
        `    if (leaf == 0) { char *args[] = { "opencode", argv[2], "--fake", 0 }; execv(argv[1], args); _exit(127); }\n` +
        `    _exit(0);\n` +
        `  }\n` +
        `  int status; waitpid(middle, &status, 0); for (;;) waitpid(-1, &status, 0);\n` +
        `}\n`,
      "utf8",
    );
    execFileSync("cc", ["-O0", "-o", subreaperBin, subreaperSrc]);

    const scratchDirs = [];
    const spawnedPids = [];

    afterEach(() => {
      for (const pid of spawnedPids.splice(0)) {
        try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
      }
      for (const dir of scratchDirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    afterAll(() => {
      rmSync(buildDir, { recursive: true, force: true });
    });

    function makeProjectDir(name) {
      const dir = mkdtempSync(join(tmpdir(), "reap-test-proj-"));
      mkdirSync(join(dir, "sub"), { recursive: true });
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name }), "utf8");
      scratchDirs.push(dir);
      return join(dir, "sub"); // cwd one level below the package.json, like a real repo subdir
    }

    /** Spawn a real orphan reparented to a Runner.Listener child subreaper. */
    async function spawnRealOrphan(cwd, mode) {
      const pidfile = join(dirname(cwd), "pid");
      const subreaper = spawn(
        subreaperBin,
        [sleeperBin, mode],
        { cwd, stdio: "ignore", env: { ...process.env, REAP_TEST_PIDFILE: pidfile } },
      );
      spawnedPids.push(subreaper.pid);
      for (let i = 0; i < 50 && !existsSync(pidfile); i++) await new Promise((r) => setTimeout(r, 20));
      const pid = Number(readFileSync(pidfile, "utf8").trim());
      spawnedPids.push(pid);
      // Confirm the child subreaper adopted the orphan before relying on it.
      for (let i = 0; i < 50; i++) {
        const status = readFileSync(`/proc/${pid}/status`, "utf8");
        if (new RegExp(`^PPid:\\s*${subreaper.pid}$`, "m").test(status)) break;
        await new Promise((r) => setTimeout(r, 20));
      }
      return { pid, subreaperPid: subreaper.pid };
    }

    /** Spawn the same fake binary directly, with THIS test process as its live parent (never orphaned). */
    function spawnLiveChild(cwd, mode) {
      const child = spawn("bash", ["-c", `exec -a opencode "$1" "$2" --fake`, "_", sleeperBin, mode], { cwd, stdio: "ignore" });
      spawnedPids.push(child.pid);
      return child.pid;
    }

    function runScript(args) {
      return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
    }

    it("treats a real orphan under a revoy2-named package.json as a candidate", async () => {
      const cwd = makeProjectDir("revoy2");
      const { pid, subreaperPid } = await spawnRealOrphan(cwd, "serve");

      const status = readFileSync(`/proc/${pid}/status`, "utf8");
      expect(status).toMatch(new RegExp(`^PPid:\\s*${subreaperPid}$`, "m"));

      const result = runScript(["--json"]);
      expect(result.status).toBe(0);
      const { candidates, excluded } = JSON.parse(result.stdout);
      expect(candidates.some((c) => c.pid === pid)).toBe(true);
      expect(excluded.some((e) => e.pid === pid)).toBe(false);
    });

    it("excludes a real orphan whose nearest package.json is NOT named revoy2 — never attributed, never a candidate", async () => {
      const cwd = makeProjectDir("some-other-project");
      const { pid } = await spawnRealOrphan(cwd, "serve");

      const result = runScript(["--json"]);
      const { candidates, excluded } = JSON.parse(result.stdout);
      expect(candidates.some((c) => c.pid === pid)).toBe(false);
      const entry = excluded.find((e) => e.pid === pid);
      expect(entry).toBeDefined();
      expect(entry.reason).toMatch(/some-other-project/);
    });

    it("excludes an opencode-shaped process with a live parent — never a candidate regardless of cwd", async () => {
      const cwd = makeProjectDir("revoy2");
      const pid = spawnLiveChild(cwd, "serve");
      await new Promise((r) => setTimeout(r, 200)); // let it start

      const status = readFileSync(`/proc/${pid}/status`, "utf8");
      expect(status).not.toMatch(/^PPid:\s*1$/m); // sanity: NOT orphaned — this test process is its parent

      const result = runScript(["--json"]);
      const { candidates, excluded } = JSON.parse(result.stdout);
      expect(candidates.some((c) => c.pid === pid)).toBe(false);
      const entry = excluded.find((e) => e.pid === pid);
      expect(entry).toBeDefined();
      expect(entry.reason).toMatch(/live parent/);
    });

    it("--kill --yes actually terminates a verified revoy2 orphan, and only that one", async () => {
      const cwdA = makeProjectDir("revoy2");
      const { pid: pidA } = await spawnRealOrphan(cwdA, "run");
      const cwdB = makeProjectDir("not-revoy2-at-all");
      const { pid: pidB } = await spawnRealOrphan(cwdB, "run");

      const result = runScript(["--kill", "--yes"]);
      expect(result.status).toBe(0);

      await new Promise((r) => setTimeout(r, 500)); // give SIGTERM a moment to land
      expect(() => process.kill(pidA, 0)).toThrow(); // gone
      expect(() => process.kill(pidB, 0)).not.toThrow(); // untouched — not revoy2-attributed
    });

    it("report-only mode (no --kill) never sends any signal", async () => {
      const cwd = makeProjectDir("revoy2");
      const { pid } = await spawnRealOrphan(cwd, "serve");

      runScript([]);
      await new Promise((r) => setTimeout(r, 300));
      expect(() => process.kill(pid, 0)).not.toThrow(); // still alive
    });
  });
}
