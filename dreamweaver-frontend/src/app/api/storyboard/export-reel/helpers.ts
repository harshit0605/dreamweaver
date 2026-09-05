/**
 * Pure helpers for the /api/storyboard/export-reel route. Separated from
 * the route itself so they can be tested without spinning up child
 * processes or touching the network.
 *
 * The route compiles a reel manifest into a series of ffmpeg invocations:
 *   1. Per shot, normalize into a uniform `shot_<i>.mp4`:
 *      - video+audio shot → trim/pad to durationS, mux with shot's audio
 *      - video only       → trim/pad to durationS, keep video's own audio
 *      - image only       → still-loop at durationS, silent or shot audio
 *      - neither          → black frame at durationS (silent)
 *   2. Write a concat list file pointing at the normalized shots.
 *   3. Run concat demuxer to stitch into the final reel.mp4.
 *
 * The helpers below return the argv arrays for each stage. The route
 * spawns them in order; any non-zero exit code is surfaced to the SSE
 * client as a shot_failed event for that specific stage.
 */

import type { ReelShot } from "@/app/api/storyboard/reel-manifest/route";

export const REEL_TARGET_WIDTH = 1920;
export const REEL_TARGET_HEIGHT = 1080;
export const REEL_TARGET_FPS = 30;
export const REEL_TARGET_VCODEC = "libx264";
export const REEL_TARGET_ACODEC = "aac";
export const REEL_TARGET_PRESET = "medium";

export type NormalizedShotKind = "video_only" | "video_audio" | "image" | "silent_black";

export interface NormalizeArgsInput {
  /** Absolute path to the local shot video file (already downloaded
   *  from the CDN). `null` when the shot has no video. */
  videoPath: string | null;
  /** Absolute path to the local shot image file. `null` when missing. */
  imagePath: string | null;
  /** Absolute path to the local shot audio file (OpenAI TTS mp3).
   *  `null` when no narration exists for this shot. */
  audioPath: string | null;
  /** Shot duration in seconds, already clamped by the manifest
   *  builder. */
  durationS: number;
  /** Absolute output path for the normalized shot. */
  outputPath: string;
}

/**
 * Build the ffmpeg argv that normalizes one shot to the reel's uniform
 * codec/fps/resolution. Exported so the concat-demuxer flow can trust
 * every intermediate clip conforms without re-encoding at concat time.
 */
