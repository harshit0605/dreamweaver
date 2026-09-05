import { describe, expect, it } from "bun:test";

import type { SubtitleCue } from "@/lib/subtitles";
import {
  fingerprintCueTexts,
  isSourceLocale,
  translateCues,
  type TranslateBatch,
} from "@/lib/subtitles/translate";

const cue = (overrides: Partial<SubtitleCue> = {}): SubtitleCue => ({
  index: 1,
  startS: 0,
  endS: 2,
  text: "Hello.",
  nodeId: "n",
  speaker: null,
  ...overrides,
});

describe("isSourceLocale", () => {
  it("treats empty / null / undefined as source", () => {
    expect(isSourceLocale(null)).toBe(true);
    expect(isSourceLocale(undefined)).toBe(true);
    expect(isSourceLocale("")).toBe(true);
    expect(isSourceLocale("   ")).toBe(true);
  });

  it("treats en and en-* as source", () => {
    expect(isSourceLocale("en")).toBe(true);
    expect(isSourceLocale("EN")).toBe(true);
    expect(isSourceLocale("en-US")).toBe(true);
    expect(isSourceLocale("en-GB")).toBe(true);
  });

  it("treats other languages as targets", () => {
    expect(isSourceLocale("es")).toBe(false);
    expect(isSourceLocale("fr-CA")).toBe(false);
    expect(isSourceLocale("ja")).toBe(false);
  });
});

describe("translateCues", () => {
  const passthroughTranslator: TranslateBatch = async (lines) => lines;
  const reverseTranslator: TranslateBatch = async (lines) =>
    lines.map((l) => l.split("").reverse().join(""));

  it("returns the same array identity when locale is source", async () => {
    const cues = [cue()];
    const out = await translateCues(cues, "en");
    expect(out).toBe(cues);
  });

  it("returns the same array identity when cues is empty", async () => {
    const cues: SubtitleCue[] = [];
    const out = await translateCues(cues, "es");
    expect(out).toBe(cues);
  });

  it("preserves timing and nodeId during translation", async () => {
    const cues = [
      cue({ text: "one.", startS: 0, endS: 1, nodeId: "a", index: 1 }),
      cue({ text: "two.", startS: 1, endS: 2, nodeId: "b", index: 2 }),
    ];
    const out = await translateCues(cues, "es", {
      translate: reverseTranslator,
    });
    expect(out).toHaveLength(2);
    expect(out[0].startS).toBe(0);
    expect(out[0].nodeId).toBe("a");
    expect(out[1].startS).toBe(1);
    expect(out[1].nodeId).toBe("b");
    expect(out[0].text).toBe(".eno");
    expect(out[1].text).toBe(".owt");
  });

  it("strips and re-applies SPEAKER: prefix by default", async () => {
    const out = await translateCues(
      [cue({ text: "MAYA: Let's go.", speaker: "MAYA" })],
      "es",
      { translate: async () => ["¡Vamos!"] },
    );
    expect(out[0].text).toBe("MAYA: ¡Vamos!");
  });

  it("does not alter prefix when preserveSpeakerPrefix is false", async () => {
    const captured: string[] = [];
    const capturing: TranslateBatch = async (lines) => {
      captured.push(...lines);
      return lines.map(() => "translated");
    };
    await translateCues(
      [cue({ text: "MAYA: Let's go." })],
      "es",
      { translate: capturing, preserveSpeakerPrefix: false },
    );
    expect(captured[0]).toBe("MAYA: Let's go.");
  });

  it("batches in chunks of batchSize", async () => {
    const batches: number[] = [];
    const capturing: TranslateBatch = async (lines) => {
      batches.push(lines.length);
      return lines.map(() => "x");
    };
    const cues = Array.from({ length: 9 }, (_, i) =>
      cue({ index: i + 1, text: `line ${i}` }),
    );
    await translateCues(cues, "es", {
      translate: capturing,
      batchSize: 4,
    });
    expect(batches).toEqual([4, 4, 1]);
  });

  it("raises when translator returns wrong number of lines", async () => {
    const bad: TranslateBatch = async () => ["only one"];
    await expect(
      translateCues([cue(), cue({ index: 2 })], "es", { translate: bad }),
    ).rejects.toThrow(/returned/);
  });

  it("passes translator as passthrough when locale happens to be en", async () => {
    // Redundant belt+suspenders — short-circuit should fire first.
    const out = await translateCues([cue()], "en", {
      translate: passthroughTranslator,
    });
    expect(out[0].text).toBe("Hello.");
  });
});

describe("fingerprintCueTexts", () => {
  it("returns a stable 8-char hex string", () => {
    const h = fingerprintCueTexts(["hello", "world"]);
    expect(h).toMatch(/^[0-9a-f]{8}$/);
  });

  it("is deterministic", () => {
    const a = fingerprintCueTexts(["hello", "world"]);
    const b = fingerprintCueTexts(["hello", "world"]);
    expect(a).toBe(b);
  });

  it("distinguishes inputs that share characters but not framing", () => {
    // Without the `\n` delimiter these would collide.
    const a = fingerprintCueTexts(["ab", "c"]);
    const b = fingerprintCueTexts(["a", "bc"]);
    expect(a).not.toBe(b);
  });

  it("differs when any cue changes", () => {
    const a = fingerprintCueTexts(["hello", "world"]);
    const b = fingerprintCueTexts(["hello", "worlds"]);
    expect(a).not.toBe(b);
  });

  it("handles empty input (stable fingerprint)", () => {
    expect(fingerprintCueTexts([])).toMatch(/^[0-9a-f]{8}$/);
  });

  it("is order-sensitive", () => {
    const a = fingerprintCueTexts(["one", "two"]);
    const b = fingerprintCueTexts(["two", "one"]);
    expect(a).not.toBe(b);
  });

  it("distinguishes SPEAKER prefix from body", () => {
    const a = fingerprintCueTexts(["MAYA: Let's go."]);
    const b = fingerprintCueTexts(["Let's go."]);
    expect(a).not.toBe(b);
  });
});
