/**
 * M6 voice #1 — multi-speaker dialogue mixing helpers.
 *
 * When a shot has 2+ unique attributed speakers (e.g. MAYA + DANIEL
 * trading lines), the single-voice `generate-shot-audios-stream` path
 * is inadequate — it would read every line in one voice. This module
 * builds the ffmpeg plumbing to concat per-line TTS clips (each
 * rendered in the speaker's own voice) with a configurable silence
 * gap between them.
 *
 * Pure — no network, no child_process. The Next.js route wraps these
 * helpers with the actual TTS downloads + ffmpeg spawn.
 */

import type { DialogueLine } from "@/lib/dialogue-extract";

/** Gap between dialogue lines in the final mix, in seconds. 250ms
 *  reads as a natural beat without feeling drawn out. */
export const DIALOGUE_GAP_SECONDS = 0.25;

/** Canonical output shape for the final mix. mp3 at 44.1kHz mono is
 *  both a widely-supported baseline and what the ffmpeg reel concat
 *  pipeline expects. The filter graph re-encodes every input to this
 *  shape so the mix is robust to the actual OpenAI TTS output format
 *  (tts-1 happens to emit 24kHz mono mp3 today; normalizing guards
 *  against that silently drifting in the future). */
export const DIALOGUE_MIX_SAMPLE_RATE = 44100;
export const DIALOGUE_MIX_CHANNELS = 1;

export interface MixPlanLine {
  /** Speaker id (uppercase). null when the extractor couldn't attribute. */
  speaker: string | null;
  /** Voice the TTS call should use for this line. Falls back to the
   *  batch default when the speaker has no assigned voice. */
  voice: string;
  /** The exact text passed to /api/media/generate-audio. */
  text: string;
  /** Ordering-stable index so the caller can correlate mp3 files back
   *  to plan entries. */
  index: number;
}

export interface BuildMixPlanOptions {
  lines: DialogueLine[];
  speakerVoices: Record<string, string | undefined>;
  defaultVoice: string;
  /** Optional cap to keep a runaway auto-extraction from fanning out
   *  into dozens of TTS calls per shot. Default 8. */
  maxLines?: number;
}

/**
 * Project a list of extracted dialogue lines into a mix plan the
 * audio batch will render. Drops empty lines, resolves voice per
 * speaker, and caps at `maxLines`.
 *
 * Returns `null` when there are fewer than 2 lines — callers should
 * fall back to the single-voice path in that case (no mixing needed).
 */
export const buildMixPlan = (
  options: BuildMixPlanOptions,
): MixPlanLine[] | null => {
  const { lines, speakerVoices, defaultVoice } = options;
  const maxLines = options.maxLines ?? 8;
  const usable = lines
    .map((l) => ({ ...l, text: l.text.trim() }))
    .filter((l) => l.text.length > 0)
    .slice(0, maxLines);
  if (usable.length < 2) return null;
  return usable.map((l, index) => {
    const speakerKey = l.speaker ? l.speaker.toUpperCase() : null;
    const voice =
      (speakerKey ? speakerVoices[speakerKey] : undefined) ?? defaultVoice;
    return {
      speaker: speakerKey,
      voice,
      text: l.text,
      index,
    };
  });
};

/**
 * Build the ffmpeg argv that produces the final mixed dialogue mp3 in a
 * single filter_complex pass. Each input is normalized to the canonical
 * shape (44.1kHz mono mp3) via `aformat`, padded with `apad=pad_dur` on
 * every line except the last to insert the inter-line beat, and then
 * concatenated with the `concat` filter.
 *
 * The filter_complex approach replaces a previous three-step pipeline
 * (synthesize silence clip, write concat list, run concat demuxer with
 * `-c copy`). That pipeline silently corrupted output when input clips
 * didn't match the silence clip's sample rate — a real hazard since
 * OpenAI TTS tts-1 emits 24kHz mono mp3 by default, not 44.1kHz. A
 * single ffmpeg invocation with an explicit normalize step sidesteps
 * that whole class of shape-mismatch bug at the cost of one re-encode.
 */
export const buildDialogueMixArgs = (
  linePaths: string[],
  outputPath: string,
  gapSeconds: number = DIALOGUE_GAP_SECONDS,
): string[] => {
  if (linePaths.length === 0) {
    throw new Error("buildDialogueMixArgs: linePaths is empty");
  }
  if (linePaths.length === 1) {
    // Degenerate case — just normalize the single line, no concat.
    return [
      "-y",
      "-i", linePaths[0],
      "-af",
      `aformat=sample_rates=${DIALOGUE_MIX_SAMPLE_RATE}:channel_layouts=mono`,
      "-c:a", "libmp3lame",
      "-b:a", "128k",
      "-ar", String(DIALOGUE_MIX_SAMPLE_RATE),
      "-ac", String(DIALOGUE_MIX_CHANNELS),
      outputPath,
    ];
  }
  const gap = Math.max(0, gapSeconds);
  const inputArgs: string[] = [];
  const filterChunks: string[] = [];
  const concatInputs: string[] = [];
  for (let i = 0; i < linePaths.length; i += 1) {
    inputArgs.push("-i", linePaths[i]);
    // Normalize sample rate + channel layout; pad every line except
    // the last so the gap falls BETWEEN lines, not after the final
    // one (trailing silence is wasted bytes in the reel).
    const isLast = i === linePaths.length - 1;
    const padSuffix =
      !isLast && gap > 0 ? `,apad=pad_dur=${gap}` : "";
    filterChunks.push(
      `[${i}:a]aformat=sample_rates=${DIALOGUE_MIX_SAMPLE_RATE}:channel_layouts=mono${padSuffix}[a${i}]`,
    );
    concatInputs.push(`[a${i}]`);
  }
  const filterComplex =
    filterChunks.join(";") +
    `;${concatInputs.join("")}concat=n=${linePaths.length}:v=0:a=1[out]`;
  return [
    "-y",
    ...inputArgs,
    "-filter_complex", filterComplex,
    "-map", "[out]",
    "-c:a", "libmp3lame",
    "-b:a", "128k",
    "-ar", String(DIALOGUE_MIX_SAMPLE_RATE),
    "-ac", String(DIALOGUE_MIX_CHANNELS),
    outputPath,
  ];
};
