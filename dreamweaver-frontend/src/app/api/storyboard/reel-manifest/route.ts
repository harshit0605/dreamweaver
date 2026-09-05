/**
 * M5 #3 — reel manifest: ordered list of shot media that the ReelPlayer
 * plays back-to-back. Serializes the storyboard's shot graph into a
 * linear edit decision list (EDL) using the existing
 * `storyboards:getStoryboardSnapshot` query — no new mutations, no
 * ffmpeg, no heavy client bundle.
 *
 * Order: shots are sorted by `shotMeta.number` parsed as "<episode>-<n>"
 * or "<n>" so a 5-episode novel ingest produces a sensible playthrough.
 * Shots without numbers fall through to their position in the snapshot
 * (which is insertion order).
 *
 * Response shape:
 *   {
 *     storyboardId, title,
 *     totalDurationS,   // sum of shot durations
 *     shots: [
 *       { nodeId, index, number?, label, durationS, videoUrl?,
 *         imageUrl?, audioUrl?, prompt? },
 *       ...
 *     ]
 *   }
 */

import { NextRequest, NextResponse } from "next/server";
import { ConvexHttpClient } from "convex/browser";
import { getToken } from "@/lib/auth-server";
import { queryRef } from "@/lib/convexRefs";
import { createLogger, resolveRequestId } from "@/lib/observability";
import type { NodeType, ShotMeta } from "@/app/storyboard/types";

export const runtime = "nodejs";
export const maxDuration = 30;

interface MediaVariant {
  mediaAssetId: string;
  url: string;
  modelId: string;
  createdAt: number;
  /** M7 — variant-level metadata. SFX variants carry `volumeDb`
   *  (stringified) so the reel export can mix at the producer's
   *  chosen level without an extra Convex lookup per shot. */
  metadata?: Record<string, string>;
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
    sfxs?: MediaVariant[];
    activeImageId?: string;
    activeVideoId?: string;
    activeAudioId?: string;
    activeSfxId?: string;
  };
}

interface StoryboardSnapshot {
  storyboard: { _id: string; title?: string } | null;
  nodes: SnapshotNode[];
}

export interface ReelShot {
  nodeId: string;
  index: number;
  number: string | null;
  label: string;
  /** Seconds; clamped to [1, 30] even when shotMeta says something wild. */
  durationS: number;
  videoUrl: string | null;
  imageUrl: string | null;
  audioUrl: string | null;
  /** M7 — active SFX (ambient / foley) track for this shot. Mixed
   *  UNDER the narration during reel export. `null` when the shot has
   *  no SFX assigned. */
  sfxUrl: string | null;
  /** M7 — producer-chosen volume trim in dB for the active SFX.
   *  `null` when no SFX or no volume metadata; the export pipeline
   *  falls back to `DEFAULT_SFX_VOLUME_DB` in that case. */
  sfxVolumeDb: number | null;
  prompt: string | null;
}

export interface ReelScoreTrack {
  /** URL of the score mp3 stored in Convex `_storage`. */
  url: string;
  /** Mix level in dB. `null` → the export pipeline falls back to
   *  DEFAULT_SCORE_VOLUME_DB. */
  volumeDb: number | null;
  /** Diagnostic — the prompt the producer used. Surfaced so the
   *  ReelPlayer can show "Score: <prompt>" in its score panel. */
  prompt: string;
}

export interface ReelManifest {
  storyboardId: string;
  title: string;
  /** M8 — reel-level background music. `null` when no score is
   *  attached; both the export pipeline and the in-browser player
   *  treat that as "narration + SFX only". */
  score?: ReelScoreTrack | null;
  totalDurationS: number;
  shots: ReelShot[];
}

/** Parse "Ep2-5" / "5" / "5.1" style shot numbers into a sortable tuple
 *  `[episodeOrdinal, shotOrdinal]`. Unknown shapes return [Infinity,
 *  Infinity] so they sort to the end without blocking playback. */
