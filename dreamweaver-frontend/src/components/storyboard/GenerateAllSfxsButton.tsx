"use client";

/**
 * M7 — batch-generate ambient / foley SFX for every shot.
 *
 * Mirrors `GenerateAllAudiosButton`: same progress grid, same SSE
 * subscription, same agent-trigger event plumbing. Distinct button so
 * producers can run narration + SFX independently (both are cheap and
 * can run in parallel on separate providers).
 */

import React, { useEffect } from "react";
import { Music } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useShotBatchStream, type ShotBatchPhase } from "@/lib/sse-ingest";
import {
  SHOT_SFX_BATCH_TRIGGER_EVENT,
  type ShotSfxBatchTriggerDetail,
} from "@/components/storyboard/StoryboardCopilotBridge";

interface GenerateAllSfxsButtonProps {
  storyboardId: string;
  disabled?: boolean;
}

const PHASE_CLASS: Record<ShotBatchPhase, string> = {
  queued: "bg-muted/40 border-border/40",
  running: "bg-amber-500/40 border-amber-500 animate-pulse",
  succeeded: "bg-emerald-500/60 border-emerald-500",
  failed: "bg-rose-500/60 border-rose-500",
  skipped: "bg-slate-500/40 border-slate-500/60",
};

export function GenerateAllSfxsButton({
  storyboardId,
  disabled,
}: GenerateAllSfxsButtonProps) {
  const { state, start } = useShotBatchStream();

  const run = async () => {
    if (!storyboardId) return;
    await start({
      storyboardId,
      skipExisting: true,
      concurrency: 3,
      mode: "sfx",
    });
  };

  // Agent HITL dispatches a CustomEvent on approve; we listen here so
  // the button behaves identically whether the producer clicked it or
  // the agent approved a batch via the copilot.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<ShotSfxBatchTriggerDetail>).detail;
      if (!detail) return;
      if (detail.storyboardId && detail.storyboardId !== storyboardId) return;
      if (state.kind === "running") return;
      void start({
        storyboardId,
        skipExisting: detail.skipExisting ?? true,
        concurrency: Math.max(1, Math.min(5, detail.concurrency ?? 3)),
        mode: "sfx",
      });
    };
    window.addEventListener(SHOT_SFX_BATCH_TRIGGER_EVENT, handler);
    return () =>
      window.removeEventListener(SHOT_SFX_BATCH_TRIGGER_EVENT, handler);
  }, [start, state.kind, storyboardId]);

  const isBusy = state.kind === "running";
  const isDisabled = disabled || !storyboardId || isBusy;

  const elapsedSec = Math.floor(state.elapsedMs / 1000);
  const doneCount =
    state.counts.succeeded + state.counts.failed + state.counts.skipped;

  return (
    <div className="flex flex-col gap-1">
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-7 gap-1.5 px-2 text-[11px]"
        onClick={() => void run()}
        disabled={isDisabled}
        title={
          isBusy
            ? "SFX batch running…"
            : "Generate ambient/foley SFX for every shot (ElevenLabs Sound Effects)"
        }
      >
        <Music className="size-3.5" />
        {isBusy
          ? `SFX ${doneCount}/${state.total} · ${elapsedSec}s`
          : "Gen all SFX"}
      </Button>
      {/* Per-shot progress grid. One tile per shot in the batch so
          producers see which shot is stuck or failing. */}
      {state.kind !== "idle" && state.rows.length > 0 ? (
        <div className="flex flex-wrap gap-0.5">
          {state.rows.map((row) => (
            <div
              key={row.index}
              className={
                "size-1.5 rounded-sm border " + PHASE_CLASS[row.phase]
              }
              title={
                row.phase === "failed"
                  ? `Shot ${row.index + 1}: ${row.error ?? "failed"}`
                  : row.phase === "skipped"
                    ? `Shot ${row.index + 1}: ${row.reason ?? "skipped"}`
                    : `Shot ${row.index + 1}: ${row.phase}`
              }
            />
          ))}
        </div>
      ) : null}
      {state.kind === "error" && state.error ? (
        <p
          className="text-[10px] text-rose-400 max-w-[200px] truncate"
          title={state.error}
        >
          {state.error}
        </p>
      ) : null}
    </div>
  );
}
