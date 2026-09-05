"use client";

import { useState } from "react";
import { ChevronsUp } from "lucide-react";
import type {
  NarrativeBranchRecord,
  NarrativeCommitRecord,
  NarrativeMotifRecord,
  NarrativeVariantRecord,
  SimulationCriticRunRecord,
  StoryNode,
} from "@/app/storyboard/types";
import { CUT_TIER_LABELS, CUT_TIER_OPTIONS } from "@/app/storyboard/types";
import { formatReviewRound, nextCutTier, type CutTier } from "@/lib/cut-tier";
import { CherryPickDialog } from "./CherryPickDialog";
import { VariantComparePanel } from "./VariantComparePanel";
import { MotifMapPanel } from "./MotifMapPanel";

type TimelineTheaterPanelProps = {
  simulationRuns: SimulationCriticRunRecord[];
  branches: NarrativeBranchRecord[];
  commits: NarrativeCommitRecord[];
  storyboardId: string;
  onRunCritic: () => Promise<void>;
  onCreateBranch: () => Promise<void>;
  onCherryPickCommit: (sourceCommitId: string, targetBranchId: string) => Promise<void>;
  onComputeLatestDiff: () => Promise<void>;
  onSetBranchCutTier?: (branchId: string, cutTier: CutTier) => Promise<void>;
  onSetCommitReviewRound?: (commitId: string, reviewRound?: number) => Promise<void>;
  onBumpBranchHeadReviewRound?: (branchId: string) => Promise<void>;
  // M9 Phase 3 — variant compare sub-panel. Optional so storyboards
  // without variants still render the Theater cleanly (Phase 1/2-only
  // producers see no added chrome).
  variants?: NarrativeVariantRecord[];
  compareBranchIds?: string[];
  onToggleCompareBranch?: (branchId: string) => void;
  onPromoteVariant?: (variant: NarrativeVariantRecord) => Promise<void>;
  // M9 Phase 4 — motif map sub-panel. Hidden when no motifs exist
  // so storyboards that never invoked the motif_tracker see no
  // added chrome.
  motifs?: NarrativeMotifRecord[];
  onFocusNode?: (nodeId: string) => void;
  // M9 Phase 5 — manual motif plant. Optional: when supplied, the
  // MotifMapPanel shows a "Plant motif" button + inline form.
  shotNodes?: StoryNode[];
  onPlantMotif?: (input: {
    motifKey: string;
    description: string;
    targetNodeId: string;
    role: "plant" | "payoff";
    visualVocabulary?: string;
  }) => Promise<void>;
};

const TONE_CLASSES: Record<
  "muted" | "info" | "violet" | "amber" | "emerald" | "sky" | "success",
  string
> = {
  muted: "border-slate-500/40 bg-slate-500/10 text-slate-200",
  info: "border-sky-500/40 bg-sky-500/10 text-sky-200",
  violet: "border-violet-500/40 bg-violet-500/10 text-violet-200",
  amber: "border-amber-500/40 bg-amber-500/10 text-amber-200",
  emerald: "border-emerald-500/40 bg-emerald-500/10 text-emerald-200",
  sky: "border-cyan-500/40 bg-cyan-500/10 text-cyan-200",
  success: "border-green-500/40 bg-green-500/10 text-green-200",
};

const getTierTone = (tier: CutTier): keyof typeof TONE_CLASSES => {
  const entry = CUT_TIER_OPTIONS.find((option) => option.value === tier);
  return entry?.tone ?? "muted";
};

