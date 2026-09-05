/**
 * M7 — per-shot sound-effects (SFX) layer.
 *
 * Intent: a shot can carry an optional ambient/foley track mixed UNDER
 * the narration (a crowd murmur, city rain, heartbeat) without
 * replacing the OpenAI TTS narration. This module is the pure helper
 * surface — no network, no child_process. The generation route and
 * export pipeline consume these helpers.
 *
 * Design notes:
 *   - SFX is a separate media asset, not a replacement for narration.
 *     Burn-in = ffmpeg `amix` with volume ducking on the SFX stream.
 *   - Producers describe SFX with a short natural-language prompt
 *     (e.g. "thunderstorm"). Providers (ElevenLabs Sound Effects,
 *     Stability Audio, etc.) are pluggable behind the route layer.
 *   - Volume is expressed in dB to match audio engineer convention.
 *     `0dB` = unattenuated; `-12dB` = narration sits well above it.
 */

/** Producer-authored SFX descriptor. Feeds both the generation call
 *  and the mix pass. */
export interface SfxDescriptor {
  /** Natural-language prompt describing the sound. Capped at 400 chars
   *  because most providers reject longer inputs. */
  prompt: string;
  /** Duration in seconds. Clamped to [1, 30] per the existing shot
   *  duration window so the SFX can't outrun the narration track. */
  durationS: number;
  /** Mix level in dB. Positive values raise the SFX above the narration
   *  (rarely what you want); the default `-12` keeps the narration
   *  clearly on top. Range: [-40, 0]. */
  volumeDb: number;
}

export const DEFAULT_SFX_VOLUME_DB = -12;
export const DEFAULT_SFX_DURATION_S = 5;
export const SFX_MIN_DURATION_S = 1;
export const SFX_MAX_DURATION_S = 30;
export const SFX_PROMPT_MAX_CHARS = 400;
export const SFX_MIN_VOLUME_DB = -40;
export const SFX_MAX_VOLUME_DB = 0;

/** Normalize a raw SFX input into a validated descriptor. Returns
 *  `null` when the prompt is missing — the caller treats that as "no
 *  SFX on this shot". Everything else gets clamped instead of rejected
 *  so an out-of-range request doesn't fail the whole shot batch. */
export const normalizeSfxDescriptor = (
  raw: Partial<SfxDescriptor> | null | undefined,
): SfxDescriptor | null => {
  if (!raw) return null;
  const prompt = (raw.prompt ?? "").trim();
  if (prompt.length === 0) return null;
  const durationRaw =
    typeof raw.durationS === "number" && Number.isFinite(raw.durationS)
      ? raw.durationS
      : SFX_MIN_DURATION_S;
  const volumeRaw =
    typeof raw.volumeDb === "number" && Number.isFinite(raw.volumeDb)
      ? raw.volumeDb
      : DEFAULT_SFX_VOLUME_DB;
  return {
    prompt: prompt.slice(0, SFX_PROMPT_MAX_CHARS),
    durationS: Math.max(
      SFX_MIN_DURATION_S,
      Math.min(SFX_MAX_DURATION_S, durationRaw),
    ),
    volumeDb: Math.max(
      SFX_MIN_VOLUME_DB,
      Math.min(SFX_MAX_VOLUME_DB, volumeRaw),
    ),
  };
};

/** Minimal shot shape the prompt deriver reads. Intentionally loose
 *  so callers can pass a snapshot row or a nodes-state row without a
 *  conversion step. */
export interface SfxShotLike {
  segment?: string | null;
  shotMeta?: {
    sfx?: string[];
    durationS?: number;
  };
}

/**
 * Derive a plausible SFX prompt for a shot. Prefers explicit producer
 * hints on `shotMeta.sfx` (e.g. `["rain", "thunder"]`), falls back to
 * trimming the first sentence of `segment`, returns `null` when
 * neither signal is available.
 *
 * The batch route uses this to pre-populate SFX prompts; the UI uses
 * the same function to preview what the batch would generate so a
 * producer can edit per-shot before committing.
 */
