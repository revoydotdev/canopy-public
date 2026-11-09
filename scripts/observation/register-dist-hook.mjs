/**
 * scripts/observation/register-dist-hook.mjs — preload entry that installs
 * dist-resolve-hook.mjs via Node's module customization hooks API.
 *
 * Scenarios inject this with `NODE_OPTIONS=--import=<absolute path to this
 * file>` (see scripts/observation/scenarios.json). `--import` runs before
 * the target script and is one of the flags NODE_OPTIONS is permitted to
 * carry, so no CLI-argv change to the scenario's declared entry point is
 * needed — argv[1] stays the real `packages/*\/dist/**.js` entry.
 */

import { register } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "dist-resolve-hook.mjs")).href, import.meta.url);
