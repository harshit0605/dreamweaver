/**
 * M5 #2 — text-to-speech for shot narration.
 *
 * POST `{ text, voice?, model?, speed?, storyboardId }` →
 *   1. OpenAI `/v1/audio/speech` (tts-1 by default) → mp3 bytes
 *   2. Upload to Convex `_storage` via a signed URL
 *   3. Return `{ url, storageId }` so the caller can stash the URL on
 *      a mediaAsset.
 *
 * Zero-dep: talks to the OpenAI HTTP API directly so we don't carry an
 * SDK for one endpoint. Uploads to Convex storage the same way the
 * cameo flow does (generate upload URL, POST bytes, get back id).
 */

import { NextRequest, NextResponse } from "next/server";
import { ConvexHttpClient } from "convex/browser";
import { getToken } from "@/lib/auth-server";
import { mutationRef } from "@/lib/convexRefs";
import { createLogger, resolveRequestId } from "@/lib/observability";

export const runtime = "nodejs";
export const maxDuration = 120;

// Per OpenAI TTS docs, supported voices. Default picks a neutral
// midrange — producers can override via the `voice` param.
const ALLOWED_VOICES = new Set([
  "alloy",
  "echo",
  "fable",
  "onyx",
  "nova",
  "shimmer",
]);
const DEFAULT_VOICE = "nova";
const DEFAULT_MODEL = "tts-1";
const MIN_SPEED = 0.25;
const MAX_SPEED = 4.0;

interface GenerateAudioBody {
  text?: string;
  voice?: string;
  model?: string;
  /** OpenAI TTS speed, 0.25–4.0. Defaults to 1.0. */
  speed?: number;
  /** M8 — ElevenLabs voice clone id. When present AND
   *  `ELEVENLABS_API_KEY` is configured, the route skips OpenAI TTS
   *  and generates via ElevenLabs using this voice. Falls back to
   *  OpenAI (with `voice`) on provider error or missing key so a
   *  missing config downgrade quality rather than fail the batch. */
  elevenlabsVoiceId?: string;
}

interface GenerateAudioResponse {
  url: string;
  storageId: string;
  voice: string;
  model: string;
  speed: number;
  byteLength: number;
  /** Provider that actually produced the mp3. Useful for observability
   *  when a clone request falls back to OpenAI. */
  provider: "openai" | "elevenlabs";
}

/** Call OpenAI TTS. Extracted so the provider-routing block below
 *  can retry the OpenAI path after an ElevenLabs fallback without
 *  duplicating the fetch body. */
const fetchOpenAiTts = async (
  apiKey: string,
  input: { model: string; voice: string; text: string; speed: number },
): Promise<ArrayBuffer> => {
  const res = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: input.model,
      voice: input.voice,
      input: input.text,
      speed: input.speed,
      response_format: "mp3",
    }),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(
      `OpenAI TTS ${res.status}: ${errText.slice(0, 300)}`,
    );
  }
  return res.arrayBuffer();
};

/** Call ElevenLabs TTS with a voice clone id. Returns raw mp3 bytes.
 *  Throws on non-2xx so the caller can log + fall back. */
