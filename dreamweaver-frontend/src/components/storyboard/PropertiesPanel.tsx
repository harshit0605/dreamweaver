"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ImageIcon, Video, Music, Sparkles, Wand2, Settings2, Users, Volume2, X, Plus } from "lucide-react";
import { useMutation, useQuery } from "convex/react";
import { mutationRef, queryRef } from "@/lib/convexRefs";
import {
  DEFAULT_SFX_VOLUME_DB,
  SFX_MAX_DURATION_S,
  SFX_MAX_VOLUME_DB,
  SFX_MIN_DURATION_S,
  SFX_MIN_VOLUME_DB,
  SFX_PROMPT_MAX_CHARS,
} from "@/lib/sfx";
import { MediaType } from "@/app/storyboard/types";
import type {
  AspectRatio,
  CameraMove,
  DeliveryStatus,
  DeliveryVariantSpec,
  ScreenDirection,
  ShotAngle,
  ShotMeta,
  ShotSize,
  StoryEdge,
  StoryNode,
  StoryboardMediaConfig,
  UserIdentity,
  VoiceName,
} from "@/app/storyboard/types";
import DeliveryMatrixSection from "@/components/storyboard/DeliveryMatrixSection";
import ReviewPanel, { type ReviewCallbacks } from "@/components/storyboard/ReviewPanel";
import {
  ASPECT_RATIO_OPTIONS,
  CAMERA_MOVE_OPTIONS,
  LENS_MM_PRESETS,
  SHOT_ANGLE_OPTIONS,
  SHOT_SIZE_OPTIONS,
} from "@/app/storyboard/types";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Separator } from "@/components/ui/separator";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

export interface DeliveryVariantCallbacks {
  createVariant: (args: {
    storyboardId: string;
    masterAssetId: string;
    variantSpec: DeliveryVariantSpec;
    sourceUrl?: string;
    modelId?: string;
  }) => Promise<unknown>;
  createMatrix: (args: {
    storyboardId: string;
    masterAssetId: string;
    matrix: {
      aspects?: AspectRatio[];
      durationsS?: number[];
      locales?: string[];
      abLabels?: string[];
      platform?: DeliveryVariantSpec["platform"];
      endCard?: string;
      notes?: string;
    };
  }) => Promise<unknown>;
  updateSpec: (args: { mediaAssetId: string; variantSpec: DeliveryVariantSpec }) => Promise<unknown>;
  updateStatus: (args: { mediaAssetId: string; deliveryStatus: DeliveryStatus }) => Promise<unknown>;
  attachSource: (args: { mediaAssetId: string; sourceUrl: string; modelId?: string }) => Promise<unknown>;
  archive: (args: { mediaAssetId: string }) => Promise<unknown>;
  promote: (args: { mediaAssetId: string }) => Promise<unknown>;
}

interface PropertiesPanelProps {
  selectedNode: StoryNode | null;
  nodes?: StoryNode[];
  edges?: StoryEdge[];
  storyboardId?: string;
  onGenerateMedia: (nodeId: string, type: MediaType, prompt: string, config: StoryboardMediaConfig) => void;
  onEditNode: (nodeId: string, instruction: string) => void;
  onUpdateShotMeta?: (nodeId: string, next: ShotMeta) => void;
  onSetNodeCharacterIds?: (nodeId: string, characterIds: string[]) => Promise<void> | void;
  /** M5 #5 — update the per-shot TTS narration override. Empty string
   *  clears the override. */
  onSetNodeAudioDesc?: (nodeId: string, audioDesc: string) => Promise<void> | void;
  deliveryVariantCallbacks?: DeliveryVariantCallbacks;
  userIdentity?: UserIdentity | null;
  reviewCallbacks?: ReviewCallbacks;
  isProcessing: boolean;
  onClose: () => void;
}

const defaultNegativePrompt =
  "full body shot, wide shot, distant, rotation of subject, spinning person, morphing, distortion";

const IMAGE_MODEL_OPTIONS: { id: string; name: string; description: string }[] = [
  { id: "zennah-image-gen", name: "Zennah Image Gen", description: "Cinematic, camera-aware (Modal)" },
  { id: "zennah-qwen-edit", name: "Zennah Multi-Angle", description: "Consistent multi-angle edits" },
  { id: "zennah-qwen-multiview", name: "Zennah Multi-View", description: "Auto 3-angle (LoRA)" },
  { id: "gpt-image-1", name: "GPT Image 1.5", description: "OpenAI flagship w/ editing" },
  { id: "dall-e-3", name: "DALL·E 3", description: "OpenAI high-quality" },
];

const VIDEO_MODEL_OPTIONS: { id: string; name: string; description: string }[] = [
  { id: "ltx-2.3", name: "LTX-2.3", description: "Lightricks 22B — I2V + keyframe + retake" },
  { id: "ltx-2", name: "LTX-2", description: "Legacy Lightricks LTX-2" },
  { id: "veo-3.1", name: "Veo 3.1", description: "Google DeepMind (coming soon)" },
];

function getNextNode(currentId: string, nodes: StoryNode[], edges: StoryEdge[]) {
  const edge = edges.find((e) => e.source === currentId);
  if (!edge) return null;
  return nodes.find((n) => n.id === edge.target) ?? null;
}

