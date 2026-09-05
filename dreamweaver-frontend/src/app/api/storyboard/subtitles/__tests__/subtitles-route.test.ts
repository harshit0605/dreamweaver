import { describe, expect, it } from "bun:test";

import { buildSubtitleInputs } from "@/app/api/storyboard/subtitles/route";
import type { NodeType, ShotMeta } from "@/app/storyboard/types";

interface SnapshotNode {
  nodeId: string;
  nodeType: NodeType;
  label: string;
  segment: string;
  shotMeta?: ShotMeta;
}

const shotNode = (overrides: Partial<SnapshotNode> = {}): SnapshotNode => ({
  nodeId: "n",
  nodeType: "shot",
  label: "Shot",
  segment: "",
  ...overrides,
});

describe("buildSubtitleInputs", () => {
  it("sorts by episode-shot ordering via parseShotNumber", () => {
    const inputs = buildSubtitleInputs([
      shotNode({
        nodeId: "a",
        shotMeta: { number: "Ep2-1", durationS: 3 },
      }),
      shotNode({
        nodeId: "b",
        shotMeta: { number: "Ep1-2", durationS: 3 },
      }),
      shotNode({
        nodeId: "c",
        shotMeta: { number: "Ep1-1", durationS: 3 },
      }),
    ]);
    expect(inputs.map((i) => i.nodeId)).toEqual(["c", "b", "a"]);
  });

  it("clamps duration to [1, 30] with default 5 for missing", () => {
    const inputs = buildSubtitleInputs([
      shotNode({ nodeId: "a", shotMeta: { number: "1", durationS: 100 } }),
      shotNode({ nodeId: "b", shotMeta: { number: "2", durationS: 0 } }),
      shotNode({ nodeId: "c", shotMeta: { number: "3" } }),
    ]);
    expect(inputs[0].durationS).toBe(30);
    expect(inputs[1].durationS).toBe(1);
    expect(inputs[2].durationS).toBe(5);
  });

  it("carries through segment text unchanged", () => {
    const seg = '<MAYA> says, "hello world"';
    const inputs = buildSubtitleInputs([
      shotNode({ nodeId: "a", segment: seg }),
    ]);
    expect(inputs[0].segment).toBe(seg);
  });

  it("falls back to insertion order when shot numbers are missing or equal", () => {
    const inputs = buildSubtitleInputs([
      shotNode({ nodeId: "first" }),
      shotNode({ nodeId: "second" }),
      shotNode({ nodeId: "third" }),
    ]);
    expect(inputs.map((i) => i.nodeId)).toEqual(["first", "second", "third"]);
  });
});
