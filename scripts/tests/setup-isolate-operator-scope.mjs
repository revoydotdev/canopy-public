/**
 * vitest setupFiles entry — isolates the suite from the operator's own
 * user-scope configuration before any test runs.
 *
 * ROOT CAUSE (2026-09-03): ADR-110 gave `~/.arbor/arbor.jsonc` a real place in
 * the config chain (defaults -> organization -> user -> project), and the same
 * day `~/.config/revoy/revoy.env` became the user-scope credential file the
 * CLI loads after the project `.env`. Both resolve through `homedir()` /
 * `XDG_CONFIG_HOME`, and every test in this repository that says "with no
 * arbor.jsonc, every leaf is a default" or "with no key, doctor reports the
 * native credential absent" was true only because no developer had those
 * files yet. The first operator who configured a native provider for real
 * watched eleven unrelated tests go red: `env.test.ts`, `cli.test.ts`,
 * `doctor.test.ts`, `native-cli-production-e2e.test.ts`,
 * `repo-flight-director.test.ts`, `tui.test.ts` — each reading the operator's
 * OpenRouter block as if the fixture had authored it.
 *
 * A suite that is hermetic only while the machine is unconfigured is not
 * hermetic. This is the one central choke point, the same shape as
 * `setup-sanitize-git-env.mjs`: the loader's own override variables point
 * every scope at empty directories, so a test that wants the operator's
 * scope must construct it explicitly (and none should).
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const empty = mkdtempSync(join(tmpdir(), "arbor-test-operator-scope-"));
process.env.ARBOR_USER_CONFIG_DIR = join(empty, "user");
process.env.ARBOR_ORGANIZATION_CONFIG_DIR = join(empty, "organization");
// `loadUserEnvironment` resolves `$XDG_CONFIG_HOME/revoy/revoy.env` before
// `~/.config/revoy/revoy.env`; an empty XDG root means neither is read.
process.env.XDG_CONFIG_HOME = join(empty, "xdg");
for (const key of ["ARBOR_NATIVE_API_KEY", "OPENROUTER_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"]) {
  // A key in the ambient shell would make "credential absent" fixtures lie
  // the same way the file does.
  delete process.env[key];
}
