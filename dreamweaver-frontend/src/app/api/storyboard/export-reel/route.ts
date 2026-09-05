/**
 * M5 #6 — real mp4 export of the reel.
 *
 * Flow:
 *   1. Resolve the reel manifest (same logic as the player's preview).
 *   2. Download each shot's video/image/audio to a per-request tmp dir.
 *   3. Run ffmpeg per shot to normalize into a uniform 1920x1080@30
 *      mp4 (silent video, video+narration, still-image+narration, or
 *      silent black — see `planShotDownloads`).
 *   4. Run ffmpeg concat demuxer to stitch every normalized clip.
 *   5. Upload the final mp4 to Convex `_storage`, return `{ url,
 *      storageId, durationS, shotCount }`.
 *   6. Clean up the tmp dir.
 *
 * Host requirement: `ffmpeg` must be on PATH. If it isn't, the route
 * returns HTTP 501 with an actionable message instead of crashing.
 * The launcher scripts document how to install it locally.
 */

import { NextRequest, NextResponse } from "next/server";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import { ConvexHttpClient } from "convex/browser";
import type { Id } from "../../../../../convex/_generated/dataModel";
import { getToken } from "@/lib/auth-server";
import { mutationRef, queryRef } from "@/lib/convexRefs";
import { createLogger, resolveRequestId } from "@/lib/observability";
import type { NodeType, ShotMeta } from "@/app/storyboard/types";
import {
  buildBurnInSubtitlesArgs,
  buildConcatArgs,
  buildConcatListFile,
  buildShotNormalizeArgs,
  planShotDownloads,
  type ShotPlan,
} from "./helpers";
import type { ReelManifest } from "@/app/api/storyboard/reel-manifest/route";
import { buildReelManifest } from "@/app/api/storyboard/reel-manifest/route";
import {
  buildForceStyleString,
  buildSubtitleCues,
  renderSrt,
  type SubtitleStyle,
} from "@/lib/subtitles";
import { buildSubtitleInputs } from "@/app/api/storyboard/subtitles/route";

export const runtime = "nodejs";
// ffmpeg-bound work can be long on a big reel. 15 min cap gives a
// 20-shot reel plenty of headroom for normalization + concat.
export const maxDuration = 900;

interface MediaVariant {
  mediaAssetId: string;
  url: string;
  modelId: string;
  createdAt: number;
}

interface SnapshotNode {
  nodeId: string;
  nodeType: NodeType;
  label: string;
  segment: string;
  shotMeta?: ShotMeta;
  promptPack?: { imagePrompt?: string };
  media?: {
    images?: MediaVariant[];
    videos?: MediaVariant[];
    audios?: MediaVariant[];
    activeImageId?: string;
    activeVideoId?: string;
    activeAudioId?: string;
  };
}

interface StoryboardSnapshot {
  storyboard: { _id: string; title?: string } | null;
  nodes: SnapshotNode[];
}

interface ExportReelBody {
  storyboardId?: string;
  /** M7 — when true, runs a second ffmpeg pass to burn captions
   *  (from dialogue extraction) into the video stream. Default off:
   *  most producers prefer a soft-subtitle `.vtt` / `.srt` they can
   *  toggle; burn-in is for delivery channels that don't support
   *  closed captions (e.g. Instagram Reels). */
  burnInSubtitles?: boolean;
  /** M7 — libass-style overrides applied when burnInSubtitles is on.
   *  Ignored for soft-subtitle exports (the .vtt carries plain text
   *  and the player styles it). */
  subtitleStyle?: SubtitleStyle;
}

/** Return `true` iff `ffmpeg` is on PATH and runs `-version` cleanly. */
const ffmpegAvailable = (): Promise<boolean> =>
  new Promise((resolve) => {
    try {
      const proc = spawn("ffmpeg", ["-version"], { stdio: "ignore" });
      proc.on("error", () => resolve(false));
      proc.on("close", (code) => resolve(code === 0));
    } catch {
      resolve(false);
    }
  });

/** Spawn ffmpeg with the given args and resolve when it exits. Rejects
 *  on non-zero exit with the last 4KB of stderr attached. */
const runFfmpeg = (args: string[]): Promise<void> =>
  new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > 4096) stderr = stderr.slice(-4096);
    });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-800)}`));
    });
  });

const fetchToFile = async (url: string, destPath: string): Promise<void> => {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`asset fetch ${res.status} for ${url.slice(0, 80)}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  await writeFile(destPath, buf);
};

