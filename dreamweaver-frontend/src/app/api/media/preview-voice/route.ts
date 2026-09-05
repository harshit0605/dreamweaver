/**
 * M6 Voice #2 — short TTS preview for auditioning voices in the picker.
 *
 * GET `/api/media/preview-voice?voice=<name>` → mp3 bytes (audio/mpeg).
 *
 * Differs from `/api/media/generate-audio` in that we deliberately do NOT
 * upload to Convex storage — this endpoint exists only for the producer
 * to hear what each OpenAI voice sounds like before assigning it to an
 * identity pack, and persisting every audition would clutter the bucket
 * with throwaway clips.
 *
 * The sample phrase is intentionally short (~1.5s) to keep OpenAI cost
 * and latency minimal. Authenticated producers only — same auth surface
 * as the rest of /api/media/*.
 */

import { NextRequest, NextResponse } from "next/server";
import { getToken } from "@/lib/auth-server";
import { createLogger, resolveRequestId } from "@/lib/observability";

export const runtime = "nodejs";
export const maxDuration = 30;

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

// Short, neutral sample phrase. Keeping it generic (not character-specific)
// so producers audition the voice itself, not the content.
const SAMPLE_TEXT =
  "This is a voice preview. Cinematic, calm, and steady.";

export async function GET(request: NextRequest): Promise<Response> {
  const requestId = resolveRequestId(request.headers);
  const log = createLogger({ service: "preview-voice", requestId });

  const token = await getToken();
  if (!token) {
    log.warn("unauthorized", { reason: "no_session_token" });
    return NextResponse.json(
      { error: "Unauthorized" },
      { status: 401, headers: { "X-Request-Id": requestId } },
    );
  }

  const url = new URL(request.url);
  const voiceRaw = (url.searchParams.get("voice") ?? DEFAULT_VOICE)
    .toLowerCase()
    .trim();
  const voice = ALLOWED_VOICES.has(voiceRaw) ? voiceRaw : DEFAULT_VOICE;

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    log.error("openai_api_key_missing");
    return NextResponse.json(
      { error: "OPENAI_API_KEY not configured on the server" },
      { status: 500, headers: { "X-Request-Id": requestId } },
    );
  }

  const endTts = log.startTimer("tts_preview", { voice });
  let audioBytes: ArrayBuffer;
  try {
    const res = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: DEFAULT_MODEL,
        voice,
        input: SAMPLE_TEXT,
        response_format: "mp3",
      }),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      log.error("tts_api_error", {
        status: res.status,
        body: errText.slice(0, 300),
      });
      return NextResponse.json(
        { error: `OpenAI TTS ${res.status}: ${errText.slice(0, 300)}` },
        { status: 502, headers: { "X-Request-Id": requestId } },
      );
    }
    audioBytes = await res.arrayBuffer();
    endTts({ byteLength: audioBytes.byteLength });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error("tts_fetch_failed", { error: msg });
    endTts({ error: msg });
    return NextResponse.json(
      { error: `TTS request failed: ${msg}` },
      { status: 502, headers: { "X-Request-Id": requestId } },
    );
  }

  // Serve mp3 bytes straight back. Private-cache for an hour since the
  // sample phrase never changes per voice — repeat auditions during the
  // same session cost us nothing.
  return new Response(audioBytes, {
    status: 200,
    headers: {
      "Content-Type": "audio/mpeg",
      "Content-Length": String(audioBytes.byteLength),
      "Cache-Control": "private, max-age=3600",
      "X-Request-Id": requestId,
      "X-Voice": voice,
    },
  });
}
