/**
 * M5 — client-side reel export fallback via ffmpeg.wasm.
 *
 * Lets producers export their reel as an mp4 even when the Next.js host
 * doesn't have the `ffmpeg` binary on PATH (the server route returns
 * 501 in that case). Runs in the browser using @ffmpeg/ffmpeg's
 * SharedArrayBuffer worker.
 *
 * Dynamic-imported by the caller so the ~30MB wasm bundle only loads
 * when this specific code path fires. Importing this module does NOT
 * itself pull in ffmpeg-core; that happens inside `loadFfmpeg()`.
 */

import type { ReelManifest, ReelShot } from "@/app/api/storyboard/reel-manifest/route";

/** Uniform encoding target — matches the server-side route so reels
 *  produced by either path are byte-comparable in metadata. */
export const CLIENT_REEL_TARGET_WIDTH = 1920;
export const CLIENT_REEL_TARGET_HEIGHT = 1080;
export const CLIENT_REEL_TARGET_FPS = 30;

export type ClientExportStage =
  | "loading_wasm"
  | "downloading"
  | "normalizing"
  | "concatenating"
  | "uploading"
  | "done";

export interface ClientExportProgress {
  stage: ClientExportStage;
  shotIndex?: number;
  shotTotal?: number;
  message?: string;
}

/** Minimal shape we need from the ffmpeg.wasm FFmpeg instance. Typing
 *  against a narrow interface instead of the @ffmpeg/ffmpeg class makes
 *  the orchestration unit-testable under bun without loading a real
 *  ffmpeg-core wasm binary. */
export interface FfmpegLike {
  writeFile(name: string, data: Uint8Array): Promise<unknown>;
  readFile(name: string): Promise<Uint8Array | string>;
  deleteFile(name: string): Promise<unknown>;
  exec(args: string[]): Promise<number>;
}

export interface ClientExportOptions {
  manifest: ReelManifest;
  /** Invoked on every stage/progress transition so the UI can show a
   *  spinner + current shot index. */
  onProgress?: (progress: ClientExportProgress) => void;
  /** Dependency-injected ffmpeg loader. Default loads the real
   *  ffmpeg.wasm bundle from unpkg; tests override with a stub. */
  ffmpegFactory?: () => Promise<FfmpegLike>;
  /** Dependency-injected fetcher for asset URLs. Default is `fetch`.
   *  Tests override to avoid real network calls. */
  fetchBytes?: (url: string) => Promise<Uint8Array>;
}

export interface ClientExportResult {
  /** Encoded mp4 bytes. Caller uploads to Convex storage. */
  bytes: Uint8Array;
  byteLength: number;
  shotCount: number;
  totalDurationS: number;
}

/** Lazily load ffmpeg-core into the browser worker. Cached so repeat
 *  exports in the same session don't re-download the wasm. */
let _ffmpegPromise: Promise<import("@ffmpeg/ffmpeg").FFmpeg> | null = null;

const loadFfmpeg = async (): Promise<import("@ffmpeg/ffmpeg").FFmpeg> => {
  if (_ffmpegPromise) return _ffmpegPromise;
  _ffmpegPromise = (async () => {
    const { FFmpeg } = await import("@ffmpeg/ffmpeg");
    const { toBlobURL } = await import("@ffmpeg/util");
    const ffmpeg = new FFmpeg();
    // @ffmpeg/core is the actual wasm binary; load from the unpkg CDN
    // the @ffmpeg/util helpers point to. Works for production bundles
    // without bundler-specific worker shenanigans.
    const baseURL = "https://unpkg.com/@ffmpeg/core@0.12.10/dist/umd";
    await ffmpeg.load({
      coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, "text/javascript"),
      wasmURL: await toBlobURL(
        `${baseURL}/ffmpeg-core.wasm`,
        "application/wasm",
      ),
    });
    return ffmpeg;
  })();
  return _ffmpegPromise;
};

const fetchToBytes = async (url: string): Promise<Uint8Array> => {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`asset fetch ${res.status} for ${url.slice(0, 80)}`);
  }
  return new Uint8Array(await res.arrayBuffer());
};

/** Build the filter chain that scales + pads to the uniform output
 *  resolution. Same shape as the server-side `buildShotNormalizeArgs`
 *  filter so the two paths produce visually-identical clips. */
export const buildClientScalePadFilter = (): string =>
  `scale=${CLIENT_REEL_TARGET_WIDTH}:${CLIENT_REEL_TARGET_HEIGHT}:force_original_aspect_ratio=decrease,` +
  `pad=${CLIENT_REEL_TARGET_WIDTH}:${CLIENT_REEL_TARGET_HEIGHT}:(ow-iw)/2:(oh-ih)/2:black,` +
  `setsar=1,fps=${CLIENT_REEL_TARGET_FPS}`;

