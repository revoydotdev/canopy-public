# Operator UX and self-build readiness

**Audit date:** 2026-08-13
**Target:** launch `arbor` from `PATH`, drive the native cockpit, submit a real
repository task, supervise it, inspect the result, and adopt verified changes.

The pass is informed by the first-party comparison in
[`research/ux-setup-integration-exemplars-2026-08-13.md`](research/ux-setup-integration-exemplars-2026-08-13.md).

## Supported self-build path

```bash
bun install --frozen-lockfile
bun run build
bun run dev:install

cd /path/to/revoy2
arbor setup
arbor doctor
arbor tui
```

In the cockpit, `?` opens the searchable command palette, `Ctrl+N` opens a
governed task form, `Ctrl+T` focuses its draft list, `Enter` opens the selected
draft dossier, and `Ctrl+Y` confirms a proposed draft. The equivalent scriptable
path is:

```bash
arbor task "Implement a bounded, verifiable improvement to this repository"
arbor task show <draft-id>
arbor task confirm <draft-id> <revision> --wait
arbor report --campaign <campaign-id>
arbor adopt --campaign <campaign-id>
arbor adopt --campaign <campaign-id> --apply
```

Confirmation is the authority transition. Adoption previews by default and
modifies the invoking checkout only with `--apply`; the operator still reviews
and commits the result.

## Blocker audit

| Blocker | Effect | Disposition |
|---|---|---|
| No stable command on `PATH` | Every workflow required a repository-relative Node invocation | Remediated: `bun run dev:install` installs `arbor` and `arbor-mcp` links to this checkout and refuses to overwrite a foreign command. |
| Launcher bundled TypeScript on every invocation through undeclared transitive `esbuild` | Slow, fragile startup; dependency could disappear | Remediated: the Bun launcher imports the workspace source directly. |
| Launcher/runtime mismatch | Node invocation forced the native OpenTUI renderer to fall back; invoking the old launcher with Bun hung | Remediated: the installed shebang is Bun and an interactive terminal defaults to OpenTUI. `--renderer stdout` remains available for streams/debugging. |
| Standard terminal control bytes were never normalized | Documented `Ctrl+N`, `Ctrl+T`, `Ctrl+Y`, and other cockpit commands did nothing | Remediated and covered by byte-level tests. |
| Failed task detail repeated the clipped one-row table | The actual planner failure was unreadable at ordinary terminal widths | Remediated: `Enter` renders a bounded vertical draft dossier with the full planner diagnostic. |
| Root help wrote successful output to stderr and buried the task lifecycle | Shell composition and first-run discovery were poor | Remediated: conventional stdout help, `--version`, task-first command groups, and the short `arbor` name. |
| Local pricing record failed schema validation | Every TUI launch emitted a warning before rendering | Remediated locally from the provider's 2026-08-13 model record; absent cache-write pricing is conservatively costed at the normal input rate, never zero. |
| Production runner constructed OpenCode fallback components directly | Upstream harness looked like product authority and could not be removed cleanly | Remediated at the runner boundary by ADR-061: executable implementations are capability-bound integration plugins. OpenCode and Claude Code now enter through that boundary; package extraction remains below. |
| `arbor selfhost` refuses a primary `master` checkout | Its historical direct-OpenCode Track B command cannot be the everyday self-build entry | Superseded for operator UX by the native task-composer/campaign/adopt path. Keep the refusal until that legacy command is retired or redesigned; do not weaken its isolation gate to improve convenience. |

## Remaining external prerequisite

The current ignored `arbor.jsonc` explicitly selects the native OpenRouter
adapter. `arbor doctor` reports `credential_absent` until the ignored `.env`
contains either `OPENROUTER_API_KEY` or the provider-independent
`ARBOR_NATIVE_API_KEY`. Revoy records the selected variable name and presence
only and never prints the value. This cannot be repaired in source code or
copied from another harness's credential store without violating the
opaque-lease boundary.

```bash
cp .env.example .env  # already done in this development checkout
# edit OPENROUTER_API_KEY in .env
arbor doctor
```

The doctor must then report direct-native execution available before a real
task is submitted. Provider reachability and account budget remain external
runtime conditions; the offline `arbor run --once --executor deterministic`
lane is available for a no-cost composition smoke test but intentionally cannot
produce `!verified` model work.

## OpenCode deprecation migration

ADR-061 starts, but does not overstate, the migration. The generic production
runner now selects an opaque implementation paired with an admitted connector
descriptor. OpenCode is one transitional registered integration and no longer a
hidden runner fallback. As of ADR-192 (2026-10-07) Canopy (native) is the only
default harness and the opencode, claude-code and codex connectors are refused
unless `arbor.jsonc` sets `connectors.allow_deprecated: true` with a
`connectors.reason`; they are deprecated until after 1.0.0.
`ARBOR_HARNESS_INTEGRATION=claude-code` (after that opt-in) selects a real
subprocess integration that uses Claude Code's existing OAuth session without
reading its credential store. Remaining work is structural:

1. move Revoy-owned loop, worktree, critic, routing, and token contracts out of
   the mixed `@arbor/opencode` package;
2. package the OpenCode subprocess/provider code as an installable integration;
3. convert legacy `demo`, recovery fallback, provider-capability probe, and
   `selfhost` call sites to injected integrations;
4. remove `@arbor/opencode` from `@arbor/mcp` dependencies and TypeScript
   references; prove the native CLI/TUI/test lane with that package absent.

Until step 4 passes, the repository must describe OpenCode as a deprecated
transitional dependency—not as already optional.

**Two corrections to that list, measured against source on 2026-08-18** (see
`docs/proposals/opencode-deprecation-migration.md` for the full assessment):

- **Step 1 is not a clean lift.** `packages/arbor-mcp/src/runtime-catalog.ts:110`
  — the *native*, non-OpenCode runtime router — imports
  `deriveCandidateNodeCard`, `deriveDispatchForeground`, `DEFAULT_NODE_CARD_SECRET`
  and `CAPABILITY_TIER` from `@arbor/opencode`. The 11-agent/5-category taxonomy
  is shared with native dispatch, so it cannot move wholesale into an
  OpenCode-specific package. Step 1 has to split the taxonomy data from the
  OpenCode-shaped builders around it, which is a design step, not a move.
- **Step 2 names the wrong location.** The subprocess and provider code it asks
  to package out of `@arbor/opencode` already lives in `@arbor/mcp/src`
  (`opencode-executor.ts`, `opencode-server-executor.ts`,
  `opencode-decomposer.ts`). It is already registry-assembled via
  `integrations/opencode-campaign.ts`; what remains is packaging it separately,
  not extracting it from `@arbor/opencode`.

Of roughly 6,968 lines in `@arbor/opencode`, about 5,276 are generic with no
OpenCode SDK coupling and about 1,011 are genuinely OpenCode-shaped — so the
package is mostly Revoy-owned code wearing an integration's name, which is what
makes step 4 a dependency-graph problem rather than an SDK problem.
`@opencode-ai/plugin` is already an uninstalled optional peer dependency, and
the package type-checks and tests without it.
