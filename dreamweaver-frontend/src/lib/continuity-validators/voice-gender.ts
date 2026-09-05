/**
 * M6 polish — voice-gender mismatch critic.
 *
 * Conservative sibling of `checkVoiceCoverage`. Flags shots where the
 * assigned TTS voice conflicts with the character's identity pack DNA
 * along the clearest axis: perceived gender. This is a quality hint,
 * not a correctness failure — a female character voiced by onyx still
 * plays fine, just sounds off.
 *
 * Scope intentionally narrow:
 *   - Only flags the three unambiguously-gendered voice pairs
 *     (echo/onyx = masculine, nova/shimmer = feminine) against explicit
 *     DNA gender fields. Voices marked androgynous (alloy, fable) and
 *     packs without a gender signal stay silent.
 *   - Ignores age axis entirely — every OpenAI voice is adult-range, so
 *     the signal is too weak to usefully flag.
 *
 * Severity `low` so it doesn't drown the critical continuity signals
 * but producers see it in the violations panel and the agent can pick
 * it up via the same Convex query.
 */

import type {
  ValidatorFn,
  ValidatorIdentityPack,
  ValidatorViolation,
} from "./types";

import { extractDialogue } from "@/lib/dialogue-extract";

/** Voice → coded gender hint. `"neutral"` voices never raise a mismatch
 *  regardless of DNA; they're the safe fallback producers pick when
 *  they don't want to commit. */
export type VoiceGenderHint = "masculine" | "feminine" | "neutral";

export const VOICE_GENDER_HINT: Record<string, VoiceGenderHint> = {
  alloy: "neutral",
  echo: "masculine",
  fable: "neutral",
  onyx: "masculine",
  nova: "feminine",
  shimmer: "feminine",
};

/** Tokens that unambiguously imply gender. Lowercased, whitespace-free.
 *  Intentionally short — a richer taxonomy would require real NLP, and
 *  this is a hint, not a judgment. */
const MASCULINE_TOKENS = new Set([
  "male",
  "man",
  "boy",
  "masculine",
  "he",
  "him",
  "his",
  "husband",
  "father",
  "son",
  "brother",
  "uncle",
  "grandfather",
  "nephew",
]);

const FEMININE_TOKENS = new Set([
  "female",
  "woman",
  "girl",
  "feminine",
  "she",
  "her",
  "hers",
  "wife",
  "mother",
  "daughter",
  "sister",
  "aunt",
  "grandmother",
  "niece",
]);

/** Walk every string leaf in a parsed DNA JSON tree, checking for
 *  tokens from the masculine/feminine vocabularies. Skipped when the
 *  DNA is malformed or empty. Returns `null` when no signal found. */
export const inferPackGender = (dnaJson: string): VoiceGenderHint | null => {
  if (!dnaJson || dnaJson.trim().length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(dnaJson);
  } catch {
    return null;
  }
  let masc = 0;
  let fem = 0;
  const visit = (value: unknown, keyHint = ""): void => {
    if (typeof value === "string") {
      const lower = value.toLowerCase();
      // Prefer an explicit `gender` / `sex` key over ambient pronoun
      // counting. First hit wins by adding a larger weight so the
      // scanner doesn't drift on loosely-written descriptions.
      const keyCares = /gender|sex/i.test(keyHint);
      const tokens = lower.split(/[^a-z]+/).filter(Boolean);
      for (const tok of tokens) {
        if (MASCULINE_TOKENS.has(tok)) masc += keyCares ? 4 : 1;
        if (FEMININE_TOKENS.has(tok)) fem += keyCares ? 4 : 1;
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, keyHint);
      return;
    }
    if (value && typeof value === "object") {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        visit(v, k);
      }
    }
  };
  visit(parsed);
  if (masc === 0 && fem === 0) return null;
  // Equal counts → genuinely ambiguous, stay silent.
  if (masc === fem) return null;
  return masc > fem ? "masculine" : "feminine";
};

/** Build an UPPERCASE-keyed map from pack identifier → inferred gender
 *  + mapped voice, for every pack that has BOTH. */
interface PackVoiceRecord {
  packName: string;
  voice: string;
  voiceHint: VoiceGenderHint;
  packGender: VoiceGenderHint;
}

const buildPackIndex = (
  packs: ValidatorIdentityPack[] | undefined,
): Map<string, PackVoiceRecord> => {
  const index = new Map<string, PackVoiceRecord>();
  for (const pack of packs ?? []) {
    const voice =
      typeof pack.voice === "string" ? pack.voice.trim().toLowerCase() : "";
    const voiceHint = VOICE_GENDER_HINT[voice];
    if (!voiceHint || voiceHint === "neutral") continue;
    // Parse DNA only for packs that already have a gendered voice — no
    // point paying the JSON + scan cost for neutral / unassigned packs.
    const dnaJson =
      typeof (pack as { dnaJson?: unknown }).dnaJson === "string"
        ? ((pack as { dnaJson?: string }).dnaJson as string)
        : "";
    const packGender = inferPackGender(dnaJson);
    if (!packGender || packGender === "neutral") continue;
    if (packGender === voiceHint) continue;
    const record: PackVoiceRecord = {
      packName:
        typeof pack.name === "string" && pack.name.length > 0
          ? pack.name
          : (pack.sourceCharacterId ?? ""),
      voice,
      voiceHint,
      packGender,
    };
    const candidates = [pack.sourceCharacterId ?? "", pack.name ?? ""];
    for (const candidate of candidates) {
      const key = candidate.trim().toUpperCase();
      if (key) index.set(key, record);
    }
  }
  return index;
};

/** `ValidatorIdentityPack` doesn't currently expose `dnaJson`. We rely
 *  on the caller passing it through via the same `Record<string, unknown>`
 *  shape Convex returns; widen the type here locally so the mismatch
 *  validator can read it without forcing every call site to refactor. */
type PackWithDna = ValidatorIdentityPack & { dnaJson?: string };

export const checkVoiceGenderMismatch: ValidatorFn = (input) => {
  if (!input.identityPacks) return [];
  const index = buildPackIndex(input.identityPacks as PackWithDna[]);
  if (index.size === 0) return [];

  const violations: ValidatorViolation[] = [];
  for (const node of input.nodes) {
    if (node.nodeType !== "shot") continue;
    const segment = (node.segment ?? "").trim();
    if (!segment) continue;
    const extracted = extractDialogue(segment);
    if (extracted.lines.length === 0) continue;

    const flagged = new Set<string>();
    for (const line of extracted.lines) {
      const raw = (line.speaker ?? "").trim();
      if (!raw) continue;
      const key = raw.toUpperCase();
      const record = index.get(key);
      if (!record) continue;
      if (flagged.has(key)) continue;
      flagged.add(key);
      violations.push({
        code: "SHOT_SPEAKER_VOICE_MISMATCH",
        severity: "low",
        message: `Shot dialogue speaker "${raw}" (${record.packGender} per identity DNA) is voiced by "${record.voice}" (perceived ${record.voiceHint}) — audition before finalizing.`,
        nodeIds: [node.nodeId],
        edgeIds: [],
        suggestedFix: `Reassign a ${record.packGender}-coded voice for "${record.packName || raw}" (alloy / fable stay neutral; ${record.packGender === "feminine" ? "nova / shimmer" : "echo / onyx"} match the DNA).`,
      });
    }
  }
  return violations;
};
