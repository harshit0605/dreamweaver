import { describe, expect, it } from "bun:test";
import {
  buildDialogueMixArgs,
  buildMixPlan,
  DIALOGUE_GAP_SECONDS,
  DIALOGUE_MIX_SAMPLE_RATE,
} from "@/lib/dialogue-mix";
import type { DialogueLine } from "@/lib/dialogue-extract";

const mkLine = (overrides: Partial<DialogueLine>): DialogueLine => ({
  speaker: null,
  text: "",
  offset: 0,
  ...overrides,
});

describe("buildMixPlan", () => {
  const voices = { MAYA: "nova", DANIEL: "onyx" };

  it("returns null for zero lines", () => {
    expect(
      buildMixPlan({
        lines: [],
        speakerVoices: voices,
        defaultVoice: "alloy",
      }),
    ).toBeNull();
  });

  it("returns null for exactly one line (fall back to single-voice path)", () => {
    const plan = buildMixPlan({
      lines: [mkLine({ speaker: "MAYA", text: "Go." })],
      speakerVoices: voices,
      defaultVoice: "alloy",
    });
    expect(plan).toBeNull();
  });

  it("assigns per-speaker voice + falls back to default for unassigned speaker", () => {
    const plan = buildMixPlan({
      lines: [
        mkLine({ speaker: "MAYA", text: "Go." }),
        mkLine({ speaker: "RITA", text: "Wait!" }),
      ],
      speakerVoices: voices,
      defaultVoice: "alloy",
    });
    expect(plan).not.toBeNull();
    expect(plan![0]).toMatchObject({ speaker: "MAYA", voice: "nova" });
    // RITA has no mapping → default.
    expect(plan![1]).toMatchObject({ speaker: "RITA", voice: "alloy" });
  });

  it("normalizes speaker ids to UPPERCASE", () => {
    const plan = buildMixPlan({
      lines: [
        mkLine({ speaker: "maya", text: "lower." }),
        mkLine({ speaker: "DANIEL", text: "upper." }),
      ],
      speakerVoices: voices,
      defaultVoice: "alloy",
    });
    expect(plan![0].speaker).toBe("MAYA");
    expect(plan![0].voice).toBe("nova");
  });

  it("drops empty / whitespace-only lines before deciding", () => {
    const plan = buildMixPlan({
      lines: [
        mkLine({ speaker: "MAYA", text: "   " }),
        mkLine({ speaker: "DANIEL", text: "One." }),
        mkLine({ speaker: "MAYA", text: "Two." }),
      ],
      speakerVoices: voices,
      defaultVoice: "alloy",
    });
    expect(plan).toHaveLength(2);
    expect(plan![0].text).toBe("One.");
    expect(plan![1].text).toBe("Two.");
  });

  it("caps at maxLines (default 8)", () => {
    const lines: DialogueLine[] = Array.from({ length: 20 }, (_, i) =>
      mkLine({ speaker: "MAYA", text: `line ${i}` }),
    );
    const plan = buildMixPlan({
      lines,
      speakerVoices: voices,
      defaultVoice: "alloy",
    });
    expect(plan).toHaveLength(8);
    // …but still returns null when maxLines=1 effectively.
    const capped = buildMixPlan({
      lines,
      speakerVoices: voices,
      defaultVoice: "alloy",
      maxLines: 1,
    });
    expect(capped).toBeNull();
  });

  it("preserves input order via `index`", () => {
    const plan = buildMixPlan({
      lines: [
        mkLine({ speaker: "A", text: "a" }),
        mkLine({ speaker: "B", text: "b" }),
        mkLine({ speaker: "C", text: "c" }),
      ],
      speakerVoices: voices,
      defaultVoice: "alloy",
    });
    expect(plan!.map((l) => l.index)).toEqual([0, 1, 2]);
  });

  it("null speaker falls back to default voice", () => {
    const plan = buildMixPlan({
      lines: [
        mkLine({ speaker: null, text: "Unattributed 1" }),
        mkLine({ speaker: null, text: "Unattributed 2" }),
      ],
      speakerVoices: voices,
      defaultVoice: "shimmer",
    });
    expect(plan![0].voice).toBe("shimmer");
    expect(plan![1].voice).toBe("shimmer");
  });
});

