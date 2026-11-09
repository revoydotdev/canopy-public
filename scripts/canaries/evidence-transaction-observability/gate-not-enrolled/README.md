# Fixture: `gate:evidence-transaction-observability` must be able to fail.

The gate has three legs. This fixture fails exactly one of them, on purpose:

- `fixtures` runs the real isolated transaction suite and needs the repository's
  own `scripts/` and `node_modules` visible, which the profile supplies via
  `link_repo_paths`. It passes, and that is what makes the census honest about
  which leg failed.
- `shape` builds its own throwaway git repository and does not read this root.
  It passes.
- `enrollment` reads `package.json` at the gate's repository root and requires a
  `gate:evidence-transaction-observability` script entry pointing at
  `scripts/evidence-transaction-observability-gate.mjs`. This `package.json`
  has no such entry, so this leg is the one that fails.

Without the `--repo` seam the gate would read the REAL package.json, find the
entry, and pass its own canary — a green that measured nothing.
