/**
 * M9 Phase 2 — narrative analysis heuristics (TypeScript mirror).
 *
 * These helpers are a deliberate port of the Python implementations in
 * `storyboard-agent/deep/tools.py` (sample_tension_curve, detect_beat_plan,
 * detect_beat_gaps). The client-side "Analyze narrative" button runs
 * them locally so producers get an instant beat plan + tension curve
 * without an agent round-trip — matches the plan's sub-45s success
 * criterion (README at /Users/harshit/.claude/plans/federated-sprouting-ullman.md).
 *
 * If these two implementations drift, the UX changes when the producer
 * switches between "client-side Analyze" and "ask the agent to re-
 * analyze." The test suite in `__tests__/narrative-heuristics.test.ts`
 * asserts both produce the same output on canonical seed inputs — if
 * you change one, update the other, or accept the drift and update
 * both tests.
 */

export type NarrativeStructure =
  | "save_the_cat"
  | "harmon_circle"
  | "three_act"
  | "kishotenketsu"
  | "hook_first";

export type BeatStatus = "planned" | "assigned" | "missing";

export type LandedStatus = "unplanted" | "planted" | "landed";

export interface BeatAssignment {
  beatKey: string;
  expectedActNumber?: number;
  nodeId?: string;
  status: BeatStatus;
  rationale?: string;
}

export interface BeatPlanProposal {
  structure: NarrativeStructure;
  beats: BeatAssignment[];
  unassignedBeatKeys: string[];
}

export interface TensionSample {
  nodeId: string;
  value: number;
}

export interface TensionDip {
  fromNodeId: string;
  toNodeId: string;
  drop: number;
  severity: "medium" | "high";
}

export interface TensionCurveProposal {
  samples: TensionSample[];
  dips: TensionDip[];
}

export interface BeatGap {
  beatKey: string;
  severity: "medium" | "high";
  reason: string;
}

export interface BeatGapsProposal {
  gapCount: number;
  missingBeatKeys: string[];
  plannedBeatKeys: string[];
  gaps: BeatGap[];
}

/**
 * Shot-like subset the heuristics consume. Loose intentionally — the
 * storyboard's `StoryNodeData` shape is heavier than the tools need.
 * Callers project down when they invoke the helpers so the heuristic
 * stays framework-agnostic.
 */
export interface HeuristicShotInput {
  nodeId: string;
  segment?: string | null;
  shotMeta?: {
    size?: string | null;
    move?: string | null;
    sfx?: string[] | null;
    vfx?: string[] | null;
  } | null;
}

// ---------------------------------------------------------------------------
// Canonical beats (mirror Python _STRUCTURE_BEATS + _POSITIONAL_HINTS)
// ---------------------------------------------------------------------------

export const SAVE_THE_CAT_BEATS: readonly string[] = [
  "opening_image", "theme_stated", "setup", "catalyst", "debate",
  "break_into_two", "b_story", "fun_and_games", "midpoint",
  "bad_guys_close_in", "all_is_lost", "dark_night_of_the_soul",
  "break_into_three", "finale", "final_image",
];

export const HARMON_CIRCLE_BEATS: readonly string[] = [
  "you", "need", "go", "search", "find", "take", "return", "change",
];

export const THREE_ACT_BEATS: readonly string[] = [
  "act1_setup", "act1_inciting_incident", "act2_rising_action",
  "act2_midpoint", "act2_crisis", "act3_climax", "act3_denouement",
];

export const KISHOTENKETSU_BEATS: readonly string[] = ["ki", "sho", "ten", "ketsu"];

export const HOOK_FIRST_BEATS: readonly string[] = [
  "hook", "promise", "proof", "payoff", "cta",
];

const STRUCTURE_BEATS: Record<NarrativeStructure, readonly string[]> = {
  save_the_cat: SAVE_THE_CAT_BEATS,
  harmon_circle: HARMON_CIRCLE_BEATS,
  three_act: THREE_ACT_BEATS,
  kishotenketsu: KISHOTENKETSU_BEATS,
  hook_first: HOOK_FIRST_BEATS,
};

const POSITIONAL_HINTS: Record<NarrativeStructure, Record<string, number>> = {
  save_the_cat: {
    opening_image: 0.0,
    theme_stated: 0.05,
    setup: 0.1,
    catalyst: 0.15,
    debate: 0.2,
    break_into_two: 0.25,
    b_story: 0.3,
    fun_and_games: 0.4,
    midpoint: 0.5,
    bad_guys_close_in: 0.6,
    all_is_lost: 0.7,
    dark_night_of_the_soul: 0.73,
    break_into_three: 0.75,
    finale: 0.9,
    final_image: 1.0,
  },
  hook_first: {
    hook: 0.0,
    promise: 0.1,
    proof: 0.5,
    payoff: 0.85,
    cta: 1.0,
  },
  harmon_circle: {},
  three_act: {},
  kishotenketsu: {},
};

