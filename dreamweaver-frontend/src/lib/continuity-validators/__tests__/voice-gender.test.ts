import { describe, expect, it } from "bun:test";

import {
  checkVoiceGenderMismatch,
  inferPackGender,
  VOICE_GENDER_HINT,
} from "@/lib/continuity-validators/voice-gender";
import type {
  ValidatorInput,
  ValidatorNode,
} from "@/lib/continuity-validators/types";

const shot = (id: string, segment: string): ValidatorNode => ({
  nodeId: id,
  nodeType: "shot",
  label: id,
  segment,
  entityRefs: { characterIds: [] },
});

const input = (
  nodes: ValidatorNode[],
  packs?: unknown,
): ValidatorInput => ({
  nodes,
  edges: [],
  // Cast so we can smuggle dnaJson through without widening the public
  // ValidatorIdentityPack shape.
  identityPacks: packs as ValidatorInput["identityPacks"],
});

describe("VOICE_GENDER_HINT table", () => {
  it("pairs masculine/feminine voices correctly", () => {
    expect(VOICE_GENDER_HINT.echo).toBe("masculine");
    expect(VOICE_GENDER_HINT.onyx).toBe("masculine");
    expect(VOICE_GENDER_HINT.nova).toBe("feminine");
    expect(VOICE_GENDER_HINT.shimmer).toBe("feminine");
    expect(VOICE_GENDER_HINT.alloy).toBe("neutral");
    expect(VOICE_GENDER_HINT.fable).toBe("neutral");
  });
});

describe("inferPackGender", () => {
  it("returns null for empty input", () => {
    expect(inferPackGender("")).toBeNull();
    expect(inferPackGender("   ")).toBeNull();
  });

  it("returns null for non-JSON", () => {
    expect(inferPackGender("not json")).toBeNull();
  });

  it("returns null when tokens are absent", () => {
    expect(inferPackGender(JSON.stringify({ color: "blue" }))).toBeNull();
  });

  it("reads explicit gender key with strong weight", () => {
    expect(inferPackGender(JSON.stringify({ gender: "female" }))).toBe(
      "feminine",
    );
    expect(inferPackGender(JSON.stringify({ sex: "male" }))).toBe("masculine");
  });

  it("counts pronouns when gender not explicit", () => {
    expect(
      inferPackGender(
        JSON.stringify({
          description: "She walks in. Her eyes are dark. Her voice is steady.",
        }),
      ),
    ).toBe("feminine");
  });

  it("explicit gender overrides incidental pronouns", () => {
    expect(
      inferPackGender(
        JSON.stringify({
          gender: "male",
          description: "She was never seen again.",
        }),
      ),
    ).toBe("masculine");
  });

  it("returns null on a tie", () => {
    expect(
      inferPackGender(
        JSON.stringify({
          description: "he and she meet.",
        }),
      ),
    ).toBeNull();
  });

  it("walks into nested arrays and objects", () => {
    expect(
      inferPackGender(
        JSON.stringify({
          relationships: [{ role: "daughter" }, { role: "sister" }],
        }),
      ),
    ).toBe("feminine");
  });
});

describe("checkVoiceGenderMismatch", () => {
  const femaleMayaPack = {
    name: "MAYA",
    sourceCharacterId: "MAYA",
    voice: "onyx",
    dnaJson: JSON.stringify({ gender: "female", description: "a young woman" }),
  };
  const maleDanielPack = {
    name: "DANIEL",
    sourceCharacterId: "DANIEL",
    voice: "nova",
    dnaJson: JSON.stringify({ gender: "male" }),
  };

  it("no-op when identityPacks undefined", () => {
    expect(
      checkVoiceGenderMismatch({
        nodes: [shot("s1", '<MAYA> says, "hello."')],
        edges: [],
      }),
    ).toEqual([]);
  });

  it("flags a female pack voiced with a masculine voice", () => {
    const result = checkVoiceGenderMismatch(
      input([shot("s1", '<MAYA> says, "hello."')], [femaleMayaPack]),
    );
    expect(result).toHaveLength(1);
    expect(result[0].code).toBe("SHOT_SPEAKER_VOICE_MISMATCH");
    expect(result[0].severity).toBe("low");
    expect(result[0].message).toContain("MAYA");
    expect(result[0].message).toContain("onyx");
  });

  it("flags a male pack voiced with a feminine voice", () => {
    const result = checkVoiceGenderMismatch(
      input([shot("s1", '<DANIEL> says, "hey."')], [maleDanielPack]),
    );
    expect(result).toHaveLength(1);
    expect(result[0].message).toContain("DANIEL");
    expect(result[0].message).toContain("nova");
  });

  it("silent when voice is neutral (alloy)", () => {
    const result = checkVoiceGenderMismatch(
      input(
        [shot("s1", '<MAYA> says, "hello."')],
        [{ ...femaleMayaPack, voice: "alloy" }],
      ),
    );
    expect(result).toEqual([]);
  });

  it("silent when pack DNA lacks gender signal", () => {
    const result = checkVoiceGenderMismatch(
      input(
        [shot("s1", '<MAYA> says, "hello."')],
        [{ ...femaleMayaPack, dnaJson: JSON.stringify({ color: "red" }) }],
      ),
    );
    expect(result).toEqual([]);
  });

  it("silent when voice matches the pack gender", () => {
    const result = checkVoiceGenderMismatch(
      input(
        [shot("s1", '<MAYA> says, "hello."')],
        [{ ...femaleMayaPack, voice: "nova" }],
      ),
    );
    expect(result).toEqual([]);
  });

  it("dedupes per shot — one line per speaker even with multiple lines", () => {
    const result = checkVoiceGenderMismatch(
      input(
        [
          shot(
            "s1",
            '<MAYA> says, "one." <MAYA> says, "two." <MAYA>: "three."',
          ),
        ],
        [femaleMayaPack],
      ),
    );
    expect(result).toHaveLength(1);
  });

  it("emits one violation per shot when multiple uncovered packs mismatch", () => {
    const result = checkVoiceGenderMismatch(
      input(
        [shot("s1", '<MAYA> says, "hi." <DANIEL>: "hey."')],
        [femaleMayaPack, maleDanielPack],
      ),
    );
    expect(result).toHaveLength(2);
  });

  it("ignores non-shot nodes", () => {
    const result = checkVoiceGenderMismatch(
      input(
        [
          {
            nodeId: "sc",
            nodeType: "scene",
            label: "x",
            segment: '<MAYA> says, "hi."',
            entityRefs: { characterIds: [] },
          },
        ],
        [femaleMayaPack],
      ),
    );
    expect(result).toEqual([]);
  });

  it("suggests genre-appropriate fallback voices in suggestedFix", () => {
    const result = checkVoiceGenderMismatch(
      input([shot("s1", '<MAYA> says, "hi."')], [femaleMayaPack]),
    );
    expect(result[0].suggestedFix).toContain("nova");
    expect(result[0].suggestedFix).toContain("shimmer");
  });
});
