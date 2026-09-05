"use client";

/**
 * M8 — reel-level score panel.
 *
 * Lets the producer attach a background music track to a storyboard.
 * Flow:
 *   1. Type a prompt, tune duration + volume
 *   2. Generate → POST /api/media/generate-score
 *   3. Persist: `mediaAssets:createMediaAsset` with `kind: "score"` +
 *      a sentinel nodeId (score isn't shot-scoped), then
 *      `storyboards:setStoryboardScore` to attach.
 *   4. Producer audits via the inline audio preview; volume slider
 *      patches `scoreVolumeDb` on the storyboard row live.
 *
 * Rendered inside the ReelPlayer dialog (above the export controls)
 * because the reel is where a producer would decide to scaffold a
 * music bed. A separate storyboard-level panel might eventually live
 * in the ProductionHubDrawer, but the ReelPlayer is the audition
 * surface — put the control where the audio is.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Music4, Wand2 } from "lucide-react";
import { useMutation, useQuery } from "convex/react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { mutationRef, queryRef } from "@/lib/convexRefs";
import {
  DEFAULT_SCORE_DURATION_S,
  DEFAULT_SCORE_VOLUME_DB,
  SCORE_MAX_DURATION_S,
  SCORE_MAX_VOLUME_DB,
  SCORE_MIN_DURATION_S,
  SCORE_MIN_VOLUME_DB,
  SCORE_PROMPT_MAX_CHARS,
} from "@/lib/score";

/** Sentinel nodeId for the mediaAssets row that backs the score.
 *  Score is storyboard-level (no real node to patch), so we pass a
 *  fixed string that the `createMediaAsset` node-patch step will
 *  silently skip (the lookup returns null and the function early-
 *  outs on patching). */
const SCORE_NODE_SENTINEL = "__score__";

interface ReelScorePanelProps {
  storyboardId: string;
  /** Usually the reel's `totalDurationS` — prefilled so the score
   *  matches the reel's length. Producer can override in the input. */
  reelDurationS: number;
  /** Disable controls while another export / generate is in flight. */
  disabled?: boolean;
}

interface StoryboardScore {
  mediaAssetId: string;
  sourceUrl: string;
  prompt: string;
  modelId: string;
  volumeDb: number | null;
  durationS: number | null;
}

