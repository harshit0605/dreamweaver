/**
 * M6 Voice #3 — voice cast import/export helpers.
 *
 * Producers building a cast on one storyboard often want to reuse the
 * exact same voice assignments on a sequel / spin-off / alternate take.
 * These helpers serialize the relevant bits of an identityPack into a
 * JSON payload the producer can copy-paste between storyboards.
 *
 * Intentionally pure (no Convex, no DOM) so the same logic can run in
 * tests, in the bridge, or in the UI without importing the framework.
 *
 * Schema (v1, `kind: "voice-cast"`):
 * ```
 * {
 *   "kind": "voice-cast",
 *   "schemaVersion": 1,
 *   "exportedAt": "2026-04-19T...",
 *   "entries": [
 *     { "name": "MAYA", "sourceCharacterId": "MAYA", "voice": "nova" },
 *     ...
 *   ]
 * }
 * ```
 *
 * `voice` is ALWAYS one of the six OpenAI TTS voices or empty string
 * (meaning "clear the assignment"). Entries whose voice is empty at
 * export time are dropped — there's nothing useful to re-apply.
 */

/** OpenAI TTS voice roster — mirrors the ALLOWED_VOICES sets across
 *  the audio routes and validators. */
export const ALLOWED_TTS_VOICES = [
  "alloy",
  "echo",
  "fable",
  "onyx",
  "nova",
  "shimmer",
] as const;

export type TtsVoice = (typeof ALLOWED_TTS_VOICES)[number];

const ALLOWED_VOICES_SET = new Set<string>(ALLOWED_TTS_VOICES);

export interface VoiceCastEntry {
  /** Pack display name, upper-cased for matching against the dialogue
   *  speaker extractor. Required. */
  name: string;
  /** `sourceCharacterId` from the identity pack (when ingestion supplied
   *  one). Optional — producers hand-creating packs often leave it
   *  blank. Kept in the payload so name-only matching and
   *  sourceCharacterId matching both work on import. */
  sourceCharacterId?: string;
  /** OpenAI TTS voice. Must be one of ALLOWED_TTS_VOICES. */
  voice: TtsVoice;
}

export interface VoiceCastPayload {
  kind: "voice-cast";
  schemaVersion: 1;
  exportedAt: string;
  entries: VoiceCastEntry[];
}

/** Loose subset of the Convex identityPack row the exporter needs.
 *  Matches what `continuityOS:listConstraintBundle` returns for the
 *  identityPacks field. */
export interface ExportablePack {
  name?: unknown;
  sourceCharacterId?: unknown;
  voice?: unknown;
}

const coerceString = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";

/**
 * Serialize an identity-pack list into the voice-cast wire format.
 *
 * Entries with missing names, empty voices, or voices outside the
 * ALLOWED set are dropped silently — the UI already constrains the
 * picker so these are "shouldn't happen" cases, but defense in depth
 * keeps the exported payload clean.
 */
export const serializeVoiceCast = (
  packs: Iterable<ExportablePack>,
  nowIso: string = new Date().toISOString(),
): VoiceCastPayload => {
  const entries: VoiceCastEntry[] = [];
  for (const pack of packs) {
    const name = coerceString(pack.name);
    if (!name) continue;
    const voiceRaw = coerceString(pack.voice).toLowerCase();
    if (!ALLOWED_VOICES_SET.has(voiceRaw)) continue;
    const sourceCharacterId = coerceString(pack.sourceCharacterId);
    entries.push({
      name,
      ...(sourceCharacterId ? { sourceCharacterId } : {}),
      voice: voiceRaw as TtsVoice,
    });
  }
  return {
    kind: "voice-cast",
    schemaVersion: 1,
    exportedAt: nowIso,
    entries,
  };
};

/** Render a VoiceCastPayload as a 2-space-indented JSON string. */
export const stringifyVoiceCast = (payload: VoiceCastPayload): string =>
  JSON.stringify(payload, null, 2);