const ACT_HINTS: Record<NarrativeStructure, Record<string, number>> = {
  save_the_cat: {
    opening_image: 1, theme_stated: 1, setup: 1, catalyst: 1, debate: 1,
    break_into_two: 2, b_story: 2, fun_and_games: 2, midpoint: 2,
    bad_guys_close_in: 2, all_is_lost: 2, dark_night_of_the_soul: 2,
    break_into_three: 3, finale: 3, final_image: 3,
  },
  harmon_circle: {
    you: 1, need: 1, go: 2, search: 2, find: 2,
    take: 3, return: 3, change: 3,
  },
  three_act: {
    act1_setup: 1, act1_inciting_incident: 1,
    act2_rising_action: 2, act2_midpoint: 2, act2_crisis: 2,
    act3_climax: 3, act3_denouement: 3,
  },
  kishotenketsu: { ki: 1, sho: 2, ten: 3, ketsu: 4 },
  hook_first: { hook: 1, promise: 1, proof: 2, payoff: 3, cta: 3 },
};

export const canonicalBeatsFor = (
  structure: NarrativeStructure,
): string[] => [...STRUCTURE_BEATS[structure]];

// ---------------------------------------------------------------------------
// Tension vocabulary (mirror Python frozensets)
// ---------------------------------------------------------------------------

const HIGH_TENSION_KEYWORDS = new Set<string>([
  "fight", "chase", "run", "runs", "running", "death", "dies", "died",
  "kill", "kills", "killing", "killed", "attack", "attacks", "attacked",
  "shoots", "shooting", "scream", "screams", "screaming",
  "explode", "explodes", "explosion", "blood", "panic",
  "crash", "crashes", "crashing",
]);
const MEDIUM_TENSION_KEYWORDS = new Set<string>([
  "reveal", "reveals", "revealed", "confront", "confronts", "confronted",
  "confess", "confesses", "betray", "betrays", "betrayed",
  "shock", "shocks", "shocked", "fear", "afraid",
  "weep", "weeps", "cry", "cries", "tears", "sob", "sobs",
]);
const LOW_TENSION_KEYWORDS = new Set<string>([
  "laugh", "laughs", "laughing", "calm", "peaceful", "quiet",
  "rest", "rests", "sleep", "sleeps", "sleeping", "smile", "smiles", "smiling",
]);
const TIGHT_SHOT_SIZES = new Set<string>(["ECU", "CU", "MCU"]);
const DYNAMIC_SHOT_MOVES = new Set<string>(["whip_pan", "handheld", "tilt"]);

const tokenizeSegment = (text: string | null | undefined): string[] => {
  if (typeof text !== "string") return [];
  const out: string[] = [];
  let buf = "";
  const lower = text.toLowerCase();
  for (let i = 0; i < lower.length; i += 1) {
    const ch = lower[i];
    if (ch >= "a" && ch <= "z") {
      buf += ch;
    } else if (buf) {
      out.push(buf);
      buf = "";
    }
  }
  if (buf) out.push(buf);
  return out;
};

/**
 * Deterministic 0-10 tension score for one shot. Matches the Python
 * `_heuristic_tension_for_shot` formula byte-for-byte so the client
 * and agent paths stay in sync.
 */
export const heuristicTensionForShot = (shot: HeuristicShotInput): number => {
  const shotMeta = shot.shotMeta ?? null;
  let score = 3.0;
  if (shotMeta?.move && DYNAMIC_SHOT_MOVES.has(shotMeta.move)) score += 2.0;
  if (shotMeta?.size && TIGHT_SHOT_SIZES.has(shotMeta.size)) score += 2.0;
  for (const key of ["sfx", "vfx"] as const) {
    const list = shotMeta?.[key];
    if (Array.isArray(list) && list.some((v) => typeof v === "string" && v.length > 0)) {
      score += 1.0;
    }
  }
  const tokens = new Set(tokenizeSegment(shot.segment));
  const hasOverlap = (a: Set<string>, b: Set<string>): boolean => {
    for (const item of a) if (b.has(item)) return true;
    return false;
  };
  if (hasOverlap(tokens, HIGH_TENSION_KEYWORDS)) score += 2.0;
  if (hasOverlap(tokens, MEDIUM_TENSION_KEYWORDS)) score += 1.0;
  if (hasOverlap(tokens, LOW_TENSION_KEYWORDS)) score -= 1.0;
  if (
    shotMeta?.move === "static"
    && shotMeta?.size
    && (shotMeta.size === "WS" || shotMeta.size === "EWS")
  ) {
    score -= 1.0;
  }
  return Math.max(0, Math.min(10, score));
};