export function ReelScorePanel({
  storyboardId,
  reelDurationS,
  disabled,
}: ReelScorePanelProps) {
  // Read the currently-attached score reactively. When `generate`
  // completes + `setStoryboardScore` fires, this query updates and
  // the UI renders the preview without any local cache synchronization.
  const score = useQuery(
    queryRef("storyboards:getStoryboardScore"),
    storyboardId ? { storyboardId: storyboardId as never } : "skip",
  ) as StoryboardScore | null | undefined;

  const createMediaAsset = useMutation(
    mutationRef("mediaAssets:createMediaAsset"),
  );
  const setStoryboardScore = useMutation(
    mutationRef("storyboards:setStoryboardScore"),
  );

  const [prompt, setPrompt] = useState("");
  const [durationS, setDurationS] = useState<number>(() =>
    clampDuration(reelDurationS || DEFAULT_SCORE_DURATION_S),
  );
  const [volumeDb, setVolumeDb] = useState<number>(DEFAULT_SCORE_VOLUME_DB);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Sync slider to server value whenever the active score changes so
  // two clients agree. Only fires on activeScoreId / volumeDb deltas
  // — slider drags are purely local.
  useEffect(() => {
    if (score && typeof score.volumeDb === "number") {
      setVolumeDb(score.volumeDb);
    }
  }, [score?.mediaAssetId, score?.volumeDb]);

  // When the dialog opens and the reel duration changes, keep the
  // input in sync UNLESS the producer has already adjusted it (the
  // draft duration differs from the clamped reel duration). We detect
  // "producer touched it" by comparing the current value to the last
  // computed default.
  const defaultDurationFromReel = useMemo(
    () => clampDuration(reelDurationS || DEFAULT_SCORE_DURATION_S),
    [reelDurationS],
  );
  const lastComputedDefaultRef = useRef(defaultDurationFromReel);
  useEffect(() => {
    if (lastComputedDefaultRef.current === durationS) {
      setDurationS(defaultDurationFromReel);
    }
    lastComputedDefaultRef.current = defaultDurationFromReel;
  }, [defaultDurationFromReel, durationS]);

  const handleGenerate = async () => {
    if (!prompt.trim()) {
      setError("Describe the music you want first.");
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const res = await fetch("/api/media/generate-score", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: prompt.trim(),
          durationS,
          volumeDb,
          storyboardId,
        }),
      });
      if (!res.ok) {
        const payload = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(
          payload.error ?? `Score generation failed (${res.status})`,
        );
      }
      const data = (await res.json()) as {
        url: string;
        provider: string;
      };
      // Persist as a mediaAsset with kind="score"; sentinel nodeId
      // keeps the function happy without a real storyboard node.
      const mediaAssetId = (await createMediaAsset({
        storyboardId: storyboardId as never,
        nodeId: SCORE_NODE_SENTINEL,
        kind: "score",
        sourceUrl: data.url,
        modelId: data.provider,
        prompt: prompt.trim(),
        status: "completed",
        metadata: {
          durationS: String(durationS),
          volumeDb: String(volumeDb),
        },
      })) as string;
      // Attach to the storyboard + record the producer's volume.
      await setStoryboardScore({
        storyboardId: storyboardId as never,
        mediaAssetId: mediaAssetId as never,
        volumeDb,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleVolumeChange = async (next: number) => {
    setVolumeDb(next);
    if (!score) return;
    try {
      await setStoryboardScore({
        storyboardId: storyboardId as never,
        mediaAssetId: score.mediaAssetId as never,
        volumeDb: next,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save volume.");
    }
  };

  const handleDetach = async () => {
    if (!score) return;
    setBusy(true);
    try {
      await setStoryboardScore({
        storyboardId: storyboardId as never,
        mediaAssetId: null,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to detach score.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-md border border-border/40 bg-background/60 p-2">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          <Music4 className="size-3.5" />
          Score
        </div>
        <span
          className={cn(
            "rounded-full border px-2 py-0.5 text-[10px]",
            score
              ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-200"
              : "border-border/60 bg-background/60 text-muted-foreground",
          )}
        >
          {score ? "attached" : "none"}
        </span>
      </div>
      <p className="mt-1 text-[10px] text-muted-foreground">
        Background music mixed UNDER narration + SFX in the final reel.
      </p>
      <Textarea
        value={prompt}
        onChange={(e) =>
          setPrompt(e.target.value.slice(0, SCORE_PROMPT_MAX_CHARS))
        }
        placeholder={
          score
            ? `Current: "${score.prompt.slice(0, 120)}"${score.prompt.length > 120 ? "…" : ""}. Write a new prompt to replace.`
            : 'e.g. "somber piano underscore, 80 BPM, sparse strings"'
        }
        disabled={disabled || busy}
        className="mt-2 min-h-[56px] bg-background/60 text-[11px]"
        maxLength={SCORE_PROMPT_MAX_CHARS}
      />
      <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px]">
        <label className="flex items-center gap-1 text-muted-foreground">
          Duration
          <input
            type="number"
            min={SCORE_MIN_DURATION_S}
            max={SCORE_MAX_DURATION_S}
            step={1}
            value={durationS}
            onChange={(e) =>
              setDurationS(clampDuration(Number(e.target.value)))
            }
            disabled={disabled || busy}
            className="h-6 w-16 rounded border border-border/60 bg-background/60 px-1.5 text-[11px]"
          />
          s
        </label>
        <label className="flex items-center gap-1 text-muted-foreground">
          Volume
          <input
            type="range"
            min={SCORE_MIN_VOLUME_DB}
            max={SCORE_MAX_VOLUME_DB}
            step={1}
            value={volumeDb}
            onChange={(e) =>
              void handleVolumeChange(
                Math.max(
                  SCORE_MIN_VOLUME_DB,
                  Math.min(
                    SCORE_MAX_VOLUME_DB,
                    Number(e.target.value) || DEFAULT_SCORE_VOLUME_DB,
                  ),
                ),
              )
            }
            disabled={disabled || busy}
            className="h-4 w-24 accent-emerald-500"
          />
          <span className="w-10 tabular-nums text-right">{volumeDb} dB</span>
        </label>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => void handleGenerate()}
          disabled={disabled || busy || prompt.trim().length === 0}
          className="gap-1.5"
        >
          {busy ? (
            <>
              <span className="size-3 animate-spin rounded-full border-2 border-current/30 border-t-current" />
              Generating…
            </>
          ) : (
            <>
              <Wand2 className="size-3.5" />
              {score ? "Regenerate" : "Generate"}
            </>
          )}
        </Button>
        {score ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => void handleDetach()}
            disabled={disabled || busy}
            className="text-[10px] text-muted-foreground hover:text-rose-400"
          >
            Detach
          </Button>
        ) : null}
      </div>
      {score?.sourceUrl ? (
        <audio
          src={score.sourceUrl}
          controls
          preload="none"
          className="mt-2 w-full"
        />
      ) : null}
      {/* M8 follow-up — historical takes. Producers iterate score
          prompts and want to swap between variants without regenerating;
          mirrors the SFX variants list in PropertiesPanel. */}
      <ScoreVariantsList
        storyboardId={storyboardId}
        activeMediaAssetId={score?.mediaAssetId ?? null}
        disabled={disabled || busy}
      />
      {error ? (
        <p className="mt-2 text-[10px] text-rose-400" title={error}>
          {error}
        </p>
      ) : null}
    </div>
  );
}

interface ScoreVariantsListProps {
  storyboardId: string;
  activeMediaAssetId: string | null;
  disabled?: boolean;
}

/**
 * Lists every `kind: "score"` mediaAsset for this storyboard. Uses the
 * sentinel `__score__` nodeId we consistently stamp on score rows when
 * creating them, so one `listNodeMedia` query returns the full history
 * without a separate storyboard-scoped endpoint.
 */
function ScoreVariantsList({
  storyboardId,
  activeMediaAssetId,
  disabled,
}: ScoreVariantsListProps) {
  const variants = useQuery(queryRef("mediaAssets:listNodeMedia"), {
    storyboardId: storyboardId as never,
    nodeId: SCORE_NODE_SENTINEL,
    kind: "score",
    limit: 20,
  }) as
    | Array<{
        _id: string;
        sourceUrl: string;
        prompt: string;
        status: "pending" | "completed" | "failed" | "rolled_back";
        createdAt: number;
      }>
    | undefined;
  const setStoryboardScore = useMutation(
    mutationRef("storyboards:setStoryboardScore"),
  );
  const [switching, setSwitching] = useState<string | null>(null);

  const completed = useMemo(
    () => (variants ?? []).filter((v) => v.status === "completed"),
    [variants],
  );

  if (completed.length <= 1) return null;

  const handleActivate = async (mediaAssetId: string) => {
    if (disabled || switching || mediaAssetId === activeMediaAssetId) return;
    setSwitching(mediaAssetId);
    try {
      // Preserve the existing volumeDb when swapping — the producer's
      // trim should survive a variant switch. The mutation clamps +
      // stores it alongside the new asset.
      await setStoryboardScore({
        storyboardId: storyboardId as never,
        mediaAssetId: mediaAssetId as never,
      });
    } finally {
      setSwitching(null);
    }
  };

  return (
    <details className="mt-2 rounded border border-border/40 bg-background/30 p-2 text-[11px]">
      <summary className="cursor-pointer text-muted-foreground">
        Previous takes ({completed.length})
      </summary>
      <ul className="mt-2 space-y-1.5">
        {completed.map((variant) => {
          const isActive = variant._id === activeMediaAssetId;
          const isSwitching = switching === variant._id;
          return (
            <li
              key={variant._id}
              className={cn(
                "flex items-center gap-2 rounded border px-1.5 py-1",
                isActive
                  ? "border-emerald-500/40 bg-emerald-500/5"
                  : "border-border/40 bg-background/40",
              )}
            >
              <button
                type="button"
                onClick={() => void handleActivate(variant._id)}
                disabled={disabled || isActive || isSwitching}
                className={cn(
                  "shrink-0 rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide",
                  isActive
                    ? "bg-emerald-500/20 text-emerald-200"
                    : "border border-border/60 bg-background/60 hover:bg-background/80 disabled:opacity-40",
                )}
                title={
                  isActive
                    ? "This take is already the active score."
                    : "Make this take the storyboard's active score."
                }
              >
                {isActive ? "active" : isSwitching ? "…" : "use"}
              </button>
              <span
                className="min-w-0 flex-1 truncate text-muted-foreground"
                title={variant.prompt}
              >
                {variant.prompt || "(no prompt)"}
              </span>
              <audio
                src={variant.sourceUrl}
                controls
                preload="none"
                className="h-6 max-w-[140px]"
              />
            </li>
          );
        })}
      </ul>
    </details>
  );
}

function clampDuration(raw: number): number {
  if (!Number.isFinite(raw)) return DEFAULT_SCORE_DURATION_S;
  return Math.max(
    SCORE_MIN_DURATION_S,
    Math.min(SCORE_MAX_DURATION_S, Math.round(raw)),
  );
}
