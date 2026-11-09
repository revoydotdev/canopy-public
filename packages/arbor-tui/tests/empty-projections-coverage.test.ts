import { describe, expect, it } from "vitest";
import { capabilitiesScreen } from "../src/screens/capabilities.js";
import { compactionScreen } from "../src/screens/compaction.js";
import { overlaysScreen } from "../src/screens/overlays.js";
import { recoveryScreen } from "../src/screens/recovery.js";
import { siblingsScreen } from "../src/screens/siblings.js";
import { surveillanceScreen } from "../src/screens/surveillance.js";
import { threadsScreen } from "../src/screens/threads.js";

describe("operational screen empty projections", () => {
  it("keeps a null query result explicit rather than rendering a blank surface", () => {
    const context = { width: 80, height: 8 };
    for (const screen of [capabilitiesScreen, compactionScreen, overlaysScreen, recoveryScreen, siblingsScreen, surveillanceScreen, threadsScreen]) {
      const projection = screen.project(null, context);
      expect(projection.variant).toBe("empty");
      expect(projection.rows).toEqual([]);
      expect(projection.caption).toEqual(expect.any(String));
    }
  });
});
