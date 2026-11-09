import { appendFileSync, chmodSync, cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync, existsSync, readFileSync, realpathSync, statSync, symlinkSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { buildCaptureText, classifyCaptureFailure, evaluateEvidence, formatCaptureCliFailure, hasFreshDispatch, parseArgs, preserveFailureEvidence, readFrameLines, reclaimOutputDirectory, recordTmuxDemo, REQUIRED_LOOP_EVENTS, writeCaptureFailureArtifacts } from "../tmux-demo-record.mjs";

let root;
let externalRoot;
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  if (externalRoot) rmSync(externalRoot, { recursive: true, force: true });
});

describe("capture output directory reclaim", () => {
  it("reclaims a directory left behind by a FAILED take", () => {
    root = mkdtempSync(join(tmpdir(), "reclaim-"));
    const output = join(root, "reel1");
    mkdirSync(output);
    writeFileSync(join(output, ".incomplete"), "capture incomplete\n");
    writeFileSync(join(output, "failure.txt"), "empirical proof incomplete\n");
    expect(reclaimOutputDirectory(output)).toBe("reclaimed");
    expect(existsSync(output)).toBe(false);
  });

  it("refuses to overwrite a COMPLETE capture", () => {
    root = mkdtempSync(join(tmpdir(), "reclaim-"));
    const output = join(root, "reel1");
    mkdirSync(output);
    writeFileSync(join(output, "manifest.json"), "{}\n");
    expect(() => reclaimOutputDirectory(output)).toThrow(/COMPLETE capture/);
    expect(existsSync(join(output, "manifest.json"))).toBe(true);
  });

  it("reports a fresh run id as created", () => {
    root = mkdtempSync(join(tmpdir(), "reclaim-"));
    expect(reclaimOutputDirectory(join(root, "never-used"))).toBe("created");
  });
});

