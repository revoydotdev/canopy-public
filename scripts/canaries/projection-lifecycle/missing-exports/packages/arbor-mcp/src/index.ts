// Canary fixture: a public barrel that does not re-export the projection
// lifecycle envelope. `checkExports` reads this file and reports every required
// name it cannot find here.
export { someOtherThing } from "./runtime.js";
