import { describe, expect, it } from "bun:test";

import {
  canonicalBeatsFor,
  detectBeatGaps,
  detectBeatPlan,
  HARMON_CIRCLE_BEATS,
  heuristicTensionForShot,
  HOOK_FIRST_BEATS,
  KISHOTENKETSU_BEATS,
  sampleTensionCurve,
  SAVE_THE_CAT_BEATS,
  suggestStructureForDuration,
  THREE_ACT_BEATS,
  type BeatAssignment,
  type HeuristicShotInput,
} from "@/lib/narrative";

describe("canonical beat rosters", () => {
  it("has 15 Save-the-Cat beats", () => {
    expect(canonicalBeatsFor("save_the_cat")).toEqual([...SAVE_THE_CAT_BEATS]);
    expect(SAVE_THE_CAT_BEATS.length).toBe(15);
  });

  it("has 8 Harmon Circle beats", () => {
    expect(canonicalBeatsFor("harmon_circle")).toEqual([...HARMON_CIRCLE_BEATS]);
    expect(HARMON_CIRCLE_BEATS.length).toBe(8);
  });

  it("has 7 three-act beats", () => {
    expect(canonicalBeatsFor("three_act")).toEqual([...THREE_ACT_BEATS]);
  });

  it("has 4 Kishōtenketsu beats", () => {
    expect(canonicalBeatsFor("kishotenketsu")).toEqual([...KISHOTENKETSU_BEATS]);
  });

  it("has 5 hook-first beats", () => {
    expect(canonicalBeatsFor("hook_first")).toEqual([...HOOK_FIRST_BEATS]);
  });

  it("returns defensive copies (caller mutation is harmless)", () => {
    const beats = canonicalBeatsFor("save_the_cat");
    beats.push("fake");
    expect(SAVE_THE_CAT_BEATS.includes("fake")).toBe(false);
  });
});

describe("heuristicTensionForShot", () => {
  it("baseline neutral descriptor returns 3.0", () => {
    // Avoid the word "shot" (is a noun in cinema; collides with the
    // agent's high-tension vocabulary otherwise and is explicitly
    // excluded from the keyword list).
    expect(
      heuristicTensionForShot({ nodeId: "n", segment: "A neutral wide frame." }),
    ).toBe(3.0);
  });

  it("handheld + CU + chase keyword saturates to 9.0", () => {
    expect(
      heuristicTensionForShot({
        nodeId: "n",
        segment: "Chase through the market.",
        shotMeta: { move: "handheld", size: "CU" },
      }),
    ).toBe(9.0);
  });

  it("static wide + peaceful keyword drops to 1.0", () => {
    expect(
      heuristicTensionForShot({
        nodeId: "n",
        segment: "A peaceful moment.",
        shotMeta: { move: "static", size: "EWS" },
      }),
    ).toBe(1.0);
  });

  it("high-tension keyword bonus caps at +2 (no saturation from repetition)", () => {
    expect(
      heuristicTensionForShot({
        nodeId: "n",
        segment: "Scream scream scream scream scream.",
      }),
    ).toBe(5.0);
  });

  it("clamps to [0, 10]", () => {
    const hot = heuristicTensionForShot({
      nodeId: "hot",
      segment: "Explosion. Scream. Kill. Blood.",
      shotMeta: {
        move: "whip_pan",
        size: "ECU",
        sfx: ["gunshot"],
        vfx: ["muzzle_flash"],
      },
    });
    expect(hot).toBe(10);
  });

  it("doesn't treat 'shot' (cinema noun) as a high-tension keyword", () => {
    // Real-world shot descriptions are full of the word 'shot' —
    // earlier drafts accidentally inflated every shot's score.
    expect(
      heuristicTensionForShot({
        nodeId: "n",
        segment: "A wide shot of the crowd.",
      }),
    ).toBe(3.0);
  });
});

describe("sampleTensionCurve", () => {
  it("empty input yields empty output", () => {
    expect(sampleTensionCurve([])).toEqual({ samples: [], dips: [] });
  });

  it("flags high-severity dip on a drop of 8", () => {
    const shots: HeuristicShotInput[] = [
      {
        nodeId: "n1",
        segment: "Chase through alleys.",
        shotMeta: { move: "handheld", size: "CU" },
      },
      {
        nodeId: "n2",
        segment: "Calm lake at sunrise.",
        shotMeta: { move: "static", size: "EWS" },
      },
    ];
    const out = sampleTensionCurve(shots);
    expect(out.dips).toHaveLength(1);
    expect(out.dips[0].fromNodeId).toBe("n1");
    expect(out.dips[0].toNodeId).toBe("n2");
    expect(out.dips[0].severity).toBe("high");
  });

  it("does not flag drops under 3 points", () => {
    const shots: HeuristicShotInput[] = [
      { nodeId: "n1", shotMeta: { move: "handheld" } },
      { nodeId: "n2" },
    ];
    // n1=5, n2=3 → drop 2 → no dip.
    expect(sampleTensionCurve(shots).dips).toEqual([]);
  });

  it("drops shots with missing nodeId", () => {
    expect(sampleTensionCurve([{ nodeId: "", segment: "orphan" }]).samples).toEqual([]);
  });
});

