import { describe, expect, it } from "bun:test";

import {
  buildPlaceholderSfxArgs,
  buildSfxMixArgs,
  DEFAULT_SFX_DURATION_S,
  DEFAULT_SFX_VOLUME_DB,
  deriveSfxDurationForShot,
  deriveSfxPromptForShot,
  normalizeSfxDescriptor,
  SFX_MAX_DURATION_S,
  SFX_MAX_VOLUME_DB,
  SFX_MIN_DURATION_S,
  SFX_MIN_VOLUME_DB,
  SFX_PROMPT_MAX_CHARS,
} from "@/lib/sfx";

describe("normalizeSfxDescriptor", () => {
  it("returns null for nullish / missing input", () => {
    expect(normalizeSfxDescriptor(null)).toBeNull();
    expect(normalizeSfxDescriptor(undefined)).toBeNull();
    expect(normalizeSfxDescriptor({})).toBeNull();
  });

  it("returns null for empty / whitespace prompt", () => {
    expect(normalizeSfxDescriptor({ prompt: "" })).toBeNull();
    expect(normalizeSfxDescriptor({ prompt: "   " })).toBeNull();
  });

  it("trims and caps the prompt at SFX_PROMPT_MAX_CHARS", () => {
    const long = "x".repeat(600);
    const result = normalizeSfxDescriptor({ prompt: long });
    expect(result?.prompt.length).toBe(SFX_PROMPT_MAX_CHARS);
  });

  it("defaults duration to the minimum when absent", () => {
    const result = normalizeSfxDescriptor({ prompt: "rain" });
    expect(result?.durationS).toBe(SFX_MIN_DURATION_S);
  });

  it("clamps duration into [SFX_MIN, SFX_MAX]", () => {
    expect(
      normalizeSfxDescriptor({ prompt: "rain", durationS: 100 })?.durationS,
    ).toBe(SFX_MAX_DURATION_S);
    expect(
      normalizeSfxDescriptor({ prompt: "rain", durationS: 0 })?.durationS,
    ).toBe(SFX_MIN_DURATION_S);
  });

  it("defaults volumeDb to the producer-friendly fallback", () => {
    const result = normalizeSfxDescriptor({ prompt: "rain" });
    expect(result?.volumeDb).toBe(DEFAULT_SFX_VOLUME_DB);
  });

  it("clamps volumeDb into [SFX_MIN_VOLUME_DB, SFX_MAX_VOLUME_DB]", () => {
    expect(
      normalizeSfxDescriptor({ prompt: "rain", volumeDb: 10 })?.volumeDb,
    ).toBe(SFX_MAX_VOLUME_DB);
    expect(
      normalizeSfxDescriptor({ prompt: "rain", volumeDb: -100 })?.volumeDb,
    ).toBe(SFX_MIN_VOLUME_DB);
  });

  it("rejects NaN / Infinity by substituting defaults", () => {
    const result = normalizeSfxDescriptor({
      prompt: "rain",
      durationS: Number.NaN,
      volumeDb: Number.POSITIVE_INFINITY,
    });
    expect(result?.durationS).toBe(SFX_MIN_DURATION_S);
    expect(result?.volumeDb).toBe(DEFAULT_SFX_VOLUME_DB);
  });
});

describe("deriveSfxPromptForShot", () => {
  it("prefers shotMeta.sfx hints over segment text", () => {
    const p = deriveSfxPromptForShot({
      segment: "Maya walks into the crowded street at night.",
      shotMeta: { sfx: ["city crowd", "traffic"] },
    });
    expect(p).toBe("city crowd, traffic");
  });

  it("drops empty / whitespace hints", () => {
    const p = deriveSfxPromptForShot({
      segment: "—",
      shotMeta: { sfx: ["", "  ", "thunder"] },
    });
    expect(p).toBe("thunder");
  });

  it("falls back to the segment's first sentence", () => {
    const p = deriveSfxPromptForShot({
      segment: "Rain taps on glass. Her breath fogs the window.",
    });
    expect(p).toBe("Rain taps on glass.");
  });

  it("caps segment fallback at 160 chars", () => {
    const long = "a".repeat(300);
    const p = deriveSfxPromptForShot({ segment: long });
    expect(p?.length).toBe(160);
  });

  it("returns null when there's no signal", () => {
    expect(deriveSfxPromptForShot({})).toBeNull();
    expect(deriveSfxPromptForShot({ segment: "   " })).toBeNull();
    expect(deriveSfxPromptForShot({ shotMeta: { sfx: [] } })).toBeNull();
  });

  it("treats non-string entries in sfx as empty", () => {
    const p = deriveSfxPromptForShot({
      shotMeta: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        sfx: [null as any, "rain", undefined as any],
      },
    });
    expect(p).toBe("rain");
  });

  it("caps joined hint output at SFX_PROMPT_MAX_CHARS", () => {
    const many = Array.from({ length: 50 }, () => "a".repeat(20));
    const p = deriveSfxPromptForShot({ shotMeta: { sfx: many } });
    expect(p?.length).toBeLessThanOrEqual(SFX_PROMPT_MAX_CHARS);
  });
});