export default function PropertiesPanel({
  selectedNode,
  nodes = [],
  edges = [],
  storyboardId,
  onGenerateMedia,
  onEditNode,
  onUpdateShotMeta,
  onSetNodeCharacterIds,
  onSetNodeAudioDesc,
  deliveryVariantCallbacks,
  userIdentity,
  reviewCallbacks,
  isProcessing,
  onClose,
}: PropertiesPanelProps) {
  // Default to the Shot tab — producers opening a freshly-ingested node
  // reach for camera + character metadata before anything else. Media is
  // a rarer entry point (producers who already have a prompt locked in).
  const [tab, setTab] = useState<"shot" | "media" | "delivery" | "review" | "continuity" | "advanced">("shot");
  const tabTriggerClass =
    "border border-transparent text-muted-foreground data-[state=active]:border-primary/40 data-[state=active]:bg-primary/15 data-[state=active]:text-foreground";

  const [mediaType, setMediaType] = useState<MediaType>(MediaType.IMAGE);
  const [promptOverride, setPromptOverride] = useState("");
  const [promptOpen, setPromptOpen] = useState(false);

  // Media config
  const [style, setStyle] = useState("");
  const [aspectRatio, setAspectRatio] = useState("16:9");
  const [negativePrompt, setNegativePrompt] = useState(defaultNegativePrompt);
  const [voice, setVoice] = useState<VoiceName>("Kore");
  const [duration, setDuration] = useState("5");
  const [audioEnabled, setAudioEnabled] = useState(true);
  const [slowMotion, setSlowMotion] = useState(false);
  const [enhancePrompt, setEnhancePrompt] = useState(false);
  const [cameraMovement, setCameraMovement] = useState("static");

  // Per-node model overrides.
  const [imageModelId, setImageModelId] = useState<string>("zennah-image-gen");
  const [videoModelId, setVideoModelId] = useState<string>("ltx-2.3");

  const [rewriteInstruction, setRewriteInstruction] = useState("");

  // The "effective" prompt is what we'd hand to the model if the user clicked
  // Generate right now without editing. Prefer the structured promptPack
  // (populated by ViMax M1 ingestion and by earlier rewrites) over the raw
  // shot segment. Fall back to segment when the pack is empty.
  const effectivePrompt = useMemo(() => {
    if (!selectedNode) return "";
    const pack = selectedNode.data.promptPack;
    if (mediaType === MediaType.IMAGE) {
      const pick = pack?.imagePrompt?.trim() ?? "";
      if (pick) return pick;
    } else if (mediaType === MediaType.VIDEO) {
      const pick = pack?.videoPrompt?.trim() ?? "";
      if (pick) return pick;
    }
    return (selectedNode.data.segment ?? "").trim();
  }, [mediaType, selectedNode]);

  // Sync the editable textarea value to the effective prompt when the user
  // switches nodes or toggles image/video mode. Tracked via refs so typing
  // into the textarea doesn't trigger the sync.
  const lastNodeIdRef = useRef<string | null>(null);
  const lastMediaTypeRef = useRef<MediaType>(mediaType);
  useEffect(() => {
    const currentId = selectedNode?.id ?? null;
    if (
      lastNodeIdRef.current !== currentId ||
      lastMediaTypeRef.current !== mediaType
    ) {
      setPromptOverride(effectivePrompt);
      lastNodeIdRef.current = currentId;
      lastMediaTypeRef.current = mediaType;
    }
  }, [selectedNode, mediaType, effectivePrompt]);

  const promptPreview = useMemo(() => {
    if (!selectedNode) return "";
    return promptOverride.trim() || effectivePrompt;
  }, [promptOverride, selectedNode, effectivePrompt]);

  if (!selectedNode) return null;
  const { id, data } = selectedNode;
  const nextNode = getNextNode(id, nodes, edges);
  const endImage = nextNode?.data?.image;

  const continuityBadge =
    data.continuity.consistencyStatus === "ok"
      ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/20"
      : data.continuity.consistencyStatus === "warning"
        ? "bg-amber-500/15 text-amber-200 border-amber-500/20"
        : "bg-rose-500/15 text-rose-200 border-rose-500/20";

  const handleGenerate = () => {
    let config: StoryboardMediaConfig = {};
    if (mediaType === MediaType.AUDIO) {
      config = { voice };
    }
    if (mediaType === MediaType.IMAGE) {
      config = { style, aspectRatio, inputImage: data.image, imageModelId };
    }
    if (mediaType === MediaType.VIDEO) {
      config = {
        aspectRatio,
        negativePrompt,
        startImage: data.image,
        endImage,
        audioEnabled,
        slowMotion,
        duration: Number(duration),
        videoModelId,
        enhancePrompt: videoModelId === "ltx-2.3" ? enhancePrompt : undefined,
        cameraMovement,
      };
    }

    onGenerateMedia(id, mediaType, promptPreview, config);
  };

  const handleRewrite = () => {
    if (!rewriteInstruction.trim()) return;
    onEditNode(id, rewriteInstruction.trim());
    setRewriteInstruction("");
  };

  return (
    <div className="h-full w-full">
      <div className="flex items-start justify-between gap-3 p-4 border-b border-border/60">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <div className="text-sm font-semibold truncate">{data.label}</div>
            <Badge variant="secondary" className="text-[10px]">
              {data.nodeType}
            </Badge>
          </div>
          <div className="mt-1 text-xs text-muted-foreground line-clamp-2">{data.segment}</div>
        </div>
        <Button variant="ghost" size="sm" className="h-8" onClick={onClose}>
          Close
        </Button>
      </div>

      <div className="p-4">
        <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)}>
          <TabsList className="grid w-full grid-cols-6 bg-background/70 border border-border/70 p-1">
            <TabsTrigger value="shot" className={tabTriggerClass}>Shot</TabsTrigger>
            <TabsTrigger value="media" className={tabTriggerClass}>Media</TabsTrigger>
            <TabsTrigger value="delivery" className={tabTriggerClass}>Delivery</TabsTrigger>
            <TabsTrigger value="review" className={tabTriggerClass}>Review</TabsTrigger>
            <TabsTrigger value="continuity" className={tabTriggerClass}>Continuity</TabsTrigger>
            <TabsTrigger value="advanced" className={tabTriggerClass}>Advanced</TabsTrigger>
          </TabsList>

          <TabsContent value="shot" className="mt-4 space-y-4">
            <ShotMetaForm
              nodeId={id}
              shotMeta={data.shotMeta}
              onUpdateShotMeta={onUpdateShotMeta}
              disabled={isProcessing}
            />

            <CharactersInShotSection
              nodeId={id}
              storyboardId={storyboardId}
              characterIds={data.entityRefs?.characterIds ?? []}
              onSetCharacterIds={onSetNodeCharacterIds}
              disabled={isProcessing}
            />

            <NarrationOverrideSection
              nodeId={id}
              audioDesc={data.promptPack?.audioDesc ?? ""}
              derivedFallback={data.promptPack?.imagePrompt ?? data.segment ?? ""}
              onSetAudioDesc={onSetNodeAudioDesc}
              disabled={isProcessing}
            />

            {/* M7 — per-shot SFX (ambient / foley) track. Generates
                via ElevenLabs Sound Effects; mixed under the narration
                at export. Only rendered when we have a storyboardId
                (required for the Convex mutation). */}
            {storyboardId ? (
              <SfxSection
                storyboardId={storyboardId}
                nodeId={id}
                activeSfxUrl={(() => {
                  const active = data.media.sfxs?.find(
                    (s) => s.id === data.media.activeSfxId,
                  );
                  return active?.url ?? null;
                })()}
                activeSfxId={data.media.activeSfxId ?? null}
                disabled={isProcessing}
                shotDurationS={data.shotMeta?.durationS}
              />
            ) : null}

            <div className="rounded-xl border border-border/60 bg-card/40 p-3">
              <div className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">
                Rewrite Node
              </div>
              <div className="mt-2 text-xs text-muted-foreground">
                Give a director-style instruction. The agent will propose an edit.
              </div>
              <div className="mt-3 flex gap-2">
                <Input
                  value={rewriteInstruction}
                  onChange={(e) => setRewriteInstruction(e.target.value)}
                  placeholder='e.g. "Make this more tense and add a reveal at the end."'
                  className="bg-background/60"
                  disabled={isProcessing}
                />
                <Button onClick={handleRewrite} disabled={!rewriteInstruction.trim() || isProcessing} className="gap-2">
                  <Wand2 className="size-4" />
                  Rewrite
                </Button>
              </div>
            </div>

            <div className="rounded-xl border border-border/60 bg-card/40 p-3">
              <div className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">
                Selected
              </div>
              <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
                <div className="rounded-lg bg-background/60 border border-border/60 px-3 py-2">
                  <div className="text-[10px] text-muted-foreground">Type</div>
                  <div className="mt-0.5 font-medium">{data.nodeType}</div>
                </div>
                <div className="rounded-lg bg-background/60 border border-border/60 px-3 py-2">
                  <div className="text-[10px] text-muted-foreground">Continuity</div>
                  <div className={cn("mt-0.5 inline-flex items-center rounded-full border px-2 py-0.5 text-[10px]", continuityBadge)}>
                    {data.continuity.consistencyStatus}
                  </div>
                </div>
              </div>
            </div>
          </TabsContent>

          <TabsContent value="media" className="mt-4 space-y-4">
            <div className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">
              Output Type
            </div>
            <div className="grid grid-cols-3 gap-2">
              <Button
                type="button"
                variant="outline"
                className={cn(
                  "h-12 gap-2 justify-start border border-border/70 bg-background/40 hover:bg-background/70",
                  mediaType === MediaType.IMAGE
                    && "border-primary/50 bg-primary/15 text-foreground shadow-[inset_0_0_0_1px_rgba(163,230,53,0.32)]",
                )}
                onClick={() => setMediaType(MediaType.IMAGE)}
                aria-pressed={mediaType === MediaType.IMAGE}
              >
                <ImageIcon className="size-4" /> Image
              </Button>
              <Button
                type="button"
                variant="outline"
                className={cn(
                  "h-12 gap-2 justify-start border border-border/70 bg-background/40 hover:bg-background/70",
                  mediaType === MediaType.VIDEO
                    && "border-primary/50 bg-primary/15 text-foreground shadow-[inset_0_0_0_1px_rgba(163,230,53,0.32)]",
                )}
                onClick={() => setMediaType(MediaType.VIDEO)}
                aria-pressed={mediaType === MediaType.VIDEO}
              >
                <Video className="size-4" /> Video
              </Button>
              <Button
                type="button"
                variant="outline"
                className={cn(
                  "h-12 gap-2 justify-start border border-border/70 bg-background/40 hover:bg-background/70",
                  mediaType === MediaType.AUDIO
                    && "border-primary/50 bg-primary/15 text-foreground shadow-[inset_0_0_0_1px_rgba(163,230,53,0.32)]",
                )}
                onClick={() => setMediaType(MediaType.AUDIO)}
                aria-pressed={mediaType === MediaType.AUDIO}
              >
                <Music className="size-4" /> Audio
              </Button>
            </div>
            <div className="text-xs text-muted-foreground">
              {mediaType === MediaType.IMAGE
                ? "Still frame generation for scene and shot look development."
                : mediaType === MediaType.VIDEO
                  ? "Motion preview generation with optional audio and continuity directives."
                  : "Voice scratch track for timing and story beats."}
            </div>

            <Collapsible open={promptOpen} onOpenChange={setPromptOpen}>
              <div className="rounded-xl border border-border/60 bg-card/40 p-3">
                <div className="flex items-center justify-between">
                  <div className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">
                    Prompt
                  </div>
                  <CollapsibleTrigger asChild>
                    <Button variant="ghost" size="sm" className="h-7 px-2 text-xs">
                      {promptOpen ? "Hide" : "Edit"}
                    </Button>
                  </CollapsibleTrigger>
                </div>
                <div className="mt-2 text-xs text-muted-foreground line-clamp-3">
                  {promptPreview}
                </div>
                <CollapsibleContent className="mt-3 space-y-2">
                  <Textarea
                    value={promptOverride}
                    onChange={(e) => setPromptOverride(e.target.value)}
                    placeholder={effectivePrompt || data.segment}
                    className="min-h-[92px] bg-background/60"
                    disabled={isProcessing}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-8"
                    onClick={() => setPromptOverride(effectivePrompt)}
                    disabled={
                      isProcessing ||
                      promptOverride.trim() === effectivePrompt.trim()
                    }
                  >
                    Reset to node prompt
                  </Button>
                </CollapsibleContent>
              </div>
            </Collapsible>

            {mediaType === MediaType.IMAGE ? (
              <ModelPicker
                label="Image Model"
                options={IMAGE_MODEL_OPTIONS}
                value={imageModelId}
                onChange={setImageModelId}
                disabled={isProcessing}
              />
            ) : null}

            {mediaType === MediaType.VIDEO ? (
              <ModelPicker
                label="Video Model"
                options={VIDEO_MODEL_OPTIONS}
                value={videoModelId}
                onChange={setVideoModelId}
                disabled={isProcessing}
              />
            ) : null}

            <Button onClick={handleGenerate} disabled={isProcessing} className="w-full h-11 gap-2">
              <Sparkles className="size-4" />
              {mediaType === MediaType.IMAGE ? "Generate Image" : mediaType === MediaType.VIDEO ? "Generate Video" : "Generate Audio"}
            </Button>
          </TabsContent>

          <TabsContent value="delivery" className="mt-4 space-y-4">
            <DeliveryMatrixSection
              storyboardId={storyboardId}
              node={selectedNode}
              callbacks={deliveryVariantCallbacks}
              disabled={isProcessing}
            />
          </TabsContent>

          <TabsContent value="review" className="mt-4 space-y-4">
            <ReviewPanel
              storyboardId={storyboardId}
              selectedNode={selectedNode}
              userIdentity={userIdentity}
              callbacks={reviewCallbacks}
            />
          </TabsContent>

          <TabsContent value="continuity" className="mt-4 space-y-4">
            <div className="rounded-xl border border-border/60 bg-card/40 p-3">
              <div className="flex items-center justify-between">
                <div className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">
                  Rolling History
                </div>
                <div className={cn("inline-flex items-center rounded-full border px-2 py-0.5 text-[10px]", continuityBadge)}>
                  {data.continuity.consistencyStatus}
                </div>
              </div>
              <div className="mt-2 text-xs text-muted-foreground whitespace-pre-wrap">
                {data.historyContext.rollingSummary || "No rolling history summary yet."}
              </div>
              <Separator className="my-3" />
              <div className="text-[11px] text-muted-foreground">
                lineage: <span className="text-foreground/80">{data.historyContext.lineageHash || "pending"}</span>
                {"  "}· tokens:{" "}
                <span className="text-foreground/80">{data.historyContext.tokenBudgetUsed}</span>
              </div>
            </div>
          </TabsContent>

          <TabsContent value="advanced" className="mt-4 space-y-4">
            <div className="rounded-xl border border-border/60 bg-card/40 p-3">
              <div className="flex items-center gap-2">
                <Settings2 className="size-4 text-muted-foreground" />
                <div className="text-sm font-semibold">Advanced</div>
              </div>
              <div className="mt-1 text-xs text-muted-foreground">
                Optional controls for camera, motion, and negatives.
              </div>
            </div>

            {mediaType === MediaType.IMAGE ? (
              <div className="rounded-xl border border-border/60 bg-card/40 p-3 space-y-3">
                <Field label="Aspect ratio">
                  <Input value={aspectRatio} onChange={(e) => setAspectRatio(e.target.value)} disabled={isProcessing} />
                </Field>
                <Field label="Style">
                  <Input value={style} onChange={(e) => setStyle(e.target.value)} placeholder="e.g. cinematic, anamorphic" disabled={isProcessing} />
                </Field>
              </div>
            ) : null}

            {mediaType === MediaType.VIDEO ? (
              <div className="rounded-xl border border-border/60 bg-card/40 p-3 space-y-3">
                <Field label="Aspect ratio">
                  <Input value={aspectRatio} onChange={(e) => setAspectRatio(e.target.value)} disabled={isProcessing} />
                </Field>
                <Field label="Negative prompt">
                  <Textarea
                    value={negativePrompt}
                    onChange={(e) => setNegativePrompt(e.target.value)}
                    className="min-h-[80px] bg-background/60"
                    disabled={isProcessing}
                  />
                </Field>
                <div className="grid grid-cols-2 gap-2">
                  <Toggle
                    label="Audio"
                    value={audioEnabled}
                    onChange={setAudioEnabled}
                    disabled={isProcessing}
                  />
                  <Toggle
                    label="Slow motion"
                    value={slowMotion}
                    onChange={setSlowMotion}
                    disabled={isProcessing}
                  />
                </div>
                <Field label="Duration (seconds)">
                  <Input value={duration} onChange={(e) => setDuration(e.target.value)} disabled={isProcessing} />
                </Field>
                <Field label="Camera movement">
                  <Input
                    value={cameraMovement}
                    onChange={(e) => setCameraMovement(e.target.value)}
                    placeholder="static, pan-left, dolly-in, orbit..."
                    disabled={isProcessing}
                  />
                </Field>
                {videoModelId === "ltx-2.3" ? (
                  <Toggle
                    label="Enhance prompt (LTX-2.3)"
                    value={enhancePrompt}
                    onChange={setEnhancePrompt}
                    disabled={isProcessing}
                  />
                ) : null}
                <div className="text-[11px] text-muted-foreground">
                  Start frame uses this node&apos;s image. End frame uses the next node image when available.
                </div>
              </div>
            ) : null}

            {mediaType === MediaType.AUDIO ? (
              <div className="rounded-xl border border-border/60 bg-card/40 p-3 space-y-3">
                <Field label="Voice">
                  <Input value={voice} onChange={(e) => setVoice(e.target.value as VoiceName)} disabled={isProcessing} />
                </Field>
                <div className="text-[11px] text-muted-foreground">
                  Voice presets: Puck, Charon, Kore, Fenrir, Zephyr.
                </div>
              </div>
            ) : null}
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}

