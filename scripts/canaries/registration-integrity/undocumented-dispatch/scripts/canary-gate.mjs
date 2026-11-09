#!/usr/bin/env node
// Canary fixture script. It carries the word "gate" in a header doc-comment
// and IS referenced from package.json, so check 5 (orphaned scripts) is
// satisfied for it. Its presence also gives check 5 a non-empty script list to
// walk; without it that check would report nothing at all.
export const CANARY = true;
