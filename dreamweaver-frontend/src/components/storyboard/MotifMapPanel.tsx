"use client";

/**
 * M9 Phase 4 — Motif Map panel.
 *
 * Lists setup → payoff chains for every motif registered on the
 * storyboard. Each row shows the motif key, its description, the
 * source + payoff node ids, a landed-status badge, and (when set) the
 * visual vocabulary that visual_director must echo on payoff shots.
 *
 * Producer actions:
 *   * Click a node chip → focus that node on the canvas (delegated to
 *     parent via `onFocusNode`).
 *   * "Land here" button on unlanded rows → dispatches the
 *     motif_tracker subagent via the chat Copilot (scaffold; the
 *     MVP producers here drive motif plants from chat since a
 *     click-target flow needs node-picking UX that's Phase 5 scope).
 *
 * Empty state: the panel is hidden entirely when no motifs exist so
 * it doesn't add chrome to pre-M9 storyboards. Once the agent lands
 * its first plant, the panel fades in under Timeline Theater.
 */

import { useMemo, useState } from "react";
import {
  CircleDot,
  CheckCircle2,
  AlertTriangle,
  Plus,
  X,
} from "lucide-react";
import type { NarrativeMotifRecord, StoryNode } from "@/app/storyboard/types";
import {
  deriveDisplayStatus,
  MOTIF_DISPLAY_ORDER,
} from "@/lib/narrative/motif-status";

type MotifMapPanelProps = {
  motifs: NarrativeMotifRecord[];
  /** Click a node chip → focus it on the canvas. Mirrors NarrativeBar. */
  onFocusNode?: (nodeId: string) => void;
  /**
   * M9 Phase 5 — manual quick-plant.
   *
   * When supplied, the panel renders a "Plant motif" inline form
   * letting the producer author a new motif row without round-
   * tripping through the agent. Shot nodes are shown in the target
   * picker; on submit, the parent wires the call to
   * `narrativeState:upsertMotif`. Kept optional so the panel still
   * renders read-only when the parent doesn't need edit capability
   * (e.g. a future producer-dashboard view).
   */
  shotNodes?: StoryNode[];
  onPlantMotif?: (input: {
    motifKey: string;
    description: string;
    targetNodeId: string;
    role: "plant" | "payoff";
    visualVocabulary?: string;
  }) => Promise<void>;
};

type StatusTone = "emerald" | "amber" | "rose" | "zinc";

const STATUS_TONE: Record<string, StatusTone> = {
  landed: "emerald",
  planted: "amber",
  orphaned: "rose",
  unplanted: "zinc",
};

const TONE_CLASS: Record<StatusTone, string> = {
  emerald: "border-emerald-500/40 bg-emerald-500/10 text-emerald-200",
  amber: "border-amber-500/40 bg-amber-500/10 text-amber-200",
  rose: "border-rose-500/40 bg-rose-500/10 text-rose-200",
  zinc: "border-zinc-700 bg-zinc-800/50 text-zinc-300",
};

