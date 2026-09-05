/**
 * M7 — autonomous SFX batch.
 *
 * @deprecated Prefer `/api/storyboard/generate-shot-sfxs-stream` for
 * producer-facing flows — the streaming variant drives the per-shot
 * progress grid in `GenerateAllSfxsButton`. This non-streaming route
 * is kept so non-interactive callers (tests, internal scripts) can
 * still request a batch + a terminal JSON response in one shot.
 *
 * POST `{ storyboardId, skipExisting?, concurrency? }` → JSON with
 * per-shot results.
 *
 * Per shot:
 *   1. Derive an SFX prompt via `deriveSfxPromptForShot` (shotMeta.sfx
 *      hints preferred; segment fallback; null when neither works).
 *   2. Call the existing `/api/media/generate-sfx` route (DRY — same
 *      provider configuration, error handling, storage upload).
 *   3. On success, create a `kind: "sfx"` mediaAsset via
 *      `mediaAssets:createMediaAsset`, which also patches the node's
 *      `activeSfxId` so the reel mix picks it up automatically.
 *
 * `skipExisting` (default true) skips shots that already have an
 * `activeSfxId` — the most common producer intent.
 */

import { NextRequest, NextResponse } from "next/server";
import { ConvexHttpClient } from "convex/browser";
import { getToken } from "@/lib/auth-server";
import { mutationRef, queryRef } from "@/lib/convexRefs";
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

interface GenerateShotSfxsBody {
  storyboardId?: string;
  skipExisting?: boolean;
  concurrency?: number;
  /** Optional per-node overrides — lets producers edit prompts in the
   *  UI before triggering the batch without having to run each shot
   *  one-at-a-time. Shots not listed here fall back to the derived
   *  prompt. */
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

interface ShotResult {
  nodeId: string;
  status: "succeeded" | "failed" | "skipped";
  sourceUrl?: string;
  error?: string;
}

/** Run a batch of async tasks with bounded concurrency. Returns results
 *  in the same order as `items`. Kept local to this route — existing
 *  batch runners in the repo use stream-scoped machinery that's more
 *  complex than this non-streaming pipeline needs. */
const runWithConcurrency = async <T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> => {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  const runSlot = async (): Promise<void> => {
    while (true) {
      const i = nextIndex;
      nextIndex += 1;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
    }
  };
  const slots = Array.from(
    { length: Math.min(concurrency, Math.max(1, items.length)) },
    () => runSlot(),
  );
  await Promise.all(slots);
  return results;
};

export async function POST(request: NextRequest): Promise<Response> {
  const requestId = resolveRequestId(request.headers);
  const log = createLogger({
    service: "generate-shot-sfxs",
    requestId,
  });

  const token = await getToken();
  if (!token) {
    return NextResponse.json(
      { error: "Unauthorized" },
      { status: 401, headers: { "X-Request-Id": requestId } },
    );
  }

  let body: GenerateShotSfxsBody;
  try {
    body = (await request.json()) as GenerateShotSfxsBody;
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
  const skipExisting = body.skipExisting !== false;
  const concurrency = Math.min(
    Math.max(1, body.concurrency ?? DEFAULT_CONCURRENCY),
    5,
  );

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

  const perShotOverrides = new Map<
    string,
    { prompt?: string; durationS?: number; volumeDb?: number }
  >();
  for (const entry of body.perShot ?? []) {
    if (entry.nodeId) perShotOverrides.set(entry.nodeId, entry);
  }

  const shots = snapshot.nodes.filter((n) => n.nodeType === "shot");

  // Pre-compute the task set: each shot either gets a generate task or
  // a "skipped" sentinel. Skipped shots still appear in the response
  // so the producer can see which ones were excluded and why.
  const tasks = shots.map<
    | {
        kind: "skip";
        nodeId: string;
        reason: string;
      }
    | {
        kind: "generate";
        nodeId: string;
        prompt: string;
        durationS: number;
        volumeDb: number;
      }
  >((shot) => {
    if (skipExisting && shot.media?.activeSfxId) {
      return {
        kind: "skip",
        nodeId: shot.nodeId,
        reason: "already has sfx",
      };
    }
    const override = perShotOverrides.get(shot.nodeId);
    const shotLike: SfxShotLike = {
      segment: shot.segment,
      shotMeta: shot.shotMeta,
    };
    const prompt = override?.prompt ?? deriveSfxPromptForShot(shotLike);
    if (!prompt) {
      return {
        kind: "skip",
        nodeId: shot.nodeId,
        reason: "no prompt could be derived",
      };
    }
    const descriptor = normalizeSfxDescriptor({
      prompt,
      durationS: override?.durationS ?? deriveSfxDurationForShot(shotLike),
      volumeDb: override?.volumeDb ?? DEFAULT_SFX_VOLUME_DB,
    });
    if (!descriptor) {
      return {
        kind: "skip",
        nodeId: shot.nodeId,
        reason: "normalization rejected the prompt",
      };
    }
    return {
      kind: "generate",
      nodeId: shot.nodeId,
      prompt: descriptor.prompt,
      durationS: descriptor.durationS,
      volumeDb: descriptor.volumeDb,
    };
  });

  const origin = request.nextUrl.origin;
  const cookieHeader = request.headers.get("cookie");
  const startedAt = Date.now();

  const results = await runWithConcurrency<typeof tasks[number], ShotResult>(
    tasks,
    concurrency,
    async (task): Promise<ShotResult> => {
      if (task.kind === "skip") {
        return {
          nodeId: task.nodeId,
          status: "skipped",
          error: task.reason,
        };
      }
      try {
        // Reuse the single-shot route so there's exactly one provider
        // integration to maintain. Forward auth via the cookie header
        // so /api/media/generate-sfx's getToken() sees the same
        // session. `request.nextUrl.origin` covers both prod + dev.
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
          return {
            nodeId: task.nodeId,
            status: "failed",
            error:
              payload.error ?? `SFX generation failed (${res.status})`,
          };
        }
        const data = (await res.json()) as {
          url: string;
          provider: string;
        };
        await client.mutation(mutationRef("mediaAssets:createMediaAsset"), {
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
        });
        return {
          nodeId: task.nodeId,
          status: "succeeded",
          sourceUrl: data.url,
        };
      } catch (err) {
        return {
          nodeId: task.nodeId,
          status: "failed",
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  );

  const counts = {
    total: results.length,
    succeeded: results.filter((r) => r.status === "succeeded").length,
    failed: results.filter((r) => r.status === "failed").length,
    skipped: results.filter((r) => r.status === "skipped").length,
  };

  log.info("sfx_batch_complete", {
    storyboardId,
    ...counts,
    elapsedMs: Date.now() - startedAt,
  });

  return NextResponse.json(
    { storyboardId, counts, results },
    {
      status: 200,
      headers: { "X-Request-Id": requestId },
    },
  );
}