export const buildClientNormalizeArgs = (input: {
  shot: ReelShot;
  videoName: string | null;
  imageName: string | null;
  audioName: string | null;
  outputName: string;
}): string[] => {
  const { shot, videoName, imageName, audioName, outputName } = input;
  const duration = Math.max(0.1, shot.durationS).toString();
  const vFilter = buildClientScalePadFilter();
  const baseV = [
    "-vf", vFilter,
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-pix_fmt", "yuv420p",
    "-r", String(CLIENT_REEL_TARGET_FPS),
    "-t", duration,
  ];
  if (videoName && audioName) {
    return [
      "-y",
      "-i", videoName,
      "-i", audioName,
      "-map", "0:v:0",
      "-map", "1:a:0",
      ...baseV,
      "-c:a", "aac",
      "-ar", "48000",
      "-ac", "2",
      "-shortest",
      outputName,
    ];
  }
  if (videoName) {
    return [
      "-y",
      "-i", videoName,
      ...baseV,
      "-c:a", "aac",
      "-ar", "48000",
      "-ac", "2",
      outputName,
    ];
  }
  if (imageName && audioName) {
    return [
      "-y",
      "-loop", "1",
      "-i", imageName,
      "-i", audioName,
      ...baseV,
      "-map", "0:v",
      "-map", "1:a",
      "-c:a", "aac",
      "-ar", "48000",
      "-ac", "2",
      "-shortest",
      outputName,
    ];
  }
  if (imageName) {
    return [
      "-y",
      "-loop", "1",
      "-i", imageName,
      "-f", "lavfi",
      "-i", "anullsrc=r=48000:cl=stereo",
      ...baseV,
      "-map", "0:v",
      "-map", "1:a",
      "-c:a", "aac",
      "-ar", "48000",
      "-ac", "2",
      "-shortest",
      outputName,
    ];
  }
  // Silent black fallback.
  return [
    "-y",
    "-f", "lavfi",
    "-i", `color=black:s=${CLIENT_REEL_TARGET_WIDTH}x${CLIENT_REEL_TARGET_HEIGHT}:r=${CLIENT_REEL_TARGET_FPS}`,
    "-f", "lavfi",
    "-i", "anullsrc=r=48000:cl=stereo",
    "-t", duration,
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-ar", "48000",
    "-ac", "2",
    "-shortest",
    outputName,
  ];
};

export const buildClientConcatListText = (shotNames: string[]): string =>
  shotNames.map((n) => `file '${n.replace(/'/g, "'\\''")}'`).join("\n") + "\n";

/** Run the whole client-side export. Returns the encoded mp4 bytes. */
export const exportReelClientSide = async (
  options: ClientExportOptions,
): Promise<ClientExportResult> => {
  const { manifest, onProgress, ffmpegFactory, fetchBytes } = options;
  const emit = (update: ClientExportProgress) => onProgress?.(update);
  const fetchImpl = fetchBytes ?? fetchToBytes;

  emit({ stage: "loading_wasm" });
  const ffmpeg: FfmpegLike = await (ffmpegFactory ?? loadFfmpeg)();

  const shotCount = manifest.shots.length;
  const normalizedNames: string[] = [];

  for (let i = 0; i < shotCount; i += 1) {
    const shot = manifest.shots[i];
    emit({ stage: "downloading", shotIndex: i, shotTotal: shotCount });

    let videoName: string | null = null;
    let imageName: string | null = null;
    let audioName: string | null = null;
    if (shot.videoUrl) {
      videoName = `shot_${i}.src.mp4`;
      await ffmpeg.writeFile(videoName, await fetchImpl(shot.videoUrl));
    }
    if (!shot.videoUrl && shot.imageUrl) {
      imageName = `shot_${i}.src.png`;
      await ffmpeg.writeFile(imageName, await fetchImpl(shot.imageUrl));
    }
    if (shot.audioUrl) {
      audioName = `shot_${i}.src.mp3`;
      await ffmpeg.writeFile(audioName, await fetchImpl(shot.audioUrl));
    }
    // M7 note: SFX ambient track is dropped on the wasm path for now.
    // The server ffmpeg path pre-mixes SFX + narration before
    // normalizing (see generate-shot-sfxs + export-reel route). Adding
    // the same amix graph here is tractable but would require another
    // per-shot filter_complex pass; deferred until producer demand.

    emit({ stage: "normalizing", shotIndex: i, shotTotal: shotCount });
    const outputName = `shot_${i}.mp4`;
    const args = buildClientNormalizeArgs({
      shot,
      videoName,
      imageName,
      audioName,
      outputName,
    });
    const code = await ffmpeg.exec(args);
    if (code !== 0) {
      throw new Error(`ffmpeg.wasm normalize failed for shot ${i} (exit ${code})`);
    }
    // Drop the source assets — their bytes can be freed immediately.
    if (videoName) {
      await ffmpeg.deleteFile(videoName).catch(() => undefined);
    }
    if (imageName) {
      await ffmpeg.deleteFile(imageName).catch(() => undefined);
    }
    if (audioName) {
      await ffmpeg.deleteFile(audioName).catch(() => undefined);
    }
    normalizedNames.push(outputName);
  }

  emit({ stage: "concatenating", shotTotal: shotCount });
  const concatListName = "concat.txt";
  await ffmpeg.writeFile(
    concatListName,
    new TextEncoder().encode(buildClientConcatListText(normalizedNames)),
  );
  const finalName = "reel.mp4";
  const concatCode = await ffmpeg.exec([
    "-y",
    "-f", "concat",
    "-safe", "0",
    "-i", concatListName,
    "-c", "copy",
    "-movflags", "+faststart",
    finalName,
  ]);
  if (concatCode !== 0) {
    throw new Error(`ffmpeg.wasm concat failed (exit ${concatCode})`);
  }
  const bytesRaw = await ffmpeg.readFile(finalName);
  const bytes =
    bytesRaw instanceof Uint8Array ? bytesRaw : new TextEncoder().encode(String(bytesRaw));

  // Free virtual FS — repeat exports in the same session start clean.
  await Promise.all([
    ...normalizedNames.map((n) => ffmpeg.deleteFile(n).catch(() => undefined)),
    ffmpeg.deleteFile(concatListName).catch(() => undefined),
    ffmpeg.deleteFile(finalName).catch(() => undefined),
  ]);

  emit({ stage: "done", shotTotal: shotCount });
  return {
    bytes,
    byteLength: bytes.byteLength,
    shotCount,
    totalDurationS: manifest.totalDurationS,
  };
};
