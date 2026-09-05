/**
 * M5 #2 — per-shot TTS batch.
 *
 * Mirrors the image + video batch routes. For each shot, derives a
 * narration text (first 2 sentences of `segment`, or
 * `promptPack.imagePrompt` as fallback), calls the single-shot
 * /api/media/generate-audio endpoint, and attaches the returned URL as
 * a completed `kind="audio"` mediaAsset.
 *
 * Event protocol mirrors the other batches so the useShotBatchStream
 * hook can subscribe with the same code path.
 */

import { NextRequest } from "next/server";
import { ConvexHttpClient } from "convex/browser";
import type { Id } from "../../../../../convex/_generated/dataModel";
import { getToken } from "@/lib/auth-server";
import { mutationRef, queryRef } from "@/lib/convexRefs";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import { sseFrame } from "@/lib/ingest-postprocess";
import { createLogger, resolveRequestId } from "@/lib/observability";
import {
  decidePrimarySpeaker,
  extractDialogue,
  type SpeakerVoiceMap,
} from "@/lib/dialogue-extract";
import {
  buildDialogueMixArgs,
  buildMixPlan,
} from "@/lib/dialogue-mix";
import type { NodeType } from "@/app/storyboard/types";

export const runtime = "nodejs";
// OpenAI TTS is fast (2-10s per shot) but we still give generous headroom
// for a 30-shot batch with concurrency=3 — worst case ~5 minutes total.
export const maxDuration = 600;

const DEFAULT_CONCURRENCY = 3;
const PER_SHOT_TIMEOUT_MS = 60_000;
const HEARTBEAT_INTERVAL_MS = 15_000;
const DEFAULT_VOICE = "nova";
const DEFAULT_MODEL = "tts-1";
const MAX_TTS_CHARS = 500; // Keep per-shot narration short — LLM prose is often verbose.

interface GenerateShotAudiosBody {
  storyboardId?: string;
  skipExisting?: boolean;
  concurrency?: number;
  voice?: string;
  model?: string;
  speed?: number;
  /** M8 — when set, translates each shot's narration into the target
   *  locale before TTS and stores the dubbed mp3 in
   *  `localeNarrations` instead of attaching it as the shot's
   *  active narration. Source-language ("", "en", "en-*") runs the
   *  original path: translate skipped, asset attached via
   *  `activeAudioId`. */
  locale?: string;
}

interface SnapshotNode {
  nodeId: string;
  nodeType: NodeType;
  label: string;
  segment: string;
  promptPack?: {
    imagePrompt?: string;
    videoPrompt?: string;
    audioDesc?: string;
  };
  media?: {
    activeImageId?: string;
    activeVideoId?: string;
    activeAudioId?: string;
  };
}

interface StoryboardSnapshot {
  storyboard: { _id: string; title?: string } | null;
  nodes: SnapshotNode[];
}

/**
 * Derive the text the TTS provider will speak. Preference order:
 *   1. An explicit `audioDesc` on the promptPack (future — Python
 *      ingester may start emitting dialogue extractions here).
 *   2. The first ~2 sentences of `segment`, capped at MAX_TTS_CHARS.
 *      Keeps narration tight so a 5-minute storyboard doesn't balloon
 *      into a 30-minute audio track.
 *   3. The imagePrompt, as a last resort.
 * Returns null when nothing usable is available.
 *
 * Exported so the route's unit tests can assert the extraction logic.
 */
export const deriveShotNarrationText = (
  node: Pick<SnapshotNode, "promptPack" | "segment">,
): string | null => {
  const explicit = node.promptPack?.audioDesc?.trim();
  if (explicit) return explicit.slice(0, MAX_TTS_CHARS);
  const seg = (node.segment ?? "").trim();
  if (seg.length > 0) {
    // Grab the first 1-2 sentences. A greedy match on `.?!` is good
    // enough for English prose; for other languages the 500-char cap
    // still prevents runaway narrations.
    const sentences: string[] = [];
    const re = /[^.!?]+[.!?]+/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(seg)) !== null && sentences.length < 2) {
      sentences.push(match[0].trim());
    }
    const condensed =
      sentences.length > 0 ? sentences.join(" ") : seg;
    return condensed.slice(0, MAX_TTS_CHARS);
  }
  const ip = node.promptPack?.imagePrompt?.trim();
  if (ip) return ip.slice(0, MAX_TTS_CHARS);
  return null;
};

