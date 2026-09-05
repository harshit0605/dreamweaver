"use client";

/**
 * M9 Phase 2 — floating narrative-analysis strip anchored above the
 * storyboard canvas. Three affordances in one bar:
 *
 *   1. Structure picker (Save-the-Cat / Harmon Circle / Three-Act /
 *      Kishōtenketsu / Hook-First). Auto-suggested from reel
 *      durationS.
 *   2. Analyze button — runs the deterministic client-side
 *      heuristics (lib/narrative), persists a beat plan row + patches
 *      each node's `tensionLevel`, then nudges the agent via a chat
 *      message so the beat_analyst can refine.
 *   3. Tension curve sparkline + beat-ribbon strip reading directly
 *      from the node snapshot (tensionLevel / beatType fields).
 *   4. (Phase 5) Color Script Strip — per-shot hue derived from
 *      tension + segment keywords.
 *
 * M9 Phase 5 — beat ribbon is now interactive. Click any slot to
 * open a popover picker of candidate shots; approved assignments
 * persist via the same `setNodeNarrativeFields` + `upsertBeatPlan`
 * pair used by the `request_beat_assignment` HITL handler, so the
 * audit trail shape stays identical whether the producer assigns by
 * hand or by approving an agent proposal.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Compass, LineChart, Sparkles } from "lucide-react";
import { useMutation, useQuery } from "convex/react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { mutationRef, queryRef } from "@/lib/convexRefs";
import {
  canonicalBeatsFor,
  detectBeatGaps,
  detectBeatPlan,
  sampleTensionCurve,
  suggestStructureForDuration,
  type HeuristicShotInput,
  type NarrativeStructure,
} from "@/lib/narrative";
import type { StoryNode } from "@/app/storyboard/types";
import { ColorScriptStrip } from "./ColorScriptStrip";

const STRUCTURE_OPTIONS: Array<{ value: NarrativeStructure; label: string }> = [
  { value: "save_the_cat", label: "Save the Cat (15)" },
  { value: "hook_first", label: "Hook First (5)" },
  { value: "harmon_circle", label: "Harmon Circle (8)" },
  { value: "three_act", label: "Three-Act (7)" },
  { value: "kishotenketsu", label: "Kishōtenketsu (4)" },
];

/** Project a StoryNode onto the loose shape the heuristics consume.
 *  Centralized so BeatRibbon + TensionCurveOverlay don't each re-
 *  invent the projection. */
const projectShot = (node: StoryNode): HeuristicShotInput => ({
  nodeId: node.id,
  segment: node.data.segment ?? null,
  shotMeta: node.data.shotMeta
    ? {
        size: node.data.shotMeta.size ?? null,
        move: node.data.shotMeta.move ?? null,
        sfx: node.data.shotMeta.sfx ?? null,
        vfx: node.data.shotMeta.vfx ?? null,
      }
    : null,
});

/** Sum of shot durations across the ordered reel — informs the
 *  structure auto-suggest. 5s fallback per shot matches the
 *  reel-manifest route's default clamp. */
const estimateReelDurationS = (shots: StoryNode[]): number =>
  shots.reduce((acc, node) => {
    const raw = node.data.shotMeta?.durationS;
    const d =
      typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? raw : 5;
    return acc + d;
  }, 0);

interface NarrativeBarProps {
  storyboardId: string;
  branchId?: string;
  nodes: StoryNode[];
  /** Jump the canvas viewport to a given node. Reuses the same
   *  `focusNode` the OutlinePanel uses. */
  onFocusNode?: (nodeId: string) => void;
}