export async function POST(request: NextRequest): Promise<Response> {
  const requestId = resolveRequestId(request.headers);
  const log = createLogger({ service: "export-reel", requestId });

  const token = await getToken();
  if (!token) {
    return NextResponse.json(
      { error: "Unauthorized" },
      { status: 401, headers: { "X-Request-Id": requestId } },
    );
  }

  let body: ExportReelBody;
  try {
    body = (await request.json()) as ExportReelBody;
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body" },
      { status: 400, headers: { "X-Request-Id": requestId } },
    );
  }
  const storyboardId = body.storyboardId?.trim();
  if (!storyboardId) {
    return NextResponse.json(
      { error: "storyboardId is required" },
      { status: 400, headers: { "X-Request-Id": requestId } },
    );
  }

  // --- Pre-flight: ffmpeg on PATH? ---------------------------------
  if (!(await ffmpegAvailable())) {
    log.error("ffmpeg_missing");
    return NextResponse.json(
      {
        error:
          "ffmpeg is not installed on this server. `brew install ffmpeg` (mac) / `apt install ffmpeg` (linux) and restart the Next dev server.",
      },
      { status: 501, headers: { "X-Request-Id": requestId } },
    );
  }

  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!convexUrl) {
    return NextResponse.json(
      { error: "NEXT_PUBLIC_CONVEX_URL not configured" },
      { status: 500, headers: { "X-Request-Id": requestId } },
    );
  }
  const client = new ConvexHttpClient(convexUrl);
  client.setAuth(token);

  const snapshot = (await client.query(
    queryRef("storyboards:getStoryboardSnapshot"),
    { storyboardId },
  )) as StoryboardSnapshot | null;
  if (!snapshot || !snapshot.storyboard) {
    return NextResponse.json(
      { error: "Storyboard not found" },
      { status: 404, headers: { "X-Request-Id": requestId } },
    );
  }

  const shots = snapshot.nodes.filter((n) => n.nodeType === "shot");
  const manifest: ReelManifest = buildReelManifest(
    storyboardId,
    snapshot.storyboard.title ?? "Untitled",
    shots,
  );
  if (manifest.shots.length === 0) {
    return NextResponse.json(
      { error: "Storyboard has no shots to export." },
      { status: 400, headers: { "X-Request-Id": requestId } },
    );
  }

  const plans: ShotPlan[] = planShotDownloads(manifest.shots);
  const workDir = joinPath(tmpdir(), `reel-${randomUUID()}`);
  await mkdir(workDir, { recursive: true });

  try {
    log.info("export_started", {
      storyboardId,
      shotCount: manifest.shots.length,
      totalDurationS: manifest.totalDurationS,
      workDir,
    });

    // --- 1. Download assets per shot -------------------------------
    const normalizedPaths: string[] = new Array(plans.length);
    for (const plan of plans) {
      const { shot, index } = plan;
      const videoPath = plan.willDownloadVideo
        ? joinPath(workDir, `shot_${index}.src.mp4`)
        : null;
      const imagePath = plan.willDownloadImage
        ? joinPath(workDir, `shot_${index}.src.png`)
        : null;
      const audioPath = plan.willDownloadAudio
        ? joinPath(workDir, `shot_${index}.src.mp3`)
        : null;
      const sfxPath = plan.willDownloadSfx
        ? joinPath(workDir, `shot_${index}.sfx.mp3`)
        : null;

      if (videoPath && shot.videoUrl) {
        await fetchToFile(shot.videoUrl, videoPath);
      }
      if (imagePath && shot.imageUrl) {
        await fetchToFile(shot.imageUrl, imagePath);
      }
      if (audioPath && shot.audioUrl) {
        await fetchToFile(shot.audioUrl, audioPath);
      }
      if (sfxPath && shot.sfxUrl) {
        await fetchToFile(shot.sfxUrl, sfxPath);
      }

      // --- 2a. Pre-mix narration + SFX into a single audio track --
      // We pre-mix instead of extending buildShotNormalizeArgs because
      // that helper already has four branches; adding a fifth with
      // three audio sources would triple its complexity. Pre-mixing
      // also keeps the normalize filter graph identical regardless of
      // whether SFX is present — easier to reason about.
      let effectiveAudioPath = audioPath;
      if (sfxPath) {
        const mixedPath = joinPath(workDir, `shot_${index}.amix.mp3`);
        const mixEnd = log.startTimer("shot_sfx_premix", { index });
        // Per-shot volume trim: producers set this via the slider in
        // the SFX section of PropertiesPanel. `sfxVolumeDb === null`
        // means no explicit trim yet → use the library default.
        const { DEFAULT_SFX_VOLUME_DB, buildSfxMixArgs } = await import(
          "@/lib/sfx"
        );
        const effectiveVolumeDb =
          typeof shot.sfxVolumeDb === "number"
            ? shot.sfxVolumeDb
            : DEFAULT_SFX_VOLUME_DB;
        if (audioPath) {
          await runFfmpeg(
            buildSfxMixArgs({
              narrationPath: audioPath,
              sfxPath,
              outputPath: mixedPath,
              volumeDb: effectiveVolumeDb,
            }),
          );
          effectiveAudioPath = mixedPath;
        } else {
          // No narration — treat the SFX as the shot's only audio
          // track. buildShotNormalizeArgs accepts it as audioPath; the
          // downstream filter graph doesn't care about its origin.
          effectiveAudioPath = sfxPath;
        }
        mixEnd({ volumeDb: effectiveVolumeDb });
      }

      // --- 2b. Normalize into a uniform clip ----------------------
      const outputPath = joinPath(workDir, `shot_${index}.mp4`);
      const normEnd = log.startTimer("shot_normalize", {
        index,
        kind: plan.kind,
        durationS: shot.durationS,
        hasSfx: Boolean(sfxPath),
      });
      const { args } = buildShotNormalizeArgs({
        videoPath,
        imagePath,
        audioPath: effectiveAudioPath,
        durationS: shot.durationS,
        outputPath,
      });
      await runFfmpeg(args);
      normEnd({});
      normalizedPaths[index] = outputPath;
    }

    // --- 3. Concat all normalized clips --------------------------
    const concatListPath = joinPath(workDir, "concat.txt");
    await writeFile(concatListPath, buildConcatListFile(normalizedPaths));
    const concatPath = joinPath(workDir, "reel.concat.mp4");
    const concatEnd = log.startTimer("concat_demuxer", {
      shotCount: normalizedPaths.length,
    });
    await runFfmpeg(buildConcatArgs(concatListPath, concatPath));
    concatEnd({});

    // --- 3a. Optional: burn in subtitles --------------------------
    // Soft-subtitle path (default): `finalPath` = concat output,
    // producers grab `.vtt` / `.srt` separately from the subtitles
    // route. Burn-in path: render captions as baked pixels so the
    // reel is playable on platforms that drop external caption
    // tracks. We always generate the SRT — even when burn-in is on,
    // cue generation is cheap and keeps the "open captions match the
    // narration" contract visible.
    let finalPath = concatPath;
    const subtitleInputs = buildSubtitleInputs(shots);
    const cues = buildSubtitleCues(subtitleInputs);
    const burnInSubtitles = body.burnInSubtitles === true && cues.length > 0;
    if (burnInSubtitles) {
      const burnEnd = log.startTimer("burn_in_subtitles", {
        cueCount: cues.length,
      });
      const srtPath = joinPath(workDir, "captions.srt");
      await writeFile(srtPath, renderSrt(cues), "utf8");
      const burnedPath = joinPath(workDir, "reel.mp4");
      const forceStyle = body.subtitleStyle
        ? buildForceStyleString(body.subtitleStyle)
        : "";
      // Host-local font directory. Operators drop .ttf / .otf files
      // here at deploy time so `fontFamily: "Inter"` resolves
      // consistently regardless of the base image's system fonts.
      // Unset → libass uses host system fonts (fine for local dev).
      const fontsDir = (process.env.SUBTITLE_FONTS_DIR ?? "").trim();
      await runFfmpeg(
        buildBurnInSubtitlesArgs({
          videoPath: concatPath,
          subtitlePath: srtPath,
          outputPath: burnedPath,
          forceStyle,
          fontsDir: fontsDir.length > 0 ? fontsDir : undefined,
        }),
      );
      finalPath = burnedPath;
      burnEnd({});
    }

    // --- 3b. Optional: mix reel-level score track ------------------
    // Runs AFTER burn-in so the score plays over the finalized
    // picture. We download the score mp3 first (since the manifest
    // only carries a URL), then feed both the reel + score to
    // buildScoreMixArgs, which stream-copies video and re-encodes
    // audio at the canonical 48kHz stereo AAC.
    if (manifest.score) {
      const scoreEnd = log.startTimer("score_mix", {
        prompt: manifest.score.prompt?.slice(0, 80),
      });
      try {
        const {
          DEFAULT_SCORE_VOLUME_DB,
          buildScoreMixArgs,
        } = await import("@/lib/score");
        const scorePath = joinPath(workDir, "score.mp3");
        await fetchToFile(manifest.score.url, scorePath);
        const mixedPath = joinPath(workDir, "reel.scored.mp4");
        const volumeDb =
          typeof manifest.score.volumeDb === "number"
            ? manifest.score.volumeDb
            : DEFAULT_SCORE_VOLUME_DB;
        await runFfmpeg(
          buildScoreMixArgs({
            reelPath: finalPath,
            scorePath,
            outputPath: mixedPath,
            volumeDb,
          }),
        );
        finalPath = mixedPath;
        scoreEnd({ volumeDb });
      } catch (err) {
        // Non-fatal — a failed score mix falls through to the already-
        // concatenated reel so the producer at least gets narration +
        // SFX. Log so the observability layer catches persistent
        // provider / ffmpeg issues.
        scoreEnd({
          error: err instanceof Error ? err.message : String(err),
        });
        log.warn("score_mix_failed_fallback", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // --- 4. Upload to Convex storage ------------------------------
    const uploadEnd = log.startTimer("upload_reel");
    const uploadUrl = (await client.mutation(
      mutationRef("storage:generateCameoUploadUrl"),
      {},
    )) as string;
    const { readFile } = await import("node:fs/promises");
    const reelBytes = await readFile(finalPath);
    const uploadRes = await fetch(uploadUrl, {
      method: "POST",
      headers: { "Content-Type": "video/mp4" },
      body: reelBytes,
    });
    if (!uploadRes.ok) {
      const text = await uploadRes.text().catch(() => "");
      throw new Error(
        `storage upload ${uploadRes.status}: ${text.slice(0, 200)}`,
      );
    }
    const { storageId } = (await uploadRes.json()) as { storageId: string };
    const publicUrl = (await client.mutation(
      mutationRef("storage:getStorageUrl"),
      { storageId: storageId as never },
    )) as string;
    uploadEnd({ storageId, byteLength: reelBytes.byteLength });

    // Persist the export so the ReelPlayer can surface a "Past exports"
    // list and producers can re-open / re-download without paying
    // another ffmpeg run.
    let reelExportId: string | null = null;
    try {
      reelExportId = (await client.mutation(
        mutationRef("reelExports:recordReelExport"),
        {
          storyboardId: storyboardId as Id<"storyboards">,
          storageId: storageId as Id<"_storage">,
          sourceUrl: publicUrl,
          shotCount: manifest.shots.length,
          totalDurationS: manifest.totalDurationS,
          byteLength: reelBytes.byteLength,
          title: manifest.title,
        },
      )) as string;
    } catch (err) {
      // The upload succeeded; failing to record the row is annoying
      // but not fatal — the URL still works. Log so operators notice.
      log.warn("reel_export_record_failed", {
        error: err instanceof Error ? err.message : String(err),
        storageId,
      });
    }

    log.info("export_completed", {
      storyboardId,
      shotCount: manifest.shots.length,
      totalDurationS: manifest.totalDurationS,
      storageId,
      byteLength: reelBytes.byteLength,
      reelExportId,
    });

    return NextResponse.json(
      {
        url: publicUrl,
        storageId,
        reelExportId,
        shotCount: manifest.shots.length,
        totalDurationS: manifest.totalDurationS,
        byteLength: reelBytes.byteLength,
      },
      { status: 200, headers: { "X-Request-Id": requestId } },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error("export_failed", { error: msg });
    return NextResponse.json(
      { error: msg },
      { status: 500, headers: { "X-Request-Id": requestId } },
    );
  } finally {
    // Always clean up the tmp dir — keeps disk use bounded across
    // repeated exports even when partial failures leave intermediates.
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
