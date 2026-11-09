// Canary fixture for `gate:reachability`. Not real code; it exists so the gate
// has a graph to walk and something it is supposed to reject.

export function reachableSymbol(): number {
  return 1;
}

reachableSymbol();