export const sampleTensionCurve = (
  shots: HeuristicShotInput[],
): TensionCurveProposal => {
  const samples: TensionSample[] = [];
  for (const shot of shots) {
    if (!shot?.nodeId) continue;
    samples.push({
      nodeId: shot.nodeId,
      value: heuristicTensionForShot(shot),
    });
  }
  const dips: TensionDip[] = [];
  for (let i = 1; i < samples.length; i += 1) {
    const drop = samples[i - 1].value - samples[i].value;
    if (drop >= 3.0) {
      dips.push({
        fromNodeId: samples[i - 1].nodeId,
        toNodeId: samples[i].nodeId,
        drop: Math.round(drop * 100) / 100,
        severity: drop >= 5.0 ? "high" : "medium",
      });
    }
  }
  return { samples, dips };
};

// ---------------------------------------------------------------------------
// Beat plan + gaps
// ---------------------------------------------------------------------------

/**
 * TypeScript port of Python's `round(x)` which uses banker's rounding
 * (half-to-even). We explicitly implement this to match the agent-
 * side output byte-for-byte — JS's `Math.round` rounds half-up, which
 * would produce different midpoint placements for even-sized reels
 * and cause the UI to drift from the agent's proposals.
 */
const bankersRound = (x: number): number => {
  const floor = Math.floor(x);
  const diff = x - floor;
  if (diff < 0.5) return floor;
  if (diff > 0.5) return floor + 1;
  // Exact half → round to even.
  return floor % 2 === 0 ? floor : floor + 1;
};

export const detectBeatPlan = (
  structure: NarrativeStructure,
  shots: HeuristicShotInput[],
  existingAssignments: BeatAssignment[] = [],
): BeatPlanProposal => {
  const beatKeys = STRUCTURE_BEATS[structure] ?? SAVE_THE_CAT_BEATS;
  const hints = POSITIONAL_HINTS[structure] ?? {};
  const existing = new Map<string, BeatAssignment>();
  for (const a of existingAssignments) {
    if (a?.beatKey) existing.set(a.beatKey, a);
  }
  const n = shots.length;
  const beats: BeatAssignment[] = [];
  const unassigned: string[] = [];

  beatKeys.forEach((beatKey, idx) => {
    const prior = existing.get(beatKey);
    if (
      prior
      && prior.status === "assigned"
      && typeof prior.nodeId === "string"
      && prior.nodeId
    ) {
      beats.push({
        beatKey,
        expectedActNumber: prior.expectedActNumber,
        nodeId: prior.nodeId,
        status: "assigned",
        rationale: prior.rationale,
      });
      return;
    }
    if (n === 0) {
      beats.push({ beatKey, status: "planned" });
      unassigned.push(beatKey);
      return;
    }
    const frac =
      beatKey in hints
        ? hints[beatKey]
        : idx / Math.max(1, beatKeys.length - 1);
    const shotIdx = Math.min(
      n - 1,
      Math.max(0, bankersRound(frac * (n - 1))),
    );
    const proposed = shots[shotIdx];
    if (!proposed?.nodeId) {
      beats.push({ beatKey, status: "planned" });
      unassigned.push(beatKey);
      return;
    }
    beats.push({
      beatKey,
      nodeId: proposed.nodeId,
      status: "planned", // Proposer never returns assigned — HITL flips.
      rationale: `positional heuristic (shot ${shotIdx + 1}/${n})`,
      expectedActNumber: ACT_HINTS[structure]?.[beatKey],
    });
  });
  return { structure, beats, unassignedBeatKeys: unassigned };
};

export const detectBeatGaps = (beats: BeatAssignment[]): BeatGapsProposal => {
  const gaps: BeatGap[] = [];
  const planned: string[] = [];
  const missing: string[] = [];
  for (const beat of beats) {
    if (!beat?.beatKey) continue;
    if (beat.status === "missing") {
      missing.push(beat.beatKey);
      gaps.push({
        beatKey: beat.beatKey,
        severity: "high",
        reason: "was assigned but node no longer exists",
      });
    } else if (beat.status === "planned") {
      planned.push(beat.beatKey);
      gaps.push({
        beatKey: beat.beatKey,
        severity: "medium",
        reason: "slot never filled",
      });
    }
  }
  return {
    gapCount: gaps.length,
    missingBeatKeys: missing,
    plannedBeatKeys: planned,
    gaps,
  };
};

/**
 * Structure auto-suggest based on reel duration. The plan's scope
 * decision was both Save-the-Cat + Hook-first land in M9; this helper
 * picks a sensible default for a first-time producer. Reels under
 * 90s → hook-first (TikTok/Reels/Shorts territory); longer → Save-
 * the-Cat. Producer can override via the picker.
 */
export const suggestStructureForDuration = (
  totalDurationS: number,
): NarrativeStructure => (totalDurationS < 90 ? "hook_first" : "save_the_cat");
