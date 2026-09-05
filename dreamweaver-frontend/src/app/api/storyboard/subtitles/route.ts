/**
 * M7 — subtitle export.
 *
 * GET `/api/storyboard/subtitles?storyboardId=…&format=srt|vtt`
 *   → text/plain subtitle file (content-type set to the format-specific
 *     MIME type) suitable for loading into a <track kind="subtitles">
 *     element or dropping into an editor.
 *
 * Reuses the same shot ordering as `/api/storyboard/reel-manifest` so a
 * reel + its subtitle file share a timeline: cue N's startS lines up
 * with the Nth line of dialogue on the reel.
 */

import { NextRequest, NextResponse } from "next/server";
import { ConvexHttpClient } from "convex/browser";
import { getToken } from "@/lib/auth-server";
import { mutationRef, queryRef } from "@/lib/convexRefs";
import { createLogger, resolveRequestId } from "@/lib/observability";
import { parseShotNumber } from "@/app/api/storyboard/reel-manifest/route";
import {
  buildSubtitleCues,
  fingerprintCueTexts,
  isSourceLocale,
  renderSrt,
  renderVtt,
  translateCues,
  type SubtitleCue,
  type SubtitleShotInput,
} from "@/lib/subtitles";
import type { NodeType, ShotMeta } from "@/app/storyboard/types";

export const runtime = "nodejs";
export const maxDuration = 30;

interface SnapshotNode {
  nodeId: string;
  nodeType: NodeType;
  label: string;
  segment: string;
  shotMeta?: ShotMeta;
}

interface StoryboardSnapshot {
  storyboard: { _id: string; title?: string } | null;
  nodes: SnapshotNode[];
}

const DEFAULT_DURATION_S = 5;
const MIN_DURATION_S = 1;
const MAX_DURATION_S = 30;

const parseFormat = (raw: string | null): "srt" | "vtt" | "json" => {
  const v = (raw ?? "").trim().toLowerCase();
  if (v === "srt") return "srt";
  if (v === "json") return "json";
  return "vtt";
};

/** Project the filtered shot list into SubtitleShotInput[] in reel
 *  order. Exported so unit tests can exercise the ordering + duration
 *  clamp without standing up the Convex client. */
export const buildSubtitleInputs = (
  shots: SnapshotNode[],
): SubtitleShotInput[] => {
  const ordered = shots
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
  return ordered.map(({ shot }) => {
    const rawDuration = shot.shotMeta?.durationS;
    const durationS = Math.max(
      MIN_DURATION_S,
      Math.min(
        MAX_DURATION_S,
        typeof rawDuration === "number" && Number.isFinite(rawDuration)
          ? rawDuration
          : DEFAULT_DURATION_S,
      ),
    );
    return {
      nodeId: shot.nodeId,
      segment: shot.segment ?? "",
      durationS,
    };
  });
};

