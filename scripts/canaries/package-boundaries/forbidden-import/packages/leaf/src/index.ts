// Canary fixture for `gate:package-boundaries`: a leaf package that imports a
// sibling workspace package its policy entry does not permit.

import { thing } from "@arbor/core";

export const carried = thing;
