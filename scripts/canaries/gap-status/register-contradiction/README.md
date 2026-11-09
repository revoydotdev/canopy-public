# canary: gate:gap-status — the corpus contradicts the register

Every verdict here is `checkGapStatusConsistency`'s own return value. The gate
script's `main` is a reporting wrapper over that function and over
`parseGapRegister` / `deriveGapStatusScanDocuments`, with a root hardcoded to
this checkout; `run.mjs` reproduces only the wrapper and takes the root as an
argument. `@arbor/governance` resolves out of the real checkout because
`guard-canaries.mjs` spawns with `cwd` set to it.

The fixture is the G-36 shape the module's own header names: the register row
says `OPEN`, and a scanned document says the gap is closed. Nothing here is
about the register row being wrong — the module is explicit that it only
proves the corpus does not contradict itself, and it does not claim more.
