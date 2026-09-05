import { describe, expect, it } from "bun:test";

import {
  buildForceStyleString,
  buildSubtitleCues,
  renderSrt,
  renderVtt,
  subtitleOverlayCss,
  type SubtitleShotInput,
  type SubtitleStyle,
} from "@/lib/subtitles";

const shot = (
  overrides: Partial<SubtitleShotInput> = {},
): SubtitleShotInput => ({
  nodeId: "n",
  segment: "",
  durationS: 5,
  ...overrides,
});

describe("buildSubtitleCues", () => {
  it("returns [] for zero shots", () => {
    expect(buildSubtitleCues([])).toEqual([]);
  });

  it("returns [] when no shot has attributed dialogue", () => {
    expect(
      buildSubtitleCues([
        shot({ nodeId: "s1", segment: "A wide shot of the desert." }),
      ]),
    ).toEqual([]);
  });

  it("skips unattributed quoted lines (null speaker)", () => {
    expect(
      buildSubtitleCues([
        shot({
          nodeId: "s1",
          segment: 'A voice whispers: "Where am I?"',
        }),
      ]),
    ).toEqual([]);
  });

  it("builds one cue per attributed line with speaker prefix", () => {
    const cues = buildSubtitleCues([
      shot({ nodeId: "s1", segment: '<MAYA> says, "Hello."' }),
    ]);
    expect(cues).toHaveLength(1);
    expect(cues[0].index).toBe(1);
    expect(cues[0].nodeId).toBe("s1");
    expect(cues[0].speaker).toBe("MAYA");
    expect(cues[0].text).toBe("MAYA: Hello.");
  });

  it("lays shots end-to-end so cue offsets accumulate", () => {
    const cues = buildSubtitleCues([
      shot({ nodeId: "s1", segment: '<MAYA> says, "one."', durationS: 3 }),
      shot({ nodeId: "s2", segment: '<DANIEL> says, "two."', durationS: 2 }),
    ]);
    expect(cues).toHaveLength(2);
    expect(cues[0].startS).toBe(0);
    expect(cues[1].startS).toBe(3);
    expect(cues[1].endS).toBe(5);
  });

  it("distributes lines proportionally to character count within a shot", () => {
    const cues = buildSubtitleCues([
      shot({
        nodeId: "s1",
        // "yes" (3 chars) vs "I remember everything" (21 chars) = 1 vs 7 shares.
        segment: '<MAYA> says, "yes." <DANIEL>: "I remember everything."',
        durationS: 8,
      }),
    ]);
    expect(cues).toHaveLength(2);
    // First cue should be proportionally shorter — well under half the shot.
    expect(cues[0].endS).toBeLessThan(4);
    // Last cue must end at the shot boundary exactly.
    expect(cues[1].endS).toBe(8);
  });

  it("enforces the minimum cue duration floor", () => {
    const cues = buildSubtitleCues(
      [
        shot({
          nodeId: "s1",
          segment: '<MAYA> says, "yes." <DANIEL>: "very very very long text here"',
          durationS: 4,
        }),
      ],
      { minCueDurationS: 0.8 },
    );
    // The short "yes" proportional slice < 0.8 is raised.
    expect(cues[0].endS - cues[0].startS).toBeGreaterThanOrEqual(0.8);
  });

  it("allows disabling the speaker prefix", () => {
    const cues = buildSubtitleCues(
      [shot({ nodeId: "s1", segment: '<MAYA> says, "Hello."' })],
      { speakerPrefix: false },
    );
    expect(cues[0].text).toBe("Hello.");
  });

  it("clamps non-positive durations to a 1-second floor", () => {
    const cues = buildSubtitleCues([
      shot({
        nodeId: "s1",
        segment: '<MAYA> says, "Hello."',
        durationS: 0,
      }),
    ]);
    expect(cues[0].endS).toBeGreaterThan(0);
  });

  it("numbers cues from 1 across the whole reel", () => {
    const cues = buildSubtitleCues([
      shot({ nodeId: "s1", segment: '<MAYA> says, "a."' }),
      shot({ nodeId: "s2", segment: '<DANIEL> says, "b."' }),
      shot({ nodeId: "s3", segment: '<MAYA> says, "c."' }),
    ]);
    expect(cues.map((c) => c.index)).toEqual([1, 2, 3]);
  });

  it("holds shot offsets even when a shot has no dialogue", () => {
    const cues = buildSubtitleCues([
      shot({ nodeId: "s1", segment: "wide landscape shot", durationS: 3 }),
      shot({ nodeId: "s2", segment: '<MAYA> says, "go."', durationS: 4 }),
    ]);
    expect(cues).toHaveLength(1);
    expect(cues[0].startS).toBe(3);
    expect(cues[0].endS).toBe(7);
  });
});