export interface ParseVoiceCastResult {
  payload: VoiceCastPayload | null;
  error?: string;
  /** Per-entry warnings that were silently dropped. Callers can surface
   *  these in a "N entries skipped" toast without failing the import. */
  droppedCount: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Parse a voice-cast JSON string into a validated payload.
 *
 * Accepts two shapes for producer convenience:
 *   1. A full { kind, schemaVersion, entries } envelope (the export shape).
 *   2. A bare array [{ name, voice, sourceCharacterId? }, ...] — producers
 *      occasionally hand-author a cast without wrapping it.
 *
 * On success returns a VoiceCastPayload with only valid entries. On
 * failure returns `{ payload: null, error }`.
 */
export const parseVoiceCast = (text: string): ParseVoiceCastResult => {
  const trimmed = text.trim();
  if (!trimmed) {
    return { payload: null, error: "empty input", droppedCount: 0 };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    return {
      payload: null,
      error: err instanceof Error ? err.message : "invalid JSON",
      droppedCount: 0,
    };
  }

  let rawEntries: unknown;
  if (Array.isArray(parsed)) {
    rawEntries = parsed;
  } else if (isRecord(parsed)) {
    if (parsed.kind !== undefined && parsed.kind !== "voice-cast") {
      return {
        payload: null,
        error: `unexpected kind "${String(parsed.kind)}" (expected "voice-cast")`,
        droppedCount: 0,
      };
    }
    rawEntries = parsed.entries;
  } else {
    return {
      payload: null,
      error: "expected JSON object or array",
      droppedCount: 0,
    };
  }

  if (!Array.isArray(rawEntries)) {
    return {
      payload: null,
      error: "missing or invalid 'entries' array",
      droppedCount: 0,
    };
  }

  const entries: VoiceCastEntry[] = [];
  let dropped = 0;
  for (const raw of rawEntries) {
    if (!isRecord(raw)) {
      dropped += 1;
      continue;
    }
    const name = coerceString(raw.name);
    if (!name) {
      dropped += 1;
      continue;
    }
    const voiceRaw = coerceString(raw.voice).toLowerCase();
    if (!ALLOWED_VOICES_SET.has(voiceRaw)) {
      dropped += 1;
      continue;
    }
    const sourceCharacterId = coerceString(raw.sourceCharacterId);
    entries.push({
      name,
      ...(sourceCharacterId ? { sourceCharacterId } : {}),
      voice: voiceRaw as TtsVoice,
    });
  }

  return {
    payload: {
      kind: "voice-cast",
      schemaVersion: 1,
      exportedAt:
        isRecord(parsed) && typeof parsed.exportedAt === "string"
          ? parsed.exportedAt
          : new Date(0).toISOString(),
      entries,
    },
    droppedCount: dropped,
  };
};

export interface PackMatch {
  /** The identityPack._id / packId whose voice we should set. */
  packId: string;
  /** Source entry that matched. */
  entry: VoiceCastEntry;
  /** How we matched — diagnostic, useful for the UI summary. */
  matchedBy: "sourceCharacterId" | "name";
}

export interface UnmatchedEntry {
  entry: VoiceCastEntry;
  /** Why the matcher skipped this entry. */
  reason: "no_matching_pack";
}

export interface PlanImportResult {
  matches: PackMatch[];
  unmatched: UnmatchedEntry[];
}

/** Subset of a pack row needed for import matching. */
export interface MatchablePack {
  packId: string;
  name?: string;
  sourceCharacterId?: string;
}

/** Subset of a pack row the suggester inspects. `dnaJson` drives the
 *  gender inference; `voice` is read to skip already-cast packs unless
 *  `overwrite` is on. */
export interface SuggestablePack {
  name?: string;
  sourceCharacterId?: string;
  voice?: string;
  dnaJson?: string;
}

export interface SuggestOptions {
  /** When true, regenerate suggestions even for packs that already have
   *  a voice. Default false (only unassigned packs get proposals). */
  overwrite?: boolean;
  /** Default voice when the inference can't pick a gender. Defaults to
   *  `alloy` — a genuinely neutral choice. */
  neutralDefault?: "alloy" | "fable";
}

/** Rotate-through pools keep the cast varied when multiple packs share
 *  the same inferred gender: a storyboard with 3 female characters
 *  gets nova, shimmer, nova rather than all nova. */
const MASCULINE_POOL: readonly TtsVoice[] = ["onyx", "echo"];
const FEMININE_POOL: readonly TtsVoice[] = ["nova", "shimmer"];

/**
 * Build a VoiceCastPayload of auto-proposed voices using each pack's
 * DNA. Intentionally conservative:
 *   - Skips packs with no DNA signal (returns no entry for them).
 *   - Skips packs whose voice is already set, unless overwrite=true.
 *   - Rotates through per-gender pools so the cast doesn't collapse
 *     into a single voice when multiple characters share a gender.
 *
 * `inferPackGender` lives in the continuity-validators module; import
 * it lazily inside the function so test environments that don't need
 * voice suggestions don't pay the validator-tree import cost.
 */
export const suggestVoiceCast = async (
  packs: SuggestablePack[],
  options: SuggestOptions = {},
  nowIso: string = new Date().toISOString(),
): Promise<VoiceCastPayload> => {
  const { inferPackGender } = await import(
    "@/lib/continuity-validators/voice-gender"
  );
  return suggestVoiceCastWith(packs, inferPackGender, options, nowIso);
};

/** Testable inner that accepts the gender inferrer as a dep. Exported so
 *  unit tests don't need to stand up the validator tree. */
export const suggestVoiceCastWith = (
  packs: SuggestablePack[],
  inferPackGender: (dnaJson: string) => "masculine" | "feminine" | "neutral" | null,
  options: SuggestOptions = {},
  nowIso: string = new Date().toISOString(),
): VoiceCastPayload => {
  const { overwrite = false, neutralDefault = "alloy" } = options;
  const entries: VoiceCastEntry[] = [];
  let mIdx = 0;
  let fIdx = 0;
  for (const pack of packs) {
    const name = coerceString(pack.name);
    if (!name) continue;
    const existingVoice = coerceString(pack.voice).toLowerCase();
    if (!overwrite && ALLOWED_VOICES_SET.has(existingVoice)) continue;
    const dna = coerceString(pack.dnaJson);
    const gender = dna ? inferPackGender(dna) : null;
    let voice: TtsVoice;
    if (gender === "masculine") {
      voice = MASCULINE_POOL[mIdx % MASCULINE_POOL.length];
      mIdx += 1;
    } else if (gender === "feminine") {
      voice = FEMININE_POOL[fIdx % FEMININE_POOL.length];
      fIdx += 1;
    } else {
      // Genuinely unknown gender → use the neutral default. We DO emit
      // the entry here (unlike the gender-required paths) because a
      // producer explicitly asked for an auto-suggest and an explicit
      // neutral choice is more useful than silence.
      voice = neutralDefault as TtsVoice;
    }
    const sourceCharacterId = coerceString(pack.sourceCharacterId);
    entries.push({
      name,
      ...(sourceCharacterId ? { sourceCharacterId } : {}),
      voice,
    });
  }
  return {
    kind: "voice-cast",
    schemaVersion: 1,
    exportedAt: nowIso,
    entries,
  };
};

/**
 * Plan an import: map each entry to a packId on the target storyboard.
 *
 * Matching order (first hit wins per entry):
 *   1. Entry's `sourceCharacterId` (case-insensitive) === pack's `sourceCharacterId`
 *   2. Entry's `name` (case-insensitive) === pack's `name`
 *
 * Returns matches + unmatched so callers can show a "X of Y packs will
 * be updated" summary before committing.
 */
export const planVoiceCastImport = (
  entries: VoiceCastEntry[],
  packs: MatchablePack[],
): PlanImportResult => {
  // Build lookup tables once. Uppercase keys so the matcher is
  // case-insensitive — "Maya" === "MAYA" for cast-transfer purposes.
  const bySourceId = new Map<string, string>();
  const byName = new Map<string, string>();
  for (const pack of packs) {
    if (!pack.packId) continue;
    const sid = coerceString(pack.sourceCharacterId).toUpperCase();
    if (sid) bySourceId.set(sid, pack.packId);
    const nm = coerceString(pack.name).toUpperCase();
    if (nm) byName.set(nm, pack.packId);
  }

  const matches: PackMatch[] = [];
  const unmatched: UnmatchedEntry[] = [];
  for (const entry of entries) {
    const sid = (entry.sourceCharacterId ?? "").trim().toUpperCase();
    const nm = entry.name.trim().toUpperCase();
    const hitBySid = sid ? bySourceId.get(sid) : undefined;
    if (hitBySid) {
      matches.push({ packId: hitBySid, entry, matchedBy: "sourceCharacterId" });
      continue;
    }
    const hitByName = byName.get(nm);
    if (hitByName) {
      matches.push({ packId: hitByName, entry, matchedBy: "name" });
      continue;
    }
    unmatched.push({ entry, reason: "no_matching_pack" });
  }
  return { matches, unmatched };
};
