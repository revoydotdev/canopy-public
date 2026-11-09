#!/usr/bin/env node
// Canary stand-in for the 6.2 reachability gate, which docs-truth.mjs spawns
// as a child and whose JSON `checklist` is the authority on symbol existence
// and reachability. This fixture's failure is decided before any symbol is
// looked up, so an EMPTY checklist is the honest answer here: there are no
// symbols in this fixture to be reachable or not.
process.stdout.write(JSON.stringify({ checklist: [] }) + "\n");