describe("renderSrt", () => {
  it("returns empty string when there are no cues", () => {
    expect(renderSrt([])).toBe("");
  });

  it("formats cues with 1-indexed ids + HH:MM:SS,mmm timestamps", () => {
    const srt = renderSrt(
      buildSubtitleCues([
        shot({
          nodeId: "s1",
          segment: '<MAYA> says, "Hello."',
          durationS: 2,
        }),
      ]),
    );
    expect(srt).toContain("1\n");
    expect(srt).toMatch(/\d{2}:\d{2}:\d{2},\d{3} --> \d{2}:\d{2}:\d{2},\d{3}/);
    expect(srt).toContain("MAYA: Hello.");
  });

  it("separates cues with a blank line", () => {
    const srt = renderSrt(
      buildSubtitleCues([
        shot({ nodeId: "s1", segment: '<MAYA> says, "one."' }),
        shot({ nodeId: "s2", segment: '<DANIEL> says, "two."' }),
      ]),
    );
    expect(srt.split("\n\n").length).toBeGreaterThanOrEqual(2);
  });
});

describe("renderVtt", () => {
  it("always emits the WEBVTT header", () => {
    expect(renderVtt([]).startsWith("WEBVTT\n")).toBe(true);
    expect(renderVtt(buildSubtitleCues([])).startsWith("WEBVTT\n")).toBe(true);
  });

  it("uses `.` millisecond separator (VTT) instead of `,` (SRT)", () => {
    const vtt = renderVtt(
      buildSubtitleCues([
        shot({ nodeId: "s1", segment: '<MAYA> says, "Hello."' }),
      ]),
    );
    expect(vtt).toMatch(/\d{2}:\d{2}:\d{2}\.\d{3} --> \d{2}:\d{2}:\d{2}\.\d{3}/);
    expect(vtt).not.toMatch(/,\d{3}/);
  });
});

