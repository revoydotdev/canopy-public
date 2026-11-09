// Canary fixture for `gate:anti-stub:blocking`.
//
// `stubbed()` is a stub in the exact shape Rule 3 looks for: the body does no
// work, and a TODO comment stands in for the behaviour it owes. Nothing
// triages it, so `--blocking` has an untriaged finding to fail on.

export function stubbed(): number {
  // TODO: implement the real behaviour
  return 1;
}
