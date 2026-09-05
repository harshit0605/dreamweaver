/**
 * M7 — streaming variant of the SFX batch.
 *
 * Mirrors the narration batch (`/api/storyboard/generate-shot-audios-stream`)
 * one frame type at a time so `useShotBatchStream` can consume it
 * without a mode-specific parser.
 *
 * Event protocol:
 *   - `open`       { total, concurrency, requestId }
 *   - `ping`       { elapsedMs }                       (every 15s)
 *   - `shot_started`   { nodeId, index, prompt }
 *   - `shot_succeeded` { nodeId, index, sourceUrl, prompt }
 *   - `shot_failed`    { nodeId, index, error }
 *   - `shot_skipped`   { nodeId, index, reason }
 *   - `done`      { total, succeeded, failed, skipped, durationMs }
 *   - `error`     { message }
 *
 * Per-shot logic (prompt derivation, duration clamping, provider call,
 * Convex write) is identical to the non-streaming `generate-shot-sfxs`
 * route so the two paths produce the same output given the same input.
 * We'll dedupe the non-streaming route once every client is on the
 * stream; leaving it in place for now keeps the agent HITL tool's
 * fire-and-forget path working.
 */

import { NextRequest } from "next/server";
import { ConvexHttpClient } from "convex/browser";
import { getToken } from "@/lib/auth-server";
import { mutationRef, queryRef } from "@/lib/convexRefs";
import { sseFrame } from "@/lib/ingest-postprocess";
import { createLogger, resolveRequestId } from "@/lib/observability";
import {
  deriveSfxDurationForShot,
  deriveSfxPromptForShot,
  DEFAULT_SFX_VOLUME_DB,
  normalizeSfxDescriptor,
  type SfxShotLike,
} from "@/lib/sfx";
import type { NodeType, ShotMeta } from "@/app/storyboard/types";

export const runtime = "nodejs";
export const maxDuration = 600;

const DEFAULT_CONCURRENCY = 3;
const HEARTBEAT_INTERVAL_MS = 15_000;

interface GenerateShotSfxsBody {
  storyboardId?: string;
  skipExisting?: boolean;
  concurrency?: number;
  /** Optional per-node overrides — lets the agent HITL pipeline or
   *  a future "edit before approve" UI override specific shots. */
  perShot?: Array<{
    nodeId: string;
    prompt?: string;
    durationS?: number;
    volumeDb?: number;
  }>;
}

interface SnapshotNode {
  nodeId: string;
  nodeType: NodeType;
  segment?: string;
  shotMeta?: ShotMeta;
  media?: {
    activeSfxId?: string;
  };
}

interface StoryboardSnapshot {
  storyboard: { _id: string; title?: string } | null;
  nodes: SnapshotNode[];
}

