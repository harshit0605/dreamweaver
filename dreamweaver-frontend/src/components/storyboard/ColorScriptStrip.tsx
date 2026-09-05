"use client";

/**
 * M9 Phase 5 — Color Script Strip.
 *
 * Traditional storyboarding: before animation starts, a "color script"
 * charts each scene's dominant hue + value across the film. Producers
 * use it to catch tonal monotony (act 2B that never cools down) or
 * jarring palette jumps (a cut from warm-dusk into saturated-neon).
 *
 * We don't have a per-shot tone field on the schema, so this first
 * iteration derives a hue from two axes the agent already populates:
 *   * tension (0-10) — drives saturation + redshift. High tension =
 *     saturated crimson; low tension = desaturated teal.
 *   * keyword heuristic on `segment` — "night/dark" cools the hue;
 *     "warm/sun/fire" warms it; "green/forest" shifts to emerald.
 *
 * The result is a single-row HSL ribbon, one column per shot. Click a
 * column → focus the node (delegates to parent). A TODO-FIXME is
 * inlined: once shots gain an explicit `tone` field (plan item for
 * M10), the keyword heuristic collapses to a passthrough and the hue
 * becomes editor-authoritative rather than agent-derived.
 */

import { useMemo } from "react";
import { Palette } from "lucide-react";
import type { StoryNode } from "@/app/storyboard/types";
import { deriveColorCell } from "@/lib/narrative/color-script";

type ColorScriptStripProps = {
  nodes: StoryNode[];
  onFocusNode?: (nodeId: string) => void;
};

// Project a StoryNode onto the loose ColorScriptInput shape. Centralised
// so the pure derivation logic in lib/narrative/color-script can stay
// React-agnostic + testable without mounting a tree.
const projectShot = (node: StoryNode) =>
  deriveColorCell({
    nodeId: node.id,
    segment: node.data.segment ?? null,
    tensionLevel:
      typeof node.data.tensionLevel === "number"
        ? node.data.tensionLevel
        : null,
    label: node.data.label ?? null,
  });

export function ColorScriptStrip({
  nodes,
  onFocusNode,
}: ColorScriptStripProps) {
  const shotNodes = useMemo(
    () => nodes.filter((n) => n.data.nodeType === "shot"),
    [nodes],
  );
  const cells = useMemo(() => shotNodes.map(projectShot), [shotNodes]);

  if (cells.length === 0) return null;

  const anySampled = cells.some((c) => c.tension !== null);

  return (
    <div
      className="flex items-center gap-1.5"
      data-testid="color-script-strip"
      role="group"
      aria-label="Color script: per-shot hue derived from tension + segment keywords"
    >
      <Palette
        className="size-3 shrink-0 text-muted-foreground"
        aria-hidden
      />
      <div
        className="flex h-4 flex-1 overflow-hidden rounded border border-border/40"
        role="list"
      >
        {cells.map((cell) => {
          const clickable = Boolean(onFocusNode);
          const title =
            cell.tension === null
              ? `${cell.label} (${cell.tone}, not sampled)`
              : `${cell.label} (${cell.tone}, tension ${cell.tension.toFixed(1)})`;
          return (
            <button
              key={cell.nodeId}
              type="button"
              role="listitem"
              disabled={!clickable}
              onClick={() => {
                if (clickable) onFocusNode?.(cell.nodeId);
              }}
              aria-label={title}
              title={title}
              className={
                clickable
                  ? "flex-1 cursor-pointer transition hover:brightness-125 focus:outline-none focus:ring-2 focus:ring-inset focus:ring-amber-300"
                  : "flex-1 cursor-default"
              }
              style={{
                backgroundColor: `hsl(${cell.hue.toFixed(0)}, ${cell.saturation.toFixed(0)}%, ${cell.lightness.toFixed(0)}%)`,
              }}
            />
          );
        })}
      </div>
      <span
        className="shrink-0 text-[9px] tabular-nums text-muted-foreground"
        title={
          anySampled
            ? "Tension + segment keywords drive each column."
            : "Run Analyze to sample tension; hues are keyword-only until then."
        }
      >
        {cells.length}
      </span>
    </div>
  );
}
