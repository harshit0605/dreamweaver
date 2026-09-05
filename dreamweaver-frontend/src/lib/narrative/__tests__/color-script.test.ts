/**
 * M9.5 L1 — color-script derivation unit tests.
 *
 * Pinned behaviors:
 *   * Keyword table picks the FIRST matching tone (order-sensitive).
 *   * Unsampled cells (tensionLevel undefined) get the muted defaults.
 *   * Tension < 6 leaves hue unchanged; tension >= 6 redshifts toward 0.
 *   * Saturation rises linearly with tension; lightness falls.
 *   * Hue redshift wraps correctly for hues > 180 (short-arc to red).
 */

import { describe, expect, test } from "bun:test";

import {
  applyTensionRedshift,
  deriveColorCell,
  TONE_KEYWORDS,
} from "../color-script";

describe("TONE_KEYWORDS table", () => {
  test("orders specific keywords before broad ones", () => {
    // 'fire' appears in TONE_KEYWORDS at index 0 because it's
    // semantically loaded; 'overcast' (rain/grey) is last because
    // it's a fallback for grey-toned shots that don't match anything
    // narrower. If this ordering ever flips by accident the
    // derivation drifts.
    expect(TONE_KEYWORDS[0].label).toBe("fire");
    expect(TONE_KEYWORDS[TONE_KEYWORDS.length - 1].label).toBe("overcast");
  });

  test("every entry has a non-empty label and a valid hue 0-360", () => {
    for (const entry of TONE_KEYWORDS) {
      expect(entry.label.length).toBeGreaterThan(0);
      expect(entry.hue).toBeGreaterThanOrEqual(0);
      expect(entry.hue).toBeLessThanOrEqual(360);
    }
  });
});

describe("deriveColorCell — keyword matching", () => {
  test("matches 'fire' on 'flame' (verb stem)", () => {
    const cell = deriveColorCell({
      nodeId: "n1",
      segment: "Embers fall as the flame consumes the timber.",
    });
    expect(cell.tone).toBe("fire");
    expect(cell.hue).toBe(18);
  });

  test("first match wins — 'fire' takes priority over 'night'", () => {
    // A segment that mentions both fire and night should land on
    // fire because it appears first in the table (more semantically
    // loaded for cinematography).
    const cell = deriveColorCell({
      nodeId: "n1",
      segment: "Night closes in around the flickering fire.",
    });
    expect(cell.tone).toBe("fire");
  });

  test("falls back to neutral overcast when nothing matches", () => {
    const cell = deriveColorCell({
      nodeId: "n1",
      segment: "Two characters discuss a contract.",
    });
    expect(cell.tone).toBe("neutral");
    expect(cell.hue).toBe(210);
  });

  test("empty segment falls back to neutral", () => {
    const cell = deriveColorCell({ nodeId: "n1", segment: "" });
    expect(cell.tone).toBe("neutral");
  });

  test("null segment falls back to neutral", () => {
    const cell = deriveColorCell({ nodeId: "n1", segment: null });
    expect(cell.tone).toBe("neutral");
  });
});

describe("deriveColorCell — tension axis", () => {
  test("unsampled cell stays muted at saturation 18 / lightness 55", () => {
    const cell = deriveColorCell({
      nodeId: "n1",
      segment: "Calm sea at dawn.",
      tensionLevel: null,
    });
    expect(cell.saturation).toBe(18);
    expect(cell.lightness).toBe(55);
    expect(cell.tension).toBeNull();
  });

  test("tension 0 sets saturation to 28 and lightness to 55", () => {
    const cell = deriveColorCell({
      nodeId: "n1",
      segment: "Calm sea at dawn.",
      tensionLevel: 0,
    });
    expect(cell.saturation).toBe(28);
    expect(cell.lightness).toBe(55);
  });

  test("tension 10 saturates fully and dims lightness to 40", () => {
    const cell = deriveColorCell({
      nodeId: "n1",
      segment: "Hostile chase through alley.",
      tensionLevel: 10,
    });
    expect(cell.saturation).toBe(70);
    expect(cell.lightness).toBe(40);
  });

  test("tension above 10 clamps to 10", () => {
    const cell = deriveColorCell({
      nodeId: "n1",
      segment: "x",
      tensionLevel: 99,
    });
    expect(cell.tension).toBe(10);
  });

  test("tension below 0 clamps to 0", () => {
    const cell = deriveColorCell({
      nodeId: "n1",
      segment: "x",
      tensionLevel: -5,
    });
    expect(cell.tension).toBe(0);
  });
});

describe("applyTensionRedshift — hue interpolation", () => {
  test("tension 5 leaves hue unchanged", () => {
    expect(applyTensionRedshift(140, 5)).toBe(140); // verdant unchanged
  });

  test("tension 6 starts the redshift (no pull yet)", () => {
    // At tension 6 the redPull factor is 0 — hue stays at baseline.
    expect(applyTensionRedshift(140, 6)).toBe(140);
  });

  test("tension 10 pulls a forest-green hue (140) toward 0", () => {
    // redPull = 1 → hue = 140 * (1 - 1) = 0
    expect(applyTensionRedshift(140, 10)).toBe(0);
  });

  test("tension 8 partially redshifts", () => {
    // redPull = (8-6)/4 = 0.5 → hue = 140 * 0.5 = 70
    expect(applyTensionRedshift(140, 8)).toBe(70);
  });

  test("hue > 180 takes the short-arc through 360 boundary", () => {
    // Neon (285) → at tension 10, delta = 285-360 = -75; hue =
    // -75 * (1-1) = 0 (or -0 from JS multiplication semantics; both
    // are mathematically equivalent for HSL output).
    expect(applyTensionRedshift(285, 10)).toBeCloseTo(0);
  });

  test("hue > 180 partial redshift goes through negative space then wraps", () => {
    // Neon (285), tension 8 (redPull 0.5):
    //   delta = 285 - 360 = -75
    //   hue = -75 * 0.5 = -37.5
    //   wraps to -37.5 + 360 = 322.5
    expect(applyTensionRedshift(285, 8)).toBe(322.5);
  });

  test("null tension is a no-op", () => {
    expect(applyTensionRedshift(140, null)).toBe(140);
  });
});

describe("deriveColorCell — label fallback", () => {
  test("uses node label when present", () => {
    const cell = deriveColorCell({
      nodeId: "n1",
      segment: "x",
      label: "Opening",
    });
    expect(cell.label).toBe("Opening");
  });

  test("falls back to nodeId when label missing", () => {
    const cell = deriveColorCell({ nodeId: "n42", segment: "x" });
    expect(cell.label).toBe("n42");
  });

  test("treats null label as missing", () => {
    const cell = deriveColorCell({
      nodeId: "n42",
      segment: "x",
      label: null,
    });
    expect(cell.label).toBe("n42");
  });
});