describe("deriveSfxDurationForShot", () => {
  it("uses shotMeta.durationS when present", () => {
    expect(deriveSfxDurationForShot({ shotMeta: { durationS: 7 } })).toBe(7);
  });

  it("clamps into the SFX duration window", () => {
    expect(deriveSfxDurationForShot({ shotMeta: { durationS: 999 } })).toBe(
      SFX_MAX_DURATION_S,
    );
    expect(deriveSfxDurationForShot({ shotMeta: { durationS: 0 } })).toBe(
      SFX_MIN_DURATION_S,
    );
  });

  it("falls back to DEFAULT_SFX_DURATION_S when absent or invalid", () => {
    expect(deriveSfxDurationForShot({})).toBe(DEFAULT_SFX_DURATION_S);
    expect(
      deriveSfxDurationForShot({ shotMeta: { durationS: Number.NaN } }),
    ).toBe(DEFAULT_SFX_DURATION_S);
  });
});

describe("buildSfxMixArgs", () => {
  it("produces a filter_complex that pipes through aformat + volume + amix", () => {
    const args = buildSfxMixArgs({
      narrationPath: "/tmp/narration.mp3",
      sfxPath: "/tmp/sfx.mp3",
      outputPath: "/tmp/mixed.mp3",
      volumeDb: -12,
    });
    const filter = args[args.indexOf("-filter_complex") + 1];
    expect(filter).toContain("aformat=sample_rates=44100:channel_layouts=mono");
    expect(filter).toContain("volume=-12dB");
    expect(filter).toContain("amix=inputs=2:duration=first");
  });

  it("clamps out-of-range volumeDb inside the filter graph", () => {
    const loud = buildSfxMixArgs({
      narrationPath: "/tmp/n.mp3",
      sfxPath: "/tmp/s.mp3",
      outputPath: "/tmp/o.mp3",
      volumeDb: 50,
    });
    expect(loud[loud.indexOf("-filter_complex") + 1]).toContain(
      `volume=${SFX_MAX_VOLUME_DB}dB`,
    );
    const quiet = buildSfxMixArgs({
      narrationPath: "/tmp/n.mp3",
      sfxPath: "/tmp/s.mp3",
      outputPath: "/tmp/o.mp3",
      volumeDb: -200,
    });
    expect(quiet[quiet.indexOf("-filter_complex") + 1]).toContain(
      `volume=${SFX_MIN_VOLUME_DB}dB`,
    );
  });

  it("outputs to the canonical 44.1 kHz mono mp3 shape", () => {
    const args = buildSfxMixArgs({
      narrationPath: "/tmp/n.mp3",
      sfxPath: "/tmp/s.mp3",
      outputPath: "/tmp/mix.mp3",
      volumeDb: -6,
    });
    expect(args).toContain("libmp3lame");
    expect(args[args.indexOf("-ar") + 1]).toBe("44100");
    expect(args[args.indexOf("-ac") + 1]).toBe("1");
    expect(args[args.length - 1]).toBe("/tmp/mix.mp3");
  });

  it("maps the narration input first so amix uses its duration", () => {
    const args = buildSfxMixArgs({
      narrationPath: "/tmp/narr.mp3",
      sfxPath: "/tmp/sfx.mp3",
      outputPath: "/tmp/out.mp3",
      volumeDb: -12,
    });
    const firstI = args.indexOf("-i");
    const secondI = args.indexOf("-i", firstI + 1);
    expect(args[firstI + 1]).toBe("/tmp/narr.mp3");
    expect(args[secondI + 1]).toBe("/tmp/sfx.mp3");
  });
});

describe("buildPlaceholderSfxArgs", () => {
  it("uses anoisesrc white-noise at the requested duration", () => {
    const args = buildPlaceholderSfxArgs({
      outputPath: "/tmp/sfx.mp3",
      durationS: 3,
    });
    expect(args).toContain("lavfi");
    expect(args[args.indexOf("-i") + 1]).toContain("anoisesrc=color=white");
    expect(args[args.indexOf("-t") + 1]).toBe("3");
    expect(args[args.length - 1]).toBe("/tmp/sfx.mp3");
  });

  it("clamps duration into the canonical window", () => {
    const long = buildPlaceholderSfxArgs({
      outputPath: "/tmp/sfx.mp3",
      durationS: 999,
    });
    expect(long[long.indexOf("-t") + 1]).toBe(String(SFX_MAX_DURATION_S));
    const zero = buildPlaceholderSfxArgs({
      outputPath: "/tmp/sfx.mp3",
      durationS: 0,
    });
    expect(zero[zero.indexOf("-t") + 1]).toBe(String(SFX_MIN_DURATION_S));
  });
});
