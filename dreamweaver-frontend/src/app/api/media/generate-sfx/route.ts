/**
 * M7 — per-shot SFX generation.
 *
 * POST `{ prompt, durationS?, volumeDb?, storyboardId? }` →
 *   1. Validate + normalize via `normalizeSfxDescriptor`
 *   2. Call the configured provider (ElevenLabs Sound Effects) to
 *      generate an mp3 of the requested ambient / foley track
 *   3. Upload to Convex `_storage` via a signed URL
 *   4. Return `{ url, storageId, durationS, volumeDb }`
 *
 * Scaffolding note: the route does NOT attach the SFX to a storyboard
 * node yet — that wiring lives in the mix step. This endpoint just
 * produces the asset so downstream callers (a future `generate-shot-sfx-
 * stream` batch or an agent HITL tool) can attach it via
 * `mediaAssets:createMediaAsset` with `kind: "sfx"`.
 *
 * 501 when no provider is configured: the caller should surface an
 * actionable message instead of crashing on a missing env var.
 */

import { NextRequest, NextResponse } from "next/server";
import { ConvexHttpClient } from "convex/browser";
import { getToken } from "@/lib/auth-server";
import { mutationRef } from "@/lib/convexRefs";
import { createLogger, resolveRequestId } from "@/lib/observability";
import { normalizeSfxDescriptor, type SfxDescriptor } from "@/lib/sfx";

export const runtime = "nodejs";
export const maxDuration = 120;

interface GenerateSfxBody {
  prompt?: string;
  durationS?: number;
  volumeDb?: number;
  /** Optional — future-proof for when we want to correlate generated
   *  SFX with a particular storyboard in the observability log. */
  storyboardId?: string;
}

interface GenerateSfxResponse {
  url: string;
  storageId: string;
  descriptor: SfxDescriptor;
  byteLength: number;
  provider: string;
}

/**
 * Call ElevenLabs Sound Effects. Pulled out so a future provider swap
 * (Stability Audio, Meta AudioCraft, etc.) only touches this function.
 * Returns raw mp3 bytes.
 */
const generateViaElevenLabs = async (
  descriptor: SfxDescriptor,
  apiKey: string,
): Promise<ArrayBuffer> => {
  const res = await fetch("https://api.elevenlabs.io/v1/sound-generation", {
    method: "POST",
    headers: {
      "xi-api-key": apiKey,
      "Content-Type": "application/json",
      Accept: "audio/mpeg",
    },
    body: JSON.stringify({
      text: descriptor.prompt,
      duration_seconds: descriptor.durationS,
      prompt_influence: 0.5,
    }),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(
      `ElevenLabs ${res.status}: ${errText.slice(0, 300)}`,
    );
  }
  return res.arrayBuffer();
};

export async function POST(request: NextRequest): Promise<Response> {
  const requestId = resolveRequestId(request.headers);
  const log = createLogger({ service: "generate-sfx", requestId });

  const token = await getToken();
  if (!token) {
    return NextResponse.json(
      { error: "Unauthorized" },
      { status: 401, headers: { "X-Request-Id": requestId } },
    );
  }

  let body: GenerateSfxBody;
  try {
    body = (await request.json()) as GenerateSfxBody;
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body" },
      { status: 400, headers: { "X-Request-Id": requestId } },
    );
  }

  const descriptor = normalizeSfxDescriptor(body);
  if (!descriptor) {
    return NextResponse.json(
      { error: "`prompt` is required" },
      { status: 400, headers: { "X-Request-Id": requestId } },
    );
  }

  const elevenlabsKey = process.env.ELEVENLABS_API_KEY;
  if (!elevenlabsKey) {
    // 501 mirrors the reel-export route's "ffmpeg unavailable" signal
    // so the UI can surface "install / configure a provider" without
    // conflating a missing key with a real runtime error.
    log.warn("no_sfx_provider_configured");
    return NextResponse.json(
      {
        error:
          "No SFX provider configured. Set ELEVENLABS_API_KEY to enable " +
          "sound-effects generation.",
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
  const endSfx = log.startTimer("sfx_generate", {
    promptLength: descriptor.prompt.length,
    durationS: descriptor.durationS,
  });
  let audioBytes: ArrayBuffer;
  try {
    audioBytes = await generateViaElevenLabs(descriptor, elevenlabsKey);
    endSfx({ byteLength: audioBytes.byteLength });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    endSfx({ error: msg });
    log.error("sfx_generate_failed", { error: msg });
    return NextResponse.json(
      { error: `SFX generation failed: ${msg}` },
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
    log.error("sfx_upload_failed", { error: msg });
    return NextResponse.json(
      { error: `Storage upload failed: ${msg}` },
      { status: 502, headers: { "X-Request-Id": requestId } },
    );
  }

  const payload: GenerateSfxResponse = {
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