export const buildShotNormalizeArgs = (input: NormalizeArgsInput): {
  args: string[];
  kind: NormalizedShotKind;
} => {
  const { videoPath, imagePath, audioPath, durationS, outputPath } = input;
  const d = Math.max(0.1, durationS);
  const vFilter =
    `scale=${REEL_TARGET_WIDTH}:${REEL_TARGET_HEIGHT}:force_original_aspect_ratio=decrease,` +
    `pad=${REEL_TARGET_WIDTH}:${REEL_TARGET_HEIGHT}:(ow-iw)/2:(oh-ih)/2:black,` +
    `setsar=1,fps=${REEL_TARGET_FPS}`;
  const baseVideoOpts = [
    "-vf", vFilter,
    "-c:v", REEL_TARGET_VCODEC,
    "-preset", REEL_TARGET_PRESET,
    "-pix_fmt", "yuv420p",
    "-r", String(REEL_TARGET_FPS),
    "-t", String(d),
  ];

  if (videoPath && audioPath) {
    // video with external narration: the TTS replaces any baked-in audio.
    return {
      kind: "video_audio",
      args: [
        "-y",
        "-i", videoPath,
        "-i", audioPath,
        "-map", "0:v:0",
        "-map", "1:a:0",
        ...baseVideoOpts,
        "-c:a", REEL_TARGET_ACODEC,
        "-ar", "48000",
        "-ac", "2",
        "-shortest",
        outputPath,
      ],
    };
  }
  if (videoPath) {
    // video only: keep whatever audio LTX-2.3 baked in, if any.
    return {
      kind: "video_only",
      args: [
        "-y",
        "-i", videoPath,
        ...baseVideoOpts,
        "-c:a", REEL_TARGET_ACODEC,
        "-ar", "48000",
        "-ac", "2",
        outputPath,
      ],
    };
  }
  if (imagePath) {
    // still-frame clip. Loop the image; if an audio track exists,
    // layer it on.
    const args: string[] = ["-y", "-loop", "1", "-i", imagePath];
    if (audioPath) {
      args.push("-i", audioPath);
    }
    args.push(...baseVideoOpts);
    if (audioPath) {
      args.push(
        "-map", "0:v",
        "-map", "1:a",
        "-c:a", REEL_TARGET_ACODEC,
        "-ar", "48000",
        "-ac", "2",
        "-shortest",
      );
    } else {
      // Synthesize silence so every normalized clip has the same audio
      // track shape — concat demuxer requires identical stream layouts.
      args.push(
        "-f", "lavfi",
        "-i", `anullsrc=r=48000:cl=stereo`,
        "-map", "0:v",
        "-map", "2:a",
        "-c:a", REEL_TARGET_ACODEC,
        "-ar", "48000",
        "-ac", "2",
        "-shortest",
      );
    }
    args.push(outputPath);
    return { kind: "image", args };
  }
  // Shot with no media at all — render a black frame at the declared
  // duration. Lets the reel preserve timing even when a producer
  // exports before every shot has rendered.
  return {
    kind: "silent_black",
    args: [
      "-y",
      "-f", "lavfi",
      "-i",
      `color=black:s=${REEL_TARGET_WIDTH}x${REEL_TARGET_HEIGHT}:r=${REEL_TARGET_FPS}`,
      "-f", "lavfi",
      "-i", `anullsrc=r=48000:cl=stereo`,
      "-t", String(d),
      "-c:v", REEL_TARGET_VCODEC,
      "-preset", REEL_TARGET_PRESET,
      "-pix_fmt", "yuv420p",
      "-c:a", REEL_TARGET_ACODEC,
      "-ar", "48000",
      "-ac", "2",
      "-shortest",
      outputPath,
    ],
  };
};

/**
 * Build the `ffmpeg -f concat` argv that stitches every normalized shot
 * into the final reel. Concat list file must list `file '<path>'` on
 * each line; see `buildConcatListFile`.
 */
export const buildConcatArgs = (
  concatListPath: string,
  outputPath: string,
): string[] => [
  "-y",
  "-f", "concat",
  "-safe", "0",
  "-i", concatListPath,
  // Safe to copy without re-encoding — every intermediate was already
  // normalized to the target codec+fps+resolution.
  "-c", "copy",
  "-movflags", "+faststart",
  outputPath,
];

/**
 * M7 — build the ffmpeg argv that burns a WebVTT/SRT subtitle file into
 * the reel video. Re-encodes the video stream (unavoidable for burn-in)
 * at the same preset the normalize pass uses, and stream-copies audio
 * so the narration isn't touched.
 *
 * ffmpeg's `subtitles` filter requires a local file path. The caller
 * must have written the SRT/VTT to `subtitlePath` before spawning.
 *
 * The filter escapes `subtitlePath`'s single quotes to match the
 * filter-graph syntax — embedded `'` inside a value is a common
 * foot-gun.
 */
/** Escape a path value for libav's filter-graph quoted syntax.
 *  Backslash, colon, and single-quote all need doubling/escaping or
 *  the filter parser mis-tokenizes. Shared between the subtitle path
 *  and the fontsdir path. */
const escapeFilterPathValue = (path: string): string =>
  path.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'");

