import type { ShotMeta, NodeType } from "@/app/storyboard/types";

export type ValidatorSeverity = "low" | "medium" | "high" | "critical";

export type ValidatorCode =
  | "SHOT_AXIS_LINE_BREAK"
  | "SHOT_SCREEN_DIRECTION_REVERSE"
  | "SHOT_THIRTY_DEGREE_RULE"
  | "SHOT_EYELINE_MISMATCH"
  | "SHOT_SPEAKER_VOICE_MISSING"
  | "SHOT_SPEAKER_VOICE_MISMATCH";

/**
 * Code prefixes owned by the shot-validator family. The mutation that
 * persists fresh validator rows uses these prefixes to soft-clear stale
 * rows while leaving unrelated continuity violations (e.g. the LLM critic
 * in Enhancement #6) untouched.
 *
 * keep in sync with convex/continuityOS.ts SHOT_VALIDATOR_CODE_PREFIXES.
 */
export const SHOT_VALIDATOR_CODE_PREFIXES: readonly string[] = [
  "SHOT_AXIS_LINE_BREAK",
  "SHOT_SCREEN_DIRECTION_REVERSE",
  "SHOT_THIRTY_DEGREE_RULE",
  "SHOT_EYELINE_MISMATCH",
  "SHOT_SPEAKER_VOICE_MISSING",
  "SHOT_SPEAKER_VOICE_MISMATCH",
] as const;

export interface ValidatorNode {
  nodeId: string;
  nodeType: NodeType;
  label: string;
  shotMeta?: ShotMeta;
  entityRefs?: {
    characterIds: string[];
    backgroundId?: string;
    sceneId?: string;
    shotId?: string;
  };
  /** M6 Voice #5 — raw shot segment text. Used by the voice-coverage
   *  validator to extract uppercase speaker names and flag ones whose
   *  identity pack has no TTS voice mapped. Optional so non-voice
   *  validators don't pay the extra payload. */
  segment?: string;
}

/** M6 Voice #5 — subset of the identityPack shape the voice-coverage
 *  validator needs. Intentionally loose so the caller can pass the raw
 *  Convex row without a conversion step. */
export interface ValidatorIdentityPack {
  name?: string;
  sourceCharacterId?: string;
  voice?: string;
}

export interface ValidatorEdge {
  sourceNodeId: string;
  targetNodeId: string;
  edgeType?: "serial" | "parallel" | "branch" | "merge";
  isPrimary?: boolean;
  order?: number;
}

export interface ValidatorInput {
  nodes: ValidatorNode[];
  edges: ValidatorEdge[];
  /** M6 Voice #5 — identity packs used only by the voice-coverage
   *  validator. Optional so legacy callers that don't yet thread
   *  packs still work (voice-coverage becomes a no-op). */
  identityPacks?: ValidatorIdentityPack[];
}

export interface ValidatorViolation {
  code: ValidatorCode;
  severity: ValidatorSeverity;
  message: string;
  nodeIds: string[];
  edgeIds: string[];
  suggestedFix?: string;
}

export type ValidatorFn = (input: ValidatorInput) => ValidatorViolation[];