function ModelPicker({
  label,
  options,
  value,
  onChange,
  disabled,
}: {
  label: string;
  options: { id: string; name: string; description: string }[];
  value: string;
  onChange: (id: string) => void;
  disabled: boolean;
}) {
  const selected = options.find((o) => o.id === value) ?? options[0];
  return (
    <div className="rounded-xl border border-border/60 bg-card/40 p-3 space-y-2">
      <div className="flex items-center justify-between">
        <div className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">
          {label}
        </div>
        <Badge variant="outline" className="text-[10px] font-medium">
          {selected?.name}
        </Badge>
      </div>
      <div className="grid grid-cols-1 gap-1.5">
        {options.map((opt) => {
          const active = opt.id === value;
          return (
            <button
              key={opt.id}
              type="button"
              disabled={disabled}
              onClick={() => onChange(opt.id)}
              className={cn(
                "text-left rounded-lg border px-3 py-2 transition-colors",
                "border-border/60 bg-background/60 hover:bg-background/80",
                active && "border-primary/50 bg-primary/15 ring-1 ring-primary/30",
                disabled && "opacity-60 cursor-not-allowed",
              )}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="text-xs font-semibold truncate">{opt.name}</div>
                <div className="text-[10px] text-muted-foreground font-mono">{opt.id}</div>
              </div>
              <div className="text-[11px] text-muted-foreground mt-0.5 truncate">
                {opt.description}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <div className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">{label}</div>
      {children}
    </div>
  );
}

function ShotMetaForm({
  nodeId,
  shotMeta,
  onUpdateShotMeta,
  disabled,
}: {
  nodeId: string;
  shotMeta: ShotMeta | undefined;
  onUpdateShotMeta?: (nodeId: string, next: ShotMeta) => void;
  disabled: boolean;
}) {
  const current: ShotMeta = shotMeta ?? {};

  const commit = (patch: Partial<ShotMeta>) => {
    if (!onUpdateShotMeta) return;
    const next: ShotMeta = { ...current, ...patch };
    // Drop explicit undefineds so the stored object stays compact.
    for (const key of Object.keys(next) as Array<keyof ShotMeta>) {
      if (next[key] === undefined) {
        delete next[key];
      }
    }
    onUpdateShotMeta(nodeId, next);
  };

  const commitListField = (field: "props" | "sfx" | "vfx", raw: string) => {
    const parsed = raw
      .split(",")
      .map((token) => token.trim())
      .filter((token) => token.length > 0);
    commit({ [field]: parsed.length > 0 ? parsed : undefined } as Partial<ShotMeta>);
  };

  return (
    <div className="rounded-xl border border-border/60 bg-card/40 p-3 space-y-3">
      <div className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">
        Shot metadata
      </div>

      <Field label="Scene / shot number">
        <Input
          defaultValue={current.number ?? ""}
          placeholder="1A"
          onBlur={(e) =>
            commit({ number: e.target.value.trim() || undefined })
          }
          disabled={disabled}
        />
      </Field>

      <div className="grid grid-cols-2 gap-2">
        <Field label="Shot size">
          <select
            value={current.size ?? ""}
            disabled={disabled}
            onChange={(e) =>
              commit({ size: (e.target.value || undefined) as ShotSize | undefined })
            }
            className="w-full rounded-md border border-border/60 bg-background/60 px-2 py-1.5 text-xs"
          >
            <option value="">—</option>
            {SHOT_SIZE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label} · {opt.description}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Angle">
          <select
            value={current.angle ?? ""}
            disabled={disabled}
            onChange={(e) =>
              commit({ angle: (e.target.value || undefined) as ShotAngle | undefined })
            }
            className="w-full rounded-md border border-border/60 bg-background/60 px-2 py-1.5 text-xs"
          >
            <option value="">—</option>
            {SHOT_ANGLE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <Field label="Camera move">
          <select
            value={current.move ?? ""}
            disabled={disabled}
            onChange={(e) =>
              commit({ move: (e.target.value || undefined) as CameraMove | undefined })
            }
            className="w-full rounded-md border border-border/60 bg-background/60 px-2 py-1.5 text-xs"
          >
            <option value="">—</option>
            {CAMERA_MOVE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Lens (mm)">
          <Input
            type="number"
            list={`lens-presets-${nodeId}`}
            defaultValue={current.lensMm ?? ""}
            placeholder="35"
            min={0}
            disabled={disabled}
            onBlur={(e) => {
              const raw = e.target.value.trim();
              if (raw === "") {
                commit({ lensMm: undefined });
                return;
              }
              const parsed = Number(raw);
              commit({ lensMm: Number.isFinite(parsed) ? parsed : undefined });
            }}
          />
          <datalist id={`lens-presets-${nodeId}`}>
            {LENS_MM_PRESETS.map((mm) => (
              <option key={mm} value={mm} />
            ))}
          </datalist>
        </Field>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <Field label="Aspect ratio">
          <select
            value={current.aspect ?? ""}
            disabled={disabled}
            onChange={(e) =>
              commit({ aspect: (e.target.value || undefined) as AspectRatio | undefined })
            }
            className="w-full rounded-md border border-border/60 bg-background/60 px-2 py-1.5 text-xs"
          >
            <option value="">—</option>
            {ASPECT_RATIO_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label} · {opt.context}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Duration (sec)">
          <Input
            type="number"
            step={0.5}
            min={0}
            defaultValue={current.durationS ?? ""}
            placeholder="3.5"
            disabled={disabled}
            onBlur={(e) => {
              const raw = e.target.value.trim();
              if (raw === "") {
                commit({ durationS: undefined });
                return;
              }
              const parsed = Number(raw);
              commit({ durationS: Number.isFinite(parsed) ? parsed : undefined });
            }}
          />
        </Field>
      </div>

      <Field label="T-stop">
        <Input
          defaultValue={current.tStop ?? ""}
          placeholder="T2.8"
          disabled={disabled}
          onBlur={(e) => commit({ tStop: e.target.value.trim() || undefined })}
        />
      </Field>

      <Field label="Screen direction">
        <div className="grid grid-cols-3 gap-1">
          {([
            { value: "left_to_right", label: "←" },
            { value: "neutral", label: "neutral" },
            { value: "right_to_left", label: "→" },
          ] as Array<{ value: ScreenDirection; label: string }>).map((opt) => {
            const active = current.screenDirection === opt.value;
            return (
              <button
                key={opt.value}
                type="button"
                disabled={disabled}
                onClick={() =>
                  commit({
                    screenDirection: active ? undefined : opt.value,
                  })
                }
                className={cn(
                  "rounded-md border px-2 py-1.5 text-xs transition-colors",
                  "border-border/60 bg-background/60 hover:bg-background/80",
                  active && "border-primary/50 bg-primary/15 ring-1 ring-primary/30",
                  disabled && "opacity-60 cursor-not-allowed",
                )}
              >
                {opt.label}
              </button>
            );
          })}
        </div>
      </Field>

      <Field label="Blocking notes">
        <Textarea
          defaultValue={current.blockingNotes ?? ""}
          placeholder="Where the actors stand, where they move, eyelines..."
          className="min-h-[72px] bg-background/60"
          disabled={disabled}
          onBlur={(e) =>
            commit({ blockingNotes: e.target.value.trim() || undefined })
          }
        />
      </Field>

      <Field label="Props (comma-separated)">
        <Input
          defaultValue={(current.props ?? []).join(", ")}
          placeholder="briefcase, umbrella"
          disabled={disabled}
          onBlur={(e) => commitListField("props", e.target.value)}
        />
      </Field>

      <Field label="SFX (comma-separated)">
        <Input
          defaultValue={(current.sfx ?? []).join(", ")}
          placeholder="thunder, footsteps"
          disabled={disabled}
          onBlur={(e) => commitListField("sfx", e.target.value)}
        />
      </Field>

      <Field label="VFX (comma-separated)">
        <Input
          defaultValue={(current.vfx ?? []).join(", ")}
          placeholder="muzzle flash, screen replacement"
          disabled={disabled}
          onBlur={(e) => commitListField("vfx", e.target.value)}
        />
      </Field>
    </div>
  );
}

function Toggle({
  label,
  value,
  onChange,
  disabled,
}: {
  label: string;
  value: boolean;
  onChange: (next: boolean) => void;
  disabled: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => onChange(!value)}
      className={cn(
        "rounded-lg border px-3 py-2 text-left transition-colors",
        "border-border/60 bg-background/60 hover:bg-background/80",
        value && "border-primary/40 ring-1 ring-primary/30",
        disabled && "opacity-60 cursor-not-allowed",
      )}
    >
      <div className="text-xs font-medium">{label}</div>
      <div className="text-[11px] text-muted-foreground mt-0.5">{value ? "On" : "Off"}</div>
    </button>
  );
}

// ---------------------------------------------------------------------------
// CharactersInShotSection
//
// Renders chips for every character id on the node's `entityRefs.characterIds`
// and a dropdown of the storyboard's identity packs to add more. Characters
// can be added, removed, or swapped here — the source of truth is the node's
// entityRefs, which gets persisted through `onSetCharacterIds`.
//
// Character identifiers are matched to identityPacks by the pack's
// `sourceCharacterId` string (set by the ViMax ingester; can match the pack's
// `name` as a fallback for packs created by hand).
// ---------------------------------------------------------------------------

interface CharactersInShotSectionProps {
  nodeId: string;
  storyboardId?: string;
  characterIds: string[];
  onSetCharacterIds?: (nodeId: string, characterIds: string[]) => Promise<void> | void;
  disabled?: boolean;
}

interface IdentityPackRow {
  _id: string;
  packId: string;
  name: string;
  sourceCharacterId?: string;
  published?: boolean;
  visibility?: string;
  // "cameo" when the pack is backed by an AutoCameo real-person photo.
  // Undefined / "generated" for packs produced by the regular ingestion
  // pipeline. Surfaces as a small amber badge on the character chip so
  // producers know the character carries real-world consent obligations.
  sourceType?: "generated" | "cameo";
}

interface ConstraintBundleQueryResult {
  identityPacks?: IdentityPackRow[];
}

// ---------------------------------------------------------------------------
// NarrationOverrideSection (M5 #5)
//
// Lets producers override the per-shot TTS narration text. When empty,
// the audio batch derives narration from `segment`; when set, the override
// is used verbatim. Blur-commit so the mutation doesn't fire on every
// keystroke.
// ---------------------------------------------------------------------------

interface NarrationOverrideSectionProps {
  nodeId: string;
  audioDesc: string;
  derivedFallback: string;
  onSetAudioDesc?: (nodeId: string, audioDesc: string) => Promise<void> | void;
  disabled?: boolean;
}

function NarrationOverrideSection({
  nodeId,
  audioDesc,
  derivedFallback,
  onSetAudioDesc,
  disabled,
}: NarrationOverrideSectionProps) {
  const [draft, setDraft] = useState(audioDesc);
  const [saving, setSaving] = useState(false);

  // Sync draft when the panel re-opens on a different node or the
  // server value changes via another client.
  useEffect(() => {
    setDraft(audioDesc);
  }, [audioDesc, nodeId]);

  const commit = useCallback(
    async (next: string) => {
      if (!onSetAudioDesc) return;
      if (next.trim() === audioDesc.trim()) return;
      setSaving(true);
      try {
        await onSetAudioDesc(nodeId, next);
      } finally {
        setSaving(false);
      }
    },
    [audioDesc, nodeId, onSetAudioDesc],
  );

  const isOverridden = audioDesc.trim().length > 0;
  const preview =
    (isOverridden ? audioDesc : derivedFallback).trim().slice(0, 140) || "—";

  return (
    <div className="rounded-xl border border-border/60 bg-card/40 p-3">
      <div className="flex items-center justify-between">
        <div className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-1.5">
          <Volume2 className="size-3.5" />
          Narration override
        </div>
        <span
          className={cn(
            "rounded-full border px-2 py-0.5 text-[10px]",
            isOverridden
              ? "border-amber-400/40 bg-amber-400/10 text-amber-200"
              : "border-border/60 bg-background/60 text-muted-foreground",
          )}
        >
          {isOverridden ? "custom" : "auto-extracted"}
        </span>
      </div>
      <div className="mt-2 text-[11px] text-muted-foreground">
        What the TTS voice reads for this shot. Leave empty to auto-extract
        from the shot&apos;s segment text.
      </div>
      <Textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={(e) => void commit(e.target.value)}
        placeholder={derivedFallback.slice(0, 180) || "Narration text…"}
        disabled={disabled || !onSetAudioDesc || saving}
        className="mt-2 min-h-[72px] bg-background/60 text-[12px]"
        maxLength={4096}
      />
      <div className="mt-1.5 flex items-center justify-between text-[10px] text-muted-foreground">
        <span className="tabular-nums">{draft.length} / 4096</span>
        {isOverridden ? (
          <button
            type="button"
            className="text-[10px] underline hover:text-foreground disabled:opacity-50"
            onClick={() => {
              setDraft("");
              void commit("");
            }}
            disabled={disabled || !onSetAudioDesc || saving}
          >
            Clear override
          </button>
        ) : (
          <span className="max-w-[60%] truncate" title={preview}>
            Will read: “{preview}{preview.length >= 140 ? "…" : ""}”
          </span>
        )}
      </div>
    </div>
  );
}

function CharactersInShotSection({
  nodeId,
  storyboardId,
  characterIds,
  onSetCharacterIds,
  disabled,
}: CharactersInShotSectionProps) {
  const [picking, setPicking] = useState(false);
  const [pickerValue, setPickerValue] = useState("");

  const bundle = useQuery(
    queryRef("continuityOS:listConstraintBundle"),
    storyboardId ? { storyboardId } : "skip",
  ) as ConstraintBundleQueryResult | undefined;
  const packs = bundle?.identityPacks ?? [];

  // Map from character identifier → pack (for display). Match against
  // sourceCharacterId first, then pack name.
  const packByIdentifier = useMemo(() => {
    const map = new Map<string, IdentityPackRow>();
    for (const p of packs) {
      if (p.sourceCharacterId) map.set(p.sourceCharacterId, p);
      map.set(p.name, p);
    }
    return map;
  }, [packs]);

  const availableToAdd = useMemo(() => {
    const current = new Set(characterIds);
    return packs.filter((p) => {
      const key = p.sourceCharacterId ?? p.name;
      return !current.has(key);
    });
  }, [packs, characterIds]);

  const commit = (next: string[]) => {
    if (!onSetCharacterIds) return;
    void onSetCharacterIds(nodeId, next);
  };

  const handleAdd = (value: string) => {
    if (!value) return;
    if (characterIds.includes(value)) return;
    commit([...characterIds, value]);
    setPicking(false);
    setPickerValue("");
  };

  const handleRemove = (value: string) => {
    commit(characterIds.filter((id) => id !== value));
  };

  const resolvedForIdentifier = (id: string): IdentityPackRow | null =>
    packByIdentifier.get(id) ?? null;

  return (
    <div className="rounded-xl border border-border/60 bg-card/40 p-3">
      <div className="flex items-center justify-between">
        <div className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-1.5">
          <Users className="size-3.5" />
          Characters in shot
        </div>
        <span className="text-[11px] text-muted-foreground">
          {characterIds.length} / {packs.length} packs
        </span>
      </div>

      {characterIds.length === 0 ? (
        <div className="mt-2 text-xs text-muted-foreground">
          No characters linked to this shot yet. Link a character to surface
          their identity pack + reference portraits during media generation.
        </div>
      ) : (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {characterIds.map((id) => {
            const resolved = resolvedForIdentifier(id);
            const isCameo = resolved?.sourceType === "cameo";
            return (
              <span
                key={id}
                className={cn(
                  "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px]",
                  resolved
                    ? "border-sky-400/35 bg-sky-500/15 text-sky-200"
                    : "border-amber-400/35 bg-amber-500/15 text-amber-200",
                )}
                title={
                  resolved
                    ? isCameo
                      ? `Linked to pack "${resolved.name}" — backed by an AutoCameo real-person photo`
                      : `Linked to pack "${resolved.name}"`
                    : `No identity pack found for "${id}"`
                }
              >
                {resolved?.name ?? id}
                {isCameo ? (
                  <span
                    className="rounded-sm bg-amber-500/30 px-1 py-[1px] text-[9px] font-semibold uppercase tracking-wide text-amber-100"
                    aria-label="AutoCameo reference"
                  >
                    cameo
                  </span>
                ) : null}
                {onSetCharacterIds && !disabled ? (
                  <button
                    type="button"
                    onClick={() => handleRemove(id)}
                    className="ml-0.5 rounded-full p-0.5 hover:bg-white/10"
                    aria-label={`Remove ${resolved?.name ?? id}`}
                  >
                    <X className="size-3" />
                  </button>
                ) : null}
              </span>
            );
          })}
        </div>
      )}

      {onSetCharacterIds ? (
        picking ? (
          <div className="mt-2 flex items-center gap-2">
            <select
              value={pickerValue}
              onChange={(e) => setPickerValue(e.target.value)}
              className="flex-1 rounded-md border border-border bg-background px-2 py-1.5 text-sm"
              disabled={disabled}
            >
              <option value="">Select a character…</option>
              {availableToAdd.map((p) => (
                <option
                  key={p._id}
                  value={p.sourceCharacterId ?? p.name}
                >
                  {p.name}
                  {p.sourceCharacterId && p.sourceCharacterId !== p.name
                    ? ` (${p.sourceCharacterId})`
                    : ""}
                </option>
              ))}
            </select>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => handleAdd(pickerValue)}
              disabled={!pickerValue || disabled}
            >
              Add
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => {
                setPicking(false);
                setPickerValue("");
              }}
              disabled={disabled}
            >
              Cancel
            </Button>
          </div>
        ) : (
          <div className="mt-3">
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 gap-1.5 text-[11px]"
              onClick={() => setPicking(true)}
              disabled={disabled || availableToAdd.length === 0}
              title={
                availableToAdd.length === 0
                  ? "All identity packs are already linked"
                  : "Add a character to this shot"
              }
            >
              <Plus className="size-3.5" />
              Add character
            </Button>
          </div>
        )
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// M7 — per-shot SFX (ambient / foley) generator.
// ---------------------------------------------------------------------------
// Producers describe a sound (e.g. "soft rain on glass"), pick a
// duration that mirrors the shot's own durationS by default, and set
// the mix level in dB. Generation is a single round-trip to
// /api/media/generate-sfx which returns an uploaded asset URL; the
// `kind: "sfx"` mediaAsset mutation patches the node's activeSfxId
// so the reel export pipeline picks it up automatically.
// ---------------------------------------------------------------------------

interface SfxSectionProps {
  storyboardId: string;
  nodeId: string;
  /** URL of the currently-active SFX track (null when none assigned). */
  activeSfxUrl: string | null;
  /** Convex id of the currently-active SFX media asset. Needed for the
   *  live-volume slider which patches metadata on the asset directly. */
  activeSfxId: string | null;
  /** Shot's declared duration — used as the default SFX duration so
   *  the ambient track doesn't outrun the narration. */
  shotDurationS?: number;
  disabled?: boolean;
}

function SfxSection({
  storyboardId,
  nodeId,
  activeSfxUrl,
  activeSfxId,
  shotDurationS,
  disabled,
}: SfxSectionProps) {
  const [prompt, setPrompt] = useState("");
  const [durationS, setDurationS] = useState<number>(() => {
    // Default to the shot's declared duration when available, clamped
    // into the SFX window. Never returns NaN.
    const d = typeof shotDurationS === "number" ? shotDurationS : 5;
    return Math.max(
      SFX_MIN_DURATION_S,
      Math.min(SFX_MAX_DURATION_S, Number.isFinite(d) ? d : 5),
    );
  });
  const [volumeDb, setVolumeDb] = useState<number>(DEFAULT_SFX_VOLUME_DB);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const createMediaAsset = useMutation(
    mutationRef("mediaAssets:createMediaAsset"),
  );
  const setSfxVolumeMutation = useMutation(
    mutationRef("mediaAssets:setSfxVolume"),
  );

  // M7 — live-trim slider. Reads the current volume off the active
  // SFX asset's metadata when it loads, and writes back on change so
  // the reel export picks up the producer's choice. Skipped when no
  // SFX is attached (the slider governs the NEXT generation's default
  // in that case, controlled via local state only).
  const activeSfxMetadata = useQuery(
    queryRef("mediaAssets:getSfxAssetMetadata"),
    activeSfxId ? { mediaAssetId: activeSfxId as never } : "skip",
  ) as { volumeDb: number | null } | null | undefined;

  // When the query resolves, sync the slider to the server value so
  // two tabs / two clients agree. Only runs on active-sfx changes
  // (not on every keystroke in the slider).
  useEffect(() => {
    if (
      activeSfxId
      && activeSfxMetadata
      && typeof activeSfxMetadata.volumeDb === "number"
    ) {
      setVolumeDb(activeSfxMetadata.volumeDb);
    }
  }, [activeSfxId, activeSfxMetadata]);

  const handleVolumeChange = useCallback(
    async (next: number) => {
      setVolumeDb(next);
      if (!activeSfxId) return;
      try {
        await setSfxVolumeMutation({
          mediaAssetId: activeSfxId as never,
          volumeDb: next,
        });
      } catch (err) {
        // Surface the error inline; the slider value is already set
        // locally so the producer can retry by nudging the slider.
        setError(
          err instanceof Error ? err.message : "Failed to save volume.",
        );
      }
    },
    [activeSfxId, setSfxVolumeMutation],
  );

  const handleGenerate = async () => {
    if (!prompt.trim()) {
      setError("Describe the sound effect first.");
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const res = await fetch("/api/media/generate-sfx", {
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
          payload.error ?? `SFX generation failed (${res.status})`,
        );
      }
      const data = (await res.json()) as {
        url: string;
        provider: string;
      };
      // Persist as a mediaAsset with kind="sfx"; createMediaAsset
      // updates the node's activeSfxId automatically.
      await createMediaAsset({
        storyboardId: storyboardId as never,
        nodeId,
        kind: "sfx",
        sourceUrl: data.url,
        modelId: data.provider,
        prompt: prompt.trim(),
        status: "completed",
        metadata: {
          durationS: String(durationS),
          volumeDb: String(volumeDb),
        },
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-xl border border-border/60 bg-card/40 p-3">
      <div className="flex items-center justify-between">
        <div className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-1.5">
          <Music className="size-3.5" />
          Sound effects
        </div>
        <span
          className={cn(
            "rounded-full border px-2 py-0.5 text-[10px]",
            activeSfxUrl
              ? "border-emerald-400/40 bg-emerald-400/10 text-emerald-200"
              : "border-border/60 bg-background/60 text-muted-foreground",
          )}
        >
          {activeSfxUrl ? "attached" : "none"}
        </span>
      </div>
      <div className="mt-2 text-[11px] text-muted-foreground">
        Ambient/foley layer mixed UNDER the narration during export.
      </div>
      <Textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value.slice(0, SFX_PROMPT_MAX_CHARS))}
        placeholder={"e.g. \"soft rain on glass, distant thunder\""}
        disabled={disabled || busy}
        className="mt-2 min-h-[56px] bg-background/60 text-[12px]"
        maxLength={SFX_PROMPT_MAX_CHARS}
      />
      <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px]">
        <label className="flex items-center gap-1 text-muted-foreground">
          Duration
          <input
            type="number"
            min={SFX_MIN_DURATION_S}
            max={SFX_MAX_DURATION_S}
            step={1}
            value={durationS}
            onChange={(e) =>
              setDurationS(
                Math.max(
                  SFX_MIN_DURATION_S,
                  Math.min(
                    SFX_MAX_DURATION_S,
                    Number(e.target.value) || SFX_MIN_DURATION_S,
                  ),
                ),
              )
            }
            disabled={disabled || busy}
            className="h-6 w-14 rounded border border-border/60 bg-background/60 px-1.5 text-[11px]"
          />
          s
        </label>
        <label
          className="flex items-center gap-1 text-muted-foreground"
          title={
            activeSfxId
              ? "Volume trim — saves to the active SFX asset so the reel export uses this level."
              : "Volume the next-generated SFX will be mixed at."
          }
        >
          Volume
          <input
            type="range"
            min={SFX_MIN_VOLUME_DB}
            max={SFX_MAX_VOLUME_DB}
            step={1}
            value={volumeDb}
            onChange={(e) => {
              const next = Math.max(
                SFX_MIN_VOLUME_DB,
                Math.min(
                  SFX_MAX_VOLUME_DB,
                  Number(e.target.value) || DEFAULT_SFX_VOLUME_DB,
                ),
              );
              void handleVolumeChange(next);
            }}
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
              {activeSfxUrl ? "Regenerate" : "Generate"}
            </>
          )}
        </Button>
      </div>
      {activeSfxUrl ? (
        <audio
          src={activeSfxUrl}
          controls
          preload="none"
          className="mt-2 w-full"
        />
      ) : null}
      {/* M7 — previous takes. Producers often iterate the prompt a
          few times before landing on one they like; keeping every
          variant listed lets them swap back without regenerating. */}
      <SfxVariantsList
        storyboardId={storyboardId}
        nodeId={nodeId}
        activeSfxId={activeSfxId}
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

// ---------------------------------------------------------------------------
// M7 — historical SFX takes picker.
// ---------------------------------------------------------------------------
// Shows every completed SFX mediaAsset for a node; clicking a row
// flips the node's `activeSfxId` via `setActiveMediaVariant`. Producers
// can audition past takes via the inline audio scrubber before
// committing.
// ---------------------------------------------------------------------------

interface SfxVariantsListProps {
  storyboardId: string;
  nodeId: string;
  activeSfxId: string | null;
  disabled?: boolean;
}

function SfxVariantsList({
  storyboardId,
  nodeId,
  activeSfxId,
  disabled,
}: SfxVariantsListProps) {
  const variants = useQuery(queryRef("mediaAssets:listNodeMedia"), {
    storyboardId: storyboardId as never,
    nodeId,
    kind: "sfx",
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

  const setActiveMediaVariant = useMutation(
    mutationRef("mediaAssets:setActiveMediaVariant"),
  );
  const [switching, setSwitching] = useState<string | null>(null);

  const completed = useMemo(
    () => (variants ?? []).filter((v) => v.status === "completed"),
    [variants],
  );

  if (completed.length <= 1) {
    // Hide the picker entirely when there's nothing to pick between —
    // the single-active case is already handled by the <audio>
    // element above.
    return null;
  }

  const handleActivate = async (mediaAssetId: string) => {
    if (disabled || switching || mediaAssetId === activeSfxId) return;
    setSwitching(mediaAssetId);
    try {
      await setActiveMediaVariant({
        storyboardId: storyboardId as never,
        nodeId,
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
          const isActive = variant._id === activeSfxId;
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
                    ? "This take is already active."
                    : "Make this take the active SFX for the shot."
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

