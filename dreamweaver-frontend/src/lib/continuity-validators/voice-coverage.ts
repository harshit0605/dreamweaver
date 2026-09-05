/**
 * M6 Voice #5 — speaker-voice coverage check.
 *
 * Scans every shot node's `segment` text for uppercase speaker names
 * (same extraction the TTS worker uses), then cross-references the
 * project's identity packs. A shot emits one `SHOT_SPEAKER_VOICE_MISSING`
 * violation per unique speaker whose pack has no voice mapped — so the
 * producer knows the shot will fall through to the default voice and
 * can either assign a voice on the pack or accept the fallback.
 *
 * Severity is intentionally `low`: missing voice coverage is a quality
 * hint, not a correctness failure — the audio batch still produces a
 * playable narration using the default voice. Producers browsing the
 * violations panel can use the hint to stage a cast-assignment pass.
 */

import { extractDialogue } from "@/lib/dialogue-extract";

import type {
  ValidatorFn,
  ValidatorIdentityPack,
  ValidatorViolation,
} from "./types";

/** Canonical OpenAI TTS voice roster — mirrors `ALLOWED_VOICES` on the
 *  audio API routes. Packs whose `voice` falls outside this set are
 *  treated as unmapped. */
const ALLOWED_VOICES = new Set([
  "alloy",
  "echo",
  "fable",
  "onyx",
  "nova",
  "shimmer",
]);

/** Build a set of UPPERCASE speaker keys that HAVE a valid voice. Both
 *  `sourceCharacterId` (ingester-provided) and `name` (producer-created)
 *  are keys because downstream routing tolerates either. */
const buildCoveredSpeakers = (
  packs: ValidatorIdentityPack[] | undefined,
): Set<string> => {
  const covered = new Set<string>();
  for (const pack of packs ?? []) {
    const voice =
      typeof pack.voice === "string" ? pack.voice.trim().toLowerCase() : "";
    if (!voice || !ALLOWED_VOICES.has(voice)) continue;
    const candidates = [pack.sourceCharacterId ?? "", pack.name ?? ""];
    for (const candidate of candidates) {
      const key = candidate.trim().toUpperCase();
      if (key.length > 0) covered.add(key);
    }
  }
  return covered;
};

export const checkVoiceCoverage: ValidatorFn = (input) => {
  // Skip entirely when the caller didn't thread packs — the default
  // validator list should still work for older call sites that don't
  // care about voice coverage.
  if (!input.identityPacks) return [];

  const covered = buildCoveredSpeakers(input.identityPacks);
  const violations: ValidatorViolation[] = [];

  for (const node of input.nodes) {
    if (node.nodeType !== "shot") continue;
    const segment = (node.segment ?? "").trim();
    if (!segment) continue;

    const extracted = extractDialogue(segment);
    if (extracted.lines.length === 0) continue;

    // Dedupe per shot: one violation per (speaker) even if the shot has
    // multiple lines from the same speaker — otherwise the panel drowns
    // in duplicates on longer monologues.
    const flagged = new Set<string>();
    for (const line of extracted.lines) {
      const raw = (line.speaker ?? "").trim();
      if (!raw) continue;
      const key = raw.toUpperCase();
      if (covered.has(key)) continue;
      if (flagged.has(key)) continue;
      flagged.add(key);
      violations.push({
        code: "SHOT_SPEAKER_VOICE_MISSING",
        severity: "low",
        message: `Shot dialogue attributes a line to "${raw}" but no identity pack maps that speaker to a TTS voice — the audio batch will fall back to the default voice.`,
        nodeIds: [node.nodeId],
        edgeIds: [],
        suggestedFix: `Open the Continuity drawer and set a voice on the identity pack for "${raw}", or rename the pack to match the speaker casing in the shot.`,
      });
    }
  }

  return violations;
};
