/**
 * M9 Phase 4-5 — derived motif display status.
 *
 * The Convex `narrativeMotifs.landedStatus` enum collapses
 * orphaned/unplanted into a single `planted` storage bucket, but the
 * UI distinguishes by sources/payoffs presence so producers can tell
 * "needs a payoff" from "needs a setup" at a glance. This helper
 * mirrors `detect_motif_gaps` on the Python side.
 *
 * Display values:
 *   * `landed`    — both sources AND payoffs exist; the chain is
 *                   complete on this branch.
 *   * `planted`   — sources exist, no payoffs; needs a callback.
 *   * `orphaned`  — payoffs exist, no sources; needs a setup.
 *   * `unplanted` — neither; bare registry entry (rare; usually a
 *                   placeholder before the first plant).
 *
 * Sort order in the panel is `landed → planted → orphaned →
 * unplanted` so producers see successes first and gaps surface
 * progressively.
 */

export type MotifDisplayStatus =
  | "landed"
  | "planted"
  | "orphaned"
  | "unplanted";

export type MotifShape = {
  sourceNodeIds: string[];
  payoffNodeIds: string[];
};

export const deriveDisplayStatus = (
  motif: MotifShape,
): MotifDisplayStatus => {
  const hasSource = motif.sourceNodeIds.length > 0;
  const hasPayoff = motif.payoffNodeIds.length > 0;
  if (hasSource && hasPayoff) return "landed";
  if (hasSource) return "planted";
  if (hasPayoff) return "orphaned";
  return "unplanted";
};

export const MOTIF_DISPLAY_ORDER: Record<MotifDisplayStatus, number> = {
  landed: 0,
  planted: 1,
  orphaned: 2,
  unplanted: 3,
};
