// Audit finding: `arbor review ...` builds its runtime via
// `(environment.runtime_factory ?? createCliRuntime)(environment.cwd, environment.persistence_dir)`
// — omitting the `runtimeOptions` (safeMode/env/onNotice) that every other
// runtime-constructing command in main() forwards. `--safe-mode` is a global
// flag stripped from `args` once, up front in `main()`, specifically so it
// applies uniformly to whichever command builds a runtime — `createCliRuntime`
// uses it to skip loading untrusted `.arbor/skills`, `.arbor/hooks`, and
// `.arbor/commands` content from disk (see cli.ts's `safeMode ? new
// SkillCatalog() : SkillCatalog.fromDirectory(...)`). Because `review` never
// forwards `runtimeOptions`, an operator's explicit `--safe-mode` on `arbor
// review ...` is silently ignored: the command still reads and loads
// project-supplied skills/hooks/commands from disk, exactly the untrusted
// content safe mode exists to keep out.
import { describe, expect, it, vi, afterEach } from "vitest";
import { PassThrough } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../src/cli.js";
import { SkillCatalog } from "../src/skills/catalog.js";

function makeEnv(cwd: string) {
  return {
    cwd,
    persistence_dir: undefined,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  };
}

describe("arbor review --safe-mode", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not load skills/hooks/commands from disk when --safe-mode is passed", async () => {
    const root = mkdtempSync(join(tmpdir(), "arbor-cli-review-safe-mode-"));
    const spy = vi.spyOn(SkillCatalog, "fromDirectory");
    try {
      await main(
        ["review", "inspect", "--campaign", "camp-1", "--node", "n1", "--safe-mode"],
        makeEnv(root),
      );
      // Safe mode must skip SkillCatalog.fromDirectory entirely (an empty
      // `new SkillCatalog()` is used instead) — exactly like every other
      // command that honors --safe-mode.
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
