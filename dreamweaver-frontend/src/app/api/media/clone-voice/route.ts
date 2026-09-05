/**
 * M8 — voice cloning (scaffold).
 *
 * POST (multipart/form-data):
 *   `audio`       — one or more sample clips (30-300s total, ≤10MB
 *                   each). ElevenLabs accepts multiple samples for a
 *                   better-conditioned clone.
 *   `name`        — producer-facing clone label
 *   `description` — optional tags / consent notes
 *   `locale`      — optional BCP-47 locale ("en", "es-ES"), defaults
 *                   to English on the provider side
 *
 * →  { voiceCloneId, elevenlabsVoiceId, previewUrl? }
 *
 * Returns HTTP 501 when `ELEVENLABS_API_KEY` is unset. Kept as a
 * scaffold: the Convex row + UI exist so producers can attach a clone
 * they cloned elsewhere by pasting an elevenlabsVoiceId directly; the
 * full upload pipeline goes live when the key is configured.
 */

import { NextRequest, NextResponse } from "next/server";
import { ConvexHttpClient } from "convex/browser";
import { getToken } from "@/lib/auth-server";
import { mutationRef } from "@/lib/convexRefs";
import { createLogger, resolveRequestId } from "@/lib/observability";

export const runtime = "nodejs";
export const maxDuration = 300;

/** Call ElevenLabs voice-add endpoint. Kept separate so a future
 *  provider swap (Resemble, Play.ht) only touches this block. */
const createVoiceOnElevenLabs = async (
  form: FormData,
  apiKey: string,
): Promise<{ voice_id: string; previewUrl?: string }> => {
  const res = await fetch("https://api.elevenlabs.io/v1/voices/add", {
    method: "POST",
    headers: {
      "xi-api-key": apiKey,
      // Don't set Content-Type — fetch injects the multipart boundary.
    },
    body: form,
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(
      `ElevenLabs voice clone ${res.status}: ${errText.slice(0, 300)}`,
    );
  }
  const data = (await res.json()) as { voice_id?: string };
  if (!data.voice_id) {
    throw new Error("ElevenLabs returned no voice_id");
  }
  return { voice_id: data.voice_id };
};

export async function POST(request: NextRequest): Promise<Response> {
  const requestId = resolveRequestId(request.headers);
  const log = createLogger({ service: "clone-voice", requestId });

  const token = await getToken();
  if (!token) {
    return NextResponse.json(
      { error: "Unauthorized" },
      { status: 401, headers: { "X-Request-Id": requestId } },
    );
  }

  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    log.warn("no_voice_clone_provider");
    return NextResponse.json(
      {
        error:
          "No voice-clone provider configured. Set ELEVENLABS_API_KEY "
          + "to enable sample-based cloning, or paste an existing "
          + "elevenlabsVoiceId into the clone catalog manually.",
      },
      { status: 501, headers: { "X-Request-Id": requestId } },
    );
  }

  let incomingForm: FormData;
  try {
    incomingForm = await request.formData();
  } catch {
    return NextResponse.json(
      { error: "Invalid multipart body" },
      { status: 400, headers: { "X-Request-Id": requestId } },
    );
  }

  const name = String(incomingForm.get("name") ?? "").trim();
  if (!name) {
    return NextResponse.json(
      { error: "`name` is required" },
      { status: 400, headers: { "X-Request-Id": requestId } },
    );
  }
  const description = String(incomingForm.get("description") ?? "").slice(
    0,
    400,
  );
  const locale = String(incomingForm.get("locale") ?? "").trim();

  // Collect every "audio" part — ElevenLabs accepts multiple files.
  const audioFiles = incomingForm.getAll("audio").filter(
    (f): f is File => f instanceof File,
  );
  if (audioFiles.length === 0) {
    return NextResponse.json(
      { error: "At least one `audio` file is required" },
      { status: 400, headers: { "X-Request-Id": requestId } },
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

  // Build the ElevenLabs-shaped form and forward.
  const forwardForm = new FormData();
  forwardForm.set("name", name);
  if (description) forwardForm.set("description", description);
  for (const file of audioFiles) {
    forwardForm.append("files", file, file.name);
  }

  const endClone = log.startTimer("voice_clone", {
    nameLength: name.length,
    audioCount: audioFiles.length,
  });
  let voiceId: string;
  try {
    const result = await createVoiceOnElevenLabs(forwardForm, apiKey);
    voiceId = result.voice_id;
    endClone({ voiceId });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    endClone({ error: msg });
    log.error("voice_clone_failed", { error: msg });
    return NextResponse.json(
      { error: `Voice clone failed: ${msg}` },
      { status: 502, headers: { "X-Request-Id": requestId } },
    );
  }

  // Persist the clone in Convex. Preview URL will be synthesized lazily
  // by a future "preview" endpoint (TTS-a-short-sentence-with-the-clone)
  // — not implemented here, so we store the provider id only.
  const voiceCloneId = (await client.mutation(
    mutationRef("voiceClones:createVoiceClone"),
    {
      name,
      description: description || undefined,
      elevenlabsVoiceId: voiceId,
      locale: locale || undefined,
    },
  )) as string;

  return NextResponse.json(
    { voiceCloneId, elevenlabsVoiceId: voiceId },
    {
      status: 200,
      headers: { "X-Request-Id": requestId },
    },
  );
}
