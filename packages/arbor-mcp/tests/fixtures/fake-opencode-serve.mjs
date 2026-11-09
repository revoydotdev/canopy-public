#!/usr/bin/env node
/**
 * Fake long-running `opencode serve` for hermetic tests of
 * opencode-server-executor.ts's server *lifecycle* (spawn / close). Unlike
 * fixtures/fake-opencode.mjs (which exits immediately — a test double for the
 * one-shot `opencode run` subprocess executor), this one mimics what a real
 * `opencode serve` actually does: report "listening" and then stay alive
 * indefinitely, exiting only when told to (SIGTERM).
 *
 * That "stays alive until killed" property is exactly the seam the
 * 2026-08-08 `--transport server` hang lived in: `spawnServer()` in
 * opencode-server-executor.ts resolves as soon as it sees the "listening"
 * line, then never touches the child again unless something calls
 * `ServerHandle.close()`. This fixture makes that observable from a test
 * without spawning a real `opencode` binary:
 *   - FAKE_SERVE_PIDFILE (required): written with this process's pid at
 *     startup, so the test can poll `process.kill(pid, 0)` to confirm the
 *     child is alive.
 *   - On SIGTERM, writes `${FAKE_SERVE_PIDFILE}.killed` before exiting, so
 *     the test can also confirm a real termination signal was actually
 *     delivered and handled, not just that the pidfile-liveness poll timed
 *     a race.
 */
import { writeFileSync } from "node:fs";

const pidfile = process.env.FAKE_SERVE_PIDFILE;
if (!pidfile) {
  process.stderr.write("FAKE_SERVE_PIDFILE not set\n");
  process.exit(1);
}
writeFileSync(pidfile, String(process.pid));

process.on("SIGTERM", () => {
  writeFileSync(`${pidfile}.killed`, "1");
  process.exit(0);
});

process.stdout.write("opencode server listening on http://127.0.0.1:0\n");
// Stay alive until killed — mirrors a real server process, which only exits
// when told to, not when its stdout stops producing output.
setInterval(() => {}, 1_000_000);
