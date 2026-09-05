/**
 * Orchestration-level smoke test for exportReelClientSide.
 *
 * Can't load the real ffmpeg.wasm under bun (needs SharedArrayBuffer +
 * the 30MB core bundle), so we inject a fake FfmpegLike that records
 * every call and returns stub output bytes. The point of the test is
 * the flow — are stages emitted in the right order, do per-shot
 * normalize args match what the callers expect, does cleanup happen
 * after a successful concat, does a non-zero exec code bubble up?
 */

import { describe, expect, it } from "bun:test";

import {
  exportReelClientSide,
  type FfmpegLike,
} from "@/lib/reel-export/client";
import type {
  ReelManifest,
  ReelShot,
} from "@/app/api/storyboard/reel-manifest/route";

const shot = (overrides: Partial<ReelShot> = {}): ReelShot => ({
  nodeId: "n",
  index: 0,
  number: null,
  label: "Shot",
  durationS: 3,
  videoUrl: null,
  imageUrl: null,
  audioUrl: null,
  sfxUrl: null,
  sfxVolumeDb: null,
  prompt: null,
  ...overrides,
});

const manifest = (shots: ReelShot[]): ReelManifest => ({
  storyboardId: "sb_1",
  title: "Test",
  totalDurationS: shots.reduce((acc, s) => acc + s.durationS, 0),
  shots,
});

interface CallLog {
  writes: string[];
  execs: string[][];
  deletes: string[];
  reads: string[];
}

const makeFakeFfmpeg = (
  options: {
    failAtShot?: number;
    failAtConcat?: boolean;
    finalBytes?: Uint8Array;
  } = {},
): { ffmpeg: FfmpegLike; log: CallLog } => {
  const log: CallLog = { writes: [], execs: [], deletes: [], reads: [] };
  const ffmpeg: FfmpegLike = {
    async writeFile(name: string) {
      log.writes.push(name);
    },
    async exec(args: string[]) {
      log.execs.push(args);
      const outputName = args[args.length - 1];
      // Detect whether this is a per-shot normalize or the concat.
      const isConcat =
        args.includes("-f") && args.includes("concat") && args.includes("-c");
      if (isConcat) {
        return options.failAtConcat ? 1 : 0;
      }
      if (options.failAtShot !== undefined) {
        const m = /shot_(\d+)\.mp4$/.exec(outputName);
        if (m && Number(m[1]) === options.failAtShot) return 1;
      }
      return 0;
    },
    async readFile() {
      log.reads.push("reel.mp4");
      return options.finalBytes ?? new Uint8Array([0x74, 0x65, 0x73, 0x74]); // "test"
    },
    async deleteFile(name: string) {
      log.deletes.push(name);
    },
  };
  return { ffmpeg, log };
};

const stubFetch = async (_url: string): Promise<Uint8Array> =>
  new Uint8Array([0x00, 0x01, 0x02]);

