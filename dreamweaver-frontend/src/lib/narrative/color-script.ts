/**
 * M9 Phase 5 — Color Script derivation helpers.
 *
 * Pure functions extracted from `ColorScriptStrip.tsx` so the hue +
 * saturation + lightness derivation can be unit-tested without
 * mounting a React tree. The component re-exports these and threads
 * them through `useMemo`; tests assert against the deterministic
 * outputs.
 *
 * The derivation has three knobs:
 *   1. A keyword table (`TONE_KEYWORDS`) maps segment text to a
 *      hue + tone label. First match wins.
 *   2. Tension >= 6 pulls the hue toward red (0°) along the shorter
 *      arc — saturated/intense shots glow regardless of keyword.
 *   3. Tension drives saturation (mute → vivid) + lightness
 *      (slight dim under tension so the strip has depth).
 *
 * Unsampled cells (tensionLevel undefined) stay muted at 18%
 * saturation + 55% lightness so producers can see at a glance which
 * shots haven't been analyzed yet.
 */

export type DerivedCell = {
  nodeId: string;
  hue: number;
  saturation: number;
  lightness: number;
  tone: string;
  tension: number | null;
  label: string;
};

export type ToneKeyword = {
  kw: RegExp;
  hue: number;
  label: string;
};

// Module-private but exported for tests so we can assert on the order
// + coverage of the keyword table without re-creating it.
export const TONE_KEYWORDS: ToneKeyword[] = [
  { kw: /\b(fire|flame|ember|burn|explosion|explod)\w*/i, hue: 18, label: "fire" },
  { kw: /\b(blood|crimson|wound|stab|kill)\w*/i, hue: 0, label: "blood" },
  { kw: /\b(sun|sunrise|sunset|dusk|dawn|golden)\w*/i, hue: 40, label: "warm" },
  { kw: /\b(forest|grass|leaf|leaves|jungle|emerald)\w*/i, hue: 140, label: "verdant" },
  { kw: /\b(ocean|sea|wave|water|river|lake)\w*/i, hue: 200, label: "aqua" },
  { kw: /\b(neon|synth|cyber|electric)\w*/i, hue: 285, label: "neon" },
  { kw: /\b(night|dark|shadow|moon|star|midnight)\w*/i, hue: 230, label: "night" },
  { kw: /\b(snow|ice|frost|winter|glacier)\w*/i, hue: 210, label: "cold" },
  { kw: /\b(rain|gray|grey|mist|fog)\w*/i, hue: 210, label: "overcast" },
];

/**
 * Tension applies a "redshift" pull when severity is high. The function
 * is exported separately so tests can pin the curve shape (no shift
 * <6, full pull at 10) without driving through a node fixture.
 */
export const applyTensionRedshift = (
  baselineHue: number,
  tension: number | null,
): number => {
  if (tension === null || tension < 6) return baselineHue;
  const redPull = (tension - 6) / 4; // 0 at 6, 1 at 10
  // Interpolate toward red (0°) via short-arc. If baselineHue > 180
  // the shorter route to red is the negative direction (e.g. 285° →
  // -75° → 0°), so we represent that as a negative delta and re-wrap
  // to 0..360 at the end.
  const delta = baselineHue > 180 ? baselineHue - 360 : baselineHue;
  let hue = delta * (1 - redPull);
  if (hue < 0) hue += 360;
  return hue;
};

export type ColorScriptInput = {
  nodeId: string;
  segment?: string | null;
  tensionLevel?: number | null;
  label?: string | null;
};

export const deriveColorCell = (input: ColorScriptInput): DerivedCell => {
  const segment = input.segment ?? "";
  const tension =
    typeof input.tensionLevel === "number"
      ? Math.max(0, Math.min(10, input.tensionLevel))
      : null;
  let hue = 210; // neutral overcast baseline
  let tone = "neutral";
  for (const entry of TONE_KEYWORDS) {
    if (entry.kw.test(segment)) {
      hue = entry.hue;
      tone = entry.label;
      break;
    }
  }
  hue = applyTensionRedshift(hue, tension);
  const saturation = tension === null ? 18 : 28 + (tension / 10) * 42; // 28-70
  const lightness = tension === null ? 55 : 55 - (tension / 10) * 15; // 55-40
  return {
    nodeId: input.nodeId,
    hue,
    saturation,
    lightness,
    tone,
    tension,
    label: input.label ?? input.nodeId,
  };
};