describe("detectBeatPlan", () => {
  it("empty shots → every slot planned, all in unassignedBeatKeys", () => {
    const out = detectBeatPlan("hook_first", []);
    expect(out.beats.every((b) => b.status === "planned")).toBe(true);
    expect(out.beats.every((b) => !b.nodeId)).toBe(true);
    expect(out.unassignedBeatKeys).toEqual([...HOOK_FIRST_BEATS]);
  });

  it("Save-the-Cat places opening at shot 0 and final at last shot", () => {
    const shots: HeuristicShotInput[] = Array.from({ length: 10 }, (_, i) => ({
      nodeId: `n${i}`,
    }));
    const out = detectBeatPlan("save_the_cat", shots);
    const byKey = new Map(out.beats.map((b) => [b.beatKey, b]));
    expect(byKey.get("opening_image")?.nodeId).toBe("n0");
    expect(byKey.get("final_image")?.nodeId).toBe("n9");
  });

  it("preserves assigned slots verbatim (never overwrites)", () => {
    const shots: HeuristicShotInput[] = Array.from({ length: 10 }, (_, i) => ({
      nodeId: `n${i}`,
    }));
    const existing: BeatAssignment[] = [
      {
        beatKey: "opening_image",
        nodeId: "producer_picked",
        status: "assigned",
        rationale: "producer chose this",
      },
    ];
    const out = detectBeatPlan("save_the_cat", shots, existing);
    const byKey = new Map(out.beats.map((b) => [b.beatKey, b]));
    expect(byKey.get("opening_image")?.nodeId).toBe("producer_picked");
    expect(byKey.get("opening_image")?.status).toBe("assigned");
  });

  it("proposals never ship status=assigned (HITL flips)", () => {
    const shots: HeuristicShotInput[] = Array.from({ length: 5 }, (_, i) => ({
      nodeId: `n${i}`,
    }));
    const out = detectBeatPlan("hook_first", shots);
    for (const beat of out.beats) {
      if (beat.nodeId) expect(beat.status).toBe("planned");
    }
  });

  it("populates expectedActNumber from act hints", () => {
    const shots: HeuristicShotInput[] = Array.from({ length: 5 }, (_, i) => ({
      nodeId: `n${i}`,
    }));
    const out = detectBeatPlan("hook_first", shots);
    const byKey = new Map(out.beats.map((b) => [b.beatKey, b]));
    expect(byKey.get("hook")?.expectedActNumber).toBe(1);
    expect(byKey.get("cta")?.expectedActNumber).toBe(3);
  });

  it("uses banker's rounding for midpoint (matches Python)", () => {
    // 0.5 × 9 = 4.5 → banker's rounding picks 4 (round half to even).
    // JS's native Math.round(4.5) = 5 (round half up) would drift.
    const shots: HeuristicShotInput[] = Array.from({ length: 10 }, (_, i) => ({
      nodeId: `n${i}`,
    }));
    const out = detectBeatPlan("save_the_cat", shots);
    const byKey = new Map(out.beats.map((b) => [b.beatKey, b]));
    expect(byKey.get("midpoint")?.nodeId).toBe("n4");
  });

  it("harmon_circle evenly distributes without positional hints", () => {
    const shots: HeuristicShotInput[] = Array.from({ length: 16 }, (_, i) => ({
      nodeId: `n${i}`,
    }));
    const out = detectBeatPlan("harmon_circle", shots);
    const byKey = new Map(out.beats.map((b) => [b.beatKey, b]));
    expect(byKey.get("you")?.nodeId).toBe("n0");
    expect(byKey.get("change")?.nodeId).toBe("n15");
  });
});

describe("detectBeatGaps", () => {
  it("empty plan → no gaps", () => {
    expect(detectBeatGaps([])).toEqual({
      gapCount: 0,
      missingBeatKeys: [],
      plannedBeatKeys: [],
      gaps: [],
    });
  });

  it("planned → medium severity gap", () => {
    const out = detectBeatGaps([
      { beatKey: "opening_image", status: "assigned", nodeId: "n1" },
      { beatKey: "midpoint", status: "planned" },
    ]);
    expect(out.gapCount).toBe(1);
    expect(out.gaps[0].severity).toBe("medium");
    expect(out.plannedBeatKeys).toEqual(["midpoint"]);
  });

  it("missing → high severity gap", () => {
    const out = detectBeatGaps([
      { beatKey: "finale", status: "missing", nodeId: "deleted" },
    ]);
    expect(out.gaps[0].severity).toBe("high");
    expect(out.missingBeatKeys).toEqual(["finale"]);
  });
});

describe("suggestStructureForDuration", () => {
  it("reels under 90s default to hook_first (short-form)", () => {
    expect(suggestStructureForDuration(30)).toBe("hook_first");
    expect(suggestStructureForDuration(89.9)).toBe("hook_first");
  });

  it("reels 90s and longer default to save_the_cat", () => {
    expect(suggestStructureForDuration(90)).toBe("save_the_cat");
    expect(suggestStructureForDuration(360)).toBe("save_the_cat");
  });
});