export function MotifMapPanel({
  motifs,
  onFocusNode,
  shotNodes,
  onPlantMotif,
}: MotifMapPanelProps) {
  const [showForm, setShowForm] = useState(false);
  // Sort: landed first (success stories), then planted (needs payoff),
  // then orphaned (needs setup), then unplanted (bare registry entry).
  // Within each bucket, most-recently-updated first.
  const sorted = useMemo(() => {
    return [...motifs].sort((a, b) => {
      const aStatus = deriveDisplayStatus(a);
      const bStatus = deriveDisplayStatus(b);
      if (aStatus !== bStatus) {
        return (
          (MOTIF_DISPLAY_ORDER[aStatus] ?? 9)
          - (MOTIF_DISPLAY_ORDER[bStatus] ?? 9)
        );
      }
      return b.updatedAt - a.updatedAt;
    });
  }, [motifs]);

  const canPlantManually = Boolean(shotNodes && onPlantMotif);
  if (sorted.length === 0 && !canPlantManually) {
    return null; // hide entirely on pre-M9 storyboards (no motifs + no edit UI)
  }

  const unlandedCount = sorted.filter(
    (m) => deriveDisplayStatus(m) === "planted",
  ).length;
  const orphanedCount = sorted.filter(
    (m) => deriveDisplayStatus(m) === "orphaned",
  ).length;

  return (
    <section
      aria-label="Motif map"
      className="rounded-xl border border-zinc-800 bg-zinc-950/95 p-4 text-zinc-100"
    >
      <div className="flex items-center justify-between">
        <div>
          <p className="text-[11px] uppercase tracking-wide text-zinc-400">
            Motif Map
          </p>
          <h3 className="mt-1 text-sm font-semibold">
            {sorted.length} motif{sorted.length === 1 ? "" : "s"}
          </h3>
        </div>
        <div className="flex items-center gap-1">
          {unlandedCount > 0 ? (
            <span
              className={`rounded-full border px-1.5 py-0.5 text-[10px] ${TONE_CLASS.amber}`}
            >
              {unlandedCount} need payoff
            </span>
          ) : null}
          {orphanedCount > 0 ? (
            <span
              className={`rounded-full border px-1.5 py-0.5 text-[10px] ${TONE_CLASS.rose}`}
            >
              {orphanedCount} orphaned
            </span>
          ) : null}
          {canPlantManually ? (
            <button
              type="button"
              className="inline-flex items-center gap-1 rounded border border-emerald-500/40 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] text-emerald-200 hover:bg-emerald-500/20 focus:outline-none focus:ring-2 focus:ring-emerald-300"
              onClick={() => setShowForm((v) => !v)}
              aria-expanded={showForm}
              aria-controls="motif-quick-plant-form"
            >
              {showForm ? (
                <>
                  <X className="size-3" />
                  Cancel
                </>
              ) : (
                <>
                  <Plus className="size-3" />
                  Plant motif
                </>
              )}
            </button>
          ) : null}
        </div>
      </div>

      {showForm && canPlantManually ? (
        <MotifQuickPlantForm
          shotNodes={shotNodes!}
          onSubmit={async (input) => {
            await onPlantMotif!(input);
            setShowForm(false);
          }}
        />
      ) : null}

      {sorted.length === 0 ? (
        <p className="mt-2 text-[11px] text-muted-foreground">
          No motifs yet.{" "}
          {canPlantManually
            ? "Plant one from the form above or ask the agent for a motif audit."
            : "Ask the agent for a motif audit."}
        </p>
      ) : null}

      <div
        className="mt-3 space-y-2"
        role="list"
        aria-label={`${sorted.length} motifs`}
      >
        {sorted.map((motif) => {
          const status = deriveDisplayStatus(motif);
          const tone = STATUS_TONE[status] ?? "zinc";
          const StatusIcon =
            status === "landed"
              ? CheckCircle2
              : status === "orphaned"
                ? AlertTriangle
                : CircleDot;
          return (
            <div
              key={motif._id}
              role="listitem"
              aria-label={`${motif.motifKey}, ${status}`}
              className="rounded border border-zinc-800 p-2"
            >
              <div className="flex items-center gap-2">
                <StatusIcon className="size-3.5 shrink-0" />
                <span className="font-mono text-[12px] font-medium">
                  {motif.motifKey}
                </span>
                <span
                  className={`ml-auto rounded-full border px-1.5 py-0.5 text-[10px] ${TONE_CLASS[tone]}`}
                >
                  {status}
                </span>
              </div>
              {motif.description ? (
                <p className="mt-1 text-[11px] text-zinc-300">
                  {motif.description}
                </p>
              ) : null}
              <div className="mt-1.5 flex flex-wrap items-center gap-1 text-[10px] text-zinc-400">
                {motif.sourceNodeIds.length > 0 ? (
                  <>
                    <span className="text-zinc-500">plants:</span>
                    {motif.sourceNodeIds.map((nodeId) => (
                      <button
                        key={`src-${nodeId}`}
                        type="button"
                        className="rounded border border-zinc-700 bg-zinc-800/60 px-1 py-0.5 font-mono text-[10px] text-zinc-200 hover:bg-zinc-800"
                        onClick={() => onFocusNode?.(nodeId)}
                        title={`Focus ${nodeId}`}
                      >
                        {nodeId}
                      </button>
                    ))}
                  </>
                ) : (
                  <span className="text-rose-300">no plant</span>
                )}
                <span className="mx-1 text-zinc-600">→</span>
                {motif.payoffNodeIds.length > 0 ? (
                  <>
                    <span className="text-zinc-500">payoffs:</span>
                    {motif.payoffNodeIds.map((nodeId) => (
                      <button
                        key={`pay-${nodeId}`}
                        type="button"
                        className="rounded border border-emerald-500/40 bg-emerald-500/10 px-1 py-0.5 font-mono text-[10px] text-emerald-200 hover:bg-emerald-500/20"
                        onClick={() => onFocusNode?.(nodeId)}
                        title={`Focus ${nodeId}`}
                      >
                        {nodeId}
                      </button>
                    ))}
                  </>
                ) : (
                  <span className="text-amber-300">no payoff</span>
                )}
              </div>
              {motif.visualVocabulary ? (
                <p className="mt-1 text-[10px] italic text-zinc-500">
                  {motif.visualVocabulary}
                </p>
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}

/**
 * M9 Phase 5 — inline manual plant form.
 *
 * Three required fields (key, description, target) + two optional
 * (role, visual vocabulary). The role picker decides whether the
 * target becomes a `sourceNodeIds` entry (plant) or a
 * `payoffNodeIds` entry (payoff). The parent handler is responsible
 * for the upsert merge — we don't read the existing row here.
 *
 * Key sanitization mirrors the Python tool: lowercase, alphanumerics
 * + dashes/underscores, max 60 chars. Matches the bridge's
 * `MotifPlantRenderer` so a manual plant + agent plant are
 * byte-for-byte equivalent on disk.
 */
function MotifQuickPlantForm({
  shotNodes,
  onSubmit,
}: {
  shotNodes: StoryNode[];
  onSubmit: (input: {
    motifKey: string;
    description: string;
    targetNodeId: string;
    role: "plant" | "payoff";
    visualVocabulary?: string;
  }) => Promise<void>;
}) {
  const [rawKey, setRawKey] = useState("");
  const [description, setDescription] = useState("");
  const [targetNodeId, setTargetNodeId] = useState(
    shotNodes[0]?.id ?? "",
  );
  const [role, setRole] = useState<"plant" | "payoff">("plant");
  const [visualVocabulary, setVisualVocabulary] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const slug = useMemo(() => {
    const lowered = rawKey.trim().toLowerCase();
    return Array.from(lowered)
      .map((c) => (/[a-z0-9_-]/.test(c) ? c : "-"))
      .join("")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60);
  }, [rawKey]);

  const canSubmit =
    !submitting
    && slug.length > 0
    && description.trim().length > 0
    && targetNodeId.length > 0;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setError(null);
    setSubmitting(true);
    try {
      await onSubmit({
        motifKey: slug,
        description: description.trim().slice(0, 400),
        targetNodeId,
        role,
        visualVocabulary: visualVocabulary.trim()
          ? visualVocabulary.trim().slice(0, 400)
          : undefined,
      });
      setRawKey("");
      setDescription("");
      setVisualVocabulary("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Plant failed.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      id="motif-quick-plant-form"
      className="mt-3 space-y-1.5 rounded border border-emerald-500/30 bg-emerald-500/5 p-2"
    >
      <div className="flex gap-1.5">
        <label className="flex-1 text-[10px] text-zinc-400">
          Key
          <input
            type="text"
            value={rawKey}
            onChange={(e) => setRawKey(e.target.value)}
            placeholder="red-umbrella"
            aria-label="Motif key (slug-cased)"
            className="mt-0.5 w-full rounded border border-border/60 bg-background/80 px-1 py-0.5 font-mono text-[11px]"
            maxLength={80}
          />
          {rawKey && slug !== rawKey.trim().toLowerCase() ? (
            <span className="text-[9px] text-amber-300">
              → {slug || "(empty)"}
            </span>
          ) : null}
        </label>
        <label className="flex-1 text-[10px] text-zinc-400">
          Role
          <select
            value={role}
            onChange={(e) =>
              setRole(e.target.value === "payoff" ? "payoff" : "plant")
            }
            aria-label="Motif role"
            className="mt-0.5 w-full rounded border border-border/60 bg-background/80 px-1 py-0.5 text-[11px]"
          >
            <option value="plant">Plant (setup)</option>
            <option value="payoff">Payoff (callback)</option>
          </select>
        </label>
      </div>
      <label className="block text-[10px] text-zinc-400">
        Target shot
        <select
          value={targetNodeId}
          onChange={(e) => setTargetNodeId(e.target.value)}
          aria-label="Target shot"
          className="mt-0.5 w-full rounded border border-border/60 bg-background/80 px-1 py-0.5 text-[11px]"
        >
          {shotNodes.map((n) => (
            <option key={n.id} value={n.id}>
              {n.id.slice(0, 10)} — {n.data.label ?? "(untitled)"}
            </option>
          ))}
        </select>
      </label>
      <label className="block text-[10px] text-zinc-400">
        Description
        <input
          type="text"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="What this motif represents"
          aria-label="Motif description"
          className="mt-0.5 w-full rounded border border-border/60 bg-background/80 px-1 py-0.5 text-[11px]"
          maxLength={400}
        />
      </label>
      <label className="block text-[10px] text-zinc-400">
        Visual vocabulary (optional)
        <input
          type="text"
          value={visualVocabulary}
          onChange={(e) => setVisualVocabulary(e.target.value)}
          placeholder="crimson fabric, rain-beaded, high-contrast gray sky"
          aria-label="Visual vocabulary"
          className="mt-0.5 w-full rounded border border-border/60 bg-background/80 px-1 py-0.5 text-[11px]"
          maxLength={400}
        />
      </label>
      {error ? (
        <p className="text-[10px] text-rose-300">{error}</p>
      ) : null}
      <div className="flex justify-end gap-1">
        <button
          type="button"
          onClick={handleSubmit}
          disabled={!canSubmit}
          className="inline-flex items-center gap-1 rounded bg-emerald-600 px-2 py-0.5 text-[11px] text-white disabled:opacity-50"
        >
          {submitting ? "Planting…" : "Plant"}
        </button>
      </div>
    </div>
  );
}
