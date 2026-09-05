"use client";

/**
 * M5 #3 + #6 — reel preview + real mp4 export.
 *
 * Preview: Fetches a manifest of ordered shots + media URLs and plays
 * them back-to-back using a single <video> element (falling back to
 * <img> when a shot has no video). Audio tracks play in parallel on a
 * separate <audio> element, gated to the shot's declared duration so
 * narration doesn't bleed across cuts. Cheap, renders instantly, lets
 * producers iterate on pacing before committing to a real encode.
 *
 * Export: The "Export mp4" button POSTs to /api/storyboard/export-reel
 * which normalizes each shot through ffmpeg (uniform 1920x1080@30 with
 * audio overlay / still-frame loop / black-frame fallback) and concats
 * the result into a single mp4. Returns a Convex-storage URL the
 * producer can open or download.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { mutationRef } from "@/lib/convexRefs";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { AlertTriangle, Download, History, Pause, Play, SkipBack, SkipForward } from "lucide-react";
import type { ReelManifest, ReelShot } from "@/app/api/storyboard/reel-manifest/route";
import { GUARANTEED_BURN_IN_FONTS, subtitleOverlayCss } from "@/lib/subtitles";
import type { SubtitleCue, SubtitleStyle } from "@/lib/subtitles";
import { ReelScorePanel } from "@/components/storyboard/ReelScorePanel";
import { queryRef } from "@/lib/convexRefs";
import { useShotBatchStream } from "@/lib/sse-ingest";
import { Languages } from "lucide-react";

interface ReelExportRow {
  _id: string;
  storageId: string;
  sourceUrl: string;
  shotCount: number;
  totalDurationS: number;
  byteLength: number;
  title: string;
  createdAt: number;
}

export interface ReelPlayerProps {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  storyboardId: string;
  /**
   * M9 Phase 3 — variant compare pins.
   *
   * When non-empty, renders a "Comparing vs:" strip above the player
   * listing the pinned variant branches with per-branch commit
   * summaries. The producer uses this to remember which candidates
   * they're weighing while scrubbing the active branch.
   *
   * Synced dual-video playback (a second `<video>` element keyed to
   * the compare branch's manifest) is scaffolded-but-not-shipped in
   * M9: the reel-manifest endpoint resolves only the active branch
   * today, so a real second player needs a `getBranchReelManifest`
   * query that reconstructs shots from `narrativeCommits.snapshotJson`.
   * Deferred to M10 — the strip here is the entry point that will
   * become the second viewport.
   */
  compareBranchIds?: string[];
  /**
   * Optional branch catalog used to resolve `compareBranchIds` →
   * display names + head commit ids for the compare strip. Kept as a
   * plain array prop rather than a Convex hook so ReelPlayer stays
   * storyboard-agnostic in tests.
   */
  compareBranches?: Array<{
    branchId: string;
    name: string;
    headCommitId?: string;
  }>;
}

type PlayerStatus = "loading" | "ready" | "playing" | "paused" | "done" | "error";

