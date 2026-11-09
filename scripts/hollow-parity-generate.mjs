#!/usr/bin/env node
/**
 * Regenerates the tracked hollow-parity surface projection.  This is the
 * explicit writer counterpart to gate:hollow-parity; the gate itself only
 * derives the projection in memory and compares it with this file's output.
 */
import { writeFileSync } from "node:fs";
import { buildCatalogSurfacesArtifact, runItem3SurfaceScopedReachability } from "./hollow-parity.mjs";

const item3 = runItem3SurfaceScopedReachability();
const document = buildCatalogSurfacesArtifact(item3.catalog, item3.surfaces);
writeFileSync(item3.outputPath, `${JSON.stringify(document, null, 2)}\n`);
console.log(`wrote ${item3.outputPath}`);
