// Canary fixture for `gate:reachability`: an exported, value-producing symbol
// that nothing in the fixture imports, so it is genuinely unreachable.

export function orphanedExport(): string {
  return "nobody calls me";
}
