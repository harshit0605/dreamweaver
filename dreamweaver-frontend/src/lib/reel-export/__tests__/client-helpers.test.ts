import { describe, expect, it } from "bun:test";
import {
  buildClientConcatListText,
  buildClientNormalizeArgs,
  buildClientScalePadFilter,
  CLIENT_REEL_TARGET_FPS,
  CLIENT_REEL_TARGET_HEIGHT,
  CLIENT_REEL_TARGET_WIDTH,
} from "@/lib/reel-export/client";
import type { ReelShot } from "@/app/api/storyboard/reel-manifest/route";

const mkShot = (overrides: Partial<ReelShot> = {}): ReelShot => ({
  nodeId: "n",
  index: 0,
  number: null,
  label: "Shot",
  durationS: 5,
  videoUrl: null,
  imageUrl: null,
  audioUrl: null,
  sfxUrl: null,
  sfxVolumeDb: null,
  prompt: null,
  ...overrides,
});

describe("buildClientScalePadFilter", () => {
  it("targets the uniform 1920x1080@30 output", () => {
    const s = buildClientScalePadFilter();
    expect(s).toContain(`scale=${CLIENT_REEL_TARGET_WIDTH}:${CLIENT_REEL_TARGET_HEIGHT}`);
    expect(s).toContain(`fps=${CLIENT_REEL_TARGET_FPS}`);
    expect(s).toContain("setsar=1");
    expect(s).toContain("pad=");
  });
});

describe("buildClientNormalizeArgs", () => {
  it("video + audio: maps video from input 0, audio from input 1", () => {
    const args = buildClientNormalizeArgs({
      shot: mkShot(),
      videoName: "v.mp4",
      imageName: null,
      audioName: "a.mp3",
      outputName: "out.mp4",
    });
    expect(args).toContain("0:v:0");
    expect(args).toContain("1:a:0");
    expect(args).toContain("-shortest");
  });

  it("video only: single input, baked-in audio path", () => {
    const args = buildClientNormalizeArgs({
      shot: mkShot(),
      videoName: "v.mp4",
      imageName: null,
      audioName: null,
      outputName: "out.mp4",
    });
    expect(args.filter((a) => a === "-i")).toHaveLength(1);
    expect(args).not.toContain("0:v:0");
  });

  it("image + audio: loop flag + maps", () => {
    const args = buildClientNormalizeArgs({
      shot: mkShot(),
      videoName: null,
      imageName: "i.png",
      audioName: "a.mp3",
      outputName: "out.mp4",
    });
    expect(args).toContain("-loop");
    expect(args).toContain("1");
    expect(args).toContain("0:v");
    expect(args).toContain("1:a");
  });

  it("image only: synthesizes silence via anullsrc", () => {
    const args = buildClientNormalizeArgs({
      shot: mkShot(),
      videoName: null,
      imageName: "i.png",
      audioName: null,
      outputName: "out.mp4",
    });
    expect(args).toContain("anullsrc=r=48000:cl=stereo");
  });

  it("nothing: synthesizes silent black at target res", () => {
    const args = buildClientNormalizeArgs({
      shot: mkShot({ durationS: 3 }),
      videoName: null,
      imageName: null,
      audioName: null,
      outputName: "out.mp4",
    });
    expect(
      args.some((a) =>
        a.startsWith(
          `color=black:s=${CLIENT_REEL_TARGET_WIDTH}x${CLIENT_REEL_TARGET_HEIGHT}`,
        ),
      ),
    ).toBe(true);
    expect(args).toContain("anullsrc=r=48000:cl=stereo");
    const tIdx = args.indexOf("-t");
    expect(args[tIdx + 1]).toBe("3");
  });

  it("clamps sub-100ms durations so ffmpeg.wasm doesn't reject", () => {
    const args = buildClientNormalizeArgs({
      shot: mkShot({ durationS: 0 }),
      videoName: "v.mp4",
      imageName: null,
      audioName: null,
      outputName: "out.mp4",
    });
    const tIdx = args.indexOf("-t");
    expect(args[tIdx + 1]).toBe("0.1");
  });
});

describe("buildClientConcatListText", () => {
  it("wraps each name in `file '...'` with newline terminator", () => {
    const text = buildClientConcatListText(["shot_0.mp4", "shot_1.mp4"]);
    expect(text).toBe("file 'shot_0.mp4'\nfile 'shot_1.mp4'\n");
  });

  it("escapes single quotes inside names", () => {
    const text = buildClientConcatListText(["it's_a_shot.mp4"]);
    expect(text).toBe("file 'it'\\''s_a_shot.mp4'\n");
  });
});
