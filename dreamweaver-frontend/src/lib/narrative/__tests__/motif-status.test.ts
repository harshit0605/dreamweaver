/**
 * M9.5 L1 — motif display-status derivation unit tests.
 *
 * Pinned behaviors:
 *   * Both arrays present → "landed"
 *   * Sources only → "planted" (needs payoff)
 *   * Payoffs only → "orphaned" (needs setup)
 *   * Neither → "unplanted"
 *   * Sort order: landed < planted < orphaned < unplanted
 *
 * This logic mirrors `detect_motif_gaps` on the Python agent side; if
 * one of these tests breaks because of a UI tweak, the matching Python
 * test in `test_narrative_tools.py::DetectMotifGapsTests` should
 * break too.
 */

import { describe, expect, test } from "bun:test";

import {
  deriveDisplayStatus,
  MOTIF_DISPLAY_ORDER,
} from "../motif-status";

describe("deriveDisplayStatus", () => {
  test("returns 'landed' when both source + payoff are present", () => {
    const status = deriveDisplayStatus({
      sourceNodeIds: ["n3"],
      payoffNodeIds: ["n18"],
    });
    expect(status).toBe("landed");
  });

  test("returns 'planted' when only source is present", () => {
    const status = deriveDisplayStatus({
      sourceNodeIds: ["n3"],
      payoffNodeIds: [],
    });
    expect(status).toBe("planted");
  });

  test("returns 'orphaned' when only payoff is present", () => {
    const status = deriveDisplayStatus({
      sourceNodeIds: [],
      payoffNodeIds: ["n18"],
    });
    expect(status).toBe("orphaned");
  });

  test("returns 'unplanted' when both arrays are empty", () => {
    const status = deriveDisplayStatus({
      sourceNodeIds: [],
      payoffNodeIds: [],
    });
    expect(status).toBe("unplanted");
  });

  test("multiple sources + multiple payoffs still classifies as landed", () => {
    const status = deriveDisplayStatus({
      sourceNodeIds: ["n3", "n5", "n7"],
      payoffNodeIds: ["n18", "n22"],
    });
    expect(status).toBe("landed");
  });
});

describe("MOTIF_DISPLAY_ORDER", () => {
  test("orders landed first, unplanted last", () => {
    expect(MOTIF_DISPLAY_ORDER.landed).toBeLessThan(MOTIF_DISPLAY_ORDER.planted);
    expect(MOTIF_DISPLAY_ORDER.planted).toBeLessThan(
      MOTIF_DISPLAY_ORDER.orphaned,
    );
    expect(MOTIF_DISPLAY_ORDER.orphaned).toBeLessThan(
      MOTIF_DISPLAY_ORDER.unplanted,
    );
  });

  test("covers every status produced by deriveDisplayStatus", () => {
    // Defensive: if a new status enum value gets added, this test
    // surfaces it before the panel sort silently drops the new
    // bucket to last via the `?? 9` fallback.
    const cases: Array<Parameters<typeof deriveDisplayStatus>[0]> = [
      { sourceNodeIds: [], payoffNodeIds: [] },
      { sourceNodeIds: ["n1"], payoffNodeIds: [] },
      { sourceNodeIds: [], payoffNodeIds: ["n1"] },
      { sourceNodeIds: ["n1"], payoffNodeIds: ["n2"] },
    ];
    for (const c of cases) {
      const status = deriveDisplayStatus(c);
      expect(MOTIF_DISPLAY_ORDER).toHaveProperty(status);
    }
  });

  test("sorting an array yields the expected status sequence", () => {
    // Producers see SUCCESSES first (landed) then PROGRESSIVE GAPS
    // (planted needs payoff → orphaned needs setup → unplanted bare).
    const items = [
      { sourceNodeIds: [], payoffNodeIds: [] }, // unplanted
      { sourceNodeIds: ["a"], payoffNodeIds: ["b"] }, // landed
      { sourceNodeIds: [], payoffNodeIds: ["c"] }, // orphaned
      { sourceNodeIds: ["d"], payoffNodeIds: [] }, // planted
    ];
    const sorted = [...items].sort(
      (a, b) =>
        MOTIF_DISPLAY_ORDER[deriveDisplayStatus(a)]
        - MOTIF_DISPLAY_ORDER[deriveDisplayStatus(b)],
    );
    expect(sorted.map(deriveDisplayStatus)).toEqual([
      "landed",
      "planted",
      "orphaned",
      "unplanted",
    ]);
  });
});