export async function POST(request: NextRequest): Promise<Response> {
  const requestId = resolveRequestId(request.headers);
  const log = createLogger({
    service: "generate-shot-sfxs-stream",
    requestId,
  });

  const token = await getToken();
  if (!token) {
    return new Response(sseFrame("error", { message: "Unauthorized" }), {
      status: 401,
      headers: {
        "Content-Type": "text/event-stream",
        "X-Request-Id": requestId,
      },
    });
  }

  let body: GenerateShotSfxsBody;
  try {
    body = (await request.json()) as GenerateShotSfxsBody;
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

  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!convexUrl) {
    return new Response(
      sseFrame("error", {
        message: "NEXT_PUBLIC_CONVEX_URL not configured",
      }),
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

  const perShotOverrides = new Map<
    string,
    { prompt?: string; durationS?: number; volumeDb?: number }
  >();
  for (const entry of body.perShot ?? []) {
    if (entry.nodeId) perShotOverrides.set(entry.nodeId, entry);
  }

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
        const snapshot = (await client.query(
          queryRef("storyboards:getStoryboardSnapshot"),
          { storyboardId },
        )) as StoryboardSnapshot | null;
        if (!snapshot || !snapshot.storyboard) {
          send("error", { message: "Storyboard not found" });
          return;
        }

        const shots = snapshot.nodes.filter((n) => n.nodeType === "shot");
        const total = shots.length;
        send("open", { total, concurrency, requestId });

        // Per-shot task plan — skipped shots get their reason emitted
        // up-front so the UI can grey them out before the worker pool
        // reaches them. Matches the audios-stream shape.
        type Task =
          | {
              kind: "skip";
              nodeId: string;
              index: number;
              reason: string;
            }
          | {
              kind: "generate";
              nodeId: string;
              index: number;
              prompt: string;
              durationS: number;
              volumeDb: number;
            };
        const tasks: Task[] = shots.map((shot, index) => {
          if (skipExisting && shot.media?.activeSfxId) {
            return {
              kind: "skip",
              nodeId: shot.nodeId,
              index,
              reason: "already has sfx",
            };
          }
          const override = perShotOverrides.get(shot.nodeId);
          const shotLike: SfxShotLike = {
            segment: shot.segment,
            shotMeta: shot.shotMeta,
          };
          const prompt =
            override?.prompt ?? deriveSfxPromptForShot(shotLike);
          if (!prompt) {
            return {
              kind: "skip",
              nodeId: shot.nodeId,
              index,
              reason: "no prompt could be derived",
            };
          }
          const descriptor = normalizeSfxDescriptor({
            prompt,
            durationS:
              override?.durationS ?? deriveSfxDurationForShot(shotLike),
            volumeDb: override?.volumeDb ?? DEFAULT_SFX_VOLUME_DB,
          });
          if (!descriptor) {
            return {
              kind: "skip",
              nodeId: shot.nodeId,
              index,
              reason: "normalization rejected the prompt",
            };
          }
          return {
            kind: "generate",
            nodeId: shot.nodeId,
            index,
            prompt: descriptor.prompt,
            durationS: descriptor.durationS,
            volumeDb: descriptor.volumeDb,
          };
        });

        let succeeded = 0;
        let failed = 0;
        let skipped = 0;
        let nextIndex = 0;

        const runSlot = async (): Promise<void> => {
          while (true) {
            const i = nextIndex;
            nextIndex += 1;
            if (i >= tasks.length) return;
            const task = tasks[i];
            if (task.kind === "skip") {
              send("shot_skipped", {
                nodeId: task.nodeId,
                index: task.index,
                reason: task.reason,
              });
              skipped += 1;
              continue;
            }
            send("shot_started", {
              nodeId: task.nodeId,
              index: task.index,
              prompt: task.prompt,
            });
            try {
              const res = await fetch(`${origin}/api/media/generate-sfx`, {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  ...(cookieHeader ? { Cookie: cookieHeader } : {}),
                },
                body: JSON.stringify({
                  prompt: task.prompt,
                  durationS: task.durationS,
                  volumeDb: task.volumeDb,
                  storyboardId,
                }),
              });
              if (!res.ok) {
                const payload = (await res.json().catch(() => ({}))) as {
                  error?: string;
                };
                const err =
                  payload.error
                  ?? `SFX generation failed (${res.status})`;
                send("shot_failed", {
                  nodeId: task.nodeId,
                  index: task.index,
                  error: err,
                });
                failed += 1;
                continue;
              }
              const data = (await res.json()) as {
                url: string;
                provider: string;
              };
              await client.mutation(
                mutationRef("mediaAssets:createMediaAsset"),
                {
                  storyboardId: storyboardId as never,
                  nodeId: task.nodeId,
                  kind: "sfx",
                  sourceUrl: data.url,
                  modelId: data.provider,
                  prompt: task.prompt,
                  status: "completed",
                  metadata: {
                    durationS: String(task.durationS),
                    volumeDb: String(task.volumeDb),
                  },
                },
              );
              send("shot_succeeded", {
                nodeId: task.nodeId,
                index: task.index,
                sourceUrl: data.url,
                prompt: task.prompt,
              });
              succeeded += 1;
            } catch (err) {
              send("shot_failed", {
                nodeId: task.nodeId,
                index: task.index,
                error: err instanceof Error ? err.message : String(err),
              });
              failed += 1;
            }
          }
        };

        const slots = Array.from(
          { length: Math.min(concurrency, Math.max(1, tasks.length)) },
          () => runSlot(),
        );
        await Promise.all(slots);

        const durationMs = Date.now() - startedAt;
        send("done", {
          total,
          succeeded,
          failed,
          skipped,
          durationMs,
        });
        log.info("sfx_batch_stream_complete", {
          storyboardId,
          total,
          succeeded,
          failed,
          skipped,
          durationMs,
        });
      } catch (err) {
        send("error", {
          message: err instanceof Error ? err.message : String(err),
        });
        log.error("sfx_batch_stream_failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        clearInterval(heartbeat);
        close();
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      "X-Request-Id": requestId,
    },
  });
}