describe("buildDialogueMixArgs", () => {
  it("throws on empty line list", () => {
    expect(() => buildDialogueMixArgs([], "/tmp/out.mp3")).toThrow();
  });

  it("handles the single-line degenerate case without a filter_complex graph", () => {
    const args = buildDialogueMixArgs(["/tmp/line_0.mp3"], "/tmp/out.mp3");
    // Single-line path uses -af (simple filter) not -filter_complex.
    expect(args).toContain("-af");
    expect(args).not.toContain("-filter_complex");
    expect(args).toContain("libmp3lame");
    expect(args[args.length - 1]).toBe("/tmp/out.mp3");
  });

  it("emits one -i per line and one filter_complex with concat=n=<count>", () => {
    const args = buildDialogueMixArgs(
      ["/tmp/l0.mp3", "/tmp/l1.mp3", "/tmp/l2.mp3"],
      "/tmp/mix.mp3",
    );
    const inputCount = args.filter((a) => a === "-i").length;
    expect(inputCount).toBe(3);
    const filterIdx = args.indexOf("-filter_complex");
    expect(filterIdx).toBeGreaterThan(-1);
    const filterGraph = args[filterIdx + 1];
    expect(filterGraph).toContain("concat=n=3:v=0:a=1");
    // Every non-final input should be padded; the final one must not be.
    expect(filterGraph).toContain("[0:a]");
    expect(filterGraph).toContain("[1:a]");
    expect(filterGraph).toContain("[2:a]");
    const lastNormalized = filterGraph
      .split(";")
      .find((chunk) => chunk.startsWith("[2:a]"));
    expect(lastNormalized).toBeDefined();
    expect(lastNormalized!).not.toContain("apad");
    // Non-final lines carry apad with the default gap.
    const firstNormalized = filterGraph
      .split(";")
      .find((chunk) => chunk.startsWith("[0:a]"));
    expect(firstNormalized!).toContain(`apad=pad_dur=${DIALOGUE_GAP_SECONDS}`);
  });

  it("normalizes every input to the canonical sample rate + mono layout", () => {
    const args = buildDialogueMixArgs(
      ["/tmp/l0.mp3", "/tmp/l1.mp3"],
      "/tmp/mix.mp3",
    );
    const filter = args[args.indexOf("-filter_complex") + 1];
    expect(filter).toContain(
      `aformat=sample_rates=${DIALOGUE_MIX_SAMPLE_RATE}:channel_layouts=mono`,
    );
    // Output encoding also locks to the canonical shape.
    expect(args[args.indexOf("-ar") + 1]).toBe(String(DIALOGUE_MIX_SAMPLE_RATE));
    expect(args[args.indexOf("-ac") + 1]).toBe("1");
    expect(args).toContain("libmp3lame");
  });

  it("omits apad when gapSeconds is 0", () => {
    const args = buildDialogueMixArgs(
      ["/tmp/l0.mp3", "/tmp/l1.mp3"],
      "/tmp/mix.mp3",
      0,
    );
    const filter = args[args.indexOf("-filter_complex") + 1];
    expect(filter).not.toContain("apad");
  });

  it("accepts a custom gap duration", () => {
    const args = buildDialogueMixArgs(
      ["/tmp/l0.mp3", "/tmp/l1.mp3"],
      "/tmp/mix.mp3",
      1.5,
    );
    const filter = args[args.indexOf("-filter_complex") + 1];
    expect(filter).toContain("apad=pad_dur=1.5");
  });

  it("places the output path as the last argv entry", () => {
    const args = buildDialogueMixArgs(
      ["/tmp/a.mp3", "/tmp/b.mp3"],
      "/tmp/out.mp3",
    );
    expect(args[args.length - 1]).toBe("/tmp/out.mp3");
  });
});