export const buildBurnInSubtitlesArgs = (input: {
  videoPath: string;
  subtitlePath: string;
  outputPath: string;
  /** M7 — libass style overrides applied via `force_style`. Pre-built
   *  by `buildForceStyleString` in @/lib/subtitles. Empty string means
   *  "use libass defaults". */
  forceStyle?: string;
  /** M7 — directory libass should scan for custom font files (.ttf /
   *  .otf). Passed through as the filter's `fontsdir=` option. When
   *  absent, libass falls back to the system font set — which varies
   *  by deploy target and is why this option exists. Typical host
   *  setup: drop a few ttf files into `SUBTITLE_FONTS_DIR` and the
   *  producer can set `fontFamily: "Inter"` and trust it across every
   *  deploy. */
  fontsDir?: string;
}): string[] => {
  const { videoPath, subtitlePath, outputPath, forceStyle, fontsDir } = input;
  // Escape single quotes for the filter value syntax. ffmpeg's filter
  // parser uses `'...'` as a quoted value; we end the string, escape,
  // and reopen. `:` inside the path also needs escaping to avoid
  // splitting filter args. Windows drive letters aren't a concern in
  // our tmpdir usage but handled for completeness.
  let filter = `subtitles='${escapeFilterPathValue(subtitlePath)}'`;
  if (forceStyle && forceStyle.trim().length > 0) {
    // Escape any embedded single quotes in the style string; libass
    // parses force_style as a comma-separated KEY=VALUE list, and the
    // outer `'…'` in the filter would otherwise terminate early.
    const escapedStyle = forceStyle.replace(/'/g, "\\'");
    filter += `:force_style='${escapedStyle}'`;
  }
  if (fontsDir && fontsDir.trim().length > 0) {
    filter += `:fontsdir='${escapeFilterPathValue(fontsDir)}'`;
  }
  return [
    "-y",
    "-i", videoPath,
    "-vf", filter,
    "-c:v", REEL_TARGET_VCODEC,
    "-preset", REEL_TARGET_PRESET,
    "-pix_fmt", "yuv420p",
    "-c:a", "copy",
    "-movflags", "+faststart",
    outputPath,
  ];
};

/**
 * Serialize a list of local shot paths into the ffmpeg concat demuxer's
 * format. Paths are wrapped in single-quoted `file '...'` entries and
 * internal single quotes are escaped as `'\''`.
 */
export const buildConcatListFile = (shotPaths: string[]): string => {
  const lines = shotPaths.map((p) => {
    const escaped = p.replace(/'/g, "'\\''");
    return `file '${escaped}'`;
  });
  return lines.join("\n") + "\n";
};

export interface ShotPlan {
  shot: ReelShot;
  index: number;
  kind: NormalizedShotKind;
  willDownloadVideo: boolean;
  willDownloadImage: boolean;
  willDownloadAudio: boolean;
  /** M7 — SFX (ambient / foley) download flag. Independent of the
   *  narration download: a shot can have SFX without narration (pure
   *  ambient), narration without SFX (most common), or both (premixed
   *  during normalization). */
  willDownloadSfx: boolean;
}

/**
 * Decide, per shot, what assets need downloading + which normalize
 * kind applies. Exported so the batch orchestration in the route can
 * short-circuit downloads for assets it isn't going to use.
 */
export const planShotDownloads = (shots: ReelShot[]): ShotPlan[] =>
  shots.map((shot, index) => {
    let kind: NormalizedShotKind;
    let willDownloadVideo = false;
    let willDownloadImage = false;
    let willDownloadAudio = false;

    if (shot.videoUrl && shot.audioUrl) {
      kind = "video_audio";
      willDownloadVideo = true;
      willDownloadAudio = true;
    } else if (shot.videoUrl) {
      kind = "video_only";
      willDownloadVideo = true;
    } else if (shot.imageUrl) {
      kind = "image";
      willDownloadImage = true;
      willDownloadAudio = Boolean(shot.audioUrl);
    } else {
      kind = "silent_black";
    }
    // SFX is always a supplement to the shot's audio track. We only
    // download when we'll actually use it — shots going down the
    // silent_black branch have nowhere to render an audio track, so
    // the SFX is dropped with a warning (producers should attach an
    // image or video first).
    const willDownloadSfx =
      Boolean(shot.sfxUrl) && kind !== "silent_black";
    return {
      shot,
      index,
      kind,
      willDownloadVideo,
      willDownloadImage,
      willDownloadAudio,
      willDownloadSfx,
    };
  });
