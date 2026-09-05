"use client";

/**
 * M9 Phase 3 — Variant Compare panel.
 *
 * Lists narrative variants (hook / remix / transition / structural)
 * grouped by type, lets the producer toggle "A/B compare" with the
 * active branch via `onTogglePair`, and promotes a winner via
 * `onPromoteWinner` (which calls `applyMergePolicy` under the hood and
 * archives the siblings).
 *
 * Why a side-panel and not a modal: producers live in Timeline Theater
 * during review; swapping between "run critic" / "see variants" / "pick
 * a winner" must be cheap, not a context switch. The panel is passive
 * when no variants exist, so this component adds zero pixels of chrome
 * for storyboards that never invoked a variant tool.
 */

import { useMemo } from "react";
import { CheckCircle2, PlayCircle, Trophy } from "lucide-react";
import type {
  NarrativeBranchRecord,
  NarrativeVariantRecord,
} from "@/app/storyboard/types";

type VariantComparePanelProps = {
  variants: NarrativeVariantRecord[];
  branches: NarrativeBranchRecord[];
  /** branchIds currently pinned into the ReelPlayer compare pair. */
  compareBranchIds: string[];
  /** Toggle a variant branch in/out of the compare pair. Max pair
   *  size of 2 is enforced here — adding a third replaces the oldest. */
  onToggleCompareBranch: (branchId: string) => void;
  /** Promote a variant branch to primary via applyMergePolicy; parent
   *  defaults to the active branch ("main"). The parent component is
   *  responsible for archiving sibling variants + recording the pick. */
  onPromoteVariant: (variant: NarrativeVariantRecord) => Promise<void>;
};

const TYPE_LABELS: Record<NarrativeVariantRecord["variantType"], string> = {
  hook: "Cold-open hooks",
  structural: "Structural alternates",
  remix: "Beat remixes",
  transition: "Transition variants",
};

const TYPE_BADGE: Record<NarrativeVariantRecord["variantType"], string> = {
  hook: "bg-amber-500/15 text-amber-200 border-amber-500/40",
  structural: "bg-violet-500/15 text-violet-200 border-violet-500/40",
  remix: "bg-sky-500/15 text-sky-200 border-sky-500/40",
  transition: "bg-emerald-500/15 text-emerald-200 border-emerald-500/40",
};

export function VariantComparePanel({
  variants,
  branches,
  compareBranchIds,
  onToggleCompareBranch,
  onPromoteVariant,
}: VariantComparePanelProps) {
  const branchByBranchId = useMemo(() => {
    const map = new Map<string, NarrativeBranchRecord>();
    for (const branch of branches) {
      map.set(branch.branchId, branch);
    }
    return map;
  }, [branches]);

  // Hide archived variants' branches — applyMergePolicy sets
  // status="archived" on the losing sibling; it stays available in git
  // history but should not clutter Variant Compare after a promotion.
  const visibleVariants = useMemo(
    () =>
      variants.filter((variant) => {
        const branch = branchByBranchId.get(variant.branchId);
        return !branch || branch.status !== "archived";
      }),
    [variants, branchByBranchId],
  );

  const grouped = useMemo(() => {
    const map = new Map<
      NarrativeVariantRecord["variantType"],
      NarrativeVariantRecord[]
    >();
    for (const variant of visibleVariants) {
      const list = map.get(variant.variantType) ?? [];
      list.push(variant);
      map.set(variant.variantType, list);
    }
    return map;
  }, [visibleVariants]);

  if (visibleVariants.length === 0) {
    return (
      <section
        aria-label="Variant compare"
        className="rounded-xl border border-zinc-800 bg-zinc-950/95 p-4 text-zinc-100"
      >
        <p className="text-[11px] uppercase tracking-wide text-zinc-400">
          Variant Compare
        </p>
        <p className="mt-1 text-xs text-zinc-400">
          No narrative variants yet. Ask the agent for{" "}
          <span className="font-mono text-zinc-300">
            3 cold-open variants
          </span>{" "}
          or{" "}
          <span className="font-mono text-zinc-300">
            a structural remix
          </span>{" "}
          to populate this panel.
        </p>
      </section>
    );
  }

  return (
    <section
      aria-label="Variant compare"
      className="rounded-xl border border-zinc-800 bg-zinc-950/95 p-4 text-zinc-100"
    >
      <div className="flex items-center justify-between">
        <div>
          <p className="text-[11px] uppercase tracking-wide text-zinc-400">
            Variant Compare
          </p>
          <h3 className="mt-1 text-sm font-semibold">
            {visibleVariants.length} candidate
            {visibleVariants.length === 1 ? "" : "s"}
          </h3>
        </div>
        <p className="text-[11px] text-zinc-500">
          {compareBranchIds.length > 0
            ? `Comparing ${compareBranchIds.length} / 2 slots`
            : "Click ▶ on two variants to compare"}
        </p>
      </div>

      {Array.from(grouped.entries()).map(([variantType, list]) => (
        <div key={variantType} className="mt-3 space-y-1.5">
          <p className="text-[10px] uppercase tracking-wide text-zinc-500">
            {TYPE_LABELS[variantType] ?? variantType}
          </p>
          {list.map((variant) => {
            const branch = branchByBranchId.get(variant.branchId);
            const isComparing = compareBranchIds.includes(variant.branchId);
            const picked = variant.producerPicked;
            return (
              <div
                key={variant._id}
                className={`rounded border px-2 py-1.5 ${
                  picked
                    ? "border-emerald-500/60 bg-emerald-500/10"
                    : "border-zinc-800"
                }`}
              >
                <div className="flex items-center gap-2">
                  <span
                    className={`rounded-full border px-1.5 py-0.5 text-[10px] ${TYPE_BADGE[variantType] ?? ""}`}
                  >
                    {variantType}
                  </span>
                  <span className="truncate text-[11px] font-medium">
                    {branch?.name ?? variant.branchId}
                  </span>
                  {picked ? (
                    <span className="ml-auto inline-flex items-center gap-1 text-[10px] text-emerald-300">
                      <Trophy className="size-3" />
                      Primary
                    </span>
                  ) : (
                    <div className="ml-auto flex items-center gap-1">
                      <button
                        type="button"
                        className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] ${
                          isComparing
                            ? "bg-sky-600 text-white"
                            : "bg-zinc-800 text-zinc-200"
                        }`}
                        onClick={() =>
                          onToggleCompareBranch(variant.branchId)
                        }
                        title={
                          isComparing
                            ? "Remove from compare pair"
                            : "Add to compare pair"
                        }
                      >
                        <PlayCircle className="size-3" />
                        {isComparing ? "Comparing" : "Compare"}
                      </button>
                      <button
                        type="button"
                        className="inline-flex items-center gap-1 rounded bg-emerald-700 px-1.5 py-0.5 text-[10px] text-white"
                        onClick={() => void onPromoteVariant(variant)}
                        title="Merge this variant into main; archive siblings"
                      >
                        <CheckCircle2 className="size-3" />
                        Pick
                      </button>
                    </div>
                  )}
                </div>
                {variant.rationale ? (
                  <p className="mt-1 text-[11px] text-zinc-400 line-clamp-2">
                    {variant.rationale}
                  </p>
                ) : null}
              </div>
            );
          })}
        </div>
      ))}
    </section>
  );
}