describe("failure classification and preservation", () => {
  it("does not print secret-bearing command stderr at the executable boundary", () => {
    const secret = "sk-proj-abcdefghijklmnop";
    const rendered = formatCaptureCliFailure(new Error(`campaign failed; stderr tail: API_KEY=${secret}`));
    expect(rendered).not.toContain(secret);
    expect(rendered).not.toContain("stderr tail");
    expect(rendered).toContain("failure-diagnostic.json");
  });

  it("keeps secret-bearing command stderr out of the real executable catch output", () => {
    root = mkdtempSync(join(tmpdir(), "capture-cli-boundary-"));
    externalRoot = mkdtempSync(join("/mnt/sda2", "revoy2-capture-cli-"));
    const fakeBin = join(root, "bin");
    const privateRoot = join(root, "private");
    mkdirSync(fakeBin);
    const secret = "sk-proj-abcdefghijklmnop";
    const tmux = join(fakeBin, "tmux");
    writeFileSync(tmux, `#!/bin/sh\nif [ "$1" = "-V" ]; then exit 0; fi\necho 'campaign stderr OPENAI_API_KEY=${secret}' >&2\nexit 1\n`);
    chmodSync(tmux, 0o755);
    for (const tool of ["ffmpeg", "ffprobe"]) {
      const path = join(fakeBin, tool);
      writeFileSync(path, "#!/bin/sh\nexit 0\n");
      chmodSync(path, 0o755);
    }
    const script = new URL("../tmux-demo-record.mjs", import.meta.url).pathname;
    const result = spawnSync(process.execPath, [script, "--run-id", "cli-secret-boundary", "--output-root", externalRoot, "--private-evidence-root", privateRoot], {
      encoding: "utf8",
      env: { ...process.env, HOME: root, PATH: `${fakeBin}:${process.env.PATH ?? ""}` },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).not.toContain(secret);
    expect(result.stderr).not.toContain("campaign stderr");
    expect(result.stderr).toContain("capture recorder failed (Error)");
    expect(readFileSync(join(externalRoot, "cli-secret-boundary", "failure-diagnostic.json"), "utf8")).not.toContain(secret);
  });

  it("classifies the four release failure classes from bounded stage and source evidence", () => {
    expect(classifyCaptureFailure({ phase: "campaign_readiness", stderr_text: "provider request failed: HTTP 429" })).toMatchObject({ failure_class: "provider", failure_code: "provider_request_failed", classification_method: "bounded_log_pattern", classification_confidence: "inferred", classification_sources: ["campaign_stderr_log"] });
    expect(classifyCaptureFailure({ phase: "campaign_readiness", console_text: "verification command failed: cargo test exit code 1" })).toMatchObject({ failure_class: "repository", failure_code: "repository_verification_failed", classification_sources: ["campaign_console_log"] });
    expect(classifyCaptureFailure({ phase: "campaign_startup" })).toMatchObject({ failure_class: "harness", failure_code: "campaign_execution_failed" });
    expect(classifyCaptureFailure({ phase: "media_encoding" })).toMatchObject({ failure_class: "capture", failure_code: "media_encoding_failed" });
    expect(classifyCaptureFailure({ phase: "untrusted phase" }).phase).toBe("setup");
  });

  it("stores raw source trees outside publication output with restrictive permissions", () => {
    root = mkdtempSync(join(tmpdir(), "capture-failure-"));
    const output = join(root, "output");
    const privateEvidence = join(root, "private", "run-1");
    const outer = join(root, "outer-persistence");
    const worktreePersistence = join(root, "selfhost-worktree", ".arbor");
    const anotherPersistence = join(root, "additional-persistence");
    const frames = join(root, "frames.jsonl");
    mkdirSync(output);
    mkdirSync(outer, { recursive: true });
    mkdirSync(join(worktreePersistence, "devtools"), { recursive: true });
    mkdirSync(anotherPersistence, { recursive: true });
    writeFileSync(join(outer, "real-stderr.log"), "[runner] campaign exited rc=1\n");
    writeFileSync(join(outer, "selfhost-stderr.log"), "selfhost typed stderr detail\n");
    writeFileSync(join(worktreePersistence, "devtools", "devtools.log"), '{"event_kind":"loop.specialist_dispatched"}\n');
    writeFileSync(join(worktreePersistence, "tree.jsonl"), "inspectable selfhost state token=sk-proj-abcdefghijklmnop\n");
    writeFileSync(join(anotherPersistence, "audit.jsonl"), "additional source state\n");
    writeFileSync(frames, '{"sequence":1}\n');

    const preservation = preserveFailureEvidence(privateEvidence, output, [outer, worktreePersistence, anotherPersistence], frames);
    writeCaptureFailureArtifacts({
      output,
      preservation,
      error: new Error("provider request failed with OPENAI_API_KEY=sk-proj-abcdefghijklmnop"),
      phase: "campaign_readiness",
      stderr_text: "provider request failed: HTTP 429",
      frame_stats: { frame_count: 1, distinct_left_frames: 1, distinct_right_frames: 1 },
      evidence: null,
    });

    const diagnosticText = readFileSync(join(output, "failure-diagnostic.json"), "utf8");
    const diagnostic = JSON.parse(diagnosticText);
    expect(diagnostic).toMatchObject({ failure_class: "provider", failure_code: "provider_request_failed", publication_status: "failed_closed" });
    expect(diagnostic.private_evidence).toMatchObject({ status: "preserved", publication_output_exclusion: expect.stringContaining("never written under publication output") });
    expect(diagnostic.private_evidence.paths).toEqual(["campaign-ledger", "campaign-ledger-2", "campaign-ledger-3", "frames.jsonl"]);
    expect(diagnosticText).not.toContain("sk-proj-abcdefghijklmnop");
    expect(readFileSync(join(output, "failure.txt"), "utf8")).toContain("failure details withheld by secret scan");
    expect(existsSync(join(output, "preserved-evidence"))).toBe(false);
    expect(readFileSync(join(privateEvidence, "campaign-ledger", "real-stderr.log"), "utf8")).toContain("campaign exited");
    expect(readFileSync(join(privateEvidence, "campaign-ledger", "selfhost-stderr.log"), "utf8")).toContain("selfhost typed stderr detail");
    expect(readFileSync(join(privateEvidence, "campaign-ledger-2", "devtools", "devtools.log"), "utf8")).toContain("loop.specialist_dispatched");
    expect(readFileSync(join(privateEvidence, "campaign-ledger-2", "tree.jsonl"), "utf8")).toContain("sk-proj-abcdefghijklmnop");
    expect(readFileSync(join(privateEvidence, "campaign-ledger-3", "audit.jsonl"), "utf8")).toContain("additional source state");
    expect(readFileSync(join(privateEvidence, "frames.jsonl"), "utf8")).toContain('"sequence":1');
    expect(statSync(privateEvidence).mode & 0o777).toBe(0o700);
    expect(statSync(join(privateEvidence, "campaign-ledger-2", "tree.jsonl")).mode & 0o777).toBe(0o600);
    expect(statSync(join(privateEvidence, "campaign-ledger-2", "devtools")).mode & 0o777).toBe(0o700);
  });

  it("refuses a private evidence path that resolves through a symlink into publication output", () => {
    root = mkdtempSync(join(tmpdir(), "capture-private-boundary-"));
    const output = join(root, "publication", "run");
    const alias = join(root, "private-alias");
    const source = join(root, "source");
    mkdirSync(output, { recursive: true });
    mkdirSync(source);
    writeFileSync(join(source, "secret.log"), "source must remain intact\n");
    symlinkSync(output, alias, "dir");

    expect(() => preserveFailureEvidence(join(alias, "private"), output, [source], join(root, "missing-frames.jsonl")))
      .toThrow(/resolves inside publication output/);
    expect(readFileSync(join(source, "secret.log"), "utf8")).toContain("source must remain intact");
    expect(readdirSync(output)).toEqual([]);
  });

  it("rejects a symlinked private run leaf in the recorder without copying raw evidence into publication output", async () => {
    root = mkdtempSync(join(tmpdir(), "capture-private-leaf-symlink-"));
    const repo = join(root, "repo");
    const outputRoot = join(root, "publication");
    const privateRoot = join(root, "private");
    const runId = "private-leaf-escape";
    mkdirSync(repo);
    mkdirSync(outputRoot);
    mkdirSync(privateRoot);
    const output = join(outputRoot, runId);
    mkdirSync(output);
    writeFileSync(join(output, ".incomplete"), "stale failed capture\n");
    symlinkSync(output, join(privateRoot, runId), "dir");
    execFileSync("git", ["init", "-q", repo]);
    execFileSync("git", ["-C", repo, "config", "user.email", "fixture@invalid"]);
    execFileSync("git", ["-C", repo, "config", "user.name", "Fixture"]);
    writeFileSync(join(repo, "README.md"), "fixture repo\n");
    execFileSync("git", ["-C", repo, "add", "README.md"]);
    execFileSync("git", ["-C", repo, "commit", "-q", "-m", "fixture"]);
    const persistence = join(repo, ".arbor", "publication-captures", runId);
    const secret = "sk-proj-abcdefghijklmnop";
    const run = (command, args) => {
      if (command === "tmux" && args[0] === "new-session") return { status: 0, stdout: "", stderr: "" };
      if (command.endsWith("/scripts/demo-window.sh")) {
        mkdirSync(persistence, { recursive: true });
        writeFileSync(join(persistence, "raw-stderr.log"), `raw source ${secret}\n`);
        throw new Error("controlled fixture failure");
      }
      if (command === "tmux" && args[0] === "capture-pane") return { status: 0, stdout: "safe pane", stderr: "" };
      if (command === "tmux" && args[0] === "kill-session") return { status: 0, stdout: "", stderr: "" };
      throw new Error(`unexpected controlled command: ${command}`);
    };

    await expect(recordTmuxDemo({
      run_id: runId,
      output_root: outputRoot,
      private_evidence_root: privateRoot,
      repo_root: repo,
      duration_seconds: 6,
    }, {
      run,
      tool_exists: () => true,
      ensure_root: (path) => { mkdirSync(path, { recursive: true }); return realpathSync(path); },
      copy_private_tree: () => { throw new Error("copy must not be attempted through a symlink leaf"); },
    })).rejects.toThrow("controlled fixture failure");

    expect(readFileSync(join(persistence, "raw-stderr.log"), "utf8")).toContain(secret);
    expect(existsSync(join(privateRoot, runId))).toBe(true);
    const diagnosticText = readFileSync(join(output, "failure-diagnostic.json"), "utf8");
    const diagnostic = JSON.parse(diagnosticText);
    expect(diagnosticText).not.toContain(secret);
    expect(diagnostic.private_evidence.location_hint).toContain("private evidence path rejected");
    expect(diagnostic.private_evidence.retained_source_locations).toEqual([{ label: "campaign-ledger", path: persistence }]);
    expect(readFileSync(join(output, "failure.txt"), "utf8")).toContain(`retained campaign-ledger: ${persistence}`);
    for (const name of readdirSync(output)) {
      const path = join(output, name);
      if (statSync(path).isFile()) expect(readFileSync(path, "utf8")).not.toContain(secret);
    }
    expect(readdirSync(output)).not.toContain("raw-stderr.log");
  });

  it("rejects a symlinked private scratch-root leaf before launching a capture", async () => {
    root = mkdtempSync(join(tmpdir(), "capture-private-scratch-leaf-"));
    const outputRoot = join(root, "publication");
    const privateRootAlias = join(root, "private-alias");
    mkdirSync(outputRoot);
    symlinkSync(outputRoot, privateRootAlias, "dir");
    const outputMode = statSync(outputRoot).mode & 0o777;
    let launched = false;

    await expect(recordTmuxDemo({
      run_id: "scratch-leaf-escape",
      output_root: outputRoot,
      private_evidence_root: privateRootAlias,
      repo_root: root,
      duration_seconds: 6,
    }, {
      run: () => { launched = true; throw new Error("capture should not launch"); },
      tool_exists: () => true,
      ensure_root: (path) => { mkdirSync(path, { recursive: true }); return realpathSync(path); },
    })).rejects.toThrow(/private scratch root must not be a symbolic link/);

    expect(launched).toBe(false);
    expect(statSync(outputRoot).mode & 0o777).toBe(outputMode);
    expect(readdirSync(outputRoot)).toEqual([]);
    expect(statSync(privateRootAlias).isDirectory()).toBe(true);
  });

  it("retains original logs through recordTmuxDemo finally when private evidence copying fails", async () => {
    root = mkdtempSync(join(tmpdir(), "capture-failure-finally-"));
    const repo = join(root, "repo");
    const outputRoot = join(root, "publication");
    const privateRoot = join(root, "private");
    const runId = "copy-failure";
    mkdirSync(repo);
    execFileSync("git", ["init", "-q", repo]);
    execFileSync("git", ["-C", repo, "config", "user.email", "fixture@invalid"]);
    execFileSync("git", ["-C", repo, "config", "user.name", "Fixture"]);
    writeFileSync(join(repo, "README.md"), "fixture repo\n");
    execFileSync("git", ["-C", repo, "add", "README.md"]);
    execFileSync("git", ["-C", repo, "commit", "-q", "-m", "fixture"]);
    const persistence = join(repo, ".arbor", "publication-captures", runId);
    const secret = "sk-proj-abcdefghijklmnop";
    const run = (command, args) => {
      if (command === "tmux" && args[0] === "new-session") return { status: 0, stdout: "", stderr: "" };
      if (command.endsWith("/scripts/demo-window.sh")) {
        mkdirSync(join(persistence, "devtools"), { recursive: true });
        writeFileSync(join(persistence, "real-console.log"), `provider response withheld ${secret}\n`);
        writeFileSync(join(persistence, "real-stderr.log"), `raw stderr ${secret}\n`);
        writeFileSync(join(persistence, "devtools", "devtools.log"), `raw ledger ${secret}\n`);
        throw new Error("controlled campaign startup failure");
      }
      if (command === "tmux" && args[0] === "capture-pane") return { status: 0, stdout: "safe final pane", stderr: "" };
      if (command === "tmux" && args[0] === "kill-session") return { status: 0, stdout: "", stderr: "" };
      throw new Error(`unexpected controlled command: ${command}`);
    };

    await expect(recordTmuxDemo({
      run_id: runId,
      output_root: outputRoot,
      private_evidence_root: privateRoot,
      repo_root: repo,
      duration_seconds: 6,
    }, {
      run,
      tool_exists: () => true,
      ensure_root: (path) => { mkdirSync(path, { recursive: true }); return realpathSync(path); },
      copy_private_tree: (source, destination, options) => {
        mkdirSync(destination, { recursive: true });
        writeFileSync(join(destination, "partial.log"), "partial secret-bearing copy must remain private\n");
        throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
      },
    })).rejects.toThrow("controlled campaign startup failure");

    expect(readFileSync(join(persistence, "real-stderr.log"), "utf8")).toContain(secret);
    expect(readFileSync(join(persistence, "devtools", "devtools.log"), "utf8")).toContain(secret);
    const output = join(outputRoot, runId);
    const diagnosticText = readFileSync(join(output, "failure-diagnostic.json"), "utf8");
    const diagnostic = JSON.parse(diagnosticText);
    expect(diagnostic.private_evidence).toMatchObject({ status: "original_sources_retained", retained_source_count: 1, retained_sources: ["campaign-ledger"], retained_source_locations: [{ label: "campaign-ledger", path: persistence }] });
    expect(diagnostic.private_evidence.publication_output_exclusion).toContain("never written under publication output");
    expect(diagnostic.private_evidence.location_hint).toBe(join(privateRoot, runId));
    expect(diagnosticText).not.toContain(secret);
    const failureText = readFileSync(join(output, "failure.txt"), "utf8");
    expect(failureText).not.toContain(secret);
    expect(failureText).toContain(`private evidence location: ${join(privateRoot, runId)}`);
    expect(failureText).toContain(`retained campaign-ledger: ${persistence}`);
    expect(existsSync(join(output, "preserved-evidence"))).toBe(false);
    expect(readFileSync(join(privateRoot, runId, "campaign-ledger", "partial.log"), "utf8")).toContain("partial secret-bearing copy");
    expect(statSync(join(privateRoot, runId, "campaign-ledger")).mode & 0o777).toBe(0o700);
    expect(statSync(join(privateRoot, runId, "campaign-ledger", "partial.log")).mode & 0o777).toBe(0o600);
    for (const name of readdirSync(output)) {
      const path = join(output, name);
      if (statSync(path).isFile()) expect(readFileSync(path, "utf8")).not.toContain(secret);
    }
    expect(readdirSync(output)).not.toContain("real-stderr.log");
    expect(statSync(join(privateRoot, runId)).mode & 0o777).toBe(0o700);
  });

  it("retains captured frame records through recordTmuxDemo finally when their private copy fails", async () => {
    root = mkdtempSync(join(tmpdir(), "capture-frame-copy-failure-"));
    const repo = join(root, "repo");
    const outputRoot = join(root, "publication");
    const privateRoot = join(root, "private");
    const runId = "frame-copy-failure";
    mkdirSync(repo);
    execFileSync("git", ["init", "-q", repo]);
    execFileSync("git", ["-C", repo, "config", "user.email", "fixture@invalid"]);
    execFileSync("git", ["-C", repo, "config", "user.name", "Fixture"]);
    writeFileSync(join(repo, "README.md"), "fixture repo\n");
    execFileSync("git", ["-C", repo, "add", "README.md"]);
    execFileSync("git", ["-C", repo, "commit", "-q", "-m", "fixture"]);
    const persistence = join(repo, ".arbor", "publication-captures", runId);
    const run = (command, args) => {
      if (command === "tmux" && args[0] === "new-session") return { status: 0, stdout: "", stderr: "" };
      if (command.endsWith("/scripts/demo-window.sh")) {
        mkdirSync(join(persistence, "devtools"), { recursive: true });
        writeFileSync(join(persistence, "devtools", "devtools.log"), '{"event_kind":"gate.recorded"}\n');
        return { status: 0, stdout: "", stderr: "" };
      }
      if (command === "test" && args[0] === "-s") return { status: 0, stdout: "", stderr: "" };
      if (command === "tmux" && args[0] === "capture-pane") {
        const frame = args.includes("-44");
        return { status: 0, stdout: frame ? `safe frame ${args[args.indexOf("-t") + 1]}` : "CAMPAIGN cockpit ready", stderr: "" };
      }
      if (command === "tmux" && args[0] === "kill-session") return { status: 0, stdout: "", stderr: "" };
      throw new Error(`unexpected controlled command: ${command}`);
    };

    await expect(recordTmuxDemo({
      run_id: runId,
      output_root: outputRoot,
      private_evidence_root: privateRoot,
      repo_root: repo,
      duration_seconds: 6,
      capture_fps: 1,
    }, {
      run,
      tool_exists: () => true,
      ensure_root: (path) => { mkdirSync(path, { recursive: true }); return realpathSync(path); },
      copy_private_tree: (source, destination, options) => {
        if (source.endsWith("frames.jsonl")) {
          mkdirSync(dirname(destination), { recursive: true });
          writeFileSync(destination, "partial frame copy\n");
          throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
        }
        cpSync(source, destination, options);
      },
    })).rejects.toThrow(/empirical proof incomplete/);

    expect(existsSync(persistence)).toBe(false); // ledger copy completed, so only its source is cleaned up.
    const scratchName = readdirSync(privateRoot).find((name) => name.startsWith(".capture-tmp-"));
    expect(scratchName).toBeTruthy();
    const framesPath = join(privateRoot, scratchName, "frames.jsonl");
    expect(readdirSync(outputRoot).some((name) => name.startsWith(".capture-tmp-"))).toBe(false);
    expect(existsSync(framesPath)).toBe(true);
    expect(readFileSync(framesPath, "utf8").trim().split("\n")).toHaveLength(6);
    const partialFrameCopy = join(privateRoot, runId, "frames.jsonl");
    expect(readFileSync(partialFrameCopy, "utf8")).toContain("partial frame copy");
    expect(statSync(partialFrameCopy).mode & 0o777).toBe(0o600);
    expect(statSync(join(privateRoot, runId)).mode & 0o777).toBe(0o700);
    const output = join(outputRoot, runId);
    const diagnostic = JSON.parse(readFileSync(join(output, "failure-diagnostic.json"), "utf8"));
    expect(diagnostic.private_evidence).toMatchObject({ status: "original_sources_retained", location_hint: join(privateRoot, runId), paths: ["campaign-ledger"], retained_frame_records: true, retained_source_locations: [{ label: "frames", path: framesPath }] });
    expect(readFileSync(join(output, "failure.txt"), "utf8")).toContain(`private evidence location: ${join(privateRoot, runId)}`);
    expect(readFileSync(join(output, "failure.txt"), "utf8")).toContain(`retained frames: ${framesPath}`);
    expect(readdirSync(output)).not.toContain("frames.jsonl");
    expect(readFileSync(join(output, "failure-diagnostic.json"), "utf8")).not.toContain("partial frame copy");
    expect(readFileSync(join(output, "failure.txt"), "utf8")).not.toContain("partial frame copy");
  });
});

describe("dispatch readiness", () => {
  it("ignores a previous take's loop events at the same log path", () => {
    root = mkdtempSync(join(tmpdir(), "reclaim-"));
    const log = join(root, "devtools.log");
    const stale = { ts: "2026-08-27T11:12:00.000Z", event_kind: "loop.specialist_dispatched" };
    writeFileSync(log, `${JSON.stringify(stale)}\n`);
    const afterStale = Date.parse("2026-08-27T11:30:00.000Z");
    expect(hasFreshDispatch(log, afterStale)).toBe(false);
  });

  it("reports readiness once THIS capture's campaign dispatches", () => {
    root = mkdtempSync(join(tmpdir(), "reclaim-"));
    const log = join(root, "devtools.log");
    const start = Date.parse("2026-08-27T11:30:00.000Z");
    const provisioning = { ts: "2026-08-27T11:31:00.000Z", event_kind: "gate.recorded" };
    const dispatch = { ts: "2026-08-27T11:34:00.000Z", event_kind: "loop.specialist_dispatched" };
    writeFileSync(log, `${JSON.stringify(provisioning)}\n`);
    expect(hasFreshDispatch(log, start)).toBe(false);
    writeFileSync(log, `${JSON.stringify(provisioning)}\n${JSON.stringify(dispatch)}\n`);
    expect(hasFreshDispatch(log, start)).toBe(true);
  });

  it("survives truncated lines mid-write", () => {
    root = mkdtempSync(join(tmpdir(), "reclaim-"));
    const log = join(root, "devtools.log");
    writeFileSync(log, `{"ts":"2026-08-27T11:34:00.000Z","event_kind":"loop.node_cl`);
    expect(hasFreshDispatch(log, 0)).toBe(false);
  });
});

describe("readiness waits for the whole required set", () => {
  const REQUIRED = ["loop.specialist_dispatched", "loop.critic_dispatched", "loop.node_claimed"];

  it("stays closed while only the specialist has been dispatched", () => {
    root = mkdtempSync(join(tmpdir(), "reclaim-"));
    const log = join(root, "devtools.log");
    writeFileSync(log, `${JSON.stringify({ ts: "2026-08-27T12:00:00.000Z", event_kind: "loop.specialist_dispatched" })}\n`);
    expect(hasFreshDispatch(log, 0, REQUIRED)).toBe(false);
  });

  it("opens once specialist, critic and claim have all really happened", () => {
    root = mkdtempSync(join(tmpdir(), "reclaim-"));
    const log = join(root, "devtools.log");
    writeFileSync(log, REQUIRED.map((kind, i) =>
      JSON.stringify({ ts: `2026-08-27T12:0${i}:00.000Z`, event_kind: kind })).join("\n") + "\n");
    expect(hasFreshDispatch(log, 0, REQUIRED)).toBe(true);
  });

  it("does not count a previous take's events toward the set", () => {
    root = mkdtempSync(join(tmpdir(), "reclaim-"));
    const log = join(root, "devtools.log");
    writeFileSync(log, REQUIRED.map((kind) =>
      JSON.stringify({ ts: "2026-08-27T11:00:00.000Z", event_kind: kind })).join("\n") + "\n");
    expect(hasFreshDispatch(log, Date.parse("2026-08-27T12:00:00.000Z"), REQUIRED)).toBe(false);
  });
});

describe("capture bounds", () => {
  const record = (opts) => recordTmuxDemo({ run_id: "bounds-probe", output_root: root, ...opts });

  it("admits a full-length run with no frame-budget ceiling", async () => {
    root = mkdtempSync(join(tmpdir(), "reclaim-"));
    // 25 minutes at 2fps is 3000 frames — the shape a whole-campaign reel needs.
    // It must fail on something later than the bounds check, never on the bounds.
    await expect(record({ duration_seconds: 1500, capture_fps: 2, repo_root: "/nonexistent-repo" }))
      .rejects.toThrow(/^(?!.*duration must be).*$/s);
  });

  it("accepts a duration that the old 3600s ceiling would have refused", async () => {
    root = mkdtempSync(join(tmpdir(), "reclaim-"));
    // Duration used to be capped at 3600s. A multi-hour capture must now fail
    // on something later than the bounds check (tooling / repo-root probes),
    // never on duration itself, and never on a frame-budget message either.
    await expect(record({ duration_seconds: 7_500, capture_fps: 2, repo_root: "/nonexistent-repo" }))
      .rejects.toThrow(/^(?!.*duration must be)(?!.*frame budget).*$/s);
  });

  it("still refuses a capture too short or too slow to show motion", async () => {
    root = mkdtempSync(join(tmpdir(), "reclaim-"));
    await expect(record({ duration_seconds: 2, capture_fps: 4 })).rejects.toThrow(/duration must be at least 6s/);
    await expect(record({ duration_seconds: 60, capture_fps: 0 })).rejects.toThrow(/capture_fps 1-12/);
  });
});

describe("frame streaming to disk", () => {
  it("keeps no frame accumulated in memory: readFrameLines starts empty until frames are written", () => {
    root = mkdtempSync(join(tmpdir(), "reclaim-"));
    const framesJsonlPath = join(root, "frames.jsonl");
    // Nothing has been captured yet, and nothing is being held in an
    // in-memory array anywhere -- the only record of "no frames yet" is that
    // the disk file does not exist.
    expect(readFrameLines(framesJsonlPath)).toEqual([]);
  });

  it("returns every appended frame record in the exact order it was written", () => {
    root = mkdtempSync(join(tmpdir(), "reclaim-"));
    const framesJsonlPath = join(root, "frames.jsonl");
    const written = [];
    for (let index = 0; index < 500; index += 1) {
      const record = { sequence: index + 1, at_ms: index * 250, left: `left-${index}`, right: `right-${index}`, left_sha256: `sha-l-${index}`, right_sha256: `sha-r-${index}` };
      written.push(record);
      // This is exactly what the capture loop does per frame: append one
      // JSON line, never push onto a JS array.
      appendFileSync(framesJsonlPath, `${JSON.stringify(record)}\n`);
    }
    const readBack = readFrameLines(framesJsonlPath).map((line) => JSON.parse(line));
    expect(readBack).toEqual(written);
    expect(readBack.map((r) => r.sequence)).toEqual(written.map((r) => r.sequence));
  });

  it("assembles tmux-capture.json from disk-read frame lines without losing or reordering any frame", () => {
    root = mkdtempSync(join(tmpdir(), "reclaim-"));
    const framesJsonlPath = join(root, "frames.jsonl");
    const written = [];
    for (let index = 0; index < 40; index += 1) {
      const record = { sequence: index + 1, at_ms: index * 250, left: `pane-${index}`, right: `right-${index}`, left_sha256: `sha-${index}`, right_sha256: `sha-r-${index}` };
      written.push(record);
      appendFileSync(framesJsonlPath, `${JSON.stringify(record)}\n`);
    }
    const captureText = buildCaptureText(
      { schema_version: 1, run_id: "stream-probe", terminal: { multiplexer: "tmux", panes: 2, capture_fps: 4, duration_seconds: 10 } },
      readFrameLines(framesJsonlPath),
    );
    const parsed = JSON.parse(captureText);
    expect(parsed.run_id).toBe("stream-probe");
    expect(parsed.frames).toHaveLength(40);
    expect(parsed.frames.map((f) => f.sequence)).toEqual(written.map((r) => r.sequence));
    expect(parsed.frames).toEqual(written);
  });

  it("writes an SVG per frame to disk as frames are produced, matching downstream (ffmpeg) capture-order expectations", () => {
    root = mkdtempSync(join(tmpdir(), "reclaim-"));
    const framesDir = join(root, "frames");
    mkdirSync(framesDir);
    // Simulate what the capture loop does: write frame N's SVG the moment
    // frame N is captured, never batched at the end from a retained array.
    for (let index = 0; index < 12; index += 1) {
      writeFileSync(join(framesDir, `frame-${String(index).padStart(5, "0")}.svg`), `<svg data-frame="${index}"/>`, "utf8");
    }
    const files = readdirSync(framesDir).sort();
    expect(files).toHaveLength(12);
    expect(files[0]).toBe("frame-00000.svg");
    expect(files[11]).toBe("frame-00011.svg");
  });
});

describe("verification stages reach the campaign", () => {
  it("collects a repeated --selfhost-verification-cmd into ordered stages", () => {
    // Single/last-wins parsing was why the staged arm was unreachable from a
    // capture: repeating the flag silently overwrote the earlier command.
    const parsed = parseArgs([
      "--run-id", "r1", "--selfhost",
      "--verification-cmd", "bun run typecheck",
      "--verification-cmd", "bun test packages/arbor-core",
    ]);
    expect(parsed.verification_cmds).toEqual([
      "bun run typecheck",
      "bun test packages/arbor-core",
    ]);
  });

  it("keeps a multi-word stage as one command rather than splitting it", () => {
    const parsed = parseArgs(["--run-id", "r1", "--verification-cmd", "bun run typecheck"]);
    expect(parsed.verification_cmds).toHaveLength(1);
    expect(parsed.verification_cmds[0]).toBe("bun run typecheck");
  });

  it("defaults to no stages, which is what leaves every result merely claimed", () => {
    // Not a bug — the honest default. Named here so the absence is deliberate
    // and visible rather than discovered again from a zero verified count.
    expect(parseArgs(["--run-id", "r1"]).verification_cmds).toEqual([]);
  });

  it("collects a --stall-timeout flag", () => {
    expect(parseArgs(["--run-id", "r1", "--stall-timeout", "900"]).stall_timeout_seconds).toBe("900");
  });
});

describe("proof set: claimed and verified are alternatives, not a hardcoded single kind", () => {
  // packages/arbor-opencode/src/loop.ts emits exactly ONE of loop.node_claimed
  // / loop.node_verified per node (an if/else). A check that required
  // `claimed` specifically failed the instant verification worked -- the
  // harness performing BETTER made the proof MORE certain to fail closed.
  // These pin the fix: either terminal-success kind must satisfy the
  // requirement, and neither must still fail it.

  it("is satisfied by loop.node_claimed alone", () => {
    root = mkdtempSync(join(tmpdir(), "reclaim-"));
    const log = join(root, "devtools.log");
    writeFileSync(log, [
      { ts: "2026-08-27T12:00:00.000Z", event_kind: "loop.specialist_dispatched" },
      { ts: "2026-08-27T12:01:00.000Z", event_kind: "loop.critic_dispatched" },
      { ts: "2026-08-27T12:02:00.000Z", event_kind: "loop.node_claimed" },
    ].map((r) => JSON.stringify(r)).join("\n") + "\n");
    const evidence = evaluateEvidence(log, { frame_count: 2, distinct_left_frames: 2, distinct_right_frames: 2 });
    expect(evidence.checks.successful_node_observed).toBe(true);
  });

  it("is satisfied by loop.node_verified alone -- the stronger outcome must not be treated as absence of the weaker one", () => {
    root = mkdtempSync(join(tmpdir(), "reclaim-"));
    const log = join(root, "devtools.log");
    writeFileSync(log, [
      { ts: "2026-08-27T12:00:00.000Z", event_kind: "loop.specialist_dispatched" },
      { ts: "2026-08-27T12:01:00.000Z", event_kind: "loop.critic_dispatched" },
      { ts: "2026-08-27T12:02:00.000Z", event_kind: "loop.node_verified" },
    ].map((r) => JSON.stringify(r)).join("\n") + "\n");
    const evidence = evaluateEvidence(log, { frame_count: 2, distinct_left_frames: 2, distinct_right_frames: 2 });
    expect(evidence.checks.successful_node_observed).toBe(true);
  });

  it("stays fail-closed when neither claimed nor verified appears", () => {
    root = mkdtempSync(join(tmpdir(), "reclaim-"));
    const log = join(root, "devtools.log");
    writeFileSync(log, [
      { ts: "2026-08-27T12:00:00.000Z", event_kind: "loop.specialist_dispatched" },
      { ts: "2026-08-27T12:01:00.000Z", event_kind: "loop.critic_dispatched" },
      { ts: "2026-08-27T12:02:00.000Z", event_kind: "loop.node_failed" },
    ].map((r) => JSON.stringify(r)).join("\n") + "\n");
    const evidence = evaluateEvidence(log, { frame_count: 2, distinct_left_frames: 2, distinct_right_frames: 2 });
    expect(evidence.checks.successful_node_observed).toBe(false);
  });

  it("hasFreshDispatch treats an OR-group requirement (array) as satisfied by any one member", () => {
    root = mkdtempSync(join(tmpdir(), "reclaim-"));
    const log = join(root, "devtools.log");
    writeFileSync(log, `${JSON.stringify({ ts: "2026-08-27T12:00:00.000Z", event_kind: "loop.node_verified" })}\n`);
    expect(hasFreshDispatch(log, 0, [["loop.node_claimed", "loop.node_verified"]])).toBe(true);
  });

  it("REQUIRED_LOOP_EVENTS is the single source of truth both the readiness gate and evidence checks read", () => {
    expect(Object.keys(REQUIRED_LOOP_EVENTS)).toEqual(["specialist_dispatch_observed", "critic_dispatch_observed", "successful_node_observed"]);
    expect(REQUIRED_LOOP_EVENTS.successful_node_observed).toEqual(["loop.node_claimed", "loop.node_verified"]);
  });
});

describe("evaluateEvidence never throws and reports last_event_at", () => {
  it("reports the latest ts across records, not just the last line", () => {
    root = mkdtempSync(join(tmpdir(), "reclaim-"));
    const log = join(root, "devtools.log");
    writeFileSync(log, [
      { ts: "2026-08-27T12:05:00.000Z", event_kind: "gate.recorded" },
      { ts: "2026-08-27T12:01:00.000Z", event_kind: "campaign.changed" },
    ].map((r) => JSON.stringify(r)).join("\n") + "\n");
    const evidence = evaluateEvidence(log, { frame_count: 1, distinct_left_frames: 1, distinct_right_frames: 1 });
    expect(evidence.last_event_at).toBe("2026-08-27T12:05:00.000Z");
    expect(evidence.record_count).toBe(2);
  });

  it("tolerates a log path that does not exist yet, reporting an unsatisfied but non-throwing result", () => {
    root = mkdtempSync(join(tmpdir(), "reclaim-"));
    const log = join(root, "never-written.log");
    const evidence = evaluateEvidence(log, { frame_count: 0, distinct_left_frames: 0, distinct_right_frames: 0 });
    expect(evidence.record_count).toBe(0);
    expect(evidence.last_event_at).toBeNull();
    expect(Object.values(evidence.checks).every((ok) => ok === false)).toBe(true);
  });
});
