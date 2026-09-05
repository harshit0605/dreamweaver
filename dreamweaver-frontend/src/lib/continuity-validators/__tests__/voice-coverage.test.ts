import { describe, expect, it } from "bun:test";

import { checkVoiceCoverage } from "@/lib/continuity-validators/voice-coverage";
import type {
  ValidatorInput,
  ValidatorNode,
} from "@/lib/continuity-validators/types";

const shot = (
  id: string,
  segment: string,
): ValidatorNode => ({
  nodeId: id,
  nodeType: "shot",
  label: id,
  segment,
  entityRefs: { characterIds: [] },
});

const input = (
  nodes: ValidatorNode[],
  packs?: ValidatorInput["identityPacks"],
): ValidatorInput => ({
  nodes,
  edges: [],
  identityPacks: packs,
});

describe("checkVoiceCoverage", () => {
  it("is a no-op when identityPacks is undefined", () => {
    const result = checkVoiceCoverage({
      nodes: [shot("s1", '<MAYA> says, "hello world."')],
      edges: [],
    });
    expect(result).toEqual([]);
  });

  it("flags a speaker with no identity pack", () => {
    const result = checkVoiceCoverage(
      input([shot("s1", '<MAYA> says, "hello world."')], []),
    );
    expect(result).toHaveLength(1);
    expect(result[0].code).toBe("SHOT_SPEAKER_VOICE_MISSING");
    expect(result[0].severity).toBe("low");
    expect(result[0].nodeIds).toEqual(["s1"]);
    expect(result[0].message).toContain("MAYA");
  });

  it("flags a speaker whose pack has no voice set", () => {
    const result = checkVoiceCoverage(
      input(
        [shot("s1", '<DANIEL>: "I remember everything."')],
        [{ name: "DANIEL", voice: "" }],
      ),
    );
    expect(result).toHaveLength(1);
    expect(result[0].message).toContain("DANIEL");
  });

  it("flags a speaker whose pack has a voice outside the allowed roster", () => {
    const result = checkVoiceCoverage(
      input(
        [shot("s1", '<MAYA> says, "test."')],
        [{ name: "MAYA", voice: "not-a-voice" }],
      ),
    );
    expect(result).toHaveLength(1);
  });

  it("passes when the pack is keyed by sourceCharacterId", () => {
    const result = checkVoiceCoverage(
      input(
        [shot("s1", '<MAYA> says, "hello."')],
        [{ sourceCharacterId: "MAYA", voice: "nova" }],
      ),
    );
    expect(result).toEqual([]);
  });

  it("passes when the pack is keyed by name with different casing", () => {
    const result = checkVoiceCoverage(
      input(
        [shot("s1", '<MAYA> says, "hello."')],
        [{ name: "Maya", voice: "nova" }],
      ),
    );
    expect(result).toEqual([]);
  });

  it("dedupes multiple lines from the same speaker in one shot", () => {
    const result = checkVoiceCoverage(
      input(
        [
          shot(
            "s1",
            '<MAYA> says, "hello." <MAYA> says, "again." <MAYA>: "third time."',
          ),
        ],
        [],
      ),
    );
    expect(result).toHaveLength(1);
  });

  it("emits one violation per uncovered speaker", () => {
    const result = checkVoiceCoverage(
      input(
        [shot("s1", '<MAYA> says, "hi." <DANIEL>: "hey."')],
        [{ name: "MAYA", voice: "nova" }],
      ),
    );
    expect(result).toHaveLength(1);
    expect(result[0].message).toContain("DANIEL");
  });

  it("ignores non-shot nodes", () => {
    const result = checkVoiceCoverage(
      input(
        [
          {
            nodeId: "scene1",
            nodeType: "scene",
            label: "opening",
            segment: '<MAYA> says, "unattached dialogue."',
            entityRefs: { characterIds: [] },
          },
        ],
        [],
      ),
    );
    expect(result).toEqual([]);
  });

  it("skips unattributed quoted lines (null speaker)", () => {
    const result = checkVoiceCoverage(
      input(
        [shot("s1", 'A whisper in the dark: "Where am I?"')],
        [],
      ),
    );
    expect(result).toEqual([]);
  });

  it("returns [] when the shot has no dialogue at all", () => {
    const result = checkVoiceCoverage(
      input(
        [shot("s1", "A sweeping aerial shot over the desert at dawn.")],
        [],
      ),
    );
    expect(result).toEqual([]);
  });

  it("returns [] when segment is empty", () => {
    const result = checkVoiceCoverage(input([shot("s1", "")], []));
    expect(result).toEqual([]);
  });
});
