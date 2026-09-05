/**
 * M7 — subtitle generation from dialogue extraction.
 *
 * Produces SRT and WebVTT subtitle files from the same dialogue lines
 * the audio batch uses, so a producer gets open-captions almost for
 * free: the heavy lifting (speaker attribution + quoted-line parsing)
 * already happened in `lib/dialogue-extract`.
 *
 * Output model:
 *   - One cue per dialogue line (narration never becomes a subtitle;
 *     readers are watching it, they don't need it as text too).
 *   - Cue duration inside a shot is proportional to the line's
 *     character count. Shots with no dialogue contribute no cues but
 *     still consume their timeline segment so downstream cues align.
 *   - Cue text is prefixed with the uppercase speaker name when the
 *     extractor identified one, plus a colon — matches the common
 *     "MAYA: Let's go." captioning convention.
 *
 * Pure — no network, no DOM. Consumed by the `/api/storyboard/subtitles`
 * route and directly testable under bun.
 */

import { extractDialogue, type DialogueLine } from "@/lib/dialogue-extract";

export interface SubtitleShotInput {
  /** Shot node id — kept as a diagnostic field on the cue; not written
   *  to SRT/VTT output but useful for UI mapping back to nodes. */
  nodeId: string;
  /** Raw segment text fed to the dialogue extractor. */
  segment: string;
  /** Duration allotted to this shot on the reel timeline. Clamped to a
   *  1-second floor inside the cue builder so a zero-duration shot
   *  doesn't collapse its cues into an instant. */
  durationS: number;
}

export interface SubtitleCue {
  /** 1-indexed cue id — mirrors SRT numbering conventions. */
  index: number;
  /** Start time in seconds from the start of the reel. */
  startS: number;
  /** End time in seconds from the start of the reel. */
  endS: number;
  /** The rendered cue text (speaker prefix already applied). */
  text: string;
  /** Shot this cue belongs to. Kept so the UI can jump to the source
   *  shot when a producer clicks a caption. */
  nodeId: string;
  /** Original speaker token from the extractor, uppercase. null when
   *  the extractor couldn't attribute (unusual — those lines are
   *  already filtered out before cue generation). */
  speaker: string | null;
}

const clampDuration = (s: number): number => {
  if (!Number.isFinite(s) || s <= 0) return 1;
  return s;
};

/** Sub-divide a shot's duration across its dialogue lines. Allocation
 *  is proportional to character count — a 2-line shot with "yes" and
 *  "I remember everything" splits about 1/6 : 5/6, not 1/2 : 1/2. */
const allocateLineSpans = (
  lines: DialogueLine[],
  durationS: number,
): Array<{ line: DialogueLine; startS: number; endS: number }> => {
  const totalChars = lines.reduce(
    (sum, l) => sum + Math.max(1, l.text.length),
    0,
  );
  if (totalChars === 0) return [];
  const spans: Array<{ line: DialogueLine; startS: number; endS: number }> = [];
  let cursor = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const charsShare = Math.max(1, line.text.length) / totalChars;
    const span = durationS * charsShare;
    const startS = cursor;
    const endS = i === lines.length - 1 ? durationS : cursor + span;
    spans.push({ line, startS, endS });
    cursor = endS;
  }
  return spans;
};

/**
 * Project a reel's shot list into a flat cue list. Shots are laid out
 * end-to-end starting at 0s. Non-dialogue shots contribute no cues but
 * still consume their timeline slot so later cues have correct offsets.
 *
 * Options:
 *   - `minCueDurationS`: floor so very short lines don't flash by. SRT
 *     readers treat <0.5s cues as near-invisible. Default 0.8s.
 *   - `speakerPrefix`: when false, skip the "NAME: " prefix. Useful for
 *     single-speaker reels where the prefix is noise. Default true.
 */
export interface BuildCuesOptions {
  minCueDurationS?: number;
  speakerPrefix?: boolean;
}

