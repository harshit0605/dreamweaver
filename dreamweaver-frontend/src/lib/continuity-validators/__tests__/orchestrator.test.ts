import { describe, expect, it } from "bun:test";
import {
  DEFAULT_VALIDATORS,
  runShotValidators,
  SHOT_VALIDATOR_CODE_PREFIXES,
} from "@/lib/continuity-validators";
import type { ValidatorInput, ValidatorNode } from "@/lib/continuity-validators/types";
import type { ShotMeta } from "@/app/storyboard/types";

const shot = (
  id: string,
  shotMeta: ShotMeta,
  characterIds: string[] = [],
): ValidatorNode => ({
  nodeId: id,
  nodeType: "shot",
  label: id,
  shotMeta,
  entityRefs: { characterIds },
});

const linear = (nodes: ValidatorNode[]): ValidatorInput => ({
  nodes,
  edges: nodes.slice(0, -1).map((n, i) => ({
    sourceNodeId: n.nodeId,
    targetNodeId: nodes[i + 1].nodeId,
    isPrimary: true,
    order: i,
  })),
});

describe("runShotValidators", () => {
  it("returns [] for an empty graph", () => {
    expect(runShotValidators({ nodes: [], edges: [] })).toEqual([]);
  });

  it("returns a union of violations across all default validators", () => {
    const input = linear([
      // axis-line break (a/b)
      shot("a", { axisLineId: "ax1", screenDirection: "left_to_right", size: "CU", angle: "eye_level" }, ["hero"]),
      shot("b", { axisLineId: "ax1", screenDirection: "right_to_left", size: "CU", angle: "eye_level" }, ["hero"]),
      // 30-degree jump (b/c) — shares axis, same size+angle, regardless of direction.
      shot("c", { axisLineId: "ax1", screenDirection: "right_to_left", size: "CU", angle: "eye_level" }, ["hero"]),
    ]);
    const violations = runShotValidators(input);
    const codes = violations.map((v) => v.code).sort();
    expect(codes).toContain("SHOT_AXIS_LINE_BREAK");
    expect(codes).toContain("SHOT_THIRTY_DEGREE_RULE");
    // Screen-direction reversal is deduped for same-axis pair.
    expect(codes).not.toContain("SHOT_SCREEN_DIRECTION_REVERSE");
  });

  it("runs exactly the validators passed in when the list is overridden", () => {
    const input = linear([
      shot("a", { axisLineId: "ax1", screenDirection: "left_to_right" }, ["hero"]),
      shot("b", { axisLineId: "ax1", screenDirection: "right_to_left" }, ["hero"]),
    ]);
    const result = runShotValidators(input, []);
    expect(result).toEqual([]);
  });

  it("exports a stable prefix list that matches DEFAULT_VALIDATORS", () => {
    expect(SHOT_VALIDATOR_CODE_PREFIXES.length).toBe(DEFAULT_VALIDATORS.length);
    expect(SHOT_VALIDATOR_CODE_PREFIXES).toEqual([
      "SHOT_AXIS_LINE_BREAK",
      "SHOT_SCREEN_DIRECTION_REVERSE",
      "SHOT_THIRTY_DEGREE_RULE",
      "SHOT_EYELINE_MISMATCH",
      "SHOT_SPEAKER_VOICE_MISSING",
      "SHOT_SPEAKER_VOICE_MISMATCH",
    ]);
  });
});