export const deriveSfxPromptForShot = (
  shot: SfxShotLike,
): string | null => {
  const hints = shot.shotMeta?.sfx ?? [];
  const valid = hints
    .map((h) => (typeof h === "string" ? h.trim() : ""))
    .filter((h) => h.length > 0);
  if (valid.length > 0) return valid.join(", ").slice(0, SFX_PROMPT_MAX_CHARS);
  const segment = (shot.segment ?? "").trim();
  if (segment.length === 0) return null;
  // Pull the first sentence or 160 chars — SFX prompts are short;
  // longer inputs confuse the generator.
  const firstSentence = /[^.!?]+[.!?]+/.exec(segment)?.[0] ?? segment;
  const prompt = firstSentence.trim().slice(0, 160);
  return prompt.length > 0 ? prompt : null;
};

/**
 * Derive a default duration for the SFX that matches the shot's own
 * declared duration. Falls back to `DEFAULT_SFX_DURATION_S` when the
 * shot has no duration set. Clamped to the SFX window.
 */
export const deriveSfxDurationForShot = (shot: SfxShotLike): number => {
  const raw = shot.shotMeta?.durationS;
  const d =
    typeof raw === "number" && Number.isFinite(raw)
      ? raw
      : DEFAULT_SFX_DURATION_S;
  return Math.max(SFX_MIN_DURATION_S, Math.min(SFX_MAX_DURATION_S, d));
};

/**
 * Build the ffmpeg argv that layers an SFX track under a narration
 * track. Uses `filter_complex` with per-input `volume` attenuation on
 * the SFX and `amix=inputs=2:duration=first` so the output length is
 * bounded by the narration — a too-long SFX clip gets truncated, a
 * too-short one leaves the narration silent tail intact.
 *
 * Output sample rate + channel layout match the reel's canonical 44.1
 * kHz mono so downstream normalization (or a future concat demuxer
 * pass) can stream-copy without re-encoding.
 */
export const buildSfxMixArgs = (input: {
  narrationPath: string;
  sfxPath: string;
  outputPath: string;
  volumeDb: number;
}): string[] => {
  const { narrationPath, sfxPath, outputPath, volumeDb } = input;
  const clampedDb = Math.max(
    SFX_MIN_VOLUME_DB,
    Math.min(SFX_MAX_VOLUME_DB, volumeDb),
  );
  // Normalize each input to the canonical shape before mixing —
  // amix tolerates mismatched rates but then silently resamples, which
  // can introduce artifacts. Explicit aformat keeps the pipeline
  // predictable. `volume=<x>dB` is libav's native dB notation.
  const filterComplex =
    `[0:a]aformat=sample_rates=44100:channel_layouts=mono[narr];` +
    `[1:a]aformat=sample_rates=44100:channel_layouts=mono,volume=${clampedDb}dB[sfx];` +
    `[narr][sfx]amix=inputs=2:duration=first:dropout_transition=0[out]`;
  return [
    "-y",
    "-i", narrationPath,
    "-i", sfxPath,
    "-filter_complex", filterComplex,
    "-map", "[out]",
    "-c:a", "libmp3lame",
    "-b:a", "128k",
    "-ar", "44100",
    "-ac", "1",
    outputPath,
  ];
};

/**
 * Build the ffmpeg argv that generates a placeholder SFX clip for
 * tests / offline dev when no real provider is configured. Synthesizes
 * white-noise at the requested duration so downstream mix code has
 * something to consume without hitting a network API.
 *
 * Intentionally NOT wired into the generate-sfx route by default — the
 * producer gets an explicit "no provider configured" error instead.
 * Exported for tests and for a future `dev-only` mode.
 */
export const buildPlaceholderSfxArgs = (input: {
  outputPath: string;
  durationS: number;
}): string[] => {
  const { outputPath, durationS } = input;
  const d = Math.max(
    SFX_MIN_DURATION_S,
    Math.min(SFX_MAX_DURATION_S, durationS),
  );
  return [
    "-y",
    "-f", "lavfi",
    "-i", `anoisesrc=color=white:sample_rate=44100`,
    "-t", String(d),
    "-c:a", "libmp3lame",
    "-b:a", "128k",
    "-ar", "44100",
    "-ac", "1",
    outputPath,
  ];
};
