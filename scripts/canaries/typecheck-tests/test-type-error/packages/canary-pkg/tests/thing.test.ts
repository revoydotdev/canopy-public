import { add } from "../src/thing";

// Canary fixture: a test that passes a string where the signature demands a
// number. `vitest` TRANSPILES and runs this, so the suite is green while the
// type is wrong — which is the entire reason gate:typecheck-tests exists.
export const wrong = add("1", 2);