export async function GET(request: NextRequest): Promise<Response> {
  const requestId = resolveRequestId(request.headers);
  const log = createLogger({ service: "subtitles", requestId });

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
  const format = parseFormat(request.nextUrl.searchParams.get("format"));
  // M7 multi-language — `locale` query selects the target language.
  // Absent / "en" / "en-*" skips translation and serves the source
  // dialogue directly.
  const locale = (request.nextUrl.searchParams.get("locale") ?? "").trim();
  const willTranslate = !isSourceLocale(locale);

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
  const inputs = buildSubtitleInputs(shots);
  let cues = buildSubtitleCues(inputs);

  let translationSource: "cache" | "live" | "n/a" = "n/a";
  if (willTranslate) {
    const sourceTexts = cues.map((c) => c.text);
    const cuesHash = fingerprintCueTexts(sourceTexts);
    const endTranslate = log.startTimer("subtitles_translate", {
      locale,
      cueCount: cues.length,
      cuesHash,
    });

    // 1. Cache lookup — if the row for (storyboardId, locale) matches
    //    our source fingerprint exactly, we can skip the OpenAI call
    //    entirely. Invalidation happens naturally: edit any dialogue
    //    and the hash changes, bypassing the stale row.
    try {
      const cached = (await client.query(
        queryRef("subtitleTranslations:getTranslation"),
        { storyboardId, locale },
      )) as {
        cuesHash: string;
        translatedTextsJson: string;
      } | null;
      if (cached && cached.cuesHash === cuesHash) {
        let cachedTexts: unknown;
        try {
          cachedTexts = JSON.parse(cached.translatedTextsJson);
        } catch {
          cachedTexts = null;
        }
        if (
          Array.isArray(cachedTexts)
          && cachedTexts.length === cues.length
        ) {
          // Re-apply speaker prefixes from the SOURCE cues. The cached
          // array only carries translated bodies so a producer
          // renaming a character in the source (via identityPacks)
          // doesn't require re-translating the whole reel.
          cues = cues.map((cue, i) => {
            const match = /^([A-Z][A-Z0-9_' -]{0,40}):\s+/.exec(cue.text);
            const prefix = match ? match[0] : "";
            return {
              ...cue,
              text: `${prefix}${String(cachedTexts[i])}`,
            } as SubtitleCue;
          });
          translationSource = "cache";
          endTranslate({ source: "cache" });
        }
      }
    } catch (err) {
      // Cache read failures are non-fatal — fall through to live
      // translation. Log so the observability layer catches
      // systematic issues (auth, network).
      log.warn("translation_cache_read_failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // 2. Live translate + cache write.
    if (translationSource === "n/a") {
      try {
        cues = await translateCues(cues, locale);
        translationSource = "live";
        // Persist only the translated bodies (prefix-stripped) so the
        // same row serves future fetches even if the producer renames
        // a speaker.
        const prefixStripped = cues.map((c) => {
          const m = /^([A-Z][A-Z0-9_' -]{0,40}):\s+/.exec(c.text);
          return m ? c.text.slice(m[0].length) : c.text;
        });
        try {
          await client.mutation(
            mutationRef("subtitleTranslations:upsertTranslation"),
            {
              storyboardId,
              locale,
              cuesHash,
              translatedTextsJson: JSON.stringify(prefixStripped),
              provider: "openai:gpt-4o-mini",
            },
          );
        } catch (err) {
          // Write failures are non-fatal — the user still gets their
          // (live-translated) captions; only future requests pay the
          // re-translation cost.
          log.warn("translation_cache_write_failed", {
            error: err instanceof Error ? err.message : String(err),
          });
        }
        endTranslate({ source: "live" });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        endTranslate({ error: msg });
        return NextResponse.json(
          { error: `Translation failed: ${msg}` },
          { status: 502, headers: { "X-Request-Id": requestId } },
        );
      }
    }
  }

  log.info("subtitles_generated", {
    storyboardId,
    format,
    locale: locale || "en",
    shotCount: inputs.length,
    cueCount: cues.length,
    translationSource,
  });

  if (format === "json") {
    // JSON format exists for the in-browser preview overlay — avoids a
    // second VTT parser on the client. Structured payload lets the
    // player filter cues by nodeId / do time lookups directly.
    return NextResponse.json(
      { storyboardId, cueCount: cues.length, cues },
      {
        status: 200,
        headers: {
          "Cache-Control": "no-store",
          "X-Request-Id": requestId,
          "X-Cue-Count": String(cues.length),
        },
      },
    );
  }

  const body = format === "srt" ? renderSrt(cues) : renderVtt(cues);

  // Safe filename for Content-Disposition — strip non-[A-Za-z0-9_-]
  // from the title and fall back to the storyboard id.
  const titleRaw = snapshot.storyboard.title ?? storyboardId;
  const safeStem = titleRaw.replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 80);
  const safeLocale =
    willTranslate && locale
      ? `.${locale.replace(/[^A-Za-z0-9-]+/g, "_")}`
      : "";
  const filename = `${safeStem || storyboardId}${safeLocale}.${format}`;

  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type":
        format === "srt"
          ? "application/x-subrip; charset=utf-8"
          : "text/vtt; charset=utf-8",
      "Content-Disposition": `inline; filename="${filename}"`,
      "Cache-Control": "no-store",
      "X-Request-Id": requestId,
      "X-Cue-Count": String(cues.length),
    },
  });
}