export function ReelPlayer({
  open,
  onOpenChange,
  storyboardId,
  compareBranchIds,
  compareBranches,
}: ReelPlayerProps) {
  const [manifest, setManifest] = useState<ReelManifest | null>(null);
  const [status, setStatus] = useState<PlayerStatus>("loading");
  const [error, setError] = useState<string | null>(null);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [autoAdvanceAt, setAutoAdvanceAt] = useState<number | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [exportedUrl, setExportedUrl] = useState<string | null>(null);
  // When the server export returns 501 (ffmpeg not installed), we offer
  // a client-side fallback via ffmpeg.wasm. Label reflects which path
  // is currently running so the producer knows the wasm download is
  // happening (and why the first export after a page load is slower).
  const [exportStageLabel, setExportStageLabel] = useState<string | null>(null);
  // M7 — captions loaded when the dialog opens; overlay is computed
  // from absolute reel time (shot offset + in-shot time).
  const [subtitleCues, setSubtitleCues] = useState<SubtitleCue[]>([]);
  const [captionsEnabled, setCaptionsEnabled] = useState(true);
  // Tick of the current shot's playback, in seconds. Driven by
  // timeupdate on the video / audio element (whichever is active).
  const [shotElapsedS, setShotElapsedS] = useState(0);
  // M7 — burn-in captions into the exported mp4 when true. Only the
  // server ffmpeg path honors this; the wasm fallback always produces
  // a soft-subtitle mp4 with the .vtt shipped alongside.
  const [burnInSubtitles, setBurnInSubtitles] = useState(false);
  // M7 — producer-selectable target locale for subtitle downloads and
  // the in-browser overlay. Empty string = source language (no
  // translation); source-language preview is ALWAYS fetched so the
  // caption overlay updates live when a producer swaps locales.
  const [subtitleLocale, setSubtitleLocale] = useState("");
  // M8 follow-up — local dub-batch stream. Fires when the producer
  // clicks "Dub to <locale>" next to a non-source locale. Kept local
  // (not window-eventful) because the progress indicator only makes
  // sense inside the ReelPlayer dialog that initiated it.
  const dubBatch = useShotBatchStream();
  // Bump to force a manifest refetch. We nudge this when the dub
  // batch finishes so the player picks up the freshly-uploaded mp3s
  // without requiring the producer to close + reopen the dialog.
  const [manifestRefreshKey, setManifestRefreshKey] = useState(0);
  useEffect(() => {
    if (dubBatch.state.kind === "done") {
      setManifestRefreshKey((k) => k + 1);
    }
  }, [dubBatch.state.kind]);
  // M7 styling — only meaningful when burnInSubtitles is on. Defaults
  // reflect the in-browser overlay: bottom position, no box background,
  // white on black outline, ~24pt.
  const [subtitleStyle, setSubtitleStyle] = useState<SubtitleStyle>({
    fontSizePx: 24,
    position: "bottom",
    boxBackground: true,
    colorHex: "FFFFFF",
    outlineHex: "000000",
  });

  const generateUploadUrlMut = useMutation(
    mutationRef("storage:generateCameoUploadUrl"),
  );
  const getStorageUrlMut = useMutation(mutationRef("storage:getStorageUrl"));
  const recordReelExportMut = useMutation(
    mutationRef("reelExports:recordReelExport"),
  );
  // Past reel exports for this storyboard (newest first). Reactive — if
  // a second device / tab exports in parallel it shows up here too.
  const pastExports = useQuery(
    queryRef("reelExports:listReelExportsForStoryboard"),
    open && storyboardId
      ? { storyboardId: storyboardId as never, limit: 10 }
      : "skip",
  ) as ReelExportRow[] | undefined;
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  // M7 — second audio element for the SFX track. Kept separate from
  // `audioRef` (which plays the narration) so the producer can audition
  // the full mix at the trimmed volume without a server roundtrip.
  const sfxAudioRef = useRef<HTMLAudioElement | null>(null);
  // M8 — reel-level score audio element. Unlike narration + SFX which
  // restart per-shot, the score plays continuously across the whole
  // reel, so we only seek to 0 when the reel restarts from shot 0.
  const scoreAudioRef = useRef<HTMLAudioElement | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // M7 — fetch captions when the dialog opens OR when the producer
  // changes the target locale. Parallel to the manifest fetch since
  // neither depends on the other; the player renders fine with empty
  // cues (just no overlay).
  useEffect(() => {
    if (!open || !storyboardId) {
      setSubtitleCues([]);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const localeParam = subtitleLocale
          ? `&locale=${encodeURIComponent(subtitleLocale)}`
          : "";
        const res = await fetch(
          `/api/storyboard/subtitles?storyboardId=${encodeURIComponent(storyboardId)}&format=json${localeParam}`,
        );
        if (!res.ok) return;
        const data = (await res.json()) as { cues?: SubtitleCue[] };
        if (cancelled) return;
        setSubtitleCues(Array.isArray(data.cues) ? data.cues : []);
      } catch {
        // Silent — overlay is a nice-to-have, don't fail the player.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, storyboardId, subtitleLocale]);

  // Fetch the manifest when the dialog opens. Reset state on close.
  useEffect(() => {
    if (!open) {
      setManifest(null);
      setStatus("loading");
      setError(null);
      setCurrentIndex(0);
      setAutoAdvanceAt(null);
      setExporting(false);
      setExportError(null);
      setExportedUrl(null);
      setExportStageLabel(null);
      return;
    }
    let cancelled = false;
    (async () => {
      setStatus("loading");
      setError(null);
      try {
        // M8 — thread the locale through so the manifest resolves to
        // the dubbed narration mp3s when the producer picks a non-
        // source language. The subtitle overlay + the audio element
        // both drive from the same `subtitleLocale` state, so the
        // picker acts as a single "dub + caption" locale switch.
        const localeParam = subtitleLocale
          ? `&locale=${encodeURIComponent(subtitleLocale)}`
          : "";
        const res = await fetch(
          `/api/storyboard/reel-manifest?storyboardId=${encodeURIComponent(storyboardId)}${localeParam}`,
        );
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          throw new Error(text || `Failed to load reel (${res.status})`);
        }
        const data = (await res.json()) as ReelManifest;
        if (cancelled) return;
        setManifest(data);
        setStatus(data.shots.length > 0 ? "ready" : "error");
        if (data.shots.length === 0) {
          setError("This storyboard has no shots yet.");
        }
      } catch (err) {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
        setStatus("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, storyboardId, subtitleLocale, manifestRefreshKey]);

  const shot: ReelShot | null = useMemo(
    () => manifest?.shots[currentIndex] ?? null,
    [manifest, currentIndex],
  );

  // Clear any pending auto-advance timer between shots.
  const clearAdvance = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setAutoAdvanceAt(null);
  }, []);

  const advanceNext = useCallback(() => {
    if (!manifest) return;
    clearAdvance();
    const next = currentIndex + 1;
    if (next >= manifest.shots.length) {
      setStatus("done");
      return;
    }
    setCurrentIndex(next);
  }, [clearAdvance, currentIndex, manifest]);

  const advancePrev = useCallback(() => {
    if (!manifest) return;
    clearAdvance();
    const prev = Math.max(0, currentIndex - 1);
    setCurrentIndex(prev);
  }, [clearAdvance, currentIndex, manifest]);

  // Drive playback per shot: when `currentIndex` or `status` changes to
  // "playing", start the video / audio and arm an auto-advance timer
  // capped at the shot's declared duration so an audio clip longer than
  // the shot doesn't block the cut, and a stuck video doesn't freeze
  // the player.
  useEffect(() => {
    if (!shot || status !== "playing") {
      return;
    }
    const video = videoRef.current;
    const audio = audioRef.current;
    const sfxAudio = sfxAudioRef.current;

    if (video) {
      video.currentTime = 0;
      void video.play().catch(() => {
        // Browser may click autoplay; producer can click to advance manually.
      });
    }
    if (audio) {
      audio.currentTime = 0;
      void audio.play().catch(() => {
        /* ignore */
      });
    }
    if (sfxAudio) {
      // SFX volume is expressed in dB (-40..0); HTMLMediaElement.volume
      // is linear 0..1. The libass / ffmpeg amix pipeline uses dB too,
      // so the conversion `10^(dB/20)` keeps the in-browser preview
      // matched to what the exported reel will sound like.
      const vdb =
        typeof shot.sfxVolumeDb === "number" ? shot.sfxVolumeDb : -12;
      sfxAudio.volume = Math.max(
        0,
        Math.min(1, Math.pow(10, vdb / 20)),
      );
      sfxAudio.currentTime = 0;
      void sfxAudio.play().catch(() => {
        /* ignore */
      });
    }

    const hardDeadlineMs = shot.durationS * 1000 + 400; // 400ms grace
    const startedAt = Date.now();
    setAutoAdvanceAt(startedAt + hardDeadlineMs);
    timerRef.current = setTimeout(() => {
      advanceNext();
    }, hardDeadlineMs);

    return () => {
      if (video) video.pause();
      if (audio) audio.pause();
      if (sfxAudio) sfxAudio.pause();
      clearAdvance();
    };
  }, [advanceNext, clearAdvance, shot, status]);

  const handlePlayToggle = useCallback(() => {
    if (status === "done") {
      setCurrentIndex(0);
      setStatus("playing");
      return;
    }
    if (status === "playing") {
      setStatus("paused");
    } else {
      setStatus("playing");
    }
  }, [status]);

  // When the loaded video ends on its own (shorter than durationS), advance.
  const handleVideoEnded = useCallback(() => {
    if (status === "playing") {
      advanceNext();
    }
  }, [advanceNext, status]);

  const elapsedOffsetS = useMemo(() => {
    if (!manifest) return 0;
    return manifest.shots
      .slice(0, currentIndex)
      .reduce((sum, s) => sum + s.durationS, 0);
  }, [currentIndex, manifest]);

  // M7 — reset the shot-local clock when the active shot changes so the
  // caption overlay re-aligns with the new shot's cues.
  useEffect(() => {
    setShotElapsedS(0);
  }, [currentIndex]);

  // M8 — reel-level score playback. Independent of the per-shot
  // playback effect because the score plays continuously across shots.
  // When the producer restarts from shot 0, we also seek the score
  // back to 0 so the audition loops cleanly. Volume conversion
  // mirrors the SFX path (dB → linear gain).
  useEffect(() => {
    const el = scoreAudioRef.current;
    if (!el) return;
    if (status !== "playing") {
      el.pause();
      return;
    }
    const vdb =
      typeof manifest?.score?.volumeDb === "number"
        ? manifest.score.volumeDb
        : -18;
    el.volume = Math.max(0, Math.min(1, Math.pow(10, vdb / 20)));
    if (currentIndex === 0) {
      el.currentTime = 0;
    }
    void el.play().catch(() => {
      /* autoplay blocked; producer can click play to retry */
    });
  }, [status, currentIndex, manifest?.score?.volumeDb]);

  // Attach timeupdate listeners to the currently-mounted media elements.
  // Either the video or the audio element can drive the tick — we
  // prefer the video's clock since its frame rate is often smoother,
  // falling back to audio when the shot has no video (image + narration
  // shots). Polling via requestAnimationFrame would work too but adds
  // overhead; timeupdate fires often enough for caption timing.
  useEffect(() => {
    const video = videoRef.current;
    const audio = audioRef.current;
    const driver: HTMLMediaElement | null = video ?? audio;
    if (!driver) return;
    const onTime = () => setShotElapsedS(driver.currentTime);
    driver.addEventListener("timeupdate", onTime);
    return () => {
      driver.removeEventListener("timeupdate", onTime);
    };
  }, [shot]);

  // Absolute time on the reel in seconds. Used both by the caption
  // overlay and (in future) by the scrubber indicator.
  const reelTimeS = elapsedOffsetS + shotElapsedS;

  // M7 — pick the cue whose [startS, endS) contains the current reel
  // time. Cues are reel-ordered, so a linear scan is fine; we also
  // scope to cues belonging to the active shot's nodeId as a belt-and-
  // suspenders guard in case the reel and subtitle orderings ever
  // drift (e.g. a shot was hidden between fetches).
  const activeCue = useMemo<SubtitleCue | null>(() => {
    if (!captionsEnabled || subtitleCues.length === 0 || !shot) return null;
    for (const cue of subtitleCues) {
      if (cue.nodeId !== shot.nodeId) continue;
      if (reelTimeS >= cue.startS && reelTimeS < cue.endS) {
        return cue;
      }
    }
    return null;
  }, [captionsEnabled, reelTimeS, shot, subtitleCues]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>
            {manifest ? `Reel — ${manifest.title}` : "Reel"}
          </DialogTitle>
          <DialogDescription>
            Sequential preview of every shot. Audio tracks (if any) play in
            parallel and each shot auto-advances at its declared duration.
          </DialogDescription>
        </DialogHeader>

        {/* M9 Phase 3 — variant compare strip. See ReelPlayerProps
         *  JSDoc: the strip is the UX anchor for variant comparison in
         *  M9; dual-video playback keyed to the compare branch is M10
         *  scope (requires getBranchReelManifest). */}
        {compareBranchIds && compareBranchIds.length > 0 ? (
          <div className="mt-1 rounded-md border border-sky-500/40 bg-sky-500/10 px-3 py-2 text-[11px] text-sky-200">
            <p className="font-semibold">
              Comparing vs {compareBranchIds.length} variant
              {compareBranchIds.length === 1 ? "" : "s"}
            </p>
            <ul className="mt-1 space-y-0.5">
              {compareBranchIds.map((branchId) => {
                const meta = (compareBranches ?? []).find(
                  (b) => b.branchId === branchId,
                );
                return (
                  <li key={branchId} className="truncate">
                    <span className="font-mono text-sky-100">{branchId}</span>
                    {meta?.name ? (
                      <span className="text-sky-300"> — {meta.name}</span>
                    ) : null}
                    {meta?.headCommitId ? (
                      <span className="text-sky-500">
                        {" "}
                        · head {meta.headCommitId.slice(0, 8)}
                      </span>
                    ) : null}
                  </li>
                );
              })}
            </ul>
            <p className="mt-1 text-sky-400">
              Active branch playing below. Synced dual-video playback
              arrives in M10; for now, pick a winner in Variant Compare
              to promote via applyMergePolicy.
            </p>
          </div>
        ) : null}

        {status === "loading" ? (
          <div className="flex h-48 items-center justify-center text-sm text-muted-foreground">
            Building manifest…
          </div>
        ) : status === "error" ? (
          <div className="rounded-md border border-rose-500/40 bg-rose-500/10 px-3 py-4 text-[12px] text-rose-200">
            {error ?? "Failed to build reel."}
          </div>
        ) : manifest && shot ? (
          <div className="flex flex-col gap-3">
            <div className="relative aspect-video w-full overflow-hidden rounded-md bg-black">
              {shot.videoUrl ? (
                <video
                  ref={videoRef}
                  src={shot.videoUrl}
                  // Muted so the <audio> narration wins when both exist.
                  muted={Boolean(shot.audioUrl)}
                  playsInline
                  onEnded={handleVideoEnded}
                  className="h-full w-full object-contain"
                />
              ) : shot.imageUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={shot.imageUrl}
                  alt={shot.label}
                  className="h-full w-full object-contain"
                />
              ) : (
                <div className="flex h-full items-center justify-center text-[12px] text-muted-foreground">
                  No media for this shot yet.
                </div>
              )}
              {shot.audioUrl ? (
                <audio ref={audioRef} src={shot.audioUrl} preload="auto" />
              ) : null}
              {/* M7 — SFX layer. Rendered as a hidden <audio>; its
                  `volume` is set from the shot's `sfxVolumeDb`
                  metadata in the playback effect above, so producers
                  preview the mix at the dB they'll ship. */}
              {shot.sfxUrl ? (
                <audio
                  ref={sfxAudioRef}
                  src={shot.sfxUrl}
                  preload="auto"
                />
              ) : null}
              {/* M8 — score layer. Plays continuously across shots
                  (see the score-playback effect above). Mounted once
                  per reel, not per shot, so swapping shots doesn't
                  restart the music. */}
              {manifest?.score?.url ? (
                <audio
                  key={manifest.score.url}
                  ref={scoreAudioRef}
                  src={manifest.score.url}
                  preload="auto"
                />
              ) : null}

              {/* M7 — caption overlay. When burn-in is enabled, mirror
                   the libass style choices (position, font size, color,
                   outline, box bg) so producers preview their output
                   faithfully. When burn-in is off, the overlay uses a
                   safe default styling — producers can still read the
                   source/translated text without seeing preview-only
                   decoration. */}
              {activeCue ? (() => {
                const css = burnInSubtitles
                  ? subtitleOverlayCss(subtitleStyle)
                  : subtitleOverlayCss({
                      position: "bottom",
                      fontSizePx: 26,
                      colorHex: "FFFFFF",
                      outlineHex: "000000",
                      outlineWidthPx: 2,
                      boxBackground: true,
                    });
                return (
                  <div
                    style={
                      css.container as unknown as React.CSSProperties
                    }
                  >
                    <p
                      style={css.text as unknown as React.CSSProperties}
                      data-testid="reel-caption"
                    >
                      {activeCue.text}
                    </p>
                  </div>
                );
              })() : null}

              <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-end justify-between bg-gradient-to-t from-black/70 via-black/30 to-transparent p-3 text-[11px] text-white">
                <span>
                  {shot.number ? `#${shot.number}` : `Shot ${currentIndex + 1}`} · {shot.label}
                </span>
                <span className="tabular-nums">
                  {elapsedOffsetS.toFixed(1)}s / {manifest.totalDurationS.toFixed(1)}s
                </span>
              </div>
            </div>

            {/* Per-shot progress strip */}
            <div className="flex gap-0.5">
              {manifest.shots.map((s, i) => (
                <div
                  key={s.nodeId}
                  className={
                    i === currentIndex
                      ? "h-1 flex-1 rounded-full bg-primary"
                      : i < currentIndex
                        ? "h-1 flex-1 rounded-full bg-primary/50"
                        : "h-1 flex-1 rounded-full bg-muted"
                  }
                  title={`Shot ${i + 1}: ${s.label}`}
                />
              ))}
            </div>

            <div className="flex items-center justify-between gap-3">
              <div className="text-[11px] text-muted-foreground">
                {currentIndex + 1} / {manifest.shots.length}
                {shot.videoUrl
                  ? " · video"
                  : shot.imageUrl
                    ? " · still image"
                    : " · empty"}
                {shot.audioUrl ? " · narration" : ""}
              </div>
              <div className="flex items-center gap-1.5">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={advancePrev}
                  disabled={currentIndex === 0}
                  aria-label="Previous shot"
                >
                  <SkipBack className="size-4" />
                </Button>
                <Button
                  type="button"
                  size="sm"
                  onClick={handlePlayToggle}
                  className="gap-1.5"
                >
                  {status === "playing" ? (
                    <>
                      <Pause className="size-4" />
                      Pause
                    </>
                  ) : status === "done" ? (
                    <>
                      <Play className="size-4" />
                      Replay
                    </>
                  ) : (
                    <>
                      <Play className="size-4" />
                      Play
                    </>
                  )}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={advanceNext}
                  disabled={currentIndex >= manifest.shots.length - 1}
                  aria-label="Next shot"
                >
                  <SkipForward className="size-4" />
                </Button>
              </div>
            </div>

            {autoAdvanceAt !== null && status === "playing" ? (
              <div className="text-[10px] tabular-nums text-muted-foreground">
                Auto-advancing at {shot.durationS.toFixed(1)}s
              </div>
            ) : null}

            {/* M8 — reel-level score panel. Mounted above the export
                controls so producers audition music before rendering
                the final mp4. */}
            {manifest && manifest.shots.length > 0 ? (
              <ReelScorePanel
                storyboardId={storyboardId}
                reelDurationS={manifest.totalDurationS}
                disabled={exporting}
              />
            ) : null}

            {/* M5 #6 — server-side mp4 export */}
            <div className="mt-1 flex items-center justify-between gap-3 border-t border-border/60 pt-2">
              <div className="flex flex-col gap-1 text-[11px] text-muted-foreground">
                {exportedUrl ? (
                  <span>
                    Exported — <a
                      href={exportedUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="underline hover:text-foreground"
                    >
                      open mp4
                    </a>
                  </span>
                ) : exporting ? (
                  <span>{exportStageLabel ?? "Encoding reel…"}</span>
                ) : (
                  <span>
                    Export concatenates every shot into a single mp4.
                    Uses server ffmpeg when available, ffmpeg.wasm
                    otherwise.
                  </span>
                )}
                {/* M7 — burn-in captions toggle. Only honored by the
                    server ffmpeg path; the wasm fallback always ships
                    a soft-subtitle mp4 (captions are downloadable via
                    the .vtt/.srt links below). Disabled while an export
                    is running so the flag can't flip mid-pass. */}
                {subtitleCues.length > 0 ? (
                  <div className="flex flex-col gap-1">
                    <label className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                      <input
                        type="checkbox"
                        checked={burnInSubtitles}
                        onChange={(e) =>
                          setBurnInSubtitles(e.target.checked)
                        }
                        disabled={exporting}
                        className="size-3"
                      />
                      Burn in captions (server path only)
                    </label>
                    {burnInSubtitles ? (
                      <div className="flex flex-wrap items-center gap-2 pl-5 text-[10px] text-muted-foreground">
                        {/* Font family — picks from the guaranteed set
                            (installed in SUBTITLE_FONTS_DIR on the host). */}
                        <label className="flex items-center gap-1">
                          Font:
                          <select
                            value={subtitleStyle.fontFamily ?? "Inter"}
                            onChange={(e) =>
                              setSubtitleStyle((prev) => ({
                                ...prev,
                                fontFamily: e.target.value,
                              }))
                            }
                            disabled={exporting}
                            className="rounded border border-zinc-700 bg-zinc-900 px-1 py-0.5 text-[10px] text-zinc-200"
                          >
                            {GUARANTEED_BURN_IN_FONTS.map((f) => (
                              <option key={f} value={f}>
                                {f}
                              </option>
                            ))}
                          </select>
                        </label>
                        {/* Position */}
                        <label className="flex items-center gap-1">
                          Pos:
                          <select
                            value={subtitleStyle.position ?? "bottom"}
                            onChange={(e) =>
                              setSubtitleStyle((prev) => ({
                                ...prev,
                                position: e.target.value as SubtitleStyle["position"],
                              }))
                            }
                            disabled={exporting}
                            className="rounded border border-zinc-700 bg-zinc-900 px-1 py-0.5 text-[10px] text-zinc-200"
                          >
                            <option value="bottom">bottom</option>
                            <option value="middle">middle</option>
                            <option value="top">top</option>
                          </select>
                        </label>
                        {/* Font size */}
                        <label className="flex items-center gap-1">
                          Size:
                          <input
                            type="number"
                            min={12}
                            max={72}
                            step={1}
                            value={subtitleStyle.fontSizePx ?? 24}
                            onChange={(e) =>
                              setSubtitleStyle((prev) => ({
                                ...prev,
                                fontSizePx: Math.max(
                                  12,
                                  Math.min(72, Number(e.target.value) || 24),
                                ),
                              }))
                            }
                            disabled={exporting}
                            className="w-12 rounded border border-zinc-700 bg-zinc-900 px-1 py-0.5 text-[10px] text-zinc-200"
                          />
                        </label>
                        {/* Text color */}
                        <label className="flex items-center gap-1">
                          Color:
                          <input
                            type="color"
                            value={`#${subtitleStyle.colorHex ?? "FFFFFF"}`}
                            onChange={(e) =>
                              setSubtitleStyle((prev) => ({
                                ...prev,
                                colorHex: e.target.value
                                  .replace(/^#/, "")
                                  .toUpperCase(),
                              }))
                            }
                            disabled={exporting}
                            className="h-4 w-6 cursor-pointer rounded border border-zinc-700 bg-transparent"
                          />
                        </label>
                        {/* Box background */}
                        <label className="flex items-center gap-1">
                          <input
                            type="checkbox"
                            checked={Boolean(subtitleStyle.boxBackground)}
                            onChange={(e) =>
                              setSubtitleStyle((prev) => ({
                                ...prev,
                                boxBackground: e.target.checked,
                              }))
                            }
                            disabled={exporting}
                            className="size-3"
                          />
                          Box bg
                        </label>
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="gap-1.5"
                disabled={exporting || !manifest || manifest.shots.length === 0}
                onClick={async () => {
                  setExporting(true);
                  setExportError(null);
                  setExportedUrl(null);
                  setExportStageLabel("Trying server ffmpeg…");
                  try {
                    // 1. Try server-side route first (fast, no client CPU).
                    const res = await fetch("/api/storyboard/export-reel", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({
                        storyboardId,
                        burnInSubtitles,
                        subtitleStyle: burnInSubtitles
                          ? subtitleStyle
                          : undefined,
                      }),
                    });
                    if (res.ok) {
                      const data = (await res.json()) as { url: string };
                      setExportedUrl(data.url);
                      setExportStageLabel(null);
                      return;
                    }
                    // 2. 501 → fall back to client-side ffmpeg.wasm.
                    //    Any other status is a real error.
                    if (res.status !== 501) {
                      const errData = (await res.json().catch(() => ({}))) as {
                        error?: string;
                      };
                      throw new Error(
                        errData.error ?? `Export failed (${res.status})`,
                      );
                    }
                    if (!manifest) throw new Error("Manifest not loaded");
                    setExportStageLabel(
                      "Server has no ffmpeg — loading wasm (~30MB)…",
                    );
                    const { exportReelClientSide } = await import(
                      "@/lib/reel-export/client"
                    );
                    const result = await exportReelClientSide({
                      manifest,
                      onProgress: (p) => {
                        if (p.stage === "loading_wasm") {
                          setExportStageLabel("Loading ffmpeg.wasm…");
                        } else if (p.stage === "downloading") {
                          setExportStageLabel(
                            `Downloading shot ${(p.shotIndex ?? 0) + 1} / ${p.shotTotal ?? 0}`,
                          );
                        } else if (p.stage === "normalizing") {
                          setExportStageLabel(
                            `Encoding shot ${(p.shotIndex ?? 0) + 1} / ${p.shotTotal ?? 0}`,
                          );
                        } else if (p.stage === "concatenating") {
                          setExportStageLabel("Concatenating reel…");
                        }
                      },
                    });
                    // Upload the wasm-produced mp4 to Convex storage the
                    // same way the server route does.
                    setExportStageLabel("Uploading to Convex storage…");
                    const uploadUrl = (await generateUploadUrlMut(
                      {},
                    )) as string;
                    // Copy the wasm-returned Uint8Array into a fresh
                    // ArrayBuffer so `Blob`'s strict BufferSource type
                    // is happy even when the original buffer is
                    // SharedArrayBuffer-backed.
                    const reelBuffer = new ArrayBuffer(result.bytes.byteLength);
                    new Uint8Array(reelBuffer).set(result.bytes);
                    const uploadRes = await fetch(uploadUrl, {
                      method: "POST",
                      headers: { "Content-Type": "video/mp4" },
                      body: new Blob([reelBuffer], { type: "video/mp4" }),
                    });
                    if (!uploadRes.ok) {
                      const text = await uploadRes.text().catch(() => "");
                      throw new Error(
                        `storage upload ${uploadRes.status}: ${text.slice(0, 200)}`,
                      );
                    }
                    const { storageId } = (await uploadRes.json()) as {
                      storageId: string;
                    };
                    const publicUrl = (await getStorageUrlMut({
                      storageId: storageId as never,
                    })) as string;
                    // Record the client-side export in the same table the
                    // server writes to so past-exports shows it.
                    try {
                      await recordReelExportMut({
                        storyboardId: storyboardId as never,
                        storageId: storageId as never,
                        sourceUrl: publicUrl,
                        shotCount: result.shotCount,
                        totalDurationS: result.totalDurationS,
                        byteLength: result.byteLength,
                        title: manifest.title,
                      });
                    } catch (recordErr) {
                      // Upload succeeded — surfacing a row-write error
                      // would confuse the producer. Log quietly.
                      console.warn("recordReelExport failed", recordErr);
                    }
                    setExportedUrl(publicUrl);
                    setExportStageLabel(null);
                  } catch (err) {
                    setExportError(
                      err instanceof Error ? err.message : String(err),
                    );
                    setExportStageLabel(null);
                  } finally {
                    setExporting(false);
                  }
                }}
              >
                {exporting ? (
                  <>
                    <span className="size-3 animate-spin rounded-full border-2 border-current/30 border-t-current" />
                    Encoding…
                  </>
                ) : (
                  <>
                    <Download className="size-4" />
                    Export mp4
                  </>
                )}
              </Button>
            </div>

            {exportError ? (
              <div className="flex items-start gap-2 rounded-md border border-rose-500/40 bg-rose-500/10 px-2 py-1.5 text-[11px] text-rose-200">
                <AlertTriangle className="size-4 shrink-0" />
                <span>{exportError}</span>
              </div>
            ) : null}

            {/* M7 — subtitle download links + in-preview CC toggle.
                Generated on-demand from the same dialogue extraction the
                audio batch uses, so captions line up with the narration
                timeline cue-for-cue. */}
            {manifest && manifest.shots.length > 0 ? (
              <div className="flex items-center justify-between gap-3 text-[11px] text-muted-foreground">
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setCaptionsEnabled((prev) => !prev)}
                    className={
                      "rounded border px-2 py-0.5 text-[10px] uppercase tracking-wide " +
                      (captionsEnabled
                        ? "border-emerald-500/60 bg-emerald-500/10 text-emerald-300"
                        : "border-zinc-700 bg-zinc-900 text-zinc-400")
                    }
                    disabled={subtitleCues.length === 0}
                    title={
                      subtitleCues.length === 0
                        ? "No dialogue detected on this storyboard"
                        : captionsEnabled
                          ? "Hide captions overlay"
                          : "Show captions overlay"
                    }
                  >
                    CC {captionsEnabled ? "on" : "off"}
                    {subtitleCues.length > 0 ? ` · ${subtitleCues.length}` : ""}
                  </button>
                  <span>subtitles:</span>
                </div>
                <div className="flex items-center gap-2">
                  {/* M7 — locale picker. Source (empty string) = no
                      translation. Translated locales hit OpenAI once per
                      fetch, so producers can audition a few without
                      re-rendering the whole reel. */}
                  <select
                    value={subtitleLocale}
                    onChange={(e) => setSubtitleLocale(e.target.value)}
                    className="rounded border border-zinc-700 bg-zinc-900 px-1 py-0.5 text-[10px] text-zinc-200"
                    title="Target language for subtitle translation (affects CC overlay, .vtt, .srt)"
                  >
                    <option value="">English (source)</option>
                    <option value="es">Spanish</option>
                    <option value="fr">French</option>
                    <option value="de">German</option>
                    <option value="pt">Portuguese</option>
                    <option value="it">Italian</option>
                    <option value="ja">Japanese</option>
                    <option value="zh">Chinese</option>
                    <option value="ko">Korean</option>
                    <option value="hi">Hindi</option>
                  </select>
                  <a
                    href={`/api/storyboard/subtitles?storyboardId=${encodeURIComponent(storyboardId)}&format=vtt${subtitleLocale ? `&locale=${encodeURIComponent(subtitleLocale)}` : ""}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    download
                    className="underline hover:text-foreground"
                  >
                    .vtt
                  </a>
                  <span className="text-border">·</span>
                  <a
                    href={`/api/storyboard/subtitles?storyboardId=${encodeURIComponent(storyboardId)}&format=srt${subtitleLocale ? `&locale=${encodeURIComponent(subtitleLocale)}` : ""}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    download
                    className="underline hover:text-foreground"
                  >
                    .srt
                  </a>
                </div>
              </div>
            ) : null}

            {/* M8 follow-up — on-demand dub generation for the
                currently-selected locale. Hidden for source language
                (no dub to generate) and when there are no shots to
                narrate. */}
            {manifest && manifest.shots.length > 0 && subtitleLocale ? (
              <div className="flex items-center justify-between gap-3 rounded-md border border-border/40 bg-background/60 px-2 py-1.5 text-[11px] text-muted-foreground">
                <div className="flex items-center gap-1.5">
                  <Languages className="size-3.5" />
                  <span>
                    {dubBatch.state.kind === "running"
                      ? `Dubbing to ${subtitleLocale}…`
                      : dubBatch.state.kind === "done" && dubBatch.state.done
                        ? `Dubbed ${dubBatch.state.done.succeeded}/${dubBatch.state.done.total} to ${subtitleLocale}.`
                        : dubBatch.state.kind === "error"
                          ? `Dub error: ${dubBatch.state.error?.slice(0, 60) ?? "unknown"}`
                          : `Produce audio in ${subtitleLocale}? Generates one dubbed narration per shot + swaps the reel's audio automatically.`}
                  </span>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-6 gap-1.5 px-2 text-[10px]"
                  disabled={
                    !storyboardId
                    || dubBatch.state.kind === "running"
                    || !subtitleLocale
                  }
                  onClick={() => {
                    void dubBatch.start({
                      storyboardId,
                      // Dubbing re-runs every shot by design —
                      // skipExisting=true would skip shots whose
                      // source-language narration is set, which is
                      // the wrong signal for the locale table.
                      skipExisting: false,
                      concurrency: 3,
                      mode: "audio",
                      locale: subtitleLocale,
                    });
                  }}
                  title={
                    dubBatch.state.kind === "running"
                      ? "Dubbing in progress"
                      : `Generate a ${subtitleLocale} dub for every shot`
                  }
                >
                  {dubBatch.state.kind === "running"
                    ? `${dubBatch.state.counts.succeeded}/${dubBatch.state.total}`
                    : dubBatch.state.kind === "done"
                      ? "Regenerate dub"
                      : "Dub"}
                </Button>
              </div>
            ) : null}

            {pastExports && pastExports.length > 0 ? (
              <div className="rounded-md border border-border/40 bg-background/60 p-2">
                <div className="mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  <History className="size-3" />
                  Past exports
                </div>
                <ul className="space-y-1 text-[11px]">
                  {pastExports.slice(0, 5).map((row) => (
                    <li
                      key={row._id}
                      className="flex items-center justify-between gap-2"
                    >
                      <span
                        className="truncate text-muted-foreground"
                        title={`${row.shotCount} shots · ${row.totalDurationS.toFixed(1)}s · ${(row.byteLength / (1024 * 1024)).toFixed(1)} MB`}
                      >
                        {new Date(row.createdAt).toLocaleString()} ·{" "}
                        {row.shotCount} shots ·{" "}
                        {row.totalDurationS.toFixed(1)}s
                      </span>
                      <a
                        href={row.sourceUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="shrink-0 underline hover:text-foreground"
                      >
                        open
                      </a>
                    </li>
                  ))}
                  {pastExports.length > 5 ? (
                    <li className="text-[10px] text-muted-foreground">
                      +{pastExports.length - 5} older exports
                    </li>
                  ) : null}
                </ul>
              </div>
            ) : null}
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
