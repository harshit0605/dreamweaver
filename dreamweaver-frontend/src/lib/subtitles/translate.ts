/**
 * M7 — subtitle translation.
 *
 * Translates a reel's cue texts into a target locale while preserving
 * every other field (timing, nodeId, speaker prefix). Intentionally
 * pure at the core: `translateCues` takes an injectable `translator`
 * function so tests can exercise the batching / passthrough logic
 * without standing up OpenAI.
 *
 * The default translator hits OpenAI chat completions once per batch,
 * asking for a strict JSON response. That's cheaper than one call per
 * cue (a 50-cue reel becomes 1 network round-trip) and lets the model
 * maintain stylistic consistency across the whole script.
 */

import type { SubtitleCue } from "./index";

/** Stable 32-bit FNV-1a fingerprint of a list of source cue texts.
 *  Used by the translation cache to detect whether the reel's dialogue
 *  has changed since the cached translation was written. Not a
 *  cryptographic hash — just a deterministic key for cache validation.
 *
 *  Emits a fixed 8-char lowercase hex string so Convex string fields
 *  have a predictable length, which simplifies debugging ("hash
 *  `3f2a1b09`") without truncation.
 */
export const fingerprintCueTexts = (texts: readonly string[]): string => {
  // FNV-1a 32-bit. Starts from the classic `offset basis`.
  let hash = 0x811c9dc5;
  for (const text of texts) {
    // `\n` delimiter between cues keeps ["ab","c"] and ["a","bc"]
    // distinct. Without it both would hash the same string.
    const framed = `${text}\n`;
    for (let i = 0; i < framed.length; i += 1) {
      hash ^= framed.charCodeAt(i);
      // Multiply by FNV prime (0x01000193). `>>> 0` keeps us in
      // unsigned 32-bit space — otherwise JS silently promotes to
      // signed after the shift.
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
  }
  return hash.toString(16).padStart(8, "0");
};

/** Target locale code. Empty / "en" / "en-*" short-circuits translation
 *  — the reel's dialogue extraction is already the source language. */
export type TargetLocale = string;

/** Source-language pass-through check. Used both by the locale picker
 *  UI (to hide the call to OpenAI) and by the subtitle route. */
export const isSourceLocale = (locale: string | null | undefined): boolean => {
  if (!locale) return true;
  const normalized = locale.trim().toLowerCase();
  if (normalized.length === 0) return true;
  if (normalized === "en") return true;
  if (normalized.startsWith("en-")) return true;
  return false;
};

/** Injectable translator: takes a batch of lines + a target locale,
 *  returns the translations in the same order. Length MUST match;
 *  callers that can't guarantee this should pad/truncate before
 *  returning. */
export type TranslateBatch = (
  lines: string[],
  targetLocale: TargetLocale,
) => Promise<string[]>;

export interface TranslateCuesOptions {
  translate?: TranslateBatch;
  /** Max lines per batch request. OpenAI allows much larger but
   *  smaller batches recover gracefully from partial failures and
   *  keep individual responses well under the context cap. */
  batchSize?: number;
  /** Preserve the "SPEAKER: " prefix in translated output by stripping
   *  it before translation and re-adding after. Defaults to true —
   *  translators often drop or mangle the prefix otherwise. */
  preserveSpeakerPrefix?: boolean;
}

const SPEAKER_PREFIX_RE = /^([A-Z][A-Z0-9_' -]{0,40}):\s+/;

/** Split "MAYA: Let's go." into `{ prefix: "MAYA: ", body: "Let's go." }`.
 *  Returns `{ prefix: "", body: input }` when no prefix is detected. */
const splitSpeakerPrefix = (
  text: string,
): { prefix: string; body: string } => {
  const m = SPEAKER_PREFIX_RE.exec(text);
  if (!m) return { prefix: "", body: text };
  return {
    prefix: m[0],
    body: text.slice(m[0].length),
  };
};

/**
 * Translate every cue's `text` into the target locale. Returns a new
 * array of cues with translated text; timing and metadata are unchanged.
 *
 * Short-circuits to the input (same identity) when the locale is the
 * source language or the cue list is empty — callers can safely diff
 * by reference to detect "did anything change".
 */
export const translateCues = async (
  cues: SubtitleCue[],
  targetLocale: TargetLocale,
  options: TranslateCuesOptions = {},
): Promise<SubtitleCue[]> => {
  if (isSourceLocale(targetLocale)) return cues;
  if (cues.length === 0) return cues;
  const {
    translate = openAiTranslateBatch,
    batchSize = 40,
    preserveSpeakerPrefix = true,
  } = options;

  // Split prefixes out before translation so the model doesn't mangle
  // speaker labels — those should stay uppercase English regardless
  // of target language (producer convention + easier post-editing).
  const split = cues.map((cue) =>
    preserveSpeakerPrefix
      ? splitSpeakerPrefix(cue.text)
      : { prefix: "", body: cue.text },
  );

  const bodies = split.map((s) => s.body);
  const translated: string[] = new Array(bodies.length);
  for (let i = 0; i < bodies.length; i += batchSize) {
    const batch = bodies.slice(i, i + batchSize);
    const out = await translate(batch, targetLocale);
    if (!Array.isArray(out) || out.length !== batch.length) {
      throw new Error(
        `translator returned ${out?.length ?? "non-array"} items for batch of ${batch.length}`,
      );
    }
    for (let j = 0; j < out.length; j += 1) {
      translated[i + j] = out[j];
    }
  }

  return cues.map((cue, i) => ({
    ...cue,
    text: `${split[i].prefix}${translated[i]}`,
  }));
};

/**
 * Default translator — one OpenAI chat.completions call per batch.
 * Uses strict JSON output so the reply is trivially parseable.
 *
 * Reads `OPENAI_API_KEY` from the environment. Throws when the key is
 * absent instead of silently falling back (the caller shouldn't ship
 * a reel in the wrong language).
 *
 * Exported for direct use when the caller wants to bypass `translateCues`'
 * prefix-stripping and batching (e.g. a one-off CLI tool).
 */
export const openAiTranslateBatch: TranslateBatch = async (
  lines,
  targetLocale,
) => {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY not configured");
  }
  const prompt =
    `Translate each of the following English lines into ${targetLocale}. ` +
    `Preserve meaning and register; prefer natural phrasing over literal. ` +
    `Return strict JSON in the shape {"lines": ["..", "..", ...]} with ` +
    `exactly ${lines.length} entries in the same order. Do not add extra ` +
    `commentary.`;
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: "You are a professional subtitle translator." },
        {
          role: "user",
          content: `${prompt}\n\nLines:\n${lines
            .map((l, i) => `${i + 1}. ${l}`)
            .join("\n")}`,
        },
      ],
      temperature: 0.2,
    }),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(
      `OpenAI translate ${res.status}: ${errText.slice(0, 300)}`,
    );
  }
  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const raw = data.choices?.[0]?.message?.content ?? "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`translator returned non-JSON: ${raw.slice(0, 200)}`);
  }
  if (
    typeof parsed !== "object"
    || parsed === null
    || !Array.isArray((parsed as { lines?: unknown }).lines)
  ) {
    throw new Error(`translator missing 'lines' array in response`);
  }
  const out = (parsed as { lines: unknown[] }).lines.map((v) => String(v));
  if (out.length !== lines.length) {
    throw new Error(
      `translator returned ${out.length} lines, expected ${lines.length}`,
    );
  }
  return out;
};
