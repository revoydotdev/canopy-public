/**
 * Re-export of the ONE persistence-root guard, which now lives in `@arbor/core`
 * so that `@arbor/campaign-support` (`worktree.ts`, which builds campaign-data
 * paths) can reach it too. It could not stay here: `arbor-mcp` depends on
 * `arbor-opencode`, which depends on `arbor-campaign-support`, so importing it
 * downward would be a cycle — the same reason it was split out of `cli.ts` in
 * the first place. A second copy of the containment check is a second
 * containment mechanism, which is how the two drift apart.
 *
 * This module stays so the existing importers (`cli.ts`, `setup.ts`,
 * `project-env.ts`) keep their import path and `cli.ts` keeps re-exporting the
 * symbol that `scheduler-command.ts` injects by dynamic import.
 */
export { resolvePersistenceDir } from "@arbor/core";