export const parseShotNumber = (
  raw: string | undefined,
): [number, number] => {
  if (!raw) return [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
  const ep = raw.match(/^Ep(\d+)-(\d+(?:\.\d+)?)$/i);
  if (ep) {
    return [Number.parseInt(ep[1], 10), Number.parseFloat(ep[2])];
  }
  const n = Number.parseFloat(raw);
  if (Number.isFinite(n)) {
    return [0, n];
  }
  return [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
};

/** Resolve a specific mediaAsset-id to its URL from the node's
 *  media.{images|videos|audios} array. Returns null when the id is
 *  missing or doesn't match any variant. Exported for unit tests. */
export const resolveActiveMediaUrl = (
  variants: MediaVariant[] | undefined,
  activeId: string | undefined,
): string | null => {
  if (!activeId || !variants || variants.length === 0) return null;
  const hit = variants.find((v) => v.mediaAssetId === activeId);
  return hit?.url ?? null;
};

/** Build the manifest from a snapshot. Pure function — exported for
 *  tests. Expects shots pre-filtered (nodeType === "shot"). */
export const buildReelManifest = (
  storyboardId: string,
  title: string,
  shots: SnapshotNode[],
): ReelManifest => {
  const withOrder = shots
    .map((shot, originalIndex) => ({
      shot,
      originalIndex,
      sortKey: parseShotNumber(shot.shotMeta?.number),
    }))
    .sort((a, b) => {
      if (a.sortKey[0] !== b.sortKey[0]) return a.sortKey[0] - b.sortKey[0];
      if (a.sortKey[1] !== b.sortKey[1]) return a.sortKey[1] - b.sortKey[1];
      return a.originalIndex - b.originalIndex;
    });

  const reelShots: ReelShot[] = withOrder.map(({ shot }, index) => {
    const rawDuration = shot.shotMeta?.durationS;
    const durationS = Math.max(
      1,
      Math.min(
        30,
        typeof rawDuration === "number" && Number.isFinite(rawDuration)
          ? rawDuration
          : 5,
      ),
    );
    return {
      nodeId: shot.nodeId,
      index,
      number: shot.shotMeta?.number ?? null,
      label: shot.label,
      durationS,
      videoUrl: resolveActiveMediaUrl(
        shot.media?.videos,
        shot.media?.activeVideoId,
      ),
      imageUrl: resolveActiveMediaUrl(
        shot.media?.images,
        shot.media?.activeImageId,
      ),
      audioUrl: resolveActiveMediaUrl(
        shot.media?.audios,
        shot.media?.activeAudioId,
      ),
      sfxUrl: resolveActiveMediaUrl(
        shot.media?.sfxs,
        shot.media?.activeSfxId,
      ),
      sfxVolumeDb: (() => {
        const variants = shot.media?.sfxs;
        const activeId = shot.media?.activeSfxId;
        if (!variants || !activeId) return null;
        const hit = variants.find((v) => v.mediaAssetId === activeId);
        const raw = hit?.metadata?.volumeDb;
        if (typeof raw !== "string") return null;
        const n = Number(raw);
        return Number.isFinite(n) ? n : null;
      })(),
      prompt: shot.promptPack?.imagePrompt ?? shot.segment ?? null,
    };
  });
  const totalDurationS = reelShots.reduce((sum, s) => sum + s.durationS, 0);
  return { storyboardId, title, totalDurationS, shots: reelShots };
};

export async function GET(request: NextRequest): Promise<Response> {
  const requestId = resolveRequestId(request.headers);
  const log = createLogger({ service: "reel-manifest", requestId });

  const token = await getToken();
  if (!token) {
    return NextResponse.json(
      { error: "Unauthorized" },
      { status: 401, headers: { "X-Request-Id": requestId } },
    );
  }
  const storyboardId = request.nextUrl.searchParams.get("storyboardId");
  if (!storyboardId) {
    return NextResponse.json(
      { error: "storyboardId query param is required" },
      { status: 400, headers: { "X-Request-Id": requestId } },
    );
  }
  // M8 — optional locale override. When non-source, we overlay each
  // shot's narration with the dubbed mp3 from localeNarrations. Empty
  // / en / en-* returns the source-language manifest unchanged.
  const localeParam = (
    request.nextUrl.searchParams.get("locale") ?? ""
  ).trim();

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
  const manifest = buildReelManifest(
    storyboardId,
    snapshot.storyboard.title ?? "Untitled",
    shots,
  );

  // M8 — swap in dubbed narration when a locale was requested. We
  // run this BEFORE the score lookup so both writes land in the same
  // manifest return below.
  if (localeParam) {
    const { isSourceLocale } = await import("@/lib/subtitles");
    if (!isSourceLocale(localeParam)) {
      try {
        const dubs = (await client.query(
          queryRef("localeNarrations:listForReel"),
          { storyboardId, locale: localeParam },
        )) as Array<{
          nodeId: string;
          sourceUrl: string;
        }>;
        const byNode = new Map(dubs.map((d) => [d.nodeId, d.sourceUrl]));
        for (const shot of manifest.shots) {
          const dubbed = byNode.get(shot.nodeId);
          if (dubbed) {
            shot.audioUrl = dubbed;
          }
        }
      } catch {
        // Non-fatal — fall back to source-language narration if the
        // locale table is empty or errors.
      }
    }
  }

  // M8 — attach the reel-level score, if any. Parallel fetch is
  // intentional: the query doesn't depend on anything above except
  // the authenticated client.
  try {
    const score = (await client.query(
      queryRef("storyboards:getStoryboardScore"),
      { storyboardId },
    )) as {
      sourceUrl: string;
      prompt: string;
      volumeDb: number | null;
    } | null;
    if (score) {
      manifest.score = {
        url: score.sourceUrl,
        volumeDb: score.volumeDb,
        prompt: score.prompt,
      };
    } else {
      manifest.score = null;
    }
  } catch {
    // Non-fatal — a missing score just means no music layer.
    manifest.score = null;
  }

  log.info("reel_manifest_built", {
    storyboardId,
    shotCount: manifest.shots.length,
    totalDurationS: manifest.totalDurationS,
    shotsWithVideo: manifest.shots.filter((s) => !!s.videoUrl).length,
    shotsWithImage: manifest.shots.filter((s) => !!s.imageUrl).length,
    shotsWithAudio: manifest.shots.filter((s) => !!s.audioUrl).length,
    hasScore: Boolean(manifest.score),
  });

  return NextResponse.json(manifest, {
    status: 200,
    headers: { "X-Request-Id": requestId },
  });
}