export function NarrativeBar({
  storyboardId,
  branchId = "main",
  nodes,
  onFocusNode,
}: NarrativeBarProps) {
  // Shot-node-only, positional-sorted list. The heuristics expect
  // ordered shots; the storyboard-node array's natural order reflects
  // creation order, which for most ingested reels is already the
  // primary timeline. Phase 5 will swap in `buildPrimaryLine` from
  // lib/screenplay for a true primary-line sort.
  const shotNodes = useMemo(
    () => nodes.filter((n) => n.data.nodeType === "shot"),
    [nodes],
  );

  // Fetched reactively so the ribbon updates when the agent commits
  // a beat assignment through request_beat_assignment. Skipped when
  // storyboardId is empty.
  const beatPlanRow = useQuery(
    queryRef("narrativeState:getBeatPlan"),
    storyboardId ? { storyboardId: storyboardId as never, branchId } : "skip",
  ) as
    | {
        structure: NarrativeStructure;
        beats: Array<{
          beatKey: string;
          nodeId?: string;
          status: "planned" | "assigned" | "missing";
          rationale?: string;
          expectedActNumber?: number;
        }>;
      }
    | null
    | undefined;

  // Persisted structure choice (if the producer has already analyzed
  // once) OR duration-based auto-suggest for first-run.
  const reelDurationS = useMemo(
    () => estimateReelDurationS(shotNodes),
    [shotNodes],
  );
  const [structure, setStructure] = useState<NarrativeStructure>(() =>
    suggestStructureForDuration(reelDurationS),
  );
  useEffect(() => {
    // Once the beat plan row lands, adopt its structure so the
    // picker reflects the committed choice instead of the duration-
    // based guess.
    if (beatPlanRow && beatPlanRow.structure) {
      setStructure(beatPlanRow.structure);
    }
  }, [beatPlanRow]);

  const upsertBeatPlan = useMutation(
    mutationRef("narrativeState:upsertBeatPlan"),
  );
  const setNodeNarrativeFields = useMutation(
    mutationRef("narrativeState:setNodeNarrativeFields"),
  );

  const [analyzing, setAnalyzing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastRunAt, setLastRunAt] = useState<number | null>(null);
  // M9 Phase 5 — which beat slot is currently open for edit.
  // `null` means no popover is open. A single string key keeps the
  // one-open-at-a-time invariant without tracking a Map of bools.
  const [editingSlotKey, setEditingSlotKey] = useState<string | null>(null);
  const [assigning, setAssigning] = useState(false);

  // Tension samples for the sparkline come straight off the node's
  // `tensionLevel` (set by `setNodeNarrativeFields` during Analyze).
  // Missing values render as 0-height gaps so producers can see
  // which shots haven't been sampled yet.
  const tensionSeries = useMemo(() => {
    return shotNodes.map((node) => ({
      nodeId: node.id,
      value:
        typeof node.data.tensionLevel === "number"
          ? Math.max(0, Math.min(10, node.data.tensionLevel))
          : null,
    }));
  }, [shotNodes]);

  const handleAnalyze = async () => {
    if (!storyboardId || shotNodes.length === 0 || analyzing) return;
    setError(null);
    setAnalyzing(true);
    try {
      // 1. Deterministic heuristics — no LLM, no network.
      const shots = shotNodes.map(projectShot);
      const curve = sampleTensionCurve(shots);
      const existingBeats = beatPlanRow?.beats ?? [];
      const planProposal = detectBeatPlan(structure, shots, existingBeats);
      // 2. Persist the tension value onto each shot (reactive into
      //    the sparkline + the agent's state). One mutation per
      //    sampled shot — acceptable at typical 15-40 shot reels.
      for (const sample of curve.samples) {
        try {
          await setNodeNarrativeFields({
            storyboardId: storyboardId as never,
            nodeId: sample.nodeId,
            tensionLevel: sample.value,
          });
        } catch {
          // Per-node failure is non-fatal — other shots still update.
        }
      }
      // 3. Persist the beat plan. We flip each proposed slot from
      //    "planned" → "planned" (keeps heuristic label so the ribbon
      //    renders "suggested" visually) so the producer has a
      //    starting point without the agent silently assigning.
      await upsertBeatPlan({
        storyboardId: storyboardId as never,
        branchId,
        structure: structure as never,
        beats: planProposal.beats.map((b) => ({
          beatKey: b.beatKey,
          expectedActNumber: b.expectedActNumber,
          nodeId: b.nodeId,
          status: b.status,
          rationale: b.rationale,
        })),
      });
      setLastRunAt(Date.now());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Analyze failed.");
    } finally {
      setAnalyzing(false);
    }
  };

  const beats = beatPlanRow?.beats ?? [];
  const gaps = useMemo(
    () =>
      detectBeatGaps(
        beats.map((b) => ({
          beatKey: b.beatKey,
          nodeId: b.nodeId,
          status: b.status,
          rationale: b.rationale,
          expectedActNumber: b.expectedActNumber,
        })),
      ),
    [beats],
  );
  const canonicalKeys = useMemo(() => canonicalBeatsFor(structure), [structure]);
  // Build the ribbon: every canonical beat for the current structure,
  // filled in from the persisted plan when available.
  const ribbonSlots = useMemo(() => {
    const byKey = new Map(beats.map((b) => [b.beatKey, b]));
    return canonicalKeys.map((key) => byKey.get(key) ?? { beatKey: key, status: "planned" as const });
  }, [beats, canonicalKeys]);

  const hasAnalysis = beats.length > 0 || lastRunAt !== null;

  // M9 Phase 5 — producer commits a manual beat assignment. Mirrors
  // the `request_beat_assignment` approval path: patch the node's
  // beatType + actNumber, then upsertBeatPlan with the merged slot
  // set (this slot's new nodeId overrides any prior assignment of the
  // same beatKey; any prior slot that previously pointed to this
  // nodeId under a different beatKey gets cleared, matching the
  // "one node → one beat" invariant the agent enforces).
  const handleAssignBeat = useCallback(
    async (beatKey: string, nodeId: string | null) => {
      if (!storyboardId || assigning) return;
      setAssigning(true);
      setError(null);
      try {
        // Build the next beat list. Keep the existing rows intact
        // except for the slot we're editing + any slot that used to
        // point at the same node (producer is re-targeting).
        const nextBeats = canonicalKeys.map((key) => {
          const existing = ribbonSlots.find((s) => s.beatKey === key);
          if (key === beatKey) {
            return {
              beatKey: key,
              nodeId: nodeId ?? undefined,
              status: (nodeId ? "assigned" : "planned") as
                | "assigned"
                | "planned"
                | "missing",
              rationale: existing?.rationale,
              expectedActNumber: existing?.expectedActNumber,
            };
          }
          if (nodeId && existing?.nodeId === nodeId) {
            // Node moved to a new slot — clear the old one.
            return {
              beatKey: key,
              nodeId: undefined,
              status: "planned" as const,
              rationale: existing.rationale,
              expectedActNumber: existing.expectedActNumber,
            };
          }
          return {
            beatKey: key,
            nodeId: existing?.nodeId,
            status: (existing?.status ?? "planned") as
              | "assigned"
              | "planned"
              | "missing",
            rationale: existing?.rationale,
            expectedActNumber: existing?.expectedActNumber,
          };
        });

        if (nodeId) {
          await setNodeNarrativeFields({
            storyboardId: storyboardId as never,
            nodeId,
            beatType: beatKey,
          });
        }
        await upsertBeatPlan({
          storyboardId: storyboardId as never,
          branchId,
          structure: structure as never,
          beats: nextBeats,
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : "Assignment failed.");
      } finally {
        setAssigning(false);
        setEditingSlotKey(null);
      }
    },
    [
      storyboardId,
      assigning,
      canonicalKeys,
      ribbonSlots,
      setNodeNarrativeFields,
      upsertBeatPlan,
      branchId,
      structure,
    ],
  );

  return (
    <section
      aria-label="Narrative analysis"
      className="pointer-events-auto absolute left-4 top-4 z-20 flex max-w-[720px] flex-col gap-1.5 rounded-md border border-border/60 bg-background/90 p-2 text-[11px] backdrop-blur"
      data-testid="narrative-bar"
    >
      <div className="flex items-center gap-2">
        <Compass
          className="size-3.5 shrink-0 text-muted-foreground"
          aria-hidden
        />
        <label className="flex items-center gap-1 text-muted-foreground">
          Structure
          <select
            value={structure}
            onChange={(e) => setStructure(e.target.value as NarrativeStructure)}
            disabled={analyzing}
            aria-label="Narrative structure"
            className="rounded border border-border/60 bg-background/80 px-1 py-0.5 text-[11px]"
            title={`Auto-suggested from reel duration (${reelDurationS.toFixed(0)}s)`}
          >
            {STRUCTURE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </label>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => void handleAnalyze()}
          disabled={analyzing || shotNodes.length === 0 || !storyboardId}
          className="h-6 gap-1.5 px-2 text-[10px]"
          title={
            shotNodes.length === 0
              ? "Add at least one shot to analyze"
              : "Run deterministic beat + tension analysis"
          }
        >
          {analyzing ? (
            <>
              <span className="size-3 animate-spin rounded-full border-2 border-current/30 border-t-current" />
              Analyzing
            </>
          ) : (
            <>
              <Sparkles className="size-3" />
              {hasAnalysis ? "Re-analyze" : "Analyze"}
            </>
          )}
        </Button>
        <span className="ml-auto text-[10px] text-muted-foreground tabular-nums">
          {shotNodes.length} shot{shotNodes.length === 1 ? "" : "s"}
          {gaps.gapCount > 0
            ? ` · ${gaps.gapCount} gap${gaps.gapCount === 1 ? "" : "s"}`
            : hasAnalysis
              ? " · no gaps"
              : ""}
        </span>
      </div>

      {/* M9 Phase 5 — editable beat ribbon. Each slot now opens a
          popover picker of candidate shots. Green = assigned, amber
          = heuristic-planned, rose = missing (was assigned but node
          deleted), muted = empty slot.

          Semantics: clicking an assigned slot shows "Focus / Change /
          Clear"; clicking an empty slot opens the picker directly. */}
      {ribbonSlots.length > 0 ? (
        <div
          className="flex items-center gap-1 overflow-x-auto"
          data-testid="beat-ribbon"
          role="list"
          aria-label="Beat ribbon"
        >
          {ribbonSlots.map((slot) => (
            <BeatSlotButton
              key={slot.beatKey}
              slot={slot}
              shotNodes={shotNodes}
              isEditing={editingSlotKey === slot.beatKey}
              assigning={assigning}
              onOpenEdit={() =>
                setEditingSlotKey(
                  editingSlotKey === slot.beatKey ? null : slot.beatKey,
                )
              }
              onCloseEdit={() => setEditingSlotKey(null)}
              onFocusNode={onFocusNode}
              onAssign={(nodeId) => void handleAssignBeat(slot.beatKey, nodeId)}
            />
          ))}
        </div>
      ) : null}

      {/* Tension curve sparkline. SVG is lightweight + scales cleanly
          for reels from 5 to 50 shots. Click a sample dot to focus
          the corresponding shot. */}
      {tensionSeries.length > 0 && hasAnalysis ? (
        <div className="flex items-center gap-1.5" data-testid="tension-curve">
          <LineChart className="size-3 shrink-0 text-muted-foreground" />
          <TensionSparkline
            series={tensionSeries}
            onPickNode={onFocusNode}
          />
        </div>
      ) : null}

      {/* M9 Phase 5 — color script. Renders whenever there are shots;
          derives hue from tension (sampled post-Analyze) + segment
          keywords, so even pre-Analyze storyboards see a palette
          preview. */}
      {shotNodes.length > 0 ? (
        <ColorScriptStrip nodes={shotNodes} onFocusNode={onFocusNode} />
      ) : null}

      {error ? (
        <p
          className="text-[10px] text-rose-400"
          title={error}
          role="alert"
        >
          {error}
        </p>
      ) : null}
    </section>
  );
}

/**
 * M9 Phase 5 — one editable beat slot.
 *
 * Collapsed state: renders a pill sized + colored by status.
 * Expanded state: pops a compact menu above the pill listing every
 * shot node with its label + act hint; assigned shots are annotated
 * so the producer sees "already at catalyst" inline.
 *
 * Keyboard: arrow-down opens, Escape closes, Enter on a list item
 * commits. We avoid a heavy combobox dependency here — the list is
 * at most 40ish shots and producers typically pick by label
 * recognition, not search.
 */
function BeatSlotButton({
  slot,
  shotNodes,
  isEditing,
  assigning,
  onOpenEdit,
  onCloseEdit,
  onFocusNode,
  onAssign,
}: {
  slot: {
    beatKey: string;
    nodeId?: string;
    status: "planned" | "assigned" | "missing";
    rationale?: string;
    expectedActNumber?: number;
  };
  shotNodes: StoryNode[];
  isEditing: boolean;
  assigning: boolean;
  onOpenEdit: () => void;
  onCloseEdit: () => void;
  onFocusNode?: (nodeId: string) => void;
  onAssign: (nodeId: string | null) => void;
}) {
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const listboxRef = useRef<HTMLDivElement | null>(null);
  // Dismiss on outside click so the picker doesn't stay pinned when
  // the producer moves on to another bar element. Arrow navigation
  // + Escape are handled at the window level because the focused
  // element while navigating the popover is a <button> inside the
  // <ul>; binding keydown to the wrapper would miss modifier combos.
  useEffect(() => {
    if (!isEditing) return;
    const onDocClick = (e: MouseEvent) => {
      if (!wrapperRef.current) return;
      if (!wrapperRef.current.contains(e.target as Node)) {
        onCloseEdit();
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onCloseEdit();
        return;
      }
      // Arrow nav: only intercept when focus is inside the listbox.
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      const root = listboxRef.current;
      if (!root) return;
      if (!root.contains(document.activeElement)) return;
      e.preventDefault();
      const focusables = Array.from(
        root.querySelectorAll<HTMLButtonElement>(
          "button:not([disabled])",
        ),
      );
      if (focusables.length === 0) return;
      const currentIndex = focusables.indexOf(
        document.activeElement as HTMLButtonElement,
      );
      const nextIndex =
        e.key === "ArrowDown"
          ? (currentIndex + 1 + focusables.length) % focusables.length
          : (currentIndex - 1 + focusables.length) % focusables.length;
      focusables[nextIndex]?.focus();
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [isEditing, onCloseEdit]);

  // Focus the first non-disabled option when the popover opens so
  // arrow keys start navigating immediately.
  useEffect(() => {
    if (!isEditing) return;
    const root = listboxRef.current;
    if (!root) return;
    const first = root.querySelector<HTMLButtonElement>(
      "button:not([disabled])",
    );
    first?.focus();
  }, [isEditing]);

  const tone =
    slot.status === "assigned"
      ? "bg-emerald-500/60 border-emerald-500 text-emerald-100"
      : slot.status === "missing"
        ? "bg-rose-500/50 border-rose-500 text-rose-100"
        : slot.nodeId
          ? "bg-amber-500/30 border-amber-500/60 text-amber-100"
          : "bg-muted/40 border-border/40 text-muted-foreground";

  const label = slot.beatKey.replace(/_/g, " ");
  const titleParts = [
    slot.beatKey,
    slot.nodeId ? `→ ${slot.nodeId}` : "(unassigned)",
    slot.rationale,
  ].filter(Boolean);

  return (
    <div ref={wrapperRef} className="relative shrink-0" role="listitem">
      <button
        type="button"
        onClick={onOpenEdit}
        disabled={assigning}
        aria-haspopup="listbox"
        aria-expanded={isEditing}
        aria-label={`${slot.beatKey}${slot.nodeId ? `, assigned to ${slot.nodeId}` : ", unassigned"}`}
        title={titleParts.join("\n")}
        className={cn(
          "rounded border px-1.5 py-0.5 text-[9px] uppercase tracking-wide transition",
          tone,
          "cursor-pointer hover:brightness-110 focus:outline-none focus:ring-2 focus:ring-inset focus:ring-amber-300",
          assigning ? "opacity-60" : "",
        )}
      >
        {label}
      </button>
      {isEditing ? (
        <div
          ref={listboxRef}
          role="listbox"
          aria-label={`Assign a shot to ${slot.beatKey}`}
          className="absolute left-0 top-full z-30 mt-1 max-h-60 w-[min(260px,70vw)] overflow-y-auto rounded-md border border-border/70 bg-popover p-1 text-[11px] text-popover-foreground shadow-lg"
        >
          {/* Action row for assigned slots — focus + clear are common
              next-steps after "edit". For empty slots this row is
              suppressed so the picker is a single column of shots. */}
          {slot.nodeId ? (
            <div className="mb-1 flex gap-1 border-b border-border/40 pb-1">
              {onFocusNode ? (
                <button
                  type="button"
                  className="flex-1 rounded px-1 py-0.5 text-[10px] hover:bg-accent"
                  onClick={() => {
                    if (slot.nodeId) onFocusNode(slot.nodeId);
                    onCloseEdit();
                  }}
                >
                  Focus {slot.nodeId}
                </button>
              ) : null}
              <button
                type="button"
                className="flex-1 rounded px-1 py-0.5 text-[10px] text-rose-300 hover:bg-rose-500/20"
                onClick={() => onAssign(null)}
                disabled={assigning}
              >
                Clear
              </button>
            </div>
          ) : null}
          {shotNodes.length === 0 ? (
            <p className="px-1 py-2 text-muted-foreground">
              No shots yet. Add at least one shot to assign beats.
            </p>
          ) : (
            <ul className="flex flex-col" role="group">
              {shotNodes.map((node) => {
                const isCurrent = slot.nodeId === node.id;
                const existingBeat = node.data.beatType;
                return (
                  <li key={node.id} role="option" aria-selected={isCurrent}>
                    <button
                      type="button"
                      disabled={assigning || isCurrent}
                      onClick={() => onAssign(node.id)}
                      className={cn(
                        "w-full rounded px-1 py-0.5 text-left",
                        isCurrent
                          ? "bg-emerald-500/30 text-emerald-100"
                          : "hover:bg-accent",
                      )}
                    >
                      <span className="font-mono text-[10px] text-muted-foreground">
                        {node.id.slice(0, 10)}
                      </span>
                      <span className="ml-1">
                        {node.data.label ?? "(untitled)"}
                      </span>
                      {existingBeat && existingBeat !== slot.beatKey ? (
                        <span className="ml-1 text-[9px] text-amber-300">
                          now @ {existingBeat.replace(/_/g, " ")}
                        </span>
                      ) : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Compact SVG sparkline. Each sample is a circle at its tension
 * value; a polyline connects them. Missing samples (null) are
 * skipped by the polyline and rendered as hollow dots. ~480px wide;
 * caller clips with overflow-hidden on the container when needed.
 */
function TensionSparkline({
  series,
  onPickNode,
}: {
  series: Array<{ nodeId: string; value: number | null }>;
  onPickNode?: (nodeId: string) => void;
}) {
  const W = 480;
  const H = 32;
  const PAD = 2;
  const usableW = W - PAD * 2;
  const usableH = H - PAD * 2;
  const n = series.length;
  const points = series.map((sample, i) => {
    const x =
      n === 1 ? PAD + usableW / 2 : PAD + (i / (n - 1)) * usableW;
    const y =
      sample.value === null
        ? PAD + usableH / 2
        : PAD + usableH - (sample.value / 10) * usableH;
    return { x, y, sample };
  });
  // Build a polyline skipping null samples by restarting on each
  // unknown. Multiple path segments keep gaps honest instead of
  // drawing straight lines through missing data.
  const segments: Array<Array<{ x: number; y: number }>> = [];
  let current: Array<{ x: number; y: number }> = [];
  for (const p of points) {
    if (p.sample.value === null) {
      if (current.length > 0) segments.push(current);
      current = [];
    } else {
      current.push({ x: p.x, y: p.y });
    }
  }
  if (current.length > 0) segments.push(current);

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      className="h-6 w-[min(480px,100%)]"
      role="img"
      aria-label="Tension curve"
    >
      {/* Midline reference (value 5). */}
      <line
        x1={PAD}
        x2={W - PAD}
        y1={PAD + usableH / 2}
        y2={PAD + usableH / 2}
        stroke="currentColor"
        strokeOpacity={0.1}
      />
      {segments.map((seg, i) => (
        <polyline
          key={i}
          fill="none"
          stroke="rgb(244 114 182)"
          strokeWidth={1.5}
          points={seg.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ")}
        />
      ))}
      {points.map((p) => (
        <circle
          key={p.sample.nodeId}
          cx={p.x}
          cy={p.y}
          r={p.sample.value === null ? 1.5 : 2.25}
          fill={p.sample.value === null ? "transparent" : "rgb(244 114 182)"}
          stroke={p.sample.value === null ? "rgb(100 116 139)" : "transparent"}
          strokeWidth={1}
          className={
            onPickNode
              ? "cursor-pointer hover:fill-rose-400"
              : undefined
          }
          onClick={() => onPickNode?.(p.sample.nodeId)}
        >
          <title>
            {p.sample.value === null
              ? `${p.sample.nodeId}: not sampled`
              : `${p.sample.nodeId}: ${p.sample.value.toFixed(1)}`}
          </title>
        </circle>
      ))}
    </svg>
  );
}