describe("exportReelClientSide orchestration", () => {
  it("emits stages in order: loading_wasm → downloading/normalizing (per shot) → concatenating → done", async () => {
    const { ffmpeg } = makeFakeFfmpeg();
    const stages: string[] = [];
    const result = await exportReelClientSide({
      manifest: manifest([
        shot({ nodeId: "s0", videoUrl: "https://x/s0.mp4" }),
        shot({ nodeId: "s1", imageUrl: "https://x/s1.png", audioUrl: "https://x/s1.mp3" }),
      ]),
      onProgress: (p) => stages.push(p.stage),
      ffmpegFactory: async () => ffmpeg,
      fetchBytes: stubFetch,
    });
    // First is loading_wasm, last is done; concatenating appears exactly once.
    expect(stages[0]).toBe("loading_wasm");
    expect(stages[stages.length - 1]).toBe("done");
    expect(stages.filter((s) => s === "concatenating")).toHaveLength(1);
    expect(stages.filter((s) => s === "downloading")).toHaveLength(2);
    expect(stages.filter((s) => s === "normalizing")).toHaveLength(2);
    expect(result.shotCount).toBe(2);
    expect(result.byteLength).toBeGreaterThan(0);
  });

  it("writes source assets, normalizes per shot, and concats at the end", async () => {
    const { ffmpeg, log } = makeFakeFfmpeg();
    await exportReelClientSide({
      manifest: manifest([
        shot({ nodeId: "s0", videoUrl: "https://x/s0.mp4", audioUrl: "https://x/s0.mp3" }),
        shot({ nodeId: "s1", imageUrl: "https://x/s1.png" }),
      ]),
      ffmpegFactory: async () => ffmpeg,
      fetchBytes: stubFetch,
    });
    // 3 source writes: shot 0 (video + audio) + shot 1 (image) = 3.
    // + 1 concat list file = 4 total writeFile calls.
    expect(log.writes).toContain("shot_0.src.mp4");
    expect(log.writes).toContain("shot_0.src.mp3");
    expect(log.writes).toContain("shot_1.src.png");
    expect(log.writes).toContain("concat.txt");
    // 3 exec calls: 2 normalize + 1 concat.
    expect(log.execs).toHaveLength(3);
    expect(log.execs[log.execs.length - 1]).toContain("concat");
  });

  it("cleans up virtual FS after success", async () => {
    const { ffmpeg, log } = makeFakeFfmpeg();
    await exportReelClientSide({
      manifest: manifest([
        shot({ nodeId: "s0", videoUrl: "https://x/s0.mp4" }),
      ]),
      ffmpegFactory: async () => ffmpeg,
      fetchBytes: stubFetch,
    });
    // Source video deleted mid-loop.
    expect(log.deletes).toContain("shot_0.src.mp4");
    // Post-concat cleanup deletes normalized shot, concat list, reel.
    expect(log.deletes).toContain("shot_0.mp4");
    expect(log.deletes).toContain("concat.txt");
    expect(log.deletes).toContain("reel.mp4");
  });

  it("propagates per-shot normalize failure", async () => {
    const { ffmpeg } = makeFakeFfmpeg({ failAtShot: 1 });
    await expect(
      exportReelClientSide({
        manifest: manifest([
          shot({ nodeId: "s0", videoUrl: "https://x/s0.mp4" }),
          shot({ nodeId: "s1", imageUrl: "https://x/s1.png" }),
        ]),
        ffmpegFactory: async () => ffmpeg,
        fetchBytes: stubFetch,
      }),
    ).rejects.toThrow(/normalize failed for shot 1/);
  });

  it("propagates concat failure", async () => {
    const { ffmpeg } = makeFakeFfmpeg({ failAtConcat: true });
    await expect(
      exportReelClientSide({
        manifest: manifest([
          shot({ nodeId: "s0", videoUrl: "https://x/s0.mp4" }),
        ]),
        ffmpegFactory: async () => ffmpeg,
        fetchBytes: stubFetch,
      }),
    ).rejects.toThrow(/concat failed/);
  });

  it("handles empty-shot manifest without executing per-shot work", async () => {
    const { ffmpeg, log } = makeFakeFfmpeg();
    const result = await exportReelClientSide({
      manifest: manifest([]),
      ffmpegFactory: async () => ffmpeg,
      fetchBytes: stubFetch,
    });
    expect(result.shotCount).toBe(0);
    // One exec for the concat with zero inputs — concat list is empty
    // but the flow still attempts the step. Counts: 1 writeFile
    // (concat.txt), 1 exec (concat), 1 delete of reel.mp4 + concat.txt.
    expect(log.execs).toHaveLength(1);
  });

  it("returns bytes from readFile through to the caller", async () => {
    const finalBytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7]);
    const { ffmpeg } = makeFakeFfmpeg({ finalBytes });
    const result = await exportReelClientSide({
      manifest: manifest([
        shot({ nodeId: "s0", videoUrl: "https://x/s0.mp4" }),
      ]),
      ffmpegFactory: async () => ffmpeg,
      fetchBytes: stubFetch,
    });
    expect(result.byteLength).toBe(7);
    expect(result.bytes).toEqual(finalBytes);
  });
});