export function TimelineTheaterPanel({
  simulationRuns,
  branches,
  commits,
  storyboardId,
  onRunCritic,
  onCreateBranch,
  onCherryPickCommit,
  onComputeLatestDiff,
  onSetBranchCutTier,
  onBumpBranchHeadReviewRound,
  variants,
  compareBranchIds,
  onToggleCompareBranch,
  onPromoteVariant,
  motifs,
  onFocusNode,
  shotNodes,
  onPlantMotif,
}: TimelineTheaterPanelProps) {
  const [cherryPickOpen, setCherryPickOpen] = useState(false);
  const rows = simulationRuns.slice(0, 6);
  const defaultBranch = branches.find((branch) => branch.isDefault) ?? null;
  const branchRows = branches.slice(0, 6);
  const commitRows = commits.slice(0, 6);

  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-950/95 text-zinc-100 p-4">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-[11px] uppercase tracking-wide text-zinc-400">Timeline Theater</p>
          <h3 className="mt-1 text-sm font-semibold">Simulation Critic</h3>
        </div>
        <button
          type="button"
          className="rounded bg-zinc-800 px-2 py-1 text-xs"
          onClick={() => void onRunCritic()}
        >
          Run Critic
        </button>
      </div>
      <div className="mt-2 flex gap-2">
        <button
          type="button"
          className="rounded bg-blue-700 px-2 py-1 text-[10px]"
          onClick={() => void onCreateBranch()}
        >
          Create Branch
        </button>
        <button
          type="button"
          className="rounded bg-violet-700 px-2 py-1 text-[10px]"
          onClick={() => setCherryPickOpen(true)}
        >
          Cherry-pick…
        </button>
        <button
          type="button"
          className="rounded bg-zinc-800 px-2 py-1 text-[10px]"
          onClick={() => void onComputeLatestDiff()}
        >
          Compute Diff
        </button>
      </div>
      <p className="mt-2 text-[11px] text-zinc-500">
        Branches: {branches.length} • Commits: {commits.length}
      </p>

      {branchRows.length > 0 ? (
        <div className="mt-3 space-y-1.5">
          <p className="text-[10px] uppercase tracking-wide text-zinc-500">Branches</p>
          {branchRows.map((branch) => {
            const tier = branch.cutTier;
            const tone = tier ? getTierTone(tier) : null;
            const label = tier ? CUT_TIER_LABELS[tier] : "No tier";
            const nextTier = nextCutTier(tier);
            const promoteDisabled = !nextTier || !onSetBranchCutTier;
            return (
              <div
                key={branch._id}
                className="flex items-center gap-2 rounded border border-zinc-800 px-2 py-1"
              >
                <span className="truncate text-[11px] font-medium">
                  {branch.name}
                  {branch.isDefault ? (
                    <span className="ml-1 text-[10px] text-zinc-500">(default)</span>
                  ) : null}
                </span>
                <span
                  className={
                    "ml-auto rounded-full border px-1.5 py-0.5 text-[10px] " +
                    (tone ? TONE_CLASSES[tone] : "border-zinc-700 text-zinc-400")
                  }
                >
                  {label}
                </span>
                <button
                  type="button"
                  disabled={promoteDisabled}
                  title={nextTier ? `Promote to ${CUT_TIER_LABELS[nextTier]}` : "At top tier"}
                  className="inline-flex items-center gap-1 rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-200 disabled:opacity-40"
                  onClick={() => {
                    if (!onSetBranchCutTier || !nextTier) return;
                    void onSetBranchCutTier(branch.branchId, nextTier);
                  }}
                >
                  <ChevronsUp className="size-3" />
                  Promote
                </button>
              </div>
            );
          })}
        </div>
      ) : null}

      {commitRows.length > 0 ? (
        <div className="mt-3 space-y-1.5">
          <p className="text-[10px] uppercase tracking-wide text-zinc-500">Recent Commits</p>
          {commitRows.map((commit) => {
            const rLabel = formatReviewRound(commit.reviewRound);
            const isDefaultHead =
              !!defaultBranch
              && defaultBranch.headCommitId === commit.commitId
              && commit.branchId === defaultBranch.branchId;
            return (
              <div
                key={commit._id}
                className="flex items-center gap-2 rounded border border-zinc-800 px-2 py-1"
              >
                <span className="truncate text-[11px]">{commit.summary}</span>
                {rLabel ? (
                  <span className="ml-auto rounded-full border border-sky-500/40 bg-sky-500/10 px-1.5 py-0.5 text-[10px] text-sky-200">
                    {rLabel}
                  </span>
                ) : (
                  <span className="ml-auto text-[10px] text-zinc-600">—</span>
                )}
                {isDefaultHead && onBumpBranchHeadReviewRound ? (
                  <button
                    type="button"
                    className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-200"
                    onClick={() => {
                      void onBumpBranchHeadReviewRound(defaultBranch.branchId);
                    }}
                  >
                    Bump R#
                  </button>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}

      {rows.length === 0 ? (
        <p className="mt-2 text-[11px] text-zinc-400">No simulation runs yet.</p>
      ) : (
        <div className="mt-3 space-y-2 max-h-56 overflow-y-auto">
          {rows.map((row) => (
            <div key={row._id} className="rounded border border-zinc-800 p-2">
              <p className="text-xs font-medium">{row.summary}</p>
              <p className="text-[11px] text-zinc-400">
                {row.riskLevel.toUpperCase()} • confidence {row.confidence.toFixed(2)} • impact {row.impactScore.toFixed(2)}
              </p>
              <p className="text-[11px] text-zinc-500">
                {row.status} • {row.branchId}
              </p>
            </div>
          ))}
        </div>
      )}
      <CherryPickDialog
        open={cherryPickOpen}
        onOpenChange={setCherryPickOpen}
        storyboardId={storyboardId}
        branches={branches}
        onCherryPick={onCherryPickCommit}
      />

      {/* M9 Phase 3 — variant compare. Only renders when the parent
       *  page supplies variants; M8-era consumers see no change. */}
      {variants && onToggleCompareBranch && onPromoteVariant ? (
        <div className="mt-4">
          <VariantComparePanel
            variants={variants}
            branches={branches}
            compareBranchIds={compareBranchIds ?? []}
            onToggleCompareBranch={onToggleCompareBranch}
            onPromoteVariant={onPromoteVariant}
          />
        </div>
      ) : null}

      {/* M9 Phase 4/5 — motif map. MotifMapPanel returns null
       *  internally when both motifs is empty AND no plant form is
       *  wired; otherwise it renders even for an empty list (the
       *  form lets the producer seed the registry manually). */}
      {motifs && (motifs.length > 0 || (shotNodes && onPlantMotif)) ? (
        <div className="mt-4">
          <MotifMapPanel
            motifs={motifs}
            onFocusNode={onFocusNode}
            shotNodes={shotNodes}
            onPlantMotif={onPlantMotif}
          />
        </div>
      ) : null}
    </section>
  );
}