/**
 * Does `ffmpeg` exist on PATH? Determines whether multi-speaker mixing
 * is possible on this host. Memoized per-process because the answer
 * can't change between requests without a restart.
 */
let _ffmpegPresent: boolean | null = null;
const ffmpegAvailable = (): Promise<boolean> => {
  if (_ffmpegPresent !== null) return Promise.resolve(_ffmpegPresent);
  return new Promise((resolve) => {
    try {
      const proc = spawn("ffmpeg", ["-version"], { stdio: "ignore" });
      proc.on("error", () => {
        _ffmpegPresent = false;
        resolve(false);
      });
      proc.on("close", (code) => {
        _ffmpegPresent = code === 0;
        resolve(_ffmpegPresent);
      });
    } catch {
      _ffmpegPresent = false;
      resolve(false);
    }
  });
};

/** Spawn ffmpeg, resolve on exit 0, reject on non-zero with last 2KB
 *  of stderr attached. Tight wrapper around child_process.spawn. */
const runFfmpeg = (args: string[]): Promise<void> =>
  new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > 2048) stderr = stderr.slice(-2048);
    });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-800)}`));
    });
  });

export async function POST(request: NextRequest): Promise<Response> {
  const requestId = resolveRequestId(request.headers);
  const log = createLogger({
    service: "generate-shot-audios-stream",
    requestId,
  });

  const token = await getToken();
  if (!token) {
    log.warn("unauthorized", { reason: "no_session_token" });
    return new Response(sseFrame("error", { message: "Unauthorized" }), {
      status: 401,
      headers: {
        "Content-Type": "text/event-stream",
        "X-Request-Id": requestId,
      },
    });
  }

  let body: GenerateShotAudiosBody;
  try {
    body = (await request.json()) as GenerateShotAudiosBody;
  } catch {
    return new Response(sseFrame("error", { message: "Invalid JSON body" }), {
      status: 400,
      headers: {
        "Content-Type": "text/event-stream",
        "X-Request-Id": requestId,
      },
    });
  }
  const storyboardId = body.storyboardId?.trim();
  if (!storyboardId) {
    return new Response(
      sseFrame("error", { message: "storyboardId is required" }),
      {
        status: 400,
        headers: {
          "Content-Type": "text/event-stream",
          "X-Request-Id": requestId,
        },
      },
    );
  }
  const skipExisting = body.skipExisting !== false;
  const concurrency = Math.min(
    Math.max(1, body.concurrency ?? DEFAULT_CONCURRENCY),
    5,
  );
  const voice = (body.voice ?? DEFAULT_VOICE).trim() || DEFAULT_VOICE;
  const model = (body.model ?? DEFAULT_MODEL).trim() || DEFAULT_MODEL;
  const speed = typeof body.speed === "number" ? body.speed : 1.0;
  const localeRaw = (body.locale ?? "").trim();
  // Import lazily — `isSourceLocale` pulls in the whole subtitles lib;
  // no need to bundle it for source-only audio batches.
  const { isSourceLocale } = await import("@/lib/subtitles");
  const willDub = !isSourceLocale(localeRaw);
  const locale = willDub ? localeRaw : "";

  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!convexUrl) {
    return new Response(
      sseFrame("error", { message: "NEXT_PUBLIC_CONVEX_URL not configured" }),
      {
        status: 500,
        headers: {
          "Content-Type": "text/event-stream",
          "X-Request-Id": requestId,
        },
      },
    );
  }
  const client = new ConvexHttpClient(convexUrl);
  client.setAuth(token);
  const origin = request.nextUrl.origin;
  const cookieHeader = request.headers.get("cookie");
  const encoder = new TextEncoder();
  const startedAt = Date.now();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const send = (eventType: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(sseFrame(eventType, data)));
        } catch {
          // already closed
        }
      };
      const close = () => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          // already closed
        }
      };
      const heartbeat = setInterval(
        () => send("ping", { elapsedMs: Date.now() - startedAt }),
        HEARTBEAT_INTERVAL_MS,
      );

      try {
        // Fetch snapshot + identity packs in parallel — packs carry
        // per-character voice assignments the M6 speaker-aware routing
        // needs before entering the shot loop.
        const [snapshot, constraintBundle] = await Promise.all([
          client.query(queryRef("storyboards:getStoryboardSnapshot"), {
            storyboardId,
          }) as Promise<StoryboardSnapshot | null>,
          client.query(queryRef("continuityOS:listConstraintBundle"), {
            storyboardId,
          }) as Promise<
            | { identityPacks?: Array<Record<string, unknown>> }
            | null
          >,
        ]);
        if (!snapshot || !snapshot.storyboard) {
          send("error", { message: "Storyboard not found" });
          return;
        }

        // Build a SpeakerVoiceMap keyed on the UPPERCASE character
        // identifier the dialogue extractor emits. Packs can be indexed
        // by either their explicit sourceCharacterId (ViMax ingester)
        // or the pack name — cover both so manual + ingested packs
        // both resolve.
        const speakerVoices: SpeakerVoiceMap = {};
        // M8 — parallel map of UPPERCASE speaker → ElevenLabs voice
        // clone id. When a shot's speaker resolves to a clone, the
        // TTS call routes through ElevenLabs instead of OpenAI
        // (falling back to the preset voice if the clone provider
        // errors). Lookup uses the same key vocabulary as
        // `speakerVoices` so the two maps align naturally.
        const speakerClones: Record<string, string> = {};
        const allowedVoices = new Set([
          "alloy",
          "echo",
          "fable",
          "onyx",
          "nova",
          "shimmer",
        ]);
        // Fetch clone rows up-front — small table per producer,
        // one round-trip, reused across every shot.
        let clonesById = new Map<string, string>();
        try {
          const clones = (await client.query(
            queryRef("voiceClones:listVoiceClones"),
            {},
          )) as Array<{ _id: string; elevenlabsVoiceId: string }> | undefined;
          for (const clone of clones ?? []) {
            clonesById.set(clone._id, clone.elevenlabsVoiceId);
          }
        } catch {
          // Non-fatal — clones are optional. Fall through to the
          // preset-voice path.
          clonesById = new Map();
        }
        for (const pack of constraintBundle?.identityPacks ?? []) {
          const packVoice = typeof pack.voice === "string" ? pack.voice : "";
          const hasPresetVoice =
            packVoice.length > 0 && allowedVoices.has(packVoice);
          const cloneRef =
            typeof pack.voiceCloneId === "string" ? pack.voiceCloneId : "";
          const cloneElevenId = cloneRef ? clonesById.get(cloneRef) : undefined;
          if (!hasPresetVoice && !cloneElevenId) continue;
          const sourceId =
            typeof pack.sourceCharacterId === "string"
              ? pack.sourceCharacterId
              : "";
          const name = typeof pack.name === "string" ? pack.name : "";
          for (const candidate of [sourceId, name]) {
            const key = candidate.trim().toUpperCase();
            if (key.length === 0) continue;
            if (hasPresetVoice) speakerVoices[key] = packVoice;
            if (cloneElevenId) speakerClones[key] = cloneElevenId;
          }
        }

        const shots = snapshot.nodes.filter((n) => n.nodeType === "shot");
        const total = shots.length;
        // Check once whether ffmpeg is available so the worker can
        // decide between single-voice TTS and multi-speaker concat.
        // Absent ffmpeg → multi-speaker shots gracefully fall back to
        // the first-line single-voice path (no crash, just degraded).
        const canMixDialogue = await ffmpegAvailable();
        send("open", {
          total,
          concurrency,
          requestId,
          voice,
          model,
          voiceAssignments: Object.keys(speakerVoices).length,
          canMixDialogue,
        });
        log.info("shot_audio_batch_started", {
          storyboardId,
          total,
          concurrency,
          voice,
          model,
          canMixDialogue,
        });

        const counts = { succeeded: 0, failed: 0, skipped: 0 };
        let cursor = 0;
        const worker = async () => {
          while (true) {
            const index = cursor;
            cursor += 1;
            if (index >= shots.length) return;
            const shot = shots[index];
            const nodeId = shot.nodeId;

            if (skipExisting && shot.media?.activeAudioId) {
              counts.skipped += 1;
              send("shot_skipped", {
                nodeId,
                index,
                reason: "already has active audio",
              });
              continue;
            }

            // M6 speaker-aware routing + M6 voice #1 multi-speaker mix.
            const segmentText = shot.segment ?? "";
            const decision = decidePrimarySpeaker(segmentText, speakerVoices);
            const extracted = extractDialogue(segmentText);
            const attributedLines = extracted.lines.filter(
              (l) => l.speaker !== null,
            );
            const uniqueSpeakers = new Set(
              attributedLines
                .map((l) => (l.speaker ?? "").toUpperCase())
                .filter((s) => s.length > 0),
            );

            // Multi-speaker path: 2+ distinct speakers AND ffmpeg on the
            // host. Each line renders in its own voice and we concat
            // them with a short silence gap. Any failure here falls
            // through to the single-voice path below.
            const mixPlan =
              canMixDialogue && uniqueSpeakers.size >= 2
                ? buildMixPlan({
                    lines: extracted.lines,
                    speakerVoices,
                    defaultVoice: voice,
                  })
                : null;
            if (mixPlan && mixPlan.length >= 2) {
              send("shot_started", {
                nodeId,
                index,
                total,
                mode: "multi_speaker_mix",
                speakerCount: uniqueSpeakers.size,
                lineCount: mixPlan.length,
              });
              let mediaAssetId: Id<"mediaAssets"> | null = null;
              const shotWorkDir = joinPath(
                tmpdir(),
                `audio-mix-${randomUUID()}`,
              );
              try {
                mediaAssetId = (await client.mutation(
                  mutationRef("mediaAssets:startMediaGeneration"),
                  {
                    storyboardId: storyboardId as Id<"storyboards">,
                    nodeId,
                    kind: "audio" as const,
                    modelId: `${model}+mix`,
                    prompt: mixPlan.map((l) => l.text).join(" | "),
                  },
                )) as Id<"mediaAssets">;

                await mkdir(shotWorkDir, { recursive: true });

                // 1. Per-line TTS — call /api/media/generate-audio which
                //    handles OpenAI + Convex storage upload, then
                //    download the resulting URL to disk. M8: resolve
                //    clone ids per-line so each speaker with an
                //    attached voice clone renders through ElevenLabs.
                const linePaths: string[] = [];
                for (const line of mixPlan) {
                  const cloneIdForLine = line.speaker
                    ? speakerClones[line.speaker]
                    : undefined;
                  const res = await fetch(
                    `${origin}/api/media/generate-audio`,
                    {
                      method: "POST",
                      headers: {
                        "Content-Type": "application/json",
                        ...(cookieHeader ? { Cookie: cookieHeader } : {}),
                      },
                      body: JSON.stringify({
                        text: line.text,
                        voice: line.voice,
                        model,
                        speed,
                        elevenlabsVoiceId: cloneIdForLine,
                      }),
                    },
                  );
                  if (!res.ok) {
                    const bodyText = await res.text().catch(() => "");
                    throw new Error(
                      `line ${line.index} TTS ${res.status}: ${bodyText.slice(0, 200)}`,
                    );
                  }
                  const data = (await res.json()) as { url?: string };
                  if (!data.url) throw new Error(`line ${line.index} TTS returned no url`);
                  const dl = await fetch(data.url);
                  if (!dl.ok) throw new Error(`line ${line.index} download ${dl.status}`);
                  const localPath = joinPath(
                    shotWorkDir,
                    `line_${line.index}.mp3`,
                  );
                  await writeFile(
                    localPath,
                    Buffer.from(await dl.arrayBuffer()),
                  );
                  linePaths.push(localPath);
                }

                // 2. Single filter_complex pass: normalize every line to
                //    a canonical 44.1kHz mono shape, pad inter-line gaps
                //    with apad, concat. One ffmpeg invocation, no
                //    shape-mismatch surprises if a TTS provider ever
                //    emits something other than 24kHz mono.
                const mixPath = joinPath(shotWorkDir, "mix.mp3");
                await runFfmpeg(
                  buildDialogueMixArgs(linePaths, mixPath),
                );

                // 3. Upload to Convex storage (same path the cameo +
                //    single-voice TTS uploads use).
                const uploadUrl = (await client.mutation(
                  mutationRef("storage:generateCameoUploadUrl"),
                  {},
                )) as string;
                const { readFile } = await import("node:fs/promises");
                const mixBytes = await readFile(mixPath);
                const mixArrayBuffer = new ArrayBuffer(mixBytes.byteLength);
                new Uint8Array(mixArrayBuffer).set(mixBytes);
                const uploadRes = await fetch(uploadUrl, {
                  method: "POST",
                  headers: { "Content-Type": "audio/mpeg" },
                  body: new Blob([mixArrayBuffer], { type: "audio/mpeg" }),
                });
                if (!uploadRes.ok) {
                  const bodyText = await uploadRes.text().catch(() => "");
                  throw new Error(
                    `mix upload ${uploadRes.status}: ${bodyText.slice(0, 200)}`,
                  );
                }
                const { storageId } = (await uploadRes.json()) as {
                  storageId: string;
                };
                const publicUrl = (await client.mutation(
                  mutationRef("storage:getStorageUrl"),
                  { storageId: storageId as never },
                )) as string;

                await client.mutation(
                  mutationRef("mediaAssets:completeMediaGeneration"),
                  { mediaAssetId, sourceUrl: publicUrl, modelId: `${model}+mix` },
                );
                counts.succeeded += 1;
                send("shot_succeeded", {
                  nodeId,
                  index,
                  sourceUrl: publicUrl,
                  modelId: `${model}+mix`,
                  mode: "multi_speaker_mix",
                  speakerCount: uniqueSpeakers.size,
                  lineCount: mixPlan.length,
                });
                await rm(shotWorkDir, {
                  recursive: true,
                  force: true,
                }).catch(() => undefined);
                continue;
              } catch (err) {
                const msg =
                  err instanceof Error
                    ? err.message
                    : "multi-speaker mix failed";
                log.warn("multi_speaker_mix_failed", {
                  nodeId,
                  error: msg,
                });
                if (mediaAssetId) {
                  try {
                    await client.mutation(
                      mutationRef("mediaAssets:failMediaGeneration"),
                      { mediaAssetId, errorMessage: msg.slice(0, 500) },
                    );
                  } catch {
                    // sweeper will clean
                  }
                }
                await rm(shotWorkDir, {
                  recursive: true,
                  force: true,
                }).catch(() => undefined);
                counts.failed += 1;
                send("shot_failed", {
                  nodeId,
                  index,
                  error: msg,
                  mode: "multi_speaker_mix",
                });
                continue;
              }
            }

            // Single-voice path (fallback when 0-1 speakers or no ffmpeg).
            let effectiveVoice = voice;
            let text: string | null;
            if (decision.speaker && decision.voice && decision.isSoloDialogue) {
              effectiveVoice = decision.voice;
              const dialogueOnly = extracted.lines
                .filter((l) => l.speaker === decision.speaker)
                .map((l) => l.text)
                .join(" ")
                .trim();
              text = dialogueOnly.length > 0
                ? dialogueOnly
                : deriveShotNarrationText(shot);
            } else if (decision.speaker && decision.voice) {
              // Single speaker but narration also present — use their
              // voice to read the full derived narration for cohesion.
              effectiveVoice = decision.voice;
              text = deriveShotNarrationText(shot);
            } else {
              // Narrator-only fallback.
              text = deriveShotNarrationText(shot);
            }
            if (!text) {
              counts.skipped += 1;
              send("shot_skipped", {
                nodeId,
                index,
                reason: "no narration text available",
              });
              continue;
            }

            // M8 — optional translation before TTS. One LLM call per
            // shot (the translator's `batchSize` cap would help a
            // bigger pipeline, but per-shot calls here make the SSE
            // progress granular; batching would delay the first
            // `shot_started` frame). Cache hits on repeat locales are
            // handled by the subtitles route, not here — the narration
            // pipeline uses the LLM directly to keep its stream
            // responsive.
            if (willDub) {
              try {
                const { openAiTranslateBatch } = await import(
                  "@/lib/subtitles"
                );
                const [translated] = await openAiTranslateBatch(
                  [text],
                  locale,
                );
                if (typeof translated === "string" && translated.length > 0) {
                  text = translated;
                }
              } catch (err) {
                // Non-fatal: fall back to the source text so the
                // producer still gets audio (in English) for this
                // shot. Next producer-requested run for the same
                // locale can retry.
                const msg =
                  err instanceof Error ? err.message : String(err);
                log.warn("translate_failed_fallback_source", {
                  nodeId,
                  locale,
                  error: msg,
                });
              }
            }

            send("shot_started", {
              nodeId,
              index,
              total,
              speaker: decision.speaker,
              voice: effectiveVoice,
              locale: willDub ? locale : undefined,
            });

            let mediaAssetId: Id<"mediaAssets"> | null = null;
            try {
              mediaAssetId = (await client.mutation(
                mutationRef("mediaAssets:startMediaGeneration"),
                {
                  storyboardId: storyboardId as Id<"storyboards">,
                  nodeId,
                  kind: "audio" as const,
                  modelId: model,
                  prompt: text,
                },
              )) as Id<"mediaAssets">;
            } catch (err) {
              counts.failed += 1;
              const msg =
                err instanceof Error
                  ? err.message
                  : "startMediaGeneration failed";
              send("shot_failed", { nodeId, index, error: msg });
              continue;
            }

            let generatedUrl: string | null = null;
            // M8 — pick the ElevenLabs clone for the chosen speaker,
            // if any. Narrator-only shots (decision.speaker === null)
            // never pick a clone — narrators go through OpenAI.
            const cloneIdForShot = decision.speaker
              ? speakerClones[decision.speaker]
              : undefined;
            try {
              const abort = new AbortController();
              const timer = setTimeout(() => abort.abort(), PER_SHOT_TIMEOUT_MS);
              try {
                const res = await fetch(`${origin}/api/media/generate-audio`, {
                  method: "POST",
                  headers: {
                    "Content-Type": "application/json",
                    ...(cookieHeader ? { Cookie: cookieHeader } : {}),
                  },
                  body: JSON.stringify({
                    text,
                    voice: effectiveVoice,
                    model,
                    speed,
                    elevenlabsVoiceId: cloneIdForShot,
                  }),
                  signal: abort.signal,
                });
                if (!res.ok) {
                  const bodyText = await res.text().catch(() => "");
                  throw new Error(
                    `generate-audio ${res.status}: ${bodyText.slice(0, 200)}`,
                  );
                }
                const data = (await res.json()) as { url?: string };
                generatedUrl = data.url ?? null;
                if (!generatedUrl)
                  throw new Error("generate-audio returned no url");
              } finally {
                clearTimeout(timer);
              }
            } catch (err) {
              const msg =
                err instanceof Error ? err.message : "audio generation failed";
              try {
                await client.mutation(
                  mutationRef("mediaAssets:failMediaGeneration"),
                  {
                    mediaAssetId,
                    errorMessage: msg.slice(0, 500),
                  },
                );
              } catch {
                // sweeper will clean up
              }
              counts.failed += 1;
              send("shot_failed", { nodeId, index, error: msg });
              continue;
            }

            try {
              await client.mutation(
                mutationRef("mediaAssets:completeMediaGeneration"),
                {
                  mediaAssetId,
                  sourceUrl: generatedUrl,
                  // Dubs must NOT replace the source-language
                  // activeAudioId — they're linked through the
                  // localeNarrations table and picked up at reel-
                  // export time based on the requested locale.
                  ...(willDub ? { skipNodePatch: true } : {}),
                },
              );
            } catch (err) {
              counts.failed += 1;
              const msg =
                err instanceof Error
                  ? err.message
                  : "completeMediaGeneration failed";
              send("shot_failed", { nodeId, index, error: msg });
              continue;
            }

            // M8 — dubbed shots register into the per-locale table so
            // the reel manifest can resolve the right narration per
            // locale without every shot carrying its own `audios` map.
            if (willDub) {
              try {
                await client.mutation(
                  mutationRef(
                    "localeNarrations:upsertLocaleNarration",
                  ),
                  {
                    storyboardId: storyboardId as Id<"storyboards">,
                    nodeId,
                    locale,
                    mediaAssetId,
                    translatedText: text,
                  },
                );
              } catch (err) {
                // Asset is already persisted; upsert failure means
                // the dub is orphaned but not broken. Surface via
                // `shot_failed` so the producer can retry.
                counts.failed += 1;
                send("shot_failed", {
                  nodeId,
                  index,
                  error:
                    err instanceof Error
                      ? `upsertLocaleNarration: ${err.message}`
                      : "upsertLocaleNarration failed",
                });
                continue;
              }
            }

            counts.succeeded += 1;
            send("shot_succeeded", {
              nodeId,
              index,
              sourceUrl: generatedUrl,
              modelId: model,
              speaker: decision.speaker,
              voice: effectiveVoice,
              locale: willDub ? locale : undefined,
            });
          }
        };

        await Promise.all(
          Array.from({ length: Math.min(concurrency, total) }, () => worker()),
        );

        const durationMs = Date.now() - startedAt;
        send("done", {
          total,
          succeeded: counts.succeeded,
          failed: counts.failed,
          skipped: counts.skipped,
          durationMs,
        });
        log.info("shot_audio_batch_completed", {
          storyboardId,
          ...counts,
          durationMs,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error("shot_audio_batch_failed", { error: msg });
        send("error", { message: msg });
      } finally {
        clearInterval(heartbeat);
        close();
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      "X-Request-Id": requestId,
    },
  });
}