export const buildSubtitleCues = (
  shots: SubtitleShotInput[],
  options: BuildCuesOptions = {},
): SubtitleCue[] => {
  const { minCueDurationS = 0.8, speakerPrefix = true } = options;
  const cues: SubtitleCue[] = [];
  let reelOffset = 0;
  let cueIndex = 1;

  for (const shot of shots) {
    const duration = clampDuration(shot.durationS);
    const extracted = extractDialogue(shot.segment ?? "");
    // Drop unattributed lines entirely — subtitle files conventionally
    // show quoted speech with attribution; ambient or narrator lines
    // without a speaker get confusing prefixes.
    const attributed = extracted.lines.filter((l) => l.speaker !== null);

    const spans = allocateLineSpans(attributed, duration);
    for (const { line, startS: localStart, endS: localEnd } of spans) {
      // Enforce the minimum cue duration while staying within the
      // shot's slot — if the proportional share is too small, extend
      // the cue forward, truncating at the shot boundary.
      const span = Math.max(
        minCueDurationS,
        Math.max(0.1, localEnd - localStart),
      );
      const effEnd = Math.min(duration, localStart + span);
      const text =
        speakerPrefix && line.speaker
          ? `${line.speaker}: ${line.text}`
          : line.text;
      cues.push({
        index: cueIndex,
        startS: reelOffset + localStart,
        endS: reelOffset + effEnd,
        text,
        nodeId: shot.nodeId,
        speaker: line.speaker,
      });
      cueIndex += 1;
    }
    reelOffset += duration;
  }

  return cues;
};

/** Format a duration as SRT timestamp: `HH:MM:SS,mmm`. Handles up to
 *  99:59:59.999 which is far beyond any reel we'd ship. */
const formatSrtTimestamp = (s: number): string => {
  const clamped = Math.max(0, s);
  const totalMs = Math.round(clamped * 1000);
  const hours = Math.floor(totalMs / 3_600_000);
  const minutes = Math.floor((totalMs % 3_600_000) / 60_000);
  const seconds = Math.floor((totalMs % 60_000) / 1000);
  const ms = totalMs % 1000;
  return (
    String(hours).padStart(2, "0") +
    ":" +
    String(minutes).padStart(2, "0") +
    ":" +
    String(seconds).padStart(2, "0") +
    "," +
    String(ms).padStart(3, "0")
  );
};

// Re-export translation surface so callers only import from
// `@/lib/subtitles`.
export {
  fingerprintCueTexts,
  isSourceLocale,
  openAiTranslateBatch,
  translateCues,
} from "./translate";
export type { TargetLocale, TranslateBatch } from "./translate";

/** WebVTT uses `.` instead of `,` for the millisecond separator but is
 *  otherwise identical. Shared formatter with a separator knob. */
const formatVttTimestamp = (s: number): string =>
  formatSrtTimestamp(s).replace(",", ".");

/**
 * M7 — subtitle styling applied when captions are burned in to the reel
 * mp4 via ffmpeg's `subtitles` filter (`force_style` option, libass
 * syntax). Only exposed for burn-in; soft-subtitle VTT/SRT files carry
 * plain text and the player styles them independently.
 *
 * All fields are optional — omit to fall back to libass defaults, which
 * produces white Arial 24pt text with a thin black outline at the
 * bottom of the frame.
 */
export interface SubtitleStyle {
  /** Font family name. Must be installed on the ffmpeg host. Producers
   *  picking a custom font should stick to common ones (Arial, Inter,
   *  Helvetica) unless the deploy environment is known to bundle it. */
  fontFamily?: string;
  /** Point size. 16-48 is the producer-sensible range; libass accepts
   *  any positive integer. */
  fontSizePx?: number;
  /** Primary text color as 6-digit hex RGB (no leading `#`).
   *  `"FFFFFF"` = white (default), `"FFD700"` = gold, etc. */
  colorHex?: string;
  /** Outline color as 6-digit hex RGB. Defaults to `000000` (black).
   *  Matters when the video has light backgrounds behind captions. */
  outlineHex?: string;
  /** Outline width in px. 0 = no outline; 2 = readable default. */
  outlineWidthPx?: number;
  /** Vertical alignment on the frame.
   *   - `"bottom"` (default, libass Alignment=2)
   *   - `"middle"` (libass Alignment=5)
   *   - `"top"` (libass Alignment=8) */
  position?: "bottom" | "middle" | "top";
  /** Vertical margin from the edge in px. Default 48 — far enough from
   *  the frame edge that it doesn't collide with device notches. */
  marginVerticalPx?: number;
  /** True for a semi-opaque box behind each line (libass BorderStyle=3);
   *  easier to read on busy backgrounds. Default false (outline-only). */
  boxBackground?: boolean;
}

