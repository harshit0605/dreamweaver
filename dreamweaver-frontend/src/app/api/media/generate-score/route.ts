/**
 * M8 — reel-level score (music) generation.
 *
 * POST `{ prompt, durationS?, volumeDb?, storyboardId? }` →
 *   1. Validate + normalize via `normalizeScoreDescriptor`
 *   2. Call the configured provider (ElevenLabs Music) to generate
 *      an mp3 of the requested length
 *   3. Upload to Convex `_storage` via a signed URL
 *   4. Return `{ url, storageId, descriptor, byteLength, provider }`
 *
 * 501 when no provider is configured — caller should surface the
 * actionable message. Same shape as `/api/media/generate-sfx`.
 */

import { NextRequest, NextResponse } from "next/server";
import { ConvexHttpClient } from "convex/browser";
import { getToken } from "@/lib/auth-server";
import { mutationRef } from "@/lib/convexRefs";
import { createLogger, resolveRequestId } from "@/lib/observability";
import {
  normalizeScoreDescriptor,
  type ScoreDescriptor,
} from "@/lib/score";

export const runtime = "nodejs";
// Score generation is longer than SFX (50-300s output vs 1-30s) so
// the API call takes proportionally longer.
export const maxDuration = 300;

interface GenerateScoreBody {
  prompt?: string;
  durationS?: number;
  volumeDb?: number;
  storyboardId?: string;
}

interface GenerateScoreResponse {
  url: string;
  storageId: string;
  descriptor: ScoreDescriptor;
  byteLength: number;
  provider: string;
}

/**
 * Call ElevenLabs Music. Kept pluggable behind a single function so a
 * future provider swap (Suno, MusicGen, Stability Audio) only edits
 * this block. Returns raw mp3 bytes.
 */
const generateViaElevenLabs = async (
  descriptor: ScoreDescriptor,
  apiKey: string,
): Promise<ArrayBuffer> => {
  const res = await fetch("https://api.elevenlabs.io/v1/music/compose", {
    method: "POST",
    headers: {
      "xi-api-key": apiKey,
      "Content-Type": "application/json",
      Accept: "audio/mpeg",
    },
    body: JSON.stringify({
      prompt: descriptor.prompt,
      music_length_ms: Math.round(descriptor.durationS * 1000),
    }),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`ElevenLabs Music ${res.status}: ${errText.slice(0, 300)}`);
  }
  return res.arrayBuffer();
};

export async function POST(request: NextRequest): Promise<Response> {
  const requestId = resolveRequestId(request.headers);
  const log = createLogger({ service: "generate-score", requestId });

  const token = await getToken();
  if (!token) {
    return NextResponse.json(
      { error: "Unauthorized" },
      { status: 401, headers: { "X-Request-Id": requestId } },
    );
  }

  let body: GenerateScoreBody;
  try {
    body = (await request.json()) as GenerateScoreBody;
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body" },
      { status: 400, headers: { "X-Request-Id": requestId } },
    );
  }

  const descriptor = normalizeScoreDescriptor(body);
  if (!descriptor) {
    return NextResponse.json(
      { error: "`prompt` is required" },
      { status: 400, headers: { "X-Request-Id": requestId } },
    );
  }

  const elevenlabsKey = process.env.ELEVENLABS_API_KEY;
  if (!elevenlabsKey) {
    log.warn("no_score_provider_configured");
    return NextResponse.json(
      {
        error:
          "No score provider configured. Set ELEVENLABS_API_KEY to "
          + "enable background-score generation.",
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

  // --- 1. Generate --------------------------------------------------
  const endScore = log.startTimer("score_generate", {
    promptLength: descriptor.prompt.length,
    durationS: descriptor.durationS,
  });
  let audioBytes: ArrayBuffer;
  try {
    audioBytes = await generateViaElevenLabs(descriptor, elevenlabsKey);
    endScore({ byteLength: audioBytes.byteLength });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    endScore({ error: msg });
    log.error("score_generate_failed", { error: msg });
    return NextResponse.json(
      { error: `Score generation failed: ${msg}` },
      { status: 502, headers: { "X-Request-Id": requestId } },
    );
  }

  // --- 2. Upload to Convex storage ---------------------------------
  const endUpload = log.startTimer("convex_storage_upload");
  let storageId: string;
  let publicUrl: string;
  try {
    const uploadUrl = (await client.mutation(
      mutationRef("storage:generateCameoUploadUrl"),
      {},
    )) as string;
    const uploadRes = await fetch(uploadUrl, {
      method: "POST",
      headers: { "Content-Type": "audio/mpeg" },
      body: audioBytes,
    });
    if (!uploadRes.ok) {
      const text = await uploadRes.text().catch(() => "");
      throw new Error(`storage upload ${uploadRes.status}: ${text.slice(0, 200)}`);
    }
    const uploadJson = (await uploadRes.json()) as { storageId?: string };
    if (!uploadJson.storageId) {
      throw new Error("storage upload did not return a storageId");
    }
    storageId = uploadJson.storageId;
    publicUrl = (await client.mutation(mutationRef("storage:getStorageUrl"), {
      storageId: storageId as never,
    })) as string;
    endUpload({ storageId });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    endUpload({ error: msg });
    log.error("score_upload_failed", { error: msg });
    return NextResponse.json(
      { error: `Storage upload failed: ${msg}` },
      { status: 502, headers: { "X-Request-Id": requestId } },
    );
  }

  const payload: GenerateScoreResponse = {
    url: publicUrl,
    storageId,
    descriptor,
    byteLength: audioBytes.byteLength,
    provider: "elevenlabs",
  };
  return NextResponse.json(payload, {
    status: 200,
    headers: { "X-Request-Id": requestId },
  });
}