describe("buildForceStyleString", () => {
  it("returns empty string for an empty style", () => {
    expect(buildForceStyleString({})).toBe("");
  });

  it("emits comma-separated KEY=VALUE pairs", () => {
    const s = buildForceStyleString({
      fontSizePx: 24,
      fontFamily: "Inter",
    });
    const parts = s.split(",");
    expect(parts).toContain("FontSize=24");
    expect(parts).toContain("FontName=Inter");
  });

  it("converts hex colors to libass BGRA with 00 alpha", () => {
    const s = buildForceStyleString({
      colorHex: "FFD700",
      outlineHex: "#123456",
    });
    // FFD700 → libass BGR reversed = 00D7FF with 00 alpha prefix.
    expect(s).toContain("PrimaryColour=&H0000D7FF");
    // 123456 → 563412 reversed.
    expect(s).toContain("OutlineColour=&H00563412");
  });

  it("drops malformed hex colors instead of emitting garbage", () => {
    const s = buildForceStyleString({
      colorHex: "not-a-color",
      fontSizePx: 20,
    });
    expect(s).not.toContain("PrimaryColour");
    expect(s).toContain("FontSize=20");
  });

  it("maps position to libass Alignment codes", () => {
    expect(buildForceStyleString({ position: "bottom" })).toBe("Alignment=2");
    expect(buildForceStyleString({ position: "middle" })).toBe("Alignment=5");
    expect(buildForceStyleString({ position: "top" })).toBe("Alignment=8");
  });

  it("strips commas from font family names (libass separator conflict)", () => {
    const s = buildForceStyleString({ fontFamily: "Inter, Helvetica, sans" });
    expect(s).toBe("FontName=Inter Helvetica sans");
  });

  it("applies BorderStyle=3 with default Outline=2 when boxBackground is true", () => {
    const s = buildForceStyleString({ boxBackground: true });
    const parts = s.split(",");
    expect(parts).toContain("BorderStyle=3");
    expect(parts).toContain("Outline=2");
  });

  it("respects explicit outlineWidthPx=0 even when boxBackground is on", () => {
    const s = buildForceStyleString({
      boxBackground: true,
      outlineWidthPx: 0,
    });
    const parts = s.split(",");
    expect(parts).toContain("BorderStyle=3");
    expect(parts).toContain("Outline=0");
    // Does not append a second Outline entry.
    expect(parts.filter((p) => p.startsWith("Outline=")).length).toBe(1);
  });

  it("rounds non-integer sizes", () => {
    const s = buildForceStyleString({ fontSizePx: 23.6 });
    expect(s).toBe("FontSize=24");
  });

  it("ignores zero / negative margin", () => {
    expect(buildForceStyleString({ marginVerticalPx: 0 })).toBe("");
    expect(buildForceStyleString({ marginVerticalPx: -10 })).toBe("");
  });

  it("emits MarginV when positive", () => {
    expect(buildForceStyleString({ marginVerticalPx: 40 })).toBe("MarginV=40");
  });
});

describe("subtitleOverlayCss", () => {
  it("places bottom-positioned captions at the default margin", () => {
    const { container } = subtitleOverlayCss({});
    expect(container.bottom).toBe("48px");
    expect(container.top).toBeUndefined();
  });

  it("places top-positioned captions at margin", () => {
    const { container } = subtitleOverlayCss({ position: "top" });
    expect(container.top).toBe("48px");
    expect(container.bottom).toBeUndefined();
  });

  it("centers middle captions with transform", () => {
    const { container } = subtitleOverlayCss({ position: "middle" });
    expect(container.top).toBe("50%");
    expect(container.transform).toBe("translateY(-50%)");
  });

  it("honors explicit marginVerticalPx", () => {
    const { container } = subtitleOverlayCss({ marginVerticalPx: 100 });
    expect(container.bottom).toBe("100px");
  });

  it("scales font size to roughly half of the libass pt for the preview", () => {
    const { text } = subtitleOverlayCss({ fontSizePx: 48 });
    // Math.round(48 * 0.5) = 24
    expect(text.fontSize).toBe("24px");
  });

  it("floors font size to 10px so very small libass sizes stay readable in preview", () => {
    const { text } = subtitleOverlayCss({ fontSizePx: 8 });
    expect(text.fontSize).toBe("10px");
  });

  it("emits an 8-direction text-shadow for the outline", () => {
    const { text } = subtitleOverlayCss({
      outlineHex: "000000",
      outlineWidthPx: 2,
    });
    expect(text.textShadow).toContain("2px 2px");
    expect(text.textShadow).toContain("-2px -2px");
    expect(text.textShadow).toContain("#000000");
  });

  it("disables text-shadow when outlineWidthPx is 0", () => {
    const { text } = subtitleOverlayCss({ outlineWidthPx: 0 });
    expect(text.textShadow).toBe("none");
  });

  it("applies a translucent box background when boxBackground is on", () => {
    const { text } = subtitleOverlayCss({ boxBackground: true });
    expect(text.backgroundColor).toBe("rgba(0, 0, 0, 0.75)");
    // Box + outline overlap visually — drop the outline when boxed.
    expect(text.textShadow).toBe("none");
  });

  it("color and outline hex both honor a leading '#'", () => {
    const { text } = subtitleOverlayCss({
      colorHex: "#FFD700",
      outlineHex: "#123456",
    } as SubtitleStyle);
    expect(text.color).toBe("#FFD700");
    expect(text.textShadow).toContain("#123456");
  });
});