const generateViaElevenLabs = async (
  text: string,
  voiceId: string,
  apiKey: string,
): Promise<ArrayBuffer> => {
  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}`,
    {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "Content-Type": "application/json",
        Accept: "audio/mpeg",
      },
      body: JSON.stringify({
        text,
        model_id: "eleven_multilingual_v2",
        voice_settings: {
          // Stability 0.5 + similarity 0.75 are ElevenLabs' documented
          // defaults for general narration. Producers who want tighter
          // voice-match can fork this later.
          stability: 0.5,
          similarity_boost: 0.75,
        },
      }),
    },
  );
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(
      `ElevenLabs TTS ${res.status}: ${errText.slice(0, 300)}`,
    );
  }
  return res.arrayBuffer();
};

export async function POST(request: NextRequest): Promise<Response> {
  const requestId = resolveRequestId(request.headers);
  const log = createLogger({ service: "generate-audio", requestId });

  const token = await getToken();
  if (!token) {
    log.warn("unauthorized", { reason: "no_session_token" });
    return NextResponse.json(
      { error: "Unauthorized" },
      { status: 401, headers: { "X-Request-Id": requestId } },
    );
  }

  let body: GenerateAudioBody;
  try {
    body = (await request.json()) as GenerateAudioBody;
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body" },
      { status: 400, headers: { "X-Request-Id": requestId } },
    );
  }

  const text = (body.text ?? "").trim();
  if (text.length === 0) {
    return NextResponse.json(
      { error: "`text` is required" },
      { status: 400, headers: { "X-Request-Id": requestId } },
    );
  }
  if (text.length > 4096) {
    // OpenAI TTS caps at 4096 chars per request. Reject up-front with a
    // clear message instead of surfacing the API's 400.
    return NextResponse.json(
      { error: `text too long (${text.length} chars, max 4096)` },
      { status: 400, headers: { "X-Request-Id": requestId } },
    );
  }

  const voiceRaw = (body.voice ?? DEFAULT_VOICE).toLowerCase().trim();
  const voice = ALLOWED_VOICES.has(voiceRaw) ? voiceRaw : DEFAULT_VOICE;
  const model = (body.model ?? DEFAULT_MODEL).trim() || DEFAULT_MODEL;
  const speed = Math.max(
    MIN_SPEED,
    Math.min(MAX_SPEED, typeof body.speed === "number" ? body.speed : 1.0),
  );

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    log.error("openai_api_key_missing");
    return NextResponse.json(
      { error: "OPENAI_API_KEY not configured on the server" },
      { status: 500, headers: { "X-Request-Id": requestId } },
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

  // --- 1. TTS --------------------------------------------------------
  // Provider selection: if the caller passed an ElevenLabs voice clone
  // id AND the key is configured, route through ElevenLabs. Any
  // ElevenLabs failure falls back to OpenAI so a provider outage
  // degrades to the default voice instead of breaking the batch.
  const elevenlabsKey = process.env.ELEVENLABS_API_KEY;
  const requestedCloneId = (body.elevenlabsVoiceId ?? "").trim();
  const useClone = requestedCloneId.length > 0 && Boolean(elevenlabsKey);

  const endTts = log.startTimer("tts_generate", {
    textLength: text.length,
    voice,
    model,
    speed,
    provider: useClone ? "elevenlabs" : "openai",
    cloneId: useClone ? requestedCloneId : undefined,
  });
  let audioBytes: ArrayBuffer;
  let effectiveProvider: "openai" | "elevenlabs" = "openai";
  try {
    if (useClone) {
      try {
        audioBytes = await generateViaElevenLabs(
          text,
          requestedCloneId,
          elevenlabsKey as string,
        );
        effectiveProvider = "elevenlabs";
      } catch (cloneErr) {
        // Fall back to OpenAI rather than failing the whole request.
        // The audio batch prefers a slightly-off voice over a missing
        // shot.
        log.warn("tts_clone_fallback_openai", {
          cloneId: requestedCloneId,
          error:
            cloneErr instanceof Error ? cloneErr.message : String(cloneErr),
        });
        audioBytes = await fetchOpenAiTts(apiKey, {
          model,
          voice,
          text,
          speed,
        });
        effectiveProvider = "openai";
      }
    } else {
      audioBytes = await fetchOpenAiTts(apiKey, {
        model,
        voice,
        text,
        speed,
      });
      effectiveProvider = "openai";
    }
    endTts({
      byteLength: audioBytes.byteLength,
      provider: effectiveProvider,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error("tts_fetch_failed", { error: msg });
    endTts({ error: msg });
    return NextResponse.json(
      { error: `TTS request failed: ${msg}` },
      { status: 502, headers: { "X-Request-Id": requestId } },
    );
  }

  // --- 2. Upload to Convex storage ---------------------------------
  // Reuse the existing cameo-upload mutation — it issues a
  // 15-minute upload URL for any authenticated user. The name is
  // "cameo" because that was the first caller, but the URL accepts any
  // mime type; we stash the resulting file under the same bucket.
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
    log.error("storage_upload_failed", { error: msg });
    endUpload({ error: msg });
    return NextResponse.json(
      { error: `Storage upload failed: ${msg}` },
      { status: 502, headers: { "X-Request-Id": requestId } },
    );
  }

  const payload: GenerateAudioResponse = {
    url: publicUrl,
    storageId,
    voice,
    model,
    speed,
    byteLength: audioBytes.byteLength,
    provider: effectiveProvider,
  };
  return NextResponse.json(payload, {
    status: 200,
    headers: { "X-Request-Id": requestId },
  });
}