/** Canonical font names we encourage producers to pick from. These
 *  resolve reliably when `SUBTITLE_FONTS_DIR` is populated on the
 *  deploy host with the matching .ttf / .otf files. Anything outside
 *  this list still works — libass will try to find it in the system
 *  font set — but we don't guarantee it. */
export const GUARANTEED_BURN_IN_FONTS: readonly string[] = [
  "Inter",
  "Roboto",
  "Helvetica",
  "Arial",
  "Georgia",
  "Courier",
];

const POSITION_TO_ALIGNMENT: Record<
  NonNullable<SubtitleStyle["position"]>,
  number
> = {
  bottom: 2,
  middle: 5,
  top: 8,
};

/** Convert 6-digit RGB hex into libass BGRA (`&H00BBGGRR`) byte order.
 *  Accepts with or without leading `#`. Returns `""` when the input is
 *  malformed — caller treats that as "skip this color override". */
const rgbHexToLibass = (hex: string): string => {
  const clean = hex.replace(/^#/, "").trim();
  if (!/^[0-9a-fA-F]{6}$/.test(clean)) return "";
  const rr = clean.slice(0, 2).toUpperCase();
  const gg = clean.slice(2, 4).toUpperCase();
  const bb = clean.slice(4, 6).toUpperCase();
  return `&H00${bb}${gg}${rr}`;
};

/**
 * Build the libass `force_style` string that goes inside the ffmpeg
 * `subtitles` filter (e.g. `subtitles=caps.srt:force_style='FontSize=24'`).
 * Returns an empty string when no style fields are set, so the caller
 * can `if (s.length > 0)` and append `:force_style='...'` conditionally.
 *
 * Escapes embedded single quotes because libass's style syntax cannot
 * represent them inside a `'...'`-quoted filter value.
 */
export const buildForceStyleString = (style: SubtitleStyle): string => {
  const parts: string[] = [];
  if (style.fontFamily && style.fontFamily.trim().length > 0) {
    // FontName values can't contain `,` (libass uses it as a separator).
    // Swap commas for spaces and collapse whitespace so the common
    // "Inter, Helvetica, sans" family list reads as a single font name.
    const fontName = style.fontFamily
      .trim()
      .replace(/,/g, " ")
      .replace(/\s+/g, " ");
    parts.push(`FontName=${fontName}`);
  }
  if (style.fontSizePx && style.fontSizePx > 0) {
    parts.push(`FontSize=${Math.round(style.fontSizePx)}`);
  }
  if (style.colorHex) {
    const libass = rgbHexToLibass(style.colorHex);
    if (libass) parts.push(`PrimaryColour=${libass}`);
  }
  if (style.outlineHex) {
    const libass = rgbHexToLibass(style.outlineHex);
    if (libass) parts.push(`OutlineColour=${libass}`);
  }
  if (
    typeof style.outlineWidthPx === "number"
    && style.outlineWidthPx >= 0
  ) {
    parts.push(`Outline=${Math.round(style.outlineWidthPx)}`);
  }
  if (style.position) {
    parts.push(`Alignment=${POSITION_TO_ALIGNMENT[style.position]}`);
  }
  if (style.marginVerticalPx && style.marginVerticalPx > 0) {
    parts.push(`MarginV=${Math.round(style.marginVerticalPx)}`);
  }
  if (style.boxBackground) {
    // BorderStyle=3 paints an opaque box behind each line; Outline is
    // the box padding in that mode. Overriding Outline to 2 gives a
    // subtle padding when boxBackground is requested without the
    // producer specifying outlineWidthPx.
    parts.push("BorderStyle=3");
    if (style.outlineWidthPx === undefined) parts.push("Outline=2");
  }
  return parts.join(",");
};

/**
 * M7 — translate a `SubtitleStyle` into CSS that mirrors libass's
 * visual output for the in-browser caption overlay.
 *
 * Returns a pair `{ container, text }`:
 *   - `container` styles the positioning wrapper (absolute placement,
 *     margin, horizontal flex alignment). Apply to the outer
 *     `<div>` that holds the caption.
 *   - `text` styles the text block itself (font size, color, shadow
 *     outline, optional box background).
 *
 * Pure — returns plain React.CSSProperties-shaped objects so both the
 * player component and any future editor preview can apply them
 * directly without importing React.
 */
export interface OverlayCss {
  container: Record<string, string | number>;
  text: Record<string, string | number>;
}

/** 8-direction text-shadow string that fakes an outline. libass
 *  `Outline=N` renders an actual outline; CSS has no native outline
 *  for text so we stack shadows at the cardinal + diagonal offsets. */
const buildOutlineShadow = (colorHex: string, widthPx: number): string => {
  if (widthPx <= 0) return "none";
  const w = widthPx;
  const c = `#${colorHex}`;
  return [
    `${-w}px ${-w}px 0 ${c}`,
    `${w}px ${-w}px 0 ${c}`,
    `${-w}px ${w}px 0 ${c}`,
    `${w}px ${w}px 0 ${c}`,
    `${-w}px 0 0 ${c}`,
    `${w}px 0 0 ${c}`,
    `0 ${-w}px 0 ${c}`,
    `0 ${w}px 0 ${c}`,
  ].join(", ");
};

export const subtitleOverlayCss = (style: SubtitleStyle): OverlayCss => {
  const margin =
    typeof style.marginVerticalPx === "number" && style.marginVerticalPx > 0
      ? style.marginVerticalPx
      : 48;
  const position = style.position ?? "bottom";

  const container: Record<string, string | number> = {
    position: "absolute",
    left: 0,
    right: 0,
    display: "flex",
    justifyContent: "center",
    pointerEvents: "none",
    padding: "0 12px",
  };
  if (position === "bottom") {
    container.bottom = `${margin}px`;
  } else if (position === "top") {
    container.top = `${margin}px`;
  } else {
    // middle — vertical centering via top-50 + translate negative half.
    container.top = "50%";
    container.transform = "translateY(-50%)";
  }

  const fontSizePx =
    typeof style.fontSizePx === "number" && style.fontSizePx > 0
      ? style.fontSizePx
      : 20;
  const colorHex = (style.colorHex ?? "FFFFFF").replace(/^#/, "");
  const outlineHex = (style.outlineHex ?? "000000").replace(/^#/, "");
  const outlineWidth =
    typeof style.outlineWidthPx === "number" && style.outlineWidthPx >= 0
      ? style.outlineWidthPx
      : 2;

  const text: Record<string, string | number> = {
    // Scale font size to ~proportional to a 1080p export. Player is
    // ~640px wide in the dialog; using exact libass px would render
    // the overlay almost invisibly small. 0.5× keeps the preview
    // faithful without being comical.
    fontSize: `${Math.max(10, Math.round(fontSizePx * 0.5))}px`,
    lineHeight: 1.25,
    color: `#${colorHex}`,
    textAlign: "center",
    maxWidth: "85%",
    textShadow: buildOutlineShadow(outlineHex, outlineWidth),
  };
  if (style.boxBackground) {
    text.backgroundColor = "rgba(0, 0, 0, 0.75)";
    text.padding = "4px 10px";
    text.borderRadius = "4px";
    // Outline shadow inside a box is redundant — turn it off.
    text.textShadow = "none";
  }
  return { container, text };
};

/** Render SRT. One blank line between cues; trailing newline. */
export const renderSrt = (cues: SubtitleCue[]): string => {
  const blocks = cues.map(
    (cue) =>
      `${cue.index}\n${formatSrtTimestamp(cue.startS)} --> ${formatSrtTimestamp(cue.endS)}\n${cue.text}`,
  );
  return blocks.join("\n\n") + (blocks.length > 0 ? "\n" : "");
};

/** Render WebVTT. Always emits the `WEBVTT` header even for zero cues
 *  (a valid empty vtt file is useful as a placeholder track). */
export const renderVtt = (cues: SubtitleCue[]): string => {
  const header = "WEBVTT\n\n";
  const blocks = cues.map(
    (cue) =>
      `${cue.index}\n${formatVttTimestamp(cue.startS)} --> ${formatVttTimestamp(cue.endS)}\n${cue.text}`,
  );
  return header + blocks.join("\n\n") + (blocks.length > 0 ? "\n" : "");
};
