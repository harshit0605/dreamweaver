/**
 * M8 — reel-level background score (music) track.
 *
 * Distinct from SFX:
 *   - Scope is the whole reel, not per-shot.
 *   - Mixed UNDER narration + SFX (third audio layer).
 *   - Duration targets the reel's totalDurationS so ffmpeg's amix
 *     doesn't truncate or pad awkwardly.
 *
 * This module mirrors `lib/sfx` — pure helpers for descriptor
 * normalization + ffmpeg argv construction, no network calls.
 */

/** Producer-authored score descriptor. Feeds both the generation
 *  call and the reel mix pass. */
export interface ScoreDescriptor {
  /** Natural-language prompt describing the music. Capped at 600
   *  chars — score prompts tend to be longer than SFX ("somber piano
   *  underscore for a quiet reveal, 80 BPM") without getting unwieldy. */
  prompt: string;
  /** Duration in seconds. Clamped to [10, 300] — scores shorter than
   *  10s aren't useful for a reel, and 5-minute caps keep the
   *  provider bill bounded. */
  durationS: number;
  /** Mix level in dB. Defaults to `-18` so the score sits well
   *  below narration (typically -12..-6 dB peak) and SFX (-12 dB by
   *  default). Range [-40, 0]. */
  volumeDb: number;
}

export const DEFAULT_SCORE_VOLUME_DB = -18;
export const DEFAULT_SCORE_DURATION_S = 60;
export const SCORE_MIN_DURATION_S = 10;
export const SCORE_MAX_DURATION_S = 300;
export const SCORE_PROMPT_MAX_CHARS = 600;
export const SCORE_MIN_VOLUME_DB = -40;
export const SCORE_MAX_VOLUME_DB = 0;

/** Normalize a raw score input into a validated descriptor. Returns
 *  `null` when the prompt is missing — caller treats that as "no
 *  score assigned". Everything else gets clamped so an out-of-range
 *  request doesn't fail the whole export. */
export const normalizeScoreDescriptor = (
  raw: Partial<ScoreDescriptor> | null | undefined,
): ScoreDescriptor | null => {
  if (!raw) return null;
  const prompt = (raw.prompt ?? "").trim();
  if (prompt.length === 0) return null;
  const durationRaw =
    typeof raw.durationS === "number" && Number.isFinite(raw.durationS)
      ? raw.durationS
      : DEFAULT_SCORE_DURATION_S;
  const volumeRaw =
    typeof raw.volumeDb === "number" && Number.isFinite(raw.volumeDb)
      ? raw.volumeDb
      : DEFAULT_SCORE_VOLUME_DB;
  return {
    prompt: prompt.slice(0, SCORE_PROMPT_MAX_CHARS),
    durationS: Math.max(
      SCORE_MIN_DURATION_S,
      Math.min(SCORE_MAX_DURATION_S, durationRaw),
    ),
    volumeDb: Math.max(
      SCORE_MIN_VOLUME_DB,
      Math.min(SCORE_MAX_VOLUME_DB, volumeRaw),
    ),
  };
};

/**
 * Build the ffmpeg argv that layers a score track over an already-
 * concatenated reel. Uses `filter_complex` with per-input `volume`
 * attenuation on the score and `amix=inputs=2:duration=first` so the
 * output is bounded by the reel — a too-long score gets truncated;
 * a too-short one leaves silent tail where it ends.
 *
 * Video stream-copies (the reel was already encoded upstream); only
 * audio is re-processed for the mix.
 *
 * Called AFTER the subtitle burn-in pass (if any) so the score mixes
 * over whatever the final video frame looks like.
 */
export const buildScoreMixArgs = (input: {
  reelPath: string;
  scorePath: string;
  outputPath: string;
  volumeDb: number;
}): string[] => {
  const { reelPath, scorePath, outputPath, volumeDb } = input;
  const clampedDb = Math.max(
    SCORE_MIN_VOLUME_DB,
    Math.min(SCORE_MAX_VOLUME_DB, volumeDb),
  );
  // Normalize both audio streams to the canonical reel shape (48kHz
  // stereo matches the export-reel route's AAC output). amix's
  // `duration=first` ties output length to the reel (input 0),
  // ensuring the score can't pad the end with silence.
  const filterComplex =
    `[0:a]aformat=sample_rates=48000:channel_layouts=stereo[reel];` +
    `[1:a]aformat=sample_rates=48000:channel_layouts=stereo,volume=${clampedDb}dB[score];` +
    `[reel][score]amix=inputs=2:duration=first:dropout_transition=0[out]`;
  return [
    "-y",
    "-i", reelPath,
    "-i", scorePath,
    "-filter_complex", filterComplex,
    "-map", "0:v:0",
    "-map", "[out]",
    "-c:v", "copy",
    "-c:a", "aac",
    "-b:a", "192k",
    "-ar", "48000",
    "-ac", "2",
    "-movflags", "+faststart",
    outputPath,
  ];
};
