import { spawnSync } from "node:child_process";

export function sanitizedGitEnv(env = process.env) {
  const clean = { ...env };
  for (const key of Object.keys(clean)) {
    if (key === "GIT_DIR" || key === "GIT_WORK_TREE" || key === "GIT_INDEX_FILE" || key === "GIT_COMMON_DIR" || key.startsWith("GIT_ALTERNATE_OBJECT_DIRECTORIES")) {
      delete clean[key];
    }
  }
  return clean;
}

export function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    env: sanitizedGitEnv(options.env),
    stdio: options.inherit ? "inherit" : ["ignore", "pipe", "pipe"],
  });
  const value = {
    ok: result.status === 0,
    status: result.status ?? 1,
    stdout: typeof result.stdout === "string" ? result.stdout.trimEnd() : "",
    stderr: typeof result.stderr === "string" ? result.stderr.trimEnd() : "",
  };
  if (!value.ok && !options.allowFailure) {
    const detail = value.stderr || value.stdout || `exit ${value.status}`;
    throw new Error(`${command} ${args.join(" ")} failed: ${detail}`);
  }
  return value;
}

export function git(repo, args, options = {}) {
  return run("git", args, { ...options, cwd: repo });
}

export function lines(value) {
  return value ? value.split("\n").filter(Boolean) : [];
}
