import { describe, expect, it } from "bun:test";

import {
  buildScoreMixArgs,
  DEFAULT_SCORE_DURATION_S,
  DEFAULT_SCORE_VOLUME_DB,
  normalizeScoreDescriptor,
  SCORE_MAX_DURATION_S,
  SCORE_MAX_VOLUME_DB,
  SCORE_MIN_DURATION_S,
  SCORE_MIN_VOLUME_DB,
  SCORE_PROMPT_MAX_CHARS,
} from "@/lib/score";

describe("normalizeScoreDescriptor", () => {
  it("returns null for empty or missing prompt", () => {
    expect(normalizeScoreDescriptor(null)).toBeNull();
    expect(normalizeScoreDescriptor({})).toBeNull();
    expect(normalizeScoreDescriptor({ prompt: "" })).toBeNull();
    expect(normalizeScoreDescriptor({ prompt: "   " })).toBeNull();
  });

  it("defaults to DEFAULT_SCORE_DURATION_S when missing", () => {
    const d = normalizeScoreDescriptor({ prompt: "piano underscore" });
    expect(d?.durationS).toBe(DEFAULT_SCORE_DURATION_S);
  });

  it("clamps duration into [10, 300]", () => {
    expect(
      normalizeScoreDescriptor({ prompt: "x", durationS: 5 })?.durationS,
    ).toBe(SCORE_MIN_DURATION_S);
    expect(
      normalizeScoreDescriptor({ prompt: "x", durationS: 10000 })?.durationS,
    ).toBe(SCORE_MAX_DURATION_S);
  });

  it("defaults volume to the narration-respecting fallback", () => {
    const d = normalizeScoreDescriptor({ prompt: "x" });
    expect(d?.volumeDb).toBe(DEFAULT_SCORE_VOLUME_DB);
  });

  it("clamps volume into the dB window", () => {
    expect(
      normalizeScoreDescriptor({ prompt: "x", volumeDb: 10 })?.volumeDb,
    ).toBe(SCORE_MAX_VOLUME_DB);
    expect(
      normalizeScoreDescriptor({ prompt: "x", volumeDb: -100 })?.volumeDb,
    ).toBe(SCORE_MIN_VOLUME_DB);
  });

  it("trims and caps the prompt", () => {
    const long = "a".repeat(1000);
    const d = normalizeScoreDescriptor({ prompt: long });
    expect(d?.prompt.length).toBe(SCORE_PROMPT_MAX_CHARS);
  });

  it("substitutes defaults for NaN / Infinity", () => {
    const d = normalizeScoreDescriptor({
      prompt: "x",
      durationS: Number.NaN,
      volumeDb: Number.POSITIVE_INFINITY,
    });
    expect(d?.durationS).toBe(DEFAULT_SCORE_DURATION_S);
    expect(d?.volumeDb).toBe(DEFAULT_SCORE_VOLUME_DB);
  });
});

describe("buildScoreMixArgs", () => {
  it("re-encodes only audio; video stream-copies", () => {
    const args = buildScoreMixArgs({
      reelPath: "/tmp/reel.mp4",
      scorePath: "/tmp/score.mp3",
      outputPath: "/tmp/out.mp4",
      volumeDb: -18,
    });
    expect(args).toContain("copy"); // -c:v copy
    expect(args).toContain("aac");  // -c:a aac
    const vIdx = args.findIndex((v, i) => v === "-c:v" && args[i + 1] === "copy");
    expect(vIdx).toBeGreaterThan(-1);
    const aIdx = args.findIndex((v, i) => v === "-c:a" && args[i + 1] === "aac");
    expect(aIdx).toBeGreaterThan(-1);
  });

  it("amix bounds output to the reel's duration (duration=first)", () => {
    const args = buildScoreMixArgs({
      reelPath: "/tmp/r.mp4",
      scorePath: "/tmp/s.mp3",
      outputPath: "/tmp/o.mp4",
      volumeDb: -12,
    });
    const filter = args[args.indexOf("-filter_complex") + 1];
    expect(filter).toContain("amix=inputs=2:duration=first");
  });

  it("clamps volumeDb outside the range", () => {
    const loud = buildScoreMixArgs({
      reelPath: "/tmp/r.mp4",
      scorePath: "/tmp/s.mp3",
      outputPath: "/tmp/o.mp4",
      volumeDb: 50,
    });
    expect(loud[loud.indexOf("-filter_complex") + 1]).toContain(
      `volume=${SCORE_MAX_VOLUME_DB}dB`,
    );
    const quiet = buildScoreMixArgs({
      reelPath: "/tmp/r.mp4",
      scorePath: "/tmp/s.mp3",
      outputPath: "/tmp/o.mp4",
      volumeDb: -200,
    });
    expect(quiet[quiet.indexOf("-filter_complex") + 1]).toContain(
      `volume=${SCORE_MIN_VOLUME_DB}dB`,
    );
  });

  it("outputs 48kHz stereo AAC to match the reel pipeline", () => {
    const args = buildScoreMixArgs({
      reelPath: "/tmp/r.mp4",
      scorePath: "/tmp/s.mp3",
      outputPath: "/tmp/o.mp4",
      volumeDb: -18,
    });
    expect(args[args.indexOf("-ar") + 1]).toBe("48000");
    expect(args[args.indexOf("-ac") + 1]).toBe("2");
  });

  it("puts reel audio first so amix's duration=first bounds to the reel", () => {
    const args = buildScoreMixArgs({
      reelPath: "/tmp/reel.mp4",
      scorePath: "/tmp/score.mp3",
      outputPath: "/tmp/out.mp4",
      volumeDb: -18,
    });
    const firstI = args.indexOf("-i");
    const secondI = args.indexOf("-i", firstI + 1);
    expect(args[firstI + 1]).toBe("/tmp/reel.mp4");
    expect(args[secondI + 1]).toBe("/tmp/score.mp3");
  });
});
