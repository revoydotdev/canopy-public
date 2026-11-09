#!/usr/bin/env node
// Canary stub. The real `scripts/host-controls.mjs check` verifies the
// deployed host adapter manifest; this fixture is not about that, so the stub
// reports success. Its absence would fire a DIFFERENT problem
// ("host-control deployment has no source-owned check command") and the
// canary would then be proving the missing-file branch instead of the
// conformance branch it declares.
process.exit(0);
