"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useCoAgent, useCopilotAction, useCopilotReadable, useHumanInTheLoop } from "@copilotkit/react-core";
import { CopilotSidebar } from "@copilotkit/react-ui";
import { useMutation } from "convex/react";
import {
  RuntimeResolvedTeam,
  type ScriptIngestProgress,
  StoryEdge,
  StoryNode,
  TeamMemberConfig,
  TeamPromptDraft,
  type UserIdentity,
} from "@/app/storyboard/types";
import { mutationRef } from "@/lib/convexRefs";
import {
  executeApprovedGraphPatch,
  executeApprovedMediaPrompt,
  executeApprovedExecutionPlan,
  executeRejectedGraphPatch,
  executeRejectedMediaPrompt,
  executeRejectedExecutionPlan,
  type AdapterDependencies,
  type ExecutionPlanInput,
  type GraphPatchInput,
  type MediaPromptInput,
} from "@/app/storyboard/agentExecutionAdapter";

type ApprovalSummary = {
  _id: string;
  taskType: string;
  status: string;
  title: string;
};

type AgentGraphNode = {
  id: string;
  nodeType: string;
  label: string;
  segment: string;
  continuityStatus: "ok" | "warning" | "blocked";
};

type AgentGraphEdge = {
  id: string;
  source: string;
  target: string;
};

type RollingContextMap = Record<
  string,
  {
    rollingSummary: string;
    lineageHash: string;
    tokenBudgetUsed: number;
    eventIds: string[];
  }
>;

// Canonical `UserIdentity` now lives in `@/app/storyboard/types`; it is
// re-exported here so existing imports from the bridge keep working.
export type { UserIdentity };

type StoryboardAgentState = {
  storyboardId: string;
  mode: "graph_studio" | "agent_draft";
  graphSnapshot: {
    nodes: AgentGraphNode[];
    edges: AgentGraphEdge[];
  };
  rollingContextMap: RollingContextMap;
  pendingApprovals: ApprovalSummary[];
  providerPolicy: {
    requiresHitl: boolean;
    imageExecutor: string;
    videoExecutor: string;
  };
  activeTeam: {
    teamId: string;
    teamName: string;
    revisionId: string;
    version: number;
  } | null;
  activeTeamRevision: string | null;
  teamGoal: string | null;
  teamPolicy: RuntimeResolvedTeam["runtimePolicy"] | null;
  effectiveToolScope: string[];
  effectiveResourceScope: string[];
  delegationView: {
    pendingApprovals: number;
    requiresHitl: boolean;
  };
  team_config: RuntimeResolvedTeam | null;
  runtime_policy: RuntimeResolvedTeam["runtimePolicy"] | null;
  effective_tool_scope: string[];
  effective_resource_scope: string[];
  // Signed-in user driving this agent session. `null` until the session resolves;
  // the route handler still requires a valid session token so an `null` here just
  // means the client hasn't hydrated yet, not that the agent is unauthenticated.
  userIdentity: UserIdentity | null;
  // Snake-cased alias so the Python router (`RouterState`) can log the identity in
  // its `policy_trace` for audit correlation without re-mapping in the graph.
  user_identity: UserIdentity | null;
  // Screenplay ingestion progress (ViMax M1). `null` outside of an active
  // ingestion run. The Python screenplay_ingester subagent patches this
  // field as it walks through the pipeline stages; CopilotKit's state sync
  // pushes the updates to the React form's progress bar.
  scriptIngestProgress: ScriptIngestProgress | null;
  // Snake-cased alias for the Python router.
  script_ingest_progress: ScriptIngestProgress | null;
};

type DryRunRiskLevel = "low" | "medium" | "high" | "critical";

const EMPTY_APPROVALS: ApprovalSummary[] = [];
const PROVIDER_POLICY = {
  requiresHitl: true,
  imageExecutor: "fastapi:/api/image/generate",
  videoExecutor: "fastapi:/api/video/generate",
} as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const parseRiskLevel = (value: unknown): DryRunRiskLevel => {
  if (value === "low" || value === "medium" || value === "high" || value === "critical") {
    return value;
  }
  return "medium";
};

// ---------------------------------------------------------------------------
// M3 #4 — Agent/chat ingestion + shot-batch gating helpers.
// ---------------------------------------------------------------------------

type IngestionMode = "screenplay" | "idea" | "novel";

export type IngestionRunInput = {
  mode: IngestionMode;
  title: string;
  rationale: string;
  hints: Record<string, string | number>;
};

export type GenerateShotBatchInput = {
  storyboardId: string;
  branchId: string;
  nodeCount: number;
  rationale: string;
  skipExisting: boolean;
  concurrency: number;
};

export type GenerateShotVideoBatchInput = {
  storyboardId: string;
  branchId: string;
  nodeCount: number;
  rationale: string;
  skipExisting: boolean;
  concurrency: number;
  videoModelId: string;
};

export type GenerateShotAudioBatchInput = {
  storyboardId: string;
  branchId: string;
  nodeCount: number;
  rationale: string;
  skipExisting: boolean;
  concurrency: number;
  voice: string;
  model: string;
  speed: number;
};

export type ExportReelInput = {
  storyboardId: string;
  rationale: string;
  shotCount: number;
  estimatedDurationS: number;
};

export type GenerateScoreInput = {
  storyboardId: string;
  prompt: string;
  durationS: number;
  volumeDb: number;
  rationale: string;
};

export type DailiesCriticReviewInput = {
  storyboardId: string;
  dailiesReelId: string;
  rationale: string;
};

export type BeatAssignmentEntry = {
  nodeId: string;
  beatKey: string;
  actNumber?: number;
  rationale?: string;
};

export type BeatAssignmentInput = {
  storyboardId: string;
  branchId: string;
  structure: string;
  assignments: BeatAssignmentEntry[];
  assignmentCount: number;
  overrideExisting: boolean;
  rationale: string;
};

export type ShotSfxBatchInput = {
  storyboardId: string;
  branchId: string;
  nodeCount: number;
  rationale: string;
  skipExisting: boolean;
  concurrency: number;
};

// M9 Phase 3 — variant generation (cold-open hooks + structural remix).
// Every variant becomes its own narrative-git branch on approve: the
// handler calls narrativeGit:createBranch, commits the variant's
// planOps via narrativeGit:commitPlanOps, then records the variant
// metadata via narrativeState:upsertVariant so the Variant Compare tab
// can enumerate candidates.
// Matches convex/narrativeGit.ts `executionOperation` shape — every
// field the Convex validator will accept on commitPlanOps. The parser
// passes through known fields verbatim; the Convex validator remains
// the source of truth so field drift between bridge + backend fails
// loudly rather than silently dropping data.
export type HookVariantPlanOp = {
  op:
    | "create_node"
    | "update_node"
    | "delete_node"
    | "create_edge"
    | "update_edge"
    | "delete_edge";
  opId?: string;
  title: string;
  rationale?: string;
  nodeId?: string;
  edgeId?: string;
  nodeType?:
    | "scene"
    | "shot"
    | "branch"
    | "merge"
    | "character_ref"
    | "background_ref";
  label?: string;
  segment?: string;
  position?: { x: number; y: number };
  sourceNodeId?: string;
  targetNodeId?: string;
  edgeType?: "serial" | "parallel" | "branch" | "merge";
  branchId?: string;
  order?: number;
  isPrimary?: boolean;
};

export type HookVariantEntry = {
  variantId: string;
  rationale: string;
  expectedRetention: string;
  branchName: string;
  planOps: HookVariantPlanOp[];
};

export type HookVariantInput = {
  storyboardId: string;
  parentBranchId: string;
  variants: HookVariantEntry[];
  variantCount: number;
  rationale: string;
};

export type StructuralRemixEntry = {
  variantId: string;
  rationale: string;
  strategy: string;
  branchName: string;
  planOps: HookVariantPlanOp[];
};

export type StructuralRemixInput = {
  storyboardId: string;
  parentBranchId: string;
  targetStructure: string;
  variants: StructuralRemixEntry[];
  variantCount: number;
  rationale: string;
};

// M9 Phase 4 — transitions + motifs.
export type TransitionProposalEntry = {
  intent: string;
  rawIntent?: string;
  rationale?: string;
  sharedElement?: string;
  planOps?: HookVariantPlanOp[];
  rank?: number;
};

export type TransitionProposalInput = {
  storyboardId: string;
  branchId: string;
  sourceNodeId: string;
  targetNodeId: string;
  proposals: TransitionProposalEntry[];
  proposalCount: number;
  rationale: string;
};

export type MotifPlantInput = {
  storyboardId: string;
  branchId: string;
  motifKey: string;
  targetNodeId: string;
  description: string;
  visualVocabulary: string;
  sourceNodeIds: string[];
  payoffNodeIds: string[];
  planOps: HookVariantPlanOp[];
  rationale: string;
};

export type VoiceCastAssignment = {
  packId: string;
  voice: string;
};

export type AssignVoiceCastInput = {
  storyboardId: string;
  assignments: VoiceCastAssignment[];
  rationale: string;
};

/**
 * CustomEvent name the bridge dispatches to kick off the batch button. The
 * `GenerateAllShotsButton` listens for this on `window` so the agent doesn't
 * need an imperative handle on the button component — decoupling avoids
 * having to thread a ref through the 2150-line storyboard page.
 */
export const SHOT_BATCH_TRIGGER_EVENT = "storyboard:generate-shot-batch";

export type ShotBatchTriggerDetail = {
  storyboardId: string;
  skipExisting: boolean;
  concurrency: number;
};

const dispatchShotBatchTrigger = (detail: ShotBatchTriggerDetail): void => {
  if (typeof window === "undefined") {
    return;
  }
  window.dispatchEvent(
    new CustomEvent<ShotBatchTriggerDetail>(SHOT_BATCH_TRIGGER_EVENT, { detail }),
  );
};

/**
 * M5 — distinct event name for the video batch so the image button and
 * video button can subscribe independently. Mirrors
 * `SHOT_BATCH_TRIGGER_EVENT` but carries an optional `videoModelId`.
 */
export const SHOT_VIDEO_BATCH_TRIGGER_EVENT =
  "storyboard:generate-shot-video-batch";

export type ShotVideoBatchTriggerDetail = {
  storyboardId: string;
  skipExisting: boolean;
  concurrency: number;
  videoModelId?: string;
};

const dispatchShotVideoBatchTrigger = (
  detail: ShotVideoBatchTriggerDetail,
): void => {
  if (typeof window === "undefined") {
    return;
  }
  window.dispatchEvent(
    new CustomEvent<ShotVideoBatchTriggerDetail>(
      SHOT_VIDEO_BATCH_TRIGGER_EVENT,
      { detail },
    ),
  );
};

/**
 * M5 #4 — matching event for the audio batch. Keep the name stable with
 * GenerateAllAudiosButton's own declaration so one listener fires for
 * both the in-component run button and agent-driven dispatches.
 */
export const SHOT_AUDIO_BATCH_TRIGGER_EVENT =
  "storyboard:generate-shot-audio-batch";

/**
 * M7 — ambient/foley SFX batch trigger. Mirrors the audio batch event
 * so `GenerateAllSfxsButton` can subscribe once and drive both
 * producer-initiated + agent-initiated SFX runs.
 */
export const SHOT_SFX_BATCH_TRIGGER_EVENT =
  "storyboard:generate-shot-sfx-batch";

export type ShotSfxBatchTriggerDetail = {
  storyboardId: string;
  skipExisting: boolean;
  concurrency: number;
};

const dispatchShotSfxBatchTrigger = (
  detail: ShotSfxBatchTriggerDetail,
): void => {
  if (typeof window === "undefined") {
    return;
  }
  window.dispatchEvent(
    new CustomEvent<ShotSfxBatchTriggerDetail>(
      SHOT_SFX_BATCH_TRIGGER_EVENT,
      { detail },
    ),
  );
};

export type ShotAudioBatchTriggerDetail = {
  storyboardId: string;
  skipExisting: boolean;
  concurrency: number;
  voice?: string;
  model?: string;
  speed?: number;
};

const dispatchShotAudioBatchTrigger = (
  detail: ShotAudioBatchTriggerDetail,
): void => {
  if (typeof window === "undefined") {
    return;
  }
  window.dispatchEvent(
    new CustomEvent<ShotAudioBatchTriggerDetail>(
      SHOT_AUDIO_BATCH_TRIGGER_EVENT,
      { detail },
    ),
  );
};

/**
 * Build the storyboard-editor URL that carries a deferred shot-batch
 * trigger as query params. The target page reads these on mount via
 * `consumeShotBatchTriggerParams`, dispatches the CustomEvent the button
 * listens for, and strips the params so a refresh doesn't re-fire.
 *
 * Shared as an exported helper so bridge tests and the storyboard page
 * round-trip the same encoding.
 */
export const buildShotBatchNavHref = (detail: ShotBatchTriggerDetail): string => {
  const params = new URLSearchParams();
  params.set("triggerBatch", "1");
  params.set("batchSkipExisting", detail.skipExisting ? "1" : "0");
  params.set("batchConcurrency", String(Math.max(1, Math.min(6, detail.concurrency))));
  return `/storyboard/${encodeURIComponent(detail.storyboardId)}?${params.toString()}`;
};

const parseIngestionMode = (value: unknown): IngestionMode | null => {
  if (value === "screenplay" || value === "idea" || value === "novel") {
    return value;
  }
  return null;
};

const parseIngestionRunInput = (value: unknown): IngestionRunInput | null => {
  if (!isRecord(value)) {
    return null;
  }
  const mode = parseIngestionMode(value.mode);
  const title = typeof value.title === "string" ? value.title : "";
  const rationale = typeof value.rationale === "string" ? value.rationale : "";
  if (!mode || !title) {
    return null;
  }
  const rawHints = isRecord(value.hints) ? value.hints : {};
  const hints: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(rawHints)) {
    if (typeof v === "string" && v.length > 0) {
      hints[k] = v;
    } else if (typeof v === "number" && Number.isFinite(v)) {
      hints[k] = v;
    }
  }
  return { mode, title, rationale, hints };
};

const parseGenerateShotBatchInput = (value: unknown): GenerateShotBatchInput | null => {
  if (!isRecord(value)) {
    return null;
  }
  const storyboardId = typeof value.storyboardId === "string" ? value.storyboardId : "";
  const branchId = typeof value.branchId === "string" ? value.branchId : "main";
  const rationale = typeof value.rationale === "string" ? value.rationale : "";
  const nodeCount = typeof value.nodeCount === "number" && Number.isFinite(value.nodeCount)
    ? Math.max(0, Math.floor(value.nodeCount))
    : 0;
  const skipExistingRaw = value.skipExisting;
  const skipExisting = typeof skipExistingRaw === "boolean" ? skipExistingRaw : true;
  const concurrencyRaw = typeof value.concurrency === "number" && Number.isFinite(value.concurrency)
    ? Math.floor(value.concurrency)
    : 3;
  const concurrency = Math.max(1, Math.min(6, concurrencyRaw));
  if (!storyboardId) {
    return null;
  }
  return {
    storyboardId,
    branchId,
    nodeCount,
    rationale,
    skipExisting,
    concurrency,
  };
};

const parseGenerateShotVideoBatchInput = (
  value: unknown,
): GenerateShotVideoBatchInput | null => {
  if (!isRecord(value)) {
    return null;
  }
  const storyboardId =
    typeof value.storyboardId === "string" ? value.storyboardId : "";
  const branchId = typeof value.branchId === "string" ? value.branchId : "main";
  const rationale = typeof value.rationale === "string" ? value.rationale : "";
  const nodeCount =
    typeof value.nodeCount === "number" && Number.isFinite(value.nodeCount)
      ? Math.max(0, Math.floor(value.nodeCount))
      : 0;
  const skipExisting =
    typeof value.skipExisting === "boolean" ? value.skipExisting : true;
  const concurrencyRaw =
    typeof value.concurrency === "number" && Number.isFinite(value.concurrency)
      ? Math.floor(value.concurrency)
      : 2;
  // Video batch caps at 4 (vs 6 for image) — see Python tool rationale.
  const concurrency = Math.max(1, Math.min(4, concurrencyRaw));
  const videoModelId =
    typeof value.videoModelId === "string" && value.videoModelId.length > 0
      ? value.videoModelId
      : "ltx-2.3";
  if (!storyboardId) {
    return null;
  }
  return {
    storyboardId,
    branchId,
    nodeCount,
    rationale,
    skipExisting,
    concurrency,
    videoModelId,
  };
};

const parseGenerateScoreInput = (
  value: unknown,
): GenerateScoreInput | null => {
  if (!isRecord(value)) return null;
  const storyboardId =
    typeof value.storyboardId === "string" ? value.storyboardId : "";
  if (!storyboardId) return null;
  const prompt =
    typeof value.prompt === "string" ? value.prompt.trim() : "";
  if (!prompt) return null;
  const durationRaw =
    typeof value.durationS === "number" && Number.isFinite(value.durationS)
      ? Math.floor(value.durationS)
      : 60;
  // Mirror lib/score clamps so the bridge rejects nonsense before the
  // route sees it.
  const durationS = Math.max(10, Math.min(300, durationRaw));
  const volumeRaw =
    typeof value.volumeDb === "number" && Number.isFinite(value.volumeDb)
      ? Math.floor(value.volumeDb)
      : -18;
  const volumeDb = Math.max(-40, Math.min(0, volumeRaw));
  const rationale =
    typeof value.rationale === "string" ? value.rationale : "";
  return { storyboardId, prompt, durationS, volumeDb, rationale };
};

const parseDailiesCriticReviewInput = (
  value: unknown,
): DailiesCriticReviewInput | null => {
  if (!isRecord(value)) return null;
  const storyboardId =
    typeof value.storyboardId === "string" ? value.storyboardId : "";
  const dailiesReelId =
    typeof value.dailiesReelId === "string" ? value.dailiesReelId : "";
  if (!storyboardId || !dailiesReelId) return null;
  const rationale =
    typeof value.rationale === "string" ? value.rationale : "";
  return { storyboardId, dailiesReelId, rationale };
};

const parseBeatAssignmentInput = (
  value: unknown,
): BeatAssignmentInput | null => {
  if (!isRecord(value)) return null;
  const storyboardId =
    typeof value.storyboardId === "string" ? value.storyboardId : "";
  if (!storyboardId) return null;
  const branchId =
    typeof value.branchId === "string" && value.branchId.length > 0
      ? value.branchId
      : "main";
  const structureRaw =
    typeof value.structure === "string" ? value.structure : "";
  // Mirror the Python tool's fallback: unknown structures collapse to
  // save_the_cat so the producer always sees a valid roster in the
  // approval card.
  const structure = VALID_STRUCTURES.has(structureRaw)
    ? structureRaw
    : "save_the_cat";
  const rationale =
    typeof value.rationale === "string" ? value.rationale : "";
  const overrideExisting =
    typeof value.overrideExisting === "boolean"
      ? value.overrideExisting
      : false;
  const rawAssignments = Array.isArray(value.assignments)
    ? value.assignments
    : [];
  const assignments: BeatAssignmentEntry[] = [];
  for (const raw of rawAssignments) {
    if (!isRecord(raw)) continue;
    const nodeId = typeof raw.nodeId === "string" ? raw.nodeId.trim() : "";
    const beatKey = typeof raw.beatKey === "string" ? raw.beatKey.trim() : "";
    if (!nodeId || !beatKey) continue;
    const entry: BeatAssignmentEntry = { nodeId, beatKey };
    if (typeof raw.actNumber === "number" && Number.isFinite(raw.actNumber)) {
      entry.actNumber = Math.max(1, Math.min(5, Math.round(raw.actNumber)));
    }
    if (typeof raw.rationale === "string" && raw.rationale.trim()) {
      entry.rationale = raw.rationale.trim().slice(0, 400);
    }
    assignments.push(entry);
  }
  return {
    storyboardId,
    branchId,
    structure,
    assignments,
    assignmentCount: assignments.length,
    overrideExisting,
    rationale,
  };
};

// M9 Phase 3 — plan-op parser shared by hook + remix variants. Mirrors
// the Python `_sanitize_plan_ops` rules: drop non-dicts, unknown op
// types, and entries with empty titles. The Convex `commitPlanOps`
// mutation runs its own shape checks at apply time; this parser is the
// client-side UX guard so the approval card only shows variants that
// can actually commit.
const VALID_PLAN_OPS = new Set([
  "create_node",
  "update_node",
  "delete_node",
  "create_edge",
  "update_edge",
  "delete_edge",
]);

const VALID_NODE_TYPES = new Set([
  "scene",
  "shot",
  "branch",
  "merge",
  "character_ref",
  "background_ref",
]);

const VALID_EDGE_TYPES = new Set(["serial", "parallel", "branch", "merge"]);

const parsePlanOpList = (value: unknown): HookVariantPlanOp[] => {
  if (!Array.isArray(value)) return [];
  const ops: HookVariantPlanOp[] = [];
  for (const raw of value) {
    if (!isRecord(raw)) continue;
    const op = typeof raw.op === "string" ? raw.op : "";
    if (!VALID_PLAN_OPS.has(op)) continue;
    const title = typeof raw.title === "string" ? raw.title.trim() : "";
    if (!title) continue;
    const planOp: HookVariantPlanOp = {
      op: op as HookVariantPlanOp["op"],
      title: title.slice(0, 200),
    };
    if (typeof raw.opId === "string" && raw.opId.trim()) {
      planOp.opId = raw.opId.trim().slice(0, 80);
    }
    if (typeof raw.rationale === "string" && raw.rationale.trim()) {
      planOp.rationale = raw.rationale.trim().slice(0, 400);
    }
    if (typeof raw.nodeId === "string" && raw.nodeId.trim()) {
      planOp.nodeId = raw.nodeId.trim();
    }
    if (typeof raw.edgeId === "string" && raw.edgeId.trim()) {
      planOp.edgeId = raw.edgeId.trim();
    }
    if (typeof raw.nodeType === "string" && VALID_NODE_TYPES.has(raw.nodeType)) {
      planOp.nodeType = raw.nodeType as HookVariantPlanOp["nodeType"];
    }
    if (typeof raw.label === "string" && raw.label.trim()) {
      planOp.label = raw.label.trim().slice(0, 400);
    }
    if (typeof raw.segment === "string" && raw.segment.trim()) {
      planOp.segment = raw.segment.trim();
    }
    if (
      isRecord(raw.position)
      && typeof raw.position.x === "number"
      && typeof raw.position.y === "number"
    ) {
      planOp.position = { x: raw.position.x, y: raw.position.y };
    }
    if (typeof raw.sourceNodeId === "string" && raw.sourceNodeId.trim()) {
      planOp.sourceNodeId = raw.sourceNodeId.trim();
    }
    if (typeof raw.targetNodeId === "string" && raw.targetNodeId.trim()) {
      planOp.targetNodeId = raw.targetNodeId.trim();
    }
    if (typeof raw.edgeType === "string" && VALID_EDGE_TYPES.has(raw.edgeType)) {
      planOp.edgeType = raw.edgeType as HookVariantPlanOp["edgeType"];
    }
    if (typeof raw.branchId === "string" && raw.branchId.trim()) {
      planOp.branchId = raw.branchId.trim();
    }
    if (typeof raw.order === "number" && Number.isFinite(raw.order)) {
      planOp.order = raw.order;
    }
    if (typeof raw.isPrimary === "boolean") {
      planOp.isPrimary = raw.isPrimary;
    }
    ops.push(planOp);
  }
  return ops;
};

// Variant-id sanitizer — matches the Python tool so branch names stay
// URL-safe + consistent across agent + bridge.
const sanitizeVariantId = (raw: unknown): string => {
  const s = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (!s) return "";
  const cleaned = Array.from(s)
    .map((c) => (/[a-z0-9_-]/.test(c) ? c : "-"))
    .join("")
    .slice(0, 40);
  return cleaned || "unnamed";
};

const parseHookVariantInput = (
  value: unknown,
): HookVariantInput | null => {
  if (!isRecord(value)) return null;
  const storyboardId =
    typeof value.storyboardId === "string" ? value.storyboardId : "";
  if (!storyboardId) return null;
  const parentBranchId =
    typeof value.parentBranchId === "string" && value.parentBranchId.length > 0
      ? value.parentBranchId
      : "main";
  const rationale =
    typeof value.rationale === "string" ? value.rationale : "";
  const rawVariants = Array.isArray(value.variants) ? value.variants : [];
  const variants: HookVariantEntry[] = [];
  for (const raw of rawVariants) {
    if (!isRecord(raw)) continue;
    const variantId = sanitizeVariantId(raw.variantId);
    if (!variantId) continue;
    const planOps = parsePlanOpList(raw.planOps);
    if (planOps.length === 0) continue;
    const branchName =
      (typeof raw.branchName === "string" && raw.branchName.trim()
        ? raw.branchName.trim()
        : `Hook variant ${variantId}`).slice(0, 100);
    variants.push({
      variantId,
      rationale:
        typeof raw.rationale === "string" ? raw.rationale.slice(0, 800) : "",
      expectedRetention:
        typeof raw.expectedRetention === "string"
          ? raw.expectedRetention.slice(0, 300)
          : "",
      branchName,
      planOps,
    });
  }
  return {
    storyboardId,
    parentBranchId,
    variants,
    variantCount: variants.length,
    rationale,
  };
};

const VALID_STRUCTURES = new Set([
  "save_the_cat",
  "harmon_circle",
  "three_act",
  "kishotenketsu",
  "hook_first",
]);

const parseStructuralRemixInput = (
  value: unknown,
): StructuralRemixInput | null => {
  if (!isRecord(value)) return null;
  const storyboardId =
    typeof value.storyboardId === "string" ? value.storyboardId : "";
  if (!storyboardId) return null;
  const parentBranchId =
    typeof value.parentBranchId === "string" && value.parentBranchId.length > 0
      ? value.parentBranchId
      : "main";
  const rawStructure =
    typeof value.targetStructure === "string" ? value.targetStructure : "";
  const targetStructure = VALID_STRUCTURES.has(rawStructure)
    ? rawStructure
    : "save_the_cat";
  const rationale =
    typeof value.rationale === "string" ? value.rationale : "";
  const rawVariants = Array.isArray(value.variants) ? value.variants : [];
  const variants: StructuralRemixEntry[] = [];
  for (const raw of rawVariants) {
    if (!isRecord(raw)) continue;
    const variantId = sanitizeVariantId(raw.variantId);
    if (!variantId) continue;
    const planOps = parsePlanOpList(raw.planOps);
    if (planOps.length === 0) continue;
    const branchName =
      (typeof raw.branchName === "string" && raw.branchName.trim()
        ? raw.branchName.trim()
        : `Remix ${targetStructure.replace(/_/g, " ")} ${variantId}`).slice(0, 100);
    variants.push({
      variantId,
      rationale:
        typeof raw.rationale === "string" ? raw.rationale.slice(0, 800) : "",
      strategy:
        typeof raw.strategy === "string" ? raw.strategy.slice(0, 60) : "",
      branchName,
      planOps,
    });
  }
  return {
    storyboardId,
    parentBranchId,
    targetStructure,
    variants,
    variantCount: variants.length,
    rationale,
  };
};

// M9 Phase 4 — transition vocabulary mirrors _KNOWN_TRANSITION_INTENTS
// in the Python tool. Kept as a module-scoped Set so the approval card
// can highlight "normalized" intents + the VariantComparePanel can
// render intent badges with consistent icons across both sides.
export const KNOWN_TRANSITION_INTENTS = new Set([
  "match_cut",
  "j_cut",
  "l_cut",
  "cross_cut_accelerate",
  "hard_cut",
  "time_jump",
  "smash_cut",
  "iris",
  "whip_pan",
  "dissolve",
]);

const parseTransitionProposalInput = (
  value: unknown,
): TransitionProposalInput | null => {
  if (!isRecord(value)) return null;
  const storyboardId =
    typeof value.storyboardId === "string" ? value.storyboardId : "";
  if (!storyboardId) return null;
  const branchId =
    typeof value.branchId === "string" && value.branchId.length > 0
      ? value.branchId
      : "main";
  const sourceNodeId =
    typeof value.sourceNodeId === "string" ? value.sourceNodeId.trim() : "";
  const targetNodeId =
    typeof value.targetNodeId === "string" ? value.targetNodeId.trim() : "";
  if (!sourceNodeId || !targetNodeId) return null;
  const rationale =
    typeof value.rationale === "string" ? value.rationale : "";
  const rawProposals = Array.isArray(value.proposals) ? value.proposals : [];
  const proposals: TransitionProposalEntry[] = [];
  for (const raw of rawProposals) {
    if (!isRecord(raw)) continue;
    const intent =
      typeof raw.intent === "string" ? raw.intent.trim().toLowerCase() : "";
    if (!intent) continue;
    const entry: TransitionProposalEntry = {
      intent: KNOWN_TRANSITION_INTENTS.has(intent) ? intent : "hard_cut",
    };
    if (typeof raw.rawIntent === "string" && raw.rawIntent.trim()) {
      entry.rawIntent = raw.rawIntent.trim().slice(0, 60);
    }
    if (typeof raw.rationale === "string" && raw.rationale.trim()) {
      entry.rationale = raw.rationale.trim().slice(0, 400);
    }
    if (typeof raw.sharedElement === "string" && raw.sharedElement.trim()) {
      entry.sharedElement = raw.sharedElement.trim().slice(0, 200);
    }
    const planOps = parsePlanOpList(raw.planOps);
    if (planOps.length > 0) {
      entry.planOps = planOps;
    }
    if (typeof raw.rank === "number" && Number.isFinite(raw.rank)) {
      entry.rank = Math.max(1, Math.min(10, Math.round(raw.rank)));
    }
    proposals.push(entry);
  }
  return {
    storyboardId,
    branchId,
    sourceNodeId,
    targetNodeId,
    proposals,
    proposalCount: proposals.length,
    rationale,
  };
};

const parseMotifPlantInput = (value: unknown): MotifPlantInput | null => {
  if (!isRecord(value)) return null;
  const storyboardId =
    typeof value.storyboardId === "string" ? value.storyboardId : "";
  if (!storyboardId) return null;
  const branchId =
    typeof value.branchId === "string" && value.branchId.length > 0
      ? value.branchId
      : "main";
  const motifKey =
    typeof value.motifKey === "string" ? value.motifKey.trim() : "";
  const targetNodeId =
    typeof value.targetNodeId === "string" ? value.targetNodeId.trim() : "";
  if (!motifKey || !targetNodeId) return null;
  const description =
    typeof value.description === "string" ? value.description : "";
  const visualVocabulary =
    typeof value.visualVocabulary === "string"
      ? value.visualVocabulary
      : "";
  const sourceNodeIds = Array.isArray(value.sourceNodeIds)
    ? (value.sourceNodeIds as unknown[])
        .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
        .map((s) => s.trim())
    : [];
  const payoffNodeIds = Array.isArray(value.payoffNodeIds)
    ? (value.payoffNodeIds as unknown[])
        .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
        .map((s) => s.trim())
    : [];
  const planOps = parsePlanOpList(value.planOps);
  const rationale =
    typeof value.rationale === "string" ? value.rationale : "";
  return {
    storyboardId,
    branchId,
    motifKey,
    targetNodeId,
    description,
    visualVocabulary,
    sourceNodeIds,
    payoffNodeIds,
    planOps,
    rationale,
  };
};

const parseShotSfxBatchInput = (
  value: unknown,
): ShotSfxBatchInput | null => {
  if (!isRecord(value)) return null;
  const storyboardId =
    typeof value.storyboardId === "string" ? value.storyboardId : "";
  if (!storyboardId) return null;
  const branchId =
    typeof value.branchId === "string" && value.branchId.length > 0
      ? value.branchId
      : "main";
  const rationale = typeof value.rationale === "string" ? value.rationale : "";
  const nodeCount =
    typeof value.nodeCount === "number" && Number.isFinite(value.nodeCount)
      ? Math.max(0, Math.floor(value.nodeCount))
      : 0;
  const skipExisting =
    typeof value.skipExisting === "boolean" ? value.skipExisting : true;
  const concurrencyRaw =
    typeof value.concurrency === "number" && Number.isFinite(value.concurrency)
      ? Math.floor(value.concurrency)
      : 3;
  // SFX batch caps at 5 — ElevenLabs Sound Effects tolerates burst
  // parallelism but we stay below the audio batch cap to avoid
  // starving the OpenAI narration batch when both run together.
  const concurrency = Math.max(1, Math.min(5, concurrencyRaw));
  return {
    storyboardId,
    branchId,
    nodeCount,
    rationale,
    skipExisting,
    concurrency,
  };
};

const parseGenerateShotAudioBatchInput = (
  value: unknown,
): GenerateShotAudioBatchInput | null => {
  if (!isRecord(value)) {
    return null;
  }
  const storyboardId =
    typeof value.storyboardId === "string" ? value.storyboardId : "";
  const branchId = typeof value.branchId === "string" ? value.branchId : "main";
  const rationale = typeof value.rationale === "string" ? value.rationale : "";
  const nodeCount =
    typeof value.nodeCount === "number" && Number.isFinite(value.nodeCount)
      ? Math.max(0, Math.floor(value.nodeCount))
      : 0;
  const skipExisting =
    typeof value.skipExisting === "boolean" ? value.skipExisting : true;
  const concurrencyRaw =
    typeof value.concurrency === "number" && Number.isFinite(value.concurrency)
      ? Math.floor(value.concurrency)
      : 3;
  // Audio batch caps at 5 — OpenAI TTS tolerates more parallel requests
  // than Modal video, but we don't push it any higher to keep rate-limit
  // headroom for other concurrent users on the key.
  const concurrency = Math.max(1, Math.min(5, concurrencyRaw));
  const voice =
    typeof value.voice === "string" && value.voice.length > 0
      ? value.voice
      : "nova";
  const model =
    typeof value.model === "string" && value.model.length > 0
      ? value.model
      : "tts-1";
  const speedRaw =
    typeof value.speed === "number" && Number.isFinite(value.speed)
      ? value.speed
      : 1.0;
  const speed = Math.max(0.25, Math.min(4.0, speedRaw));
  if (!storyboardId) {
    return null;
  }
  return {
    storyboardId,
    branchId,
    nodeCount,
    rationale,
    skipExisting,
    concurrency,
    voice,
    model,
    speed,
  };
};

const ALLOWED_TTS_VOICES = new Set([
  "alloy",
  "echo",
  "fable",
  "onyx",
  "nova",
  "shimmer",
]);

const parseAssignVoiceCastInput = (
  value: unknown,
): AssignVoiceCastInput | null => {
  if (!isRecord(value)) return null;
  const storyboardId =
    typeof value.storyboardId === "string" ? value.storyboardId : "";
  const rationale = typeof value.rationale === "string" ? value.rationale : "";
  if (!storyboardId) return null;
  if (!Array.isArray(value.assignments)) return null;
  const assignments: VoiceCastAssignment[] = [];
  for (const raw of value.assignments) {
    if (!isRecord(raw)) continue;
    const packId = typeof raw.packId === "string" ? raw.packId.trim() : "";
    const voiceRaw =
      typeof raw.voice === "string" ? raw.voice.trim().toLowerCase() : "";
    if (!packId) continue;
    // Empty string is preserved — it's the "clear mapping" signal.
    // Non-empty strings must match the OpenAI TTS vocabulary to be
    // honored; anything else is dropped silently so a misbehaving
    // agent can't crash the handler.
    if (voiceRaw.length > 0 && !ALLOWED_TTS_VOICES.has(voiceRaw)) continue;
    assignments.push({ packId, voice: voiceRaw });
  }
  return { storyboardId, assignments, rationale };
};

const parseExportReelInput = (value: unknown): ExportReelInput | null => {
  if (!isRecord(value)) {
    return null;
  }
  const storyboardId =
    typeof value.storyboardId === "string" ? value.storyboardId : "";
  const rationale = typeof value.rationale === "string" ? value.rationale : "";
  const shotCount =
    typeof value.shotCount === "number" && Number.isFinite(value.shotCount)
      ? Math.max(0, Math.floor(value.shotCount))
      : 0;
  const estimatedDurationS =
    typeof value.estimatedDurationS === "number" &&
    Number.isFinite(value.estimatedDurationS)
      ? Math.max(0, value.estimatedDurationS)
      : 0;
  if (!storyboardId) return null;
  return { storyboardId, rationale, shotCount, estimatedDurationS };
};

const capitalize = (s: string): string => (s.length === 0 ? s : s[0].toUpperCase() + s.slice(1));

const HINT_LABELS: Record<string, string> = {
  style: "Style",
  userRequirement: "Constraints",
  ideaSynopsis: "Synopsis",
  novelExcerpt: "Excerpt",
  screenplayExcerpt: "Excerpt",
  targetEpisodeCount: "Episodes",
  targetShotCount: "Shots",
};

const formatIngestionHintLines = (hints: Record<string, string | number>): string[] => {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(hints)) {
    const label = HINT_LABELS[key] ?? key;
    const rendered =
      typeof value === "string" && value.length > 160 ? `${value.slice(0, 160)}…` : String(value);
    lines.push(`• ${label}: ${rendered}`);
  }
  return lines;
};

/**
 * Library page ingestion dialogs open automatically when these query params
 * are present. Kept as a pure helper so both the approval handler and the
 * unit tests can share the encoding.
 */
export const buildIngestionDialogHref = (input: IngestionRunInput): string => {
  const params = new URLSearchParams();
  params.set("ingest", input.mode);
  if (input.title) params.set("title", input.title);
  for (const [key, value] of Object.entries(input.hints)) {
    params.set(`hint_${key}`, String(value));
  }
  return `/storyboard?${params.toString()}`;
};

const parseGraphPatchInput = (value: unknown): GraphPatchInput | null => {
  if (!isRecord(value)) {
    return null;
  }
  const patchId = typeof value.patchId === "string" ? value.patchId : "";
  const title = typeof value.title === "string" ? value.title : "";
  const rationale = typeof value.rationale === "string" ? value.rationale : "";
  const diffSummary = typeof value.diffSummary === "string" ? value.diffSummary : "";
  const operations = Array.isArray(value.operations) ? value.operations : [];
  if (!patchId || !title || !rationale || !diffSummary || operations.length === 0) {
    return null;
  }
  return {
    patchId,
    title,
    rationale,
    diffSummary,
    operations,
  };
};

const parseMediaPromptInput = (value: unknown): MediaPromptInput | null => {
  if (!isRecord(value)) {
    return null;
  }
  const nodeId = typeof value.nodeId === "string" ? value.nodeId : "";
  const mediaType = value.mediaType === "video" ? "video" : value.mediaType === "image" ? "image" : null;
  const prompt = typeof value.prompt === "string" ? value.prompt : "";
  const contextSummary = typeof value.contextSummary === "string" ? value.contextSummary : "";
  const negativePrompt = typeof value.negativePrompt === "string" ? value.negativePrompt : undefined;
  if (!nodeId || !mediaType || !prompt || !contextSummary) {
    return null;
  }
  return {
    nodeId,
    mediaType,
    prompt,
    negativePrompt,
    contextSummary,
  };
};

const parseExecutionPlanInput = (value: unknown): ExecutionPlanInput | null => {
  if (!isRecord(value)) {
    return null;
  }
  const planId = typeof value.planId === "string" ? value.planId : "";
  const storyboardId = typeof value.storyboardId === "string" ? value.storyboardId : "";
  const branchId = typeof value.branchId === "string" ? value.branchId : "main";
  const title = typeof value.title === "string" ? value.title : "";
  const rationale = typeof value.rationale === "string" ? value.rationale : "";
  const source = value.source === "dailies"
    || value.source === "simulation_critic"
    || value.source === "repair"
    || value.source === "agent"
    ? value.source
    : undefined;
  const sourceId = typeof value.sourceId === "string" ? value.sourceId : undefined;
  const taskType = value.taskType === "execution_plan"
    || value.taskType === "batch_ops"
    || value.taskType === "dailies_batch"
    || value.taskType === "simulation_critic_batch"
    || value.taskType === "repair_plan"
    ? value.taskType
    : undefined;
  const operations = Array.isArray(value.operations) ? value.operations : [];
  const dryRun = isRecord(value.dryRun)
      ? {
        valid: Boolean(value.dryRun.valid),
        riskLevel: parseRiskLevel(value.dryRun.riskLevel),
        summary: typeof value.dryRun.summary === "string" ? value.dryRun.summary : "",
        issues: Array.isArray(value.dryRun.issues) ? value.dryRun.issues : [],
        estimatedTotalCost:
          typeof value.dryRun.estimatedTotalCost === "number" ? value.dryRun.estimatedTotalCost : 0,
        estimatedDurationSec:
          typeof value.dryRun.estimatedDurationSec === "number" ? value.dryRun.estimatedDurationSec : 0,
        planHash: typeof value.dryRun.planHash === "string" ? value.dryRun.planHash : "",
      }
    : undefined;

  if (!planId || !storyboardId || !title || !rationale || operations.length === 0) {
    return null;
  }
  return {
    planId,
    storyboardId,
    branchId,
    title,
    rationale,
    operations,
    source,
    sourceId,
    taskType,
    dryRun,
  };
};

const parseBatchOpsInput = (value: unknown): {
  planId: string;
  storyboardId?: string;
  branchId?: string;
  title?: string;
  rationale?: string;
  source?: "agent" | "dailies" | "simulation_critic" | "repair";
  sourceId?: string;
  taskType?: "execution_plan" | "batch_ops" | "dailies_batch" | "simulation_critic_batch" | "repair_plan";
  operations: unknown[];
  dryRun?: ExecutionPlanInput["dryRun"];
} | null => {
  if (!isRecord(value)) {
    return null;
  }
  const planId = typeof value.planId === "string" ? value.planId : "";
  const storyboardId = typeof value.storyboardId === "string" ? value.storyboardId : undefined;
  const branchId = typeof value.branchId === "string" ? value.branchId : undefined;
  const title = typeof value.title === "string" ? value.title : undefined;
  const rationale = typeof value.rationale === "string" ? value.rationale : undefined;
  const source = value.source === "dailies"
    || value.source === "simulation_critic"
    || value.source === "repair"
    || value.source === "agent"
    ? value.source
    : undefined;
  const sourceId = typeof value.sourceId === "string" ? value.sourceId : undefined;
  const taskType = value.taskType === "execution_plan"
    || value.taskType === "batch_ops"
    || value.taskType === "dailies_batch"
    || value.taskType === "simulation_critic_batch"
    || value.taskType === "repair_plan"
    ? value.taskType
    : undefined;
  const operations = Array.isArray(value.operations) ? value.operations : [];
  const dryRun = isRecord(value.dryRun)
    ? {
        valid: Boolean(value.dryRun.valid),
        riskLevel: parseRiskLevel(value.dryRun.riskLevel),
        summary: typeof value.dryRun.summary === "string" ? value.dryRun.summary : "",
        issues: Array.isArray(value.dryRun.issues) ? value.dryRun.issues : [],
        estimatedTotalCost:
          typeof value.dryRun.estimatedTotalCost === "number" ? value.dryRun.estimatedTotalCost : 0,
        estimatedDurationSec:
          typeof value.dryRun.estimatedDurationSec === "number" ? value.dryRun.estimatedDurationSec : 0,
        planHash: typeof value.dryRun.planHash === "string" ? value.dryRun.planHash : "",
      }
    : undefined;
  if (!planId || operations.length === 0) {
    return null;
  }
  return {
    planId,
    storyboardId,
    branchId,
    title,
    rationale,
    source,
    sourceId,
    taskType,
    operations,
    dryRun,
  };
};

const parseSimulationCriticPreviewInput = (value: unknown): {
  simulationRunId: string;
  storyboardId: string;
  branchId: string;
  summary: string;
  riskLevel: DryRunRiskLevel;
  issues: Array<{
    code: string;
    severity: DryRunRiskLevel;
    message: string;
    suggestedFix?: string;
  }>;
  confidence: number;
  impactScore: number;
  executionPlan: {
    planId: string;
    storyboardId: string;
    branchId: string;
    title: string;
    rationale: string;
    source: "simulation_critic";
    sourceId: string;
    taskType: "simulation_critic_batch";
    operations: unknown[];
    dryRun?: ExecutionPlanInput["dryRun"];
  };
} | null => {
  if (!isRecord(value)) {
    return null;
  }
  const simulationRunId = typeof value.simulationRunId === "string" ? value.simulationRunId : "";
  const storyboardId = typeof value.storyboardId === "string" ? value.storyboardId : "";
  const branchId = typeof value.branchId === "string" ? value.branchId : "main";
  const summary = typeof value.summary === "string" ? value.summary : "";
  const riskLevel = parseRiskLevel(value.riskLevel);
  const confidence = typeof value.confidence === "number" ? value.confidence : 0;
  const impactScore = typeof value.impactScore === "number" ? value.impactScore : 0;
  const issues = Array.isArray(value.issues)
    ? value.issues
      .filter(isRecord)
      .map((issue, index) => ({
        code: typeof issue.code === "string" ? issue.code : `ISSUE_${index + 1}`,
        severity: parseRiskLevel(issue.severity),
        message: typeof issue.message === "string" ? issue.message : "Issue summary unavailable.",
        suggestedFix: typeof issue.suggestedFix === "string" ? issue.suggestedFix : undefined,
      }))
    : [];
  if (!isRecord(value.executionPlan)) {
    return null;
  }
  const executionBatch = parseBatchOpsInput(value.executionPlan);
  if (!executionBatch || !simulationRunId || !storyboardId) {
    return null;
  }
  return {
    simulationRunId,
    storyboardId,
    branchId,
    summary,
    riskLevel,
    issues,
    confidence,
    impactScore,
    executionPlan: {
      planId: executionBatch.planId,
      storyboardId: executionBatch.storyboardId ?? storyboardId,
      branchId: executionBatch.branchId ?? branchId,
      title: executionBatch.title ?? "Simulation Critic Repair Batch",
      rationale: executionBatch.rationale ?? summary,
      source: "simulation_critic",
      sourceId: simulationRunId,
      taskType: "simulation_critic_batch",
      operations: executionBatch.operations,
      dryRun: executionBatch.dryRun,
    },
  };
};

const parseRepairPlanInput = (value: unknown): {
  repairPlanId: string;
  operations: unknown[];
  confidence: number;
} | null => {
  if (!isRecord(value)) {
    return null;
  }
  const repairPlanId = typeof value.repairPlanId === "string" ? value.repairPlanId : "";
  const operations = Array.isArray(value.operations) ? value.operations : [];
  const confidence = typeof value.confidence === "number" ? value.confidence : 0;
  if (!repairPlanId || operations.length === 0) {
    return null;
  }
  return { repairPlanId, operations, confidence };
};

const parseMergePolicyInput = (value: unknown): {
  branchId: string;
  sourceBranchId: string;
  targetBranchId: string;
  policy: string;
  semanticDiff?: Record<string, unknown>;
} | null => {
  if (!isRecord(value)) {
    return null;
  }
  const branchId = typeof value.branchId === "string" ? value.branchId : "";
  const sourceBranchId = typeof value.sourceBranchId === "string" ? value.sourceBranchId : "";
  const targetBranchId = typeof value.targetBranchId === "string" ? value.targetBranchId : "";
  const policy = typeof value.policy === "string" ? value.policy : "";
  const semanticDiff = isRecord(value.semanticDiff) ? value.semanticDiff : undefined;
  if (!branchId || !sourceBranchId || !targetBranchId || !policy) {
    return null;
  }
  return { branchId, sourceBranchId, targetBranchId, policy, semanticDiff };
};

const parseSelectTeamInput = (value: unknown): { teamId: string; revisionId?: string } | null => {
  if (!isRecord(value)) {
    return null;
  }
  const teamId = typeof value.teamId === "string" ? value.teamId : "";
  const revisionId = typeof value.revisionId === "string" ? value.revisionId : undefined;
  if (!teamId) {
    return null;
  }
  return { teamId, revisionId };
};

const parseCreateTeamInput = (value: unknown): {
  name: string;
  description: string;
  teamGoal: string;
} | null => {
  if (!isRecord(value)) {
    return null;
  }
  const name = typeof value.name === "string" ? value.name : "";
  const description = typeof value.description === "string"
    ? value.description
    : "Custom producer team";
  const teamGoal = typeof value.teamGoal === "string"
    ? value.teamGoal
    : "Deliver safe storyboard proposals with strict HITL.";
  if (!name) {
    return null;
  }
  return { name, description, teamGoal };
};

const parseUpdateTeamMemberInput = (value: unknown): {
  teamId: string;
  revisionId: string;
  member: TeamMemberConfig;
} | null => {
  if (!isRecord(value)) {
    return null;
  }
  const teamId = typeof value.teamId === "string" ? value.teamId : "";
  const revisionId = typeof value.revisionId === "string" ? value.revisionId : "";
  if (!teamId || !revisionId || !isRecord(value.member)) {
    return null;
  }
  const member = value.member;
  const agentName = typeof member.agentName === "string" ? member.agentName : "";
  const role = typeof member.role === "string" ? member.role : "";
  const persona = typeof member.persona === "string" ? member.persona : "";
  const nicheDescription = typeof member.nicheDescription === "string" ? member.nicheDescription : "";
  if (!agentName || !role || !persona || !nicheDescription) {
    return null;
  }
  return {
    teamId,
    revisionId,
    member: {
      memberId: typeof member.memberId === "string" ? member.memberId : agentName,
      agentName,
      role,
      persona,
      nicheDescription,
      toolScope: Array.isArray(member.toolScope)
        ? member.toolScope.filter((item): item is string => typeof item === "string")
        : [],
      resourceScope: Array.isArray(member.resourceScope)
        ? member.resourceScope.filter((item): item is string => typeof item === "string")
        : [],
      weight: typeof member.weight === "number" ? member.weight : 1,
      enabled: typeof member.enabled === "boolean" ? member.enabled : true,
    },
  };
};

const parsePublishRevisionInput = (value: unknown): { teamId: string; revisionId: string } | null => {
  if (!isRecord(value)) {
    return null;
  }
  const teamId = typeof value.teamId === "string" ? value.teamId : "";
  const revisionId = typeof value.revisionId === "string" ? value.revisionId : "";
  if (!teamId || !revisionId) {
    return null;
  }
  return { teamId, revisionId };
};

const parseGenerateTeamFromPromptInput = (value: unknown): {
  inputPrompt: string;
  teamId?: string;
  publish?: boolean;
} | null => {
  if (!isRecord(value)) {
    return null;
  }
  const inputPrompt = typeof value.inputPrompt === "string" ? value.inputPrompt : "";
  const teamId = typeof value.teamId === "string" ? value.teamId : undefined;
  const publish = typeof value.publish === "boolean" ? value.publish : undefined;
  if (!inputPrompt || inputPrompt.trim().length < 8) {
    return null;
  }
  return { inputPrompt, teamId, publish };
};

const toAgentNodes = (nodes: StoryNode[]): AgentGraphNode[] =>
  nodes.map((node) => ({
    id: node.id,
    nodeType: node.data.nodeType,
    label: node.data.label,
    segment: node.data.segment,
    continuityStatus: node.data.continuity.consistencyStatus,
  }));

const toAgentEdges = (edges: StoryEdge[]): AgentGraphEdge[] =>
  edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
  }));

const toRollingContextMap = (nodes: StoryNode[]): RollingContextMap =>
  Object.fromEntries(
    nodes.map((node) => [
      node.id,
      {
        rollingSummary: node.data.historyContext.rollingSummary,
        lineageHash: node.data.historyContext.lineageHash,
        tokenBudgetUsed: node.data.historyContext.tokenBudgetUsed,
        eventIds: node.data.historyContext.eventIds,
      },
    ]),
  );

export function StoryboardCopilotBridge({
  storyboardId,
  nodes,
  edges,
  approvals,
  mode,
  runtimeResolvedTeam,
  userIdentity,
}: {
  storyboardId: string | null;
  nodes: StoryNode[];
  edges: StoryEdge[];
  approvals: ApprovalSummary[];
  mode: "graph_studio" | "agent_draft";
  runtimeResolvedTeam: RuntimeResolvedTeam | null;
  userIdentity: UserIdentity | null;
}) {
  const safeStoryboardId = storyboardId ?? "";
  const approvalsStable = approvals.length === 0 ? EMPTY_APPROVALS : approvals;
  const router = useRouter();
  const graphSnapshot = useMemo(
    () => ({
      nodes: toAgentNodes(nodes),
      edges: toAgentEdges(edges),
    }),
    [edges, nodes],
  );
  const rollingContextMap = useMemo(() => toRollingContextMap(nodes), [nodes]);
  const activeTeamSnapshot = useMemo(
    () =>
      runtimeResolvedTeam
        ? {
            teamId: runtimeResolvedTeam.teamId,
            teamName: runtimeResolvedTeam.teamName,
            revisionId: runtimeResolvedTeam.revisionId,
            version: runtimeResolvedTeam.version,
          }
        : null,
    [runtimeResolvedTeam],
  );

  const agentState = useMemo<StoryboardAgentState>(
    () => ({
      storyboardId: safeStoryboardId,
      mode,
      graphSnapshot,
      rollingContextMap,
      pendingApprovals: approvalsStable,
      providerPolicy: PROVIDER_POLICY,
      activeTeam: activeTeamSnapshot,
      activeTeamRevision: runtimeResolvedTeam?.revisionId ?? null,
      teamGoal: runtimeResolvedTeam?.teamGoal ?? null,
      teamPolicy: runtimeResolvedTeam?.runtimePolicy ?? null,
      effectiveToolScope: runtimeResolvedTeam?.toolAllowlist ?? [],
      effectiveResourceScope: runtimeResolvedTeam?.resourceScopes ?? [],
      delegationView: {
        pendingApprovals: approvalsStable.length,
        requiresHitl: runtimeResolvedTeam?.runtimePolicy.requiresHitl ?? true,
      },
      team_config: runtimeResolvedTeam,
      runtime_policy: runtimeResolvedTeam?.runtimePolicy ?? null,
      effective_tool_scope: runtimeResolvedTeam?.toolAllowlist ?? [],
      effective_resource_scope: runtimeResolvedTeam?.resourceScopes ?? [],
      userIdentity,
      user_identity: userIdentity,
      // Script-ingest progress is null until the screenplay_ingester subagent
      // patches it mid-run. Kept in the initial state so the React form can
      // subscribe via `useCoAgent` without a narrowing guard.
      scriptIngestProgress: null,
      script_ingest_progress: null,
    }),
    [
      activeTeamSnapshot,
      approvalsStable,
      graphSnapshot,
      mode,
      rollingContextMap,
      runtimeResolvedTeam,
      safeStoryboardId,
      userIdentity,
    ],
  );

  const { setState } = useCoAgent<StoryboardAgentState>({
    name: "storyboard_agent",
    initialState: agentState,
  });

  const lastPushedKeyRef = useRef<string>("");
  useEffect(() => {
    if (!agentState.storyboardId) {
      return;
    }

    // Guard against unstable references causing infinite "setState -> rerender -> setState" loops.
    // We only push when the meaningful snapshot changes.
    const key = JSON.stringify({
      storyboardId: agentState.storyboardId,
      mode: agentState.mode,
      graph: agentState.graphSnapshot,
      rolling: agentState.rollingContextMap,
      approvals: agentState.pendingApprovals,
      team: agentState.activeTeam,
      teamRevision: agentState.activeTeamRevision,
      userId: agentState.userIdentity?.userId ?? null,
    });
    if (key === lastPushedKeyRef.current) {
      return;
    }
    lastPushedKeyRef.current = key;
    setState(agentState);
  }, [agentState, setState]);

  useCopilotReadable({
    description: "Current storyboard graph snapshot",
    value: graphSnapshot,
  });

  useCopilotReadable({
    description: "Path-aware rolling context per node",
    value: rollingContextMap,
  });

  useCopilotReadable({
    description: "Pending approvals requiring producer review",
    value: approvals,
  });

  useCopilotReadable({
    description: "Active agent team runtime configuration and policy",
    value: runtimeResolvedTeam,
  });

  const createApprovalTask = useMutation(mutationRef("approvals:createTask"));
  const resolveApprovalTask = useMutation(mutationRef("approvals:resolveTask"));
  const markApprovalExecutionStarted = useMutation(
    mutationRef("approvals:markExecutionStarted"),
  );
  const markApprovalExecutionFinished = useMutation(
    mutationRef("approvals:markExecutionFinished"),
  );
  const upsertAgentDailies = useMutation(mutationRef("dailies:upsertAgentDailies"));
  const upsertAgentSimulationRun = useMutation(
    mutationRef("dailies:upsertAgentSimulationRun"),
  );
  const applyGraphPatch = useMutation(mutationRef("storyboards:applyGraphPatch"));
  const recordStoryEvent = useMutation(mutationRef("storyboards:recordStoryEvent"));
  const refreshNodeHistoryContexts = useMutation(
    mutationRef("storyboards:refreshNodeHistoryContexts"),
  );
  const createMediaAsset = useMutation(mutationRef("mediaAssets:createMediaAsset"));
  const revertBatchMediaAssets = useMutation(mutationRef("mediaAssets:revertBatchMediaAssets"));
  const compileNodePromptPack = useMutation(mutationRef("storyboards:compileNodePromptPack"));
  const simulateExecutionPlan = useMutation(mutationRef("narrativeGit:simulateExecutionPlan"));
  const commitPlanOps = useMutation(mutationRef("narrativeGit:commitPlanOps"));
  const rollbackToCommit = useMutation(mutationRef("narrativeGit:rollbackToCommit"));
  const applyMergePolicyMutation = useMutation(mutationRef("narrativeGit:applyMergePolicy"));
  const generateAutonomousDailies = useMutation(mutationRef("dailies:generateAutonomousDailies"));
  const updateDailiesStatus = useMutation(mutationRef("dailies:updateDailiesStatus"));
  const runSimulationCritic = useMutation(mutationRef("dailies:runSimulationCritic"));
  const updateSimulationRunStatus = useMutation(mutationRef("dailies:updateSimulationRunStatus"));
  const startAgentRun = useMutation(mutationRef("agentRuns:startRun"));
  const finishAgentRun = useMutation(mutationRef("agentRuns:finishRun"));
  const checkAndReserveRunBudget = useMutation(mutationRef("quotas:checkAndReserveRunBudget"));
  const releaseRunBudget = useMutation(mutationRef("quotas:releaseRunBudget"));
  const selectTeamMutation = useMutation(mutationRef("agentTeams:assignTeamToStoryboard"));
  const createTeamMutation = useMutation(mutationRef("agentTeams:createTeam"));
  const updateTeamMemberMutation = useMutation(mutationRef("agentTeams:updateRevisionMember"));
  const publishRevisionMutation = useMutation(mutationRef("agentTeams:publishRevision"));
  const generateTeamFromPromptMutation = useMutation(
    mutationRef("agentTeams:generateTeamFromPrompt"),
  );
  const applyPromptDraftMutation = useMutation(mutationRef("agentTeams:applyPromptDraftToRevision"));
  // M8 follow-up — score attach flow. `request_generate_score` on
  // approve posts to /api/media/generate-score, then uses these
  // mutations to create the asset row + attach it to the storyboard.
  const setStoryboardScoreMutation = useMutation(
    mutationRef("storyboards:setStoryboardScore"),
  );
  // M9 Phase 2 — beat assignment approval handler. Patches each shot
  // node's narrative fields + replaces the beat plan row in one pass.
  const setNodeNarrativeFieldsMutation = useMutation(
    mutationRef("narrativeState:setNodeNarrativeFields"),
  );
  const upsertBeatPlanMutation = useMutation(
    mutationRef("narrativeState:upsertBeatPlan"),
  );
  // M9 Phase 3 — variant generation approval handlers. Each approved
  // variant becomes a narrative-git branch + commit; siblings stay
  // around until the producer picks one via the Variant Compare tab.
  const createNarrativeBranchMutation = useMutation(
    mutationRef("narrativeGit:createBranch"),
  );
  const upsertVariantMutation = useMutation(
    mutationRef("narrativeState:upsertVariant"),
  );
  // M9 Phase 4 — transition + motif mutations.
  const setEdgeTransitionIntentMutation = useMutation(
    mutationRef("narrativeState:setEdgeTransitionIntent"),
  );
  const upsertMotifMutation = useMutation(
    mutationRef("narrativeState:upsertMotif"),
  );
  const setIdentityPackVoiceMutation = useMutation(
    mutationRef("continuityOS:setIdentityPackVoice"),
  );
  const recordToolCallAudit = useMutation(mutationRef("toolAudits:recordToolCallAudit"));

  const adapterDependencies = useMemo<AdapterDependencies>(
    () => ({
      storyboardId: safeStoryboardId,
      nodes,
      edges,
      createApprovalTask,
      resolveApprovalTask,
      markApprovalExecutionStarted,
      markApprovalExecutionFinished,
      applyGraphPatch,
      recordStoryEvent,
      refreshNodeHistoryContexts,
      createMediaAsset,
      revertBatchMediaAssets,
      compileNodePromptPack,
      simulateExecutionPlan,
      commitPlanOps,
      rollbackToCommit,
      generateAutonomousDailies,
      updateDailiesStatus,
      runSimulationCritic,
      updateSimulationRunStatus,
      startAgentRun,
      finishAgentRun,
      runtimeResolvedTeam,
      checkAndReserveRunBudget,
      releaseRunBudget,
    }),
    [
      applyGraphPatch,
      createApprovalTask,
      markApprovalExecutionStarted,
      markApprovalExecutionFinished,
      createMediaAsset,
      revertBatchMediaAssets,
      compileNodePromptPack,
      simulateExecutionPlan,
      commitPlanOps,
      rollbackToCommit,
      generateAutonomousDailies,
      updateDailiesStatus,
      runSimulationCritic,
      checkAndReserveRunBudget,
      updateSimulationRunStatus,
      edges,
      finishAgentRun,
      nodes,
      recordStoryEvent,
      refreshNodeHistoryContexts,
      resolveApprovalTask,
      releaseRunBudget,
      runtimeResolvedTeam,
      safeStoryboardId,
      startAgentRun,
    ],
  );

  const auditToolCall = async (input: {
    tool: string;
    result: "success" | "failure" | "blocked";
    details?: Record<string, unknown>;
    member?: string;
    runId?: string;
  }) => {
    if (!safeStoryboardId) {
      return;
    }
    await recordToolCallAudit({
      storyboardId: safeStoryboardId,
      runId: input.runId,
      teamId: runtimeResolvedTeam?.teamId,
      revisionId: runtimeResolvedTeam?.revisionId,
      member: input.member ?? "supervisor",
      tool: input.tool,
      scope: runtimeResolvedTeam?.resourceScopes ?? [],
      result: input.result,
      detailsJson: input.details ? JSON.stringify(input.details) : undefined,
    });
  };

  useHumanInTheLoop({
    name: "approve_graph_patch",
    description:
      "Approve, edit, or reject a graph mutation patch. Call before mutating storyboard nodes/edges.",
    parameters: [
      { name: "patchId", type: "string", description: "Patch id", required: true },
      { name: "title", type: "string", description: "Patch title", required: true },
      { name: "rationale", type: "string", description: "Rationale", required: true },
      { name: "diffSummary", type: "string", description: "Diff summary", required: true },
      { name: "operations", type: "object[]", description: "Patch operations", required: true },
    ],
    render: ({ args, status, respond }) => {
      if (status !== "executing" || !respond) {
        return <></>;
      }
      const input = parseGraphPatchInput(args);
      if (!input) {
        return (
          <ToolStatusCard
            name="approve_graph_patch"
            status="failed"
            args={JSON.stringify(args ?? {}, null, 2)}
            result={JSON.stringify({ error: "Invalid graph patch payload" })}
          />
        );
      }
      return (
        <ApprovalCard
          title={input.title}
          subtitle={input.rationale}
          body={input.diffSummary}
          onApprove={async () => {
            const execution = await executeApprovedGraphPatch(adapterDependencies, input);
            await auditToolCall({
              tool: "approve_graph_patch",
              result: "success",
              details: { patchId: input.patchId, operationCount: input.operations.length },
            });
            respond({ approved: true, execution });
          }}
          onEdit={async () => {
            const execution = await executeApprovedGraphPatch(
              adapterDependencies,
              input,
              input.operations,
            );
            await auditToolCall({
              tool: "approve_graph_patch",
              result: "success",
              details: { patchId: input.patchId, operationCount: input.operations.length, edited: true },
            });
            respond({ approved: true, editedOperations: input.operations, execution });
          }}
          onReject={async () => {
            const rejection = await executeRejectedGraphPatch(adapterDependencies, input);
            await auditToolCall({
              tool: "approve_graph_patch",
              result: "blocked",
              details: { patchId: input.patchId },
            });
            respond({ approved: false, rejection });
          }}
        />
      );
    },
  });

  useHumanInTheLoop({
    name: "approve_media_prompt",
    description:
      "Approve, edit, or reject an image/video prompt before media execution.",
    parameters: [
      { name: "nodeId", type: "string", description: "Target node id", required: true },
      { name: "mediaType", type: "string", description: "image or video", required: true },
      { name: "prompt", type: "string", description: "Prompt text", required: true },
      { name: "negativePrompt", type: "string", description: "Negative prompt", required: false },
      { name: "contextSummary", type: "string", description: "Rolling context summary", required: true },
    ],
    render: ({ args, status, respond }) => {
      if (status !== "executing" || !respond) {
        return <></>;
      }
      const input = parseMediaPromptInput(args);
      if (!input) {
        return (
          <ToolStatusCard
            name="approve_media_prompt"
            status="failed"
            args={JSON.stringify(args ?? {}, null, 2)}
            result={JSON.stringify({ error: "Invalid media prompt payload" })}
          />
        );
      }
      return (
        <PromptApprovalCard
          nodeId={input.nodeId}
          mediaType={input.mediaType}
          prompt={input.prompt}
          negativePrompt={input.negativePrompt}
          contextSummary={input.contextSummary}
          onApprove={async (payload) => {
            const execution = await executeApprovedMediaPrompt(adapterDependencies, input, payload);
            await auditToolCall({
              tool: "approve_media_prompt",
              result: "success",
              details: { nodeId: input.nodeId, mediaType: input.mediaType },
            });
            respond({ approved: true, ...payload, execution });
          }}
          onReject={async () => {
            const rejection = await executeRejectedMediaPrompt(adapterDependencies, input);
            await auditToolCall({
              tool: "approve_media_prompt",
              result: "blocked",
              details: { nodeId: input.nodeId, mediaType: input.mediaType },
            });
            respond({ approved: false, rejection });
          }}
        />
      );
    },
  });

  useHumanInTheLoop({
    name: "approve_execution_plan",
    description:
      "Approve, edit, or reject a multi-operation execution plan after dry-run simulation.",
    parameters: [
      { name: "planId", type: "string", description: "Execution plan id", required: true },
      { name: "storyboardId", type: "string", description: "Storyboard id", required: true },
      { name: "branchId", type: "string", description: "Branch id", required: true },
      { name: "title", type: "string", description: "Plan title", required: true },
      { name: "rationale", type: "string", description: "Plan rationale", required: true },
      { name: "operations", type: "object[]", description: "Plan operations", required: true },
      { name: "dryRun", type: "object", description: "Dry-run report", required: false },
    ],
    render: ({ args, status, respond }) => {
      if (status !== "executing" || !respond) {
        return <></>;
      }
      const input = parseExecutionPlanInput(args);
      if (!input) {
        return (
          <ToolStatusCard
            name="approve_execution_plan"
            status="failed"
            args={JSON.stringify(args ?? {}, null, 2)}
            result={JSON.stringify({ error: "Invalid execution plan payload" })}
          />
        );
      }
      const dryRunSummary = input.dryRun
        ? `Dry-run: ${input.dryRun.summary} (risk: ${input.dryRun.riskLevel})`
        : "Dry-run summary unavailable.";
      return (
        <ApprovalCard
          title={input.title}
          subtitle={`Branch ${input.branchId} - ${input.operations.length} op(s)`}
          body={`${input.rationale}\n\n${dryRunSummary}`}
          onApprove={async () => {
            const execution = await executeApprovedExecutionPlan(adapterDependencies, input);
            await auditToolCall({
              tool: "approve_execution_plan",
              result: "success",
              details: { planId: input.planId, operationCount: input.operations.length },
            });
            respond({ approved: true, execution });
          }}
          onEdit={async () => {
            const execution = await executeApprovedExecutionPlan(
              adapterDependencies,
              input,
              input.operations,
            );
            await auditToolCall({
              tool: "approve_execution_plan",
              result: "success",
              details: { planId: input.planId, operationCount: input.operations.length, edited: true },
            });
            respond({ approved: true, editedOperations: input.operations, execution });
          }}
          onReject={async () => {
            const rejection = await executeRejectedExecutionPlan(adapterDependencies, input);
            await auditToolCall({
              tool: "approve_execution_plan",
              result: "blocked",
              details: { planId: input.planId },
            });
            respond({ approved: false, rejection });
          }}
        />
      );
    },
  });

  useHumanInTheLoop({
    name: "preview_simulation_critic_plan",
    description:
      "Preview simulation critic rationale (issues, confidence, impact) before requesting batch approval.",
    parameters: [
      { name: "simulationRunId", type: "string", description: "Simulation critic run id", required: true },
      { name: "storyboardId", type: "string", description: "Storyboard id", required: true },
      { name: "branchId", type: "string", description: "Branch id", required: true },
      { name: "summary", type: "string", description: "Critic summary", required: true },
      { name: "riskLevel", type: "string", description: "Critic risk level", required: true },
      { name: "issues", type: "object[]", description: "Critic issues", required: true },
      { name: "confidence", type: "number", description: "Critic confidence", required: true },
      { name: "impactScore", type: "number", description: "Estimated impact score", required: true },
      { name: "executionPlan", type: "object", description: "Proposed batch execution plan", required: true },
    ],
    render: ({ args, status, respond }) => {
      if (status !== "executing" || !respond) {
        return <></>;
      }
      const input = parseSimulationCriticPreviewInput(args);
      if (!input) {
        return (
          <ToolStatusCard
            name="preview_simulation_critic_plan"
            status="failed"
            args={JSON.stringify(args ?? {}, null, 2)}
            result={JSON.stringify({ error: "Invalid simulation critic preview payload" })}
          />
        );
      }

      return (
        <AgentSimulationCriticPreviewCard
          input={input}
          upsertAgentSimulationRun={upsertAgentSimulationRun}
          onContinue={async () => {
            const nextPayload = {
              ...input.executionPlan,
              source: "simulation_critic",
              sourceId: input.simulationRunId,
              taskType: "simulation_critic_batch",
            };
            respond({
              approved: true,
              nextAction: "approve_batch_ops",
              nextPayload,
              executionPlan: nextPayload,
              policyEvidence: {
                action: "preview_simulation_critic_plan",
                simulationRunId: input.simulationRunId,
                riskLevel: input.riskLevel,
                confidence: input.confidence,
                impactScore: input.impactScore,
              },
            });
            await auditToolCall({
              tool: "preview_simulation_critic_plan",
              result: "success",
              details: { simulationRunId: input.simulationRunId, riskLevel: input.riskLevel },
            });
          }}
          onReject={async () => {
            await auditToolCall({
              tool: "preview_simulation_critic_plan",
              result: "blocked",
              details: { simulationRunId: input.simulationRunId },
            });
            respond({
              approved: false,
              nextAction: "approve_batch_ops",
              blockedReason: "Producer rejected simulation critic proposal at preview stage.",
            });
          }}
        />
      );
    },
  });

  useHumanInTheLoop({
    name: "approve_batch_ops",
    description:
      "Approve, edit, or reject batched operations with per-op override support.",
    parameters: [
      { name: "planId", type: "string", description: "Execution plan id", required: true },
      { name: "storyboardId", type: "string", description: "Storyboard id", required: false },
      { name: "branchId", type: "string", description: "Branch id", required: false },
      { name: "title", type: "string", description: "Batch title", required: false },
      { name: "rationale", type: "string", description: "Batch rationale", required: false },
      { name: "source", type: "string", description: "Batch source", required: false },
      { name: "sourceId", type: "string", description: "Source id", required: false },
      { name: "taskType", type: "string", description: "Task type", required: false },
      { name: "operations", type: "object[]", description: "Batch operations", required: true },
      { name: "dryRun", type: "object", description: "Dry-run summary", required: false },
    ],
    render: ({ args, status, respond }) => {
      if (status !== "executing" || !respond) {
        return <></>;
      }
      const input = parseBatchOpsInput(args);
      if (!input) {
        return (
          <ToolStatusCard
            name="approve_batch_ops"
            status="failed"
            args={JSON.stringify(args ?? {}, null, 2)}
            result={JSON.stringify({ error: "Invalid batch ops payload" })}
          />
        );
      }
      const executionInput: ExecutionPlanInput = {
        planId: input.planId,
        storyboardId: input.storyboardId ?? safeStoryboardId,
        branchId: input.branchId ?? "main",
        title: input.title ?? `Batch Apply ${input.planId}`,
        rationale: input.rationale ?? "Producer-approved batched operations",
        operations: input.operations,
        source: input.source,
        sourceId: input.sourceId,
        taskType: input.taskType ?? "batch_ops",
        dryRun: input.dryRun,
      };

      return (
        <BatchApprovalCard
          title={`Batch Ops - ${input.operations.length} op(s)`}
          subtitle="Per-op override enabled"
          body={input.dryRun?.summary ?? "Dry-run summary unavailable."}
          operations={input.operations}
          onApprove={async (selectedOperations) => {
            const execution = await executeApprovedExecutionPlan(
              adapterDependencies,
              executionInput,
              selectedOperations,
            );
            await auditToolCall({
              tool: "approve_batch_ops",
              result: "success",
              details: { planId: executionInput.planId, selectedCount: selectedOperations.length },
            });
            respond({ approved: true, editedOperations: selectedOperations, execution });
          }}
          onReject={async () => {
            const rejection = await executeRejectedExecutionPlan(adapterDependencies, executionInput);
            await auditToolCall({
              tool: "approve_batch_ops",
              result: "blocked",
              details: { planId: executionInput.planId },
            });
            respond({ approved: false, rejection });
          }}
        />
      );
    },
  });


  useHumanInTheLoop({
    name: "approve_dailies_batch",
    description:
      "Approve or reject autonomous dailies execution plan with per-op override support.",
    parameters: [
      { name: "planId", type: "string", description: "Execution plan id", required: true },
      { name: "storyboardId", type: "string", description: "Storyboard id", required: true },
      { name: "branchId", type: "string", description: "Branch id", required: true },
      { name: "title", type: "string", description: "Plan title", required: true },
      { name: "rationale", type: "string", description: "Plan rationale", required: true },
      { name: "sourceId", type: "string", description: "Autonomous dailies reel id", required: true },
      { name: "operations", type: "object[]", description: "Plan operations", required: true },
      { name: "dryRun", type: "object", description: "Dry-run summary", required: false },
    ],
    render: ({ args, status, respond }) => {
      if (status !== "executing" || !respond) {
        return <></>;
      }
      const input = parseBatchOpsInput(args);
      if (!input || !input.sourceId) {
        return (
          <ToolStatusCard
            name="approve_dailies_batch"
            status="failed"
            args={JSON.stringify(args ?? {}, null, 2)}
            result={JSON.stringify({ error: "Invalid autonomous dailies payload" })}
          />
        );
      }
      const executionInput: ExecutionPlanInput = {
        planId: input.planId,
        storyboardId: input.storyboardId ?? safeStoryboardId,
        branchId: input.branchId ?? "main",
        title: input.title ?? `Autonomous Dailies ${input.planId}`,
        rationale: input.rationale ?? "Autonomous dailies batch proposal",
        operations: input.operations,
        source: "dailies",
        sourceId: input.sourceId,
        taskType: "dailies_batch",
        dryRun: input.dryRun,
      };

      return (
        <AgentDailiesApprovalCard
          input={input}
          executionInput={executionInput}
          upsertAgentDailies={upsertAgentDailies}
          onApprove={async (selectedOperations) => {
            const execution = await executeApprovedExecutionPlan(
              adapterDependencies,
              executionInput,
              selectedOperations,
            );
            await auditToolCall({
              tool: "approve_dailies_batch",
              result: "success",
              details: { planId: executionInput.planId, reelId: input.sourceId, selectedCount: selectedOperations.length },
            });
            respond({ approved: true, editedOperations: selectedOperations, execution });
          }}
          onReject={async () => {
            const rejection = await executeRejectedExecutionPlan(adapterDependencies, executionInput);
            await auditToolCall({
              tool: "approve_dailies_batch",
              result: "blocked",
              details: { planId: executionInput.planId, reelId: input.sourceId },
            });
            respond({ approved: false, rejection });
          }}
        />
      );
    },
  });
  useHumanInTheLoop({
    name: "approve_merge_policy",
    description: "Approve or reject merge policy for branch integration.",
    parameters: [
      { name: "branchId", type: "string", description: "Working branch", required: true },
      { name: "sourceBranchId", type: "string", description: "Source branch", required: true },
      { name: "targetBranchId", type: "string", description: "Target branch", required: true },
      { name: "policy", type: "string", description: "Merge policy", required: true },
      { name: "semanticDiff", type: "object", description: "Semantic diff summary", required: false },
    ],
    render: ({ args, status, respond }) => {
      if (status !== "executing" || !respond) {
        return <></>;
      }
      const input = parseMergePolicyInput(args);
      if (!input) {
        return (
          <ToolStatusCard
            name="approve_merge_policy"
            status="failed"
            args={JSON.stringify(args ?? {}, null, 2)}
            result={JSON.stringify({ error: "Invalid merge policy payload" })}
          />
        );
      }
      const body = `Source: ${input.sourceBranchId}\nTarget: ${input.targetBranchId}\nPolicy: ${input.policy}`;
      return (
        <ApprovalCard
          title="Merge Policy Approval"
          subtitle={`Branch ${input.branchId}`}
          body={body}
          onApprove={async () => {
            const taskId = await createApprovalTask({
              storyboardId: safeStoryboardId,
              taskType: "merge_policy",
              title: "Merge policy approved",
              rationale: `Policy ${input.policy}`,
              diffSummary: "Merge policy approval",
              payloadJson: JSON.stringify(input),
            });
            await resolveApprovalTask({
              taskId,
              approved: true,
            });
            const mergeExecution = await applyMergePolicyMutation({
              storyboardId: safeStoryboardId,
              sourceBranchId: input.sourceBranchId,
              targetBranchId: input.targetBranchId,
              policy: input.policy,
              approvalToken: `approved:${taskId}`,
            });
            await auditToolCall({
              tool: "approve_merge_policy",
              result: "success",
              details: {
                branchId: input.branchId,
                sourceBranchId: input.sourceBranchId,
                targetBranchId: input.targetBranchId,
                policy: input.policy,
              },
            });
            respond({ approved: true, taskId, mergeExecution });
          }}
          onEdit={async () => {
            const taskId = await createApprovalTask({
              storyboardId: safeStoryboardId,
              taskType: "merge_policy",
              title: "Merge policy edited and approved",
              rationale: `Policy ${input.policy}`,
              diffSummary: "Merge policy edited",
              payloadJson: JSON.stringify(input),
            });
            await resolveApprovalTask({
              taskId,
              approved: true,
              editedPayloadJson: JSON.stringify(input),
            });
            const mergeExecution = await applyMergePolicyMutation({
              storyboardId: safeStoryboardId,
              sourceBranchId: input.sourceBranchId,
              targetBranchId: input.targetBranchId,
              policy: input.policy,
              approvalToken: `approved:${taskId}`,
            });
            await auditToolCall({
              tool: "approve_merge_policy",
              result: "success",
              details: {
                branchId: input.branchId,
                sourceBranchId: input.sourceBranchId,
                targetBranchId: input.targetBranchId,
                policy: input.policy,
                edited: true,
              },
            });
            respond({ approved: true, taskId, edited: true, mergeExecution });
          }}
          onReject={async () => {
            const taskId = await createApprovalTask({
              storyboardId: safeStoryboardId,
              taskType: "merge_policy",
              title: "Merge policy rejected",
              rationale: `Policy ${input.policy}`,
              diffSummary: "Merge policy rejected",
              payloadJson: JSON.stringify(input),
            });
            await resolveApprovalTask({
              taskId,
              approved: false,
              justification: "Rejected by producer",
            });
            await auditToolCall({
              tool: "approve_merge_policy",
              result: "blocked",
              details: {
                branchId: input.branchId,
                sourceBranchId: input.sourceBranchId,
                targetBranchId: input.targetBranchId,
                policy: input.policy,
              },
            });
            respond({ approved: false, taskId });
          }}
        />
      );
    },
  });

  useHumanInTheLoop({
    name: "approve_repair_plan",
    description:
      "Approve, edit, or reject a generated repair plan for continuity/simulation failures.",
    parameters: [
      { name: "repairPlanId", type: "string", description: "Repair plan id", required: true },
      { name: "operations", type: "object[]", description: "Repair operations", required: true },
      { name: "confidence", type: "number", description: "Repair confidence", required: true },
    ],
    render: ({ args, status, respond }) => {
      if (status !== "executing" || !respond) {
        return <></>;
      }
      const input = parseRepairPlanInput(args);
      if (!input) {
        return (
          <ToolStatusCard
            name="approve_repair_plan"
            status="failed"
            args={JSON.stringify(args ?? {}, null, 2)}
            result={JSON.stringify({ error: "Invalid repair plan payload" })}
          />
        );
      }
      const executionInput: ExecutionPlanInput = {
        planId: input.repairPlanId,
        storyboardId: safeStoryboardId,
        branchId: "main",
        title: `Repair Plan ${input.repairPlanId}`,
        rationale: `Auto-repair with confidence ${input.confidence.toFixed(2)}`,
        operations: input.operations,
      };
      return (
        <ApprovalCard
          title={`Repair Plan - ${input.operations.length} op(s)`}
          subtitle={`Confidence ${input.confidence.toFixed(2)}`}
          body="Apply suggested continuity repairs."
          onApprove={async () => {
            const execution = await executeApprovedExecutionPlan(adapterDependencies, executionInput);
            await auditToolCall({
              tool: "approve_repair_plan",
              result: "success",
              details: { repairPlanId: input.repairPlanId, operationCount: input.operations.length },
            });
            respond({ approved: true, execution });
          }}
          onEdit={async () => {
            const execution = await executeApprovedExecutionPlan(
              adapterDependencies,
              executionInput,
              input.operations,
            );
            await auditToolCall({
              tool: "approve_repair_plan",
              result: "success",
              details: { repairPlanId: input.repairPlanId, operationCount: input.operations.length, edited: true },
            });
            respond({ approved: true, editedOperations: input.operations, execution });
          }}
          onReject={async () => {
            const rejection = await executeRejectedExecutionPlan(adapterDependencies, executionInput);
            await auditToolCall({
              tool: "approve_repair_plan",
              result: "blocked",
              details: { repairPlanId: input.repairPlanId },
            });
            respond({ approved: false, rejection });
          }}
        />
      );
    },
  });

  useHumanInTheLoop({
    name: "select_agent_team",
    description: "Assign an agent team revision to the current storyboard runtime.",
    parameters: [
      { name: "teamId", type: "string", description: "Team id", required: true },
      { name: "revisionId", type: "string", description: "Team revision id", required: false },
    ],
    render: ({ args, status, respond }) => {
      if (status !== "executing" || !respond) {
        return <></>;
      }
      const input = parseSelectTeamInput(args);
      if (!input || !safeStoryboardId) {
        return (
          <ToolStatusCard
            name="select_agent_team"
            status="failed"
            args={JSON.stringify(args ?? {}, null, 2)}
            result={JSON.stringify({ error: "Invalid team selection payload" })}
          />
        );
      }
      return (
        <ApprovalCard
          title={`Activate team ${input.teamId}`}
          subtitle={input.revisionId ? `Revision ${input.revisionId}` : "Latest published revision"}
          body="Switching teams changes subagent composition, policy, and tool scope."
          onApprove={async () => {
            await selectTeamMutation({
              storyboardId: safeStoryboardId,
              activeTeamId: input.teamId,
              activeRevisionId: input.revisionId,
            });
            await auditToolCall({
              tool: "select_agent_team",
              result: "success",
              details: { teamId: input.teamId, revisionId: input.revisionId },
            });
            respond({
              approved: true,
              policyEvidence: {
                action: "select_agent_team",
                teamId: input.teamId,
                revisionId: input.revisionId ?? "published",
              },
            });
          }}
          onEdit={async () => {
            await selectTeamMutation({
              storyboardId: safeStoryboardId,
              activeTeamId: input.teamId,
              activeRevisionId: input.revisionId,
            });
            await auditToolCall({
              tool: "select_agent_team",
              result: "success",
              details: { teamId: input.teamId, revisionId: input.revisionId, edited: true },
            });
            respond({ approved: true, edited: true });
          }}
          onReject={async () => {
            await auditToolCall({
              tool: "select_agent_team",
              result: "blocked",
              details: { teamId: input.teamId, revisionId: input.revisionId },
            });
            respond({ approved: false, blockedReason: "Producer rejected team switch." });
          }}
        />
      );
    },
  });

  useHumanInTheLoop({
    name: "create_agent_team",
    description: "Create a new custom agent team definition.",
    parameters: [
      { name: "name", type: "string", description: "Team name", required: true },
      { name: "description", type: "string", description: "Team description", required: false },
      { name: "teamGoal", type: "string", description: "Team goal", required: false },
    ],
    render: ({ args, status, respond }) => {
      if (status !== "executing" || !respond) {
        return <></>;
      }
      const input = parseCreateTeamInput(args);
      if (!input) {
        return (
          <ToolStatusCard
            name="create_agent_team"
            status="failed"
            args={JSON.stringify(args ?? {}, null, 2)}
            result={JSON.stringify({ error: "Invalid create team payload" })}
          />
        );
      }
      return (
        <ApprovalCard
          title={`Create team ${input.name}`}
          subtitle="New custom team"
          body={input.teamGoal}
          onApprove={async () => {
            const result = await createTeamMutation(input) as { teamId: string; revisionId: string };
            if (safeStoryboardId) {
              await selectTeamMutation({
                storyboardId: safeStoryboardId,
                activeTeamId: result.teamId,
                activeRevisionId: result.revisionId,
              });
            }
            await auditToolCall({
              tool: "create_agent_team",
              result: "success",
              details: { teamId: result.teamId, revisionId: result.revisionId },
            });
            respond({
              approved: true,
              teamId: result.teamId,
              revisionId: result.revisionId,
              nextAction: "select_agent_team",
            });
          }}
          onEdit={async () => {
            const result = await createTeamMutation(input) as { teamId: string; revisionId: string };
            await auditToolCall({
              tool: "create_agent_team",
              result: "success",
              details: { teamId: result.teamId, revisionId: result.revisionId, edited: true },
            });
            respond({ approved: true, edited: true, teamId: result.teamId, revisionId: result.revisionId });
          }}
          onReject={async () => {
            await auditToolCall({
              tool: "create_agent_team",
              result: "blocked",
              details: { name: input.name },
            });
            respond({ approved: false, blockedReason: "Producer rejected team creation." });
          }}
        />
      );
    },
  });

  useHumanInTheLoop({
    name: "update_agent_team_member",
    description: "Update team member persona/scope in a specific revision.",
    parameters: [
      { name: "teamId", type: "string", description: "Team id", required: true },
      { name: "revisionId", type: "string", description: "Revision id", required: true },
      { name: "member", type: "object", description: "Member update payload", required: true },
    ],
    render: ({ args, status, respond }) => {
      if (status !== "executing" || !respond) {
        return <></>;
      }
      const input = parseUpdateTeamMemberInput(args);
      if (!input) {
        return (
          <ToolStatusCard
            name="update_agent_team_member"
            status="failed"
            args={JSON.stringify(args ?? {}, null, 2)}
            result={JSON.stringify({ error: "Invalid member update payload" })}
          />
        );
      }
      return (
        <ApprovalCard
          title={`Update ${input.member.agentName}`}
          subtitle={`Team ${input.teamId} • Revision ${input.revisionId}`}
          body={input.member.persona}
          onApprove={async () => {
            await updateTeamMemberMutation(input);
            await auditToolCall({
              tool: "update_agent_team_member",
              result: "success",
              details: { teamId: input.teamId, revisionId: input.revisionId, agentName: input.member.agentName },
            });
            respond({ approved: true, policyEvidence: { action: "update_agent_team_member", teamId: input.teamId } });
          }}
          onEdit={async () => {
            await updateTeamMemberMutation(input);
            await auditToolCall({
              tool: "update_agent_team_member",
              result: "success",
              details: { teamId: input.teamId, revisionId: input.revisionId, agentName: input.member.agentName, edited: true },
            });
            respond({ approved: true, edited: true });
          }}
          onReject={async () => {
            await auditToolCall({
              tool: "update_agent_team_member",
              result: "blocked",
              details: { teamId: input.teamId, revisionId: input.revisionId, agentName: input.member.agentName },
            });
            respond({ approved: false, blockedReason: "Producer rejected member update." });
          }}
        />
      );
    },
  });

  useHumanInTheLoop({
    name: "publish_agent_team_revision",
    description: "Publish a team revision for runtime use.",
    parameters: [
      { name: "teamId", type: "string", description: "Team id", required: true },
      { name: "revisionId", type: "string", description: "Revision id", required: true },
    ],
    render: ({ args, status, respond }) => {
      if (status !== "executing" || !respond) {
        return <></>;
      }
      const input = parsePublishRevisionInput(args);
      if (!input) {
        return (
          <ToolStatusCard
            name="publish_agent_team_revision"
            status="failed"
            args={JSON.stringify(args ?? {}, null, 2)}
            result={JSON.stringify({ error: "Invalid publish revision payload" })}
          />
        );
      }
      return (
        <ApprovalCard
          title={`Publish ${input.teamId}`}
          subtitle={`Revision ${input.revisionId}`}
          body="Publishing revision updates runtime policy and subagent configuration."
          onApprove={async () => {
            await publishRevisionMutation(input);
            await auditToolCall({
              tool: "publish_agent_team_revision",
              result: "success",
              details: input,
            });
            respond({ approved: true, policyEvidence: { action: "publish_agent_team_revision", ...input } });
          }}
          onEdit={async () => {
            await publishRevisionMutation(input);
            await auditToolCall({
              tool: "publish_agent_team_revision",
              result: "success",
              details: { ...input, edited: true },
            });
            respond({ approved: true, edited: true });
          }}
          onReject={async () => {
            await auditToolCall({
              tool: "publish_agent_team_revision",
              result: "blocked",
              details: input,
            });
            respond({ approved: false, blockedReason: "Producer rejected publish revision." });
          }}
        />
      );
    },
  });

  useHumanInTheLoop({
    name: "generate_team_from_prompt",
    description: "Generate editable team draft from natural-language prompt.",
    parameters: [
      { name: "inputPrompt", type: "string", description: "Prompt describing team intent", required: true },
      { name: "teamId", type: "string", description: "Optional target team id", required: false },
      { name: "publish", type: "boolean", description: "Publish after apply", required: false },
    ],
    render: ({ args, status, respond }) => {
      if (status !== "executing" || !respond) {
        return <></>;
      }
      const input = parseGenerateTeamFromPromptInput(args);
      if (!input) {
        return (
          <ToolStatusCard
            name="generate_team_from_prompt"
            status="failed"
            args={JSON.stringify(args ?? {}, null, 2)}
            result={JSON.stringify({ error: "Invalid prompt bootstrap payload" })}
          />
        );
      }
      return (
        <ApprovalCard
          title="Generate Team Draft"
          subtitle="Prompt bootstrap"
          body={input.inputPrompt}
          onApprove={async () => {
            const draft = await generateTeamFromPromptMutation({
              inputPrompt: input.inputPrompt,
            }) as TeamPromptDraft;
            if (input.teamId) {
              await applyPromptDraftMutation({
                teamId: input.teamId,
                draftId: draft.draftId,
                publish: input.publish ?? false,
              });
            }
            await auditToolCall({
              tool: "generate_team_from_prompt",
              result: "success",
              details: { draftId: draft.draftId, teamId: input.teamId, publish: input.publish },
            });
            respond({
              approved: true,
              draft,
              nextAction: input.teamId ? "publish_agent_team_revision" : undefined,
            });
          }}
          onEdit={async () => {
            const draft = await generateTeamFromPromptMutation({
              inputPrompt: input.inputPrompt,
            }) as TeamPromptDraft;
            await auditToolCall({
              tool: "generate_team_from_prompt",
              result: "success",
              details: { draftId: draft.draftId, teamId: input.teamId, publish: input.publish, edited: true },
            });
            respond({ approved: true, edited: true, draft });
          }}
          onReject={async () => {
            await auditToolCall({
              tool: "generate_team_from_prompt",
              result: "blocked",
              details: { teamId: input.teamId },
            });
            respond({ approved: false, blockedReason: "Producer rejected prompt bootstrap." });
          }}
        />
      );
    },
  });

  useHumanInTheLoop({
    name: "request_ingestion_run",
    description:
      "Approve/edit/reject opening the ingestion dialog (screenplay/idea/novel) with agent-suggested hints.",
    parameters: [
      { name: "mode", type: "string", description: "screenplay | idea | novel", required: true },
      { name: "title", type: "string", description: "Proposed storyboard title", required: true },
      { name: "rationale", type: "string", description: "Why this ingestion surface", required: true },
      { name: "hints", type: "object", description: "Pre-fill hints", required: false },
    ],
    render: ({ args, status, respond }) => {
      if (status !== "executing" || !respond) {
        return <></>;
      }
      const input = parseIngestionRunInput(args);
      if (!input) {
        return (
          <ToolStatusCard
            name="request_ingestion_run"
            status="failed"
            args={JSON.stringify(args ?? {}, null, 2)}
            result={JSON.stringify({ error: "Invalid ingestion run payload" })}
          />
        );
      }
      const hintLines = formatIngestionHintLines(input.hints);
      const subtitle = `Open From-${capitalize(input.mode)} dialog`;
      const body = [
        input.rationale,
        hintLines.length > 0 ? `Pre-fill:\n${hintLines.join("\n")}` : "",
      ]
        .filter(Boolean)
        .join("\n\n");
      return (
        <ApprovalCard
          title={input.title}
          subtitle={subtitle}
          body={body || "No additional rationale provided."}
          onApprove={async () => {
            const target = buildIngestionDialogHref(input);
            router.push(target);
            await auditToolCall({
              tool: "request_ingestion_run",
              result: "success",
              details: { mode: input.mode, title: input.title },
            });
            respond({ approved: true, navigatedTo: target });
          }}
          onEdit={async () => {
            const target = buildIngestionDialogHref(input);
            router.push(target);
            await auditToolCall({
              tool: "request_ingestion_run",
              result: "success",
              details: { mode: input.mode, title: input.title, edited: true },
            });
            respond({
              approved: true,
              edited: true,
              navigatedTo: target,
              editedHints: input.hints,
            });
          }}
          onReject={async () => {
            await auditToolCall({
              tool: "request_ingestion_run",
              result: "blocked",
              details: { mode: input.mode, title: input.title },
            });
            respond({
              approved: false,
              blockedReason: "Producer rejected ingestion run.",
            });
          }}
        />
      );
    },
  });

  useHumanInTheLoop({
    name: "request_generate_shot_batch",
    description:
      "Approve/edit/reject kicking off the Generate-All-Shots batch on the current storyboard.",
    parameters: [
      { name: "storyboardId", type: "string", description: "Storyboard id", required: true },
      { name: "branchId", type: "string", description: "Branch id (main by default)", required: true },
      { name: "nodeCount", type: "number", description: "Total shot count", required: true },
      { name: "rationale", type: "string", description: "Why batch now", required: true },
      { name: "skipExisting", type: "boolean", description: "Skip shots that already have media", required: false },
      { name: "concurrency", type: "number", description: "Parallel workers (1-6)", required: false },
    ],
    render: ({ args, status, respond }) => {
      if (status !== "executing" || !respond) {
        return <></>;
      }
      const input = parseGenerateShotBatchInput(args);
      if (!input) {
        return (
          <ToolStatusCard
            name="request_generate_shot_batch"
            status="failed"
            args={JSON.stringify(args ?? {}, null, 2)}
            result={JSON.stringify({ error: "Invalid shot batch payload" })}
          />
        );
      }
      const isOnTargetStoryboard =
        Boolean(storyboardId) && storyboardId === input.storyboardId;
      const subtitle = `${input.nodeCount} shot${input.nodeCount === 1 ? "" : "s"} · concurrency ${input.concurrency} · skipExisting ${input.skipExisting ? "on" : "off"}${isOnTargetStoryboard ? "" : " · will navigate"}`;

      const startBatch = () => {
        const detail: ShotBatchTriggerDetail = {
          storyboardId: input.storyboardId,
          skipExisting: input.skipExisting,
          concurrency: input.concurrency,
        };
        if (isOnTargetStoryboard) {
          dispatchShotBatchTrigger(detail);
          return { navigated: false, dispatched: true };
        }
        // Cross-storyboard trigger — navigate to the target editor, which
        // reads the query params on mount and dispatches the event itself.
        router.push(buildShotBatchNavHref(detail));
        return { navigated: true, dispatched: false };
      };

      return (
        <ApprovalCard
          title="Generate all shot images"
          subtitle={subtitle}
          body={input.rationale || "Render every shot using linked character portraits."}
          onApprove={async () => {
            const outcome = startBatch();
            await auditToolCall({
              tool: "request_generate_shot_batch",
              result: "success",
              details: {
                storyboardId: input.storyboardId,
                nodeCount: input.nodeCount,
                concurrency: input.concurrency,
                navigated: outcome.navigated,
              },
            });
            respond({ approved: true, ...outcome });
          }}
          onEdit={async () => {
            const outcome = startBatch();
            await auditToolCall({
              tool: "request_generate_shot_batch",
              result: "success",
              details: {
                storyboardId: input.storyboardId,
                nodeCount: input.nodeCount,
                concurrency: input.concurrency,
                navigated: outcome.navigated,
                edited: true,
              },
            });
            respond({ approved: true, edited: true, ...outcome });
          }}
          onReject={async () => {
            await auditToolCall({
              tool: "request_generate_shot_batch",
              result: "blocked",
              details: { storyboardId: input.storyboardId },
            });
            respond({
              approved: false,
              blockedReason: "Producer rejected shot batch.",
            });
          }}
        />
      );
    },
  });

  useHumanInTheLoop({
    name: "request_generate_shot_video_batch",
    description:
      "Approve/edit/reject kicking off the Generate-All-Videos (LTX-2.3 I2V) batch on the current storyboard.",
    parameters: [
      { name: "storyboardId", type: "string", description: "Storyboard id", required: true },
      { name: "branchId", type: "string", description: "Branch id (main by default)", required: true },
      { name: "nodeCount", type: "number", description: "Total shot count", required: true },
      { name: "rationale", type: "string", description: "Why batch now", required: true },
      { name: "skipExisting", type: "boolean", description: "Skip shots that already have an active video", required: false },
      { name: "concurrency", type: "number", description: "Parallel workers (1-4)", required: false },
      { name: "videoModelId", type: "string", description: "ltx-2.3 | ltx-2 | veo-3.1", required: false },
    ],
    render: ({ args, status, respond }) => {
      if (status !== "executing" || !respond) {
        return <></>;
      }
      const input = parseGenerateShotVideoBatchInput(args);
      if (!input) {
        return (
          <ToolStatusCard
            name="request_generate_shot_video_batch"
            status="failed"
            args={JSON.stringify(args ?? {}, null, 2)}
            result={JSON.stringify({ error: "Invalid shot video batch payload" })}
          />
        );
      }
      const isOnTargetStoryboard =
        Boolean(storyboardId) && storyboardId === input.storyboardId;
      const subtitle = `${input.nodeCount} shot${input.nodeCount === 1 ? "" : "s"} · ${input.videoModelId} · concurrency ${input.concurrency} · skipExisting ${input.skipExisting ? "on" : "off"}${isOnTargetStoryboard ? "" : " · will navigate"}`;

      const startBatch = () => {
        const detail: ShotVideoBatchTriggerDetail = {
          storyboardId: input.storyboardId,
          skipExisting: input.skipExisting,
          concurrency: input.concurrency,
          videoModelId: input.videoModelId,
        };
        if (isOnTargetStoryboard) {
          dispatchShotVideoBatchTrigger(detail);
          return { navigated: false, dispatched: true };
        }
        // Cross-storyboard: navigate to the editor and let the video
        // button's mount-time event listener pick up the run. (Unlike
        // the image batch, we don't need query-param replay because the
        // video button isn't gated on `?triggerBatch=1` — it just fires
        // via the event each approval.)
        router.push(`/storyboard/${encodeURIComponent(input.storyboardId)}`);
        // Fire the event after a small tick so the new page's button
        // listener has mounted.
        window.setTimeout(() => dispatchShotVideoBatchTrigger(detail), 600);
        return { navigated: true, dispatched: true };
      };

      return (
        <ApprovalCard
          title="Generate all shot videos"
          subtitle={subtitle}
          body={
            input.rationale ||
            "Render an I2V clip per shot using each shot's existing image as keyframe 0."
          }
          onApprove={async () => {
            const outcome = startBatch();
            await auditToolCall({
              tool: "request_generate_shot_video_batch",
              result: "success",
              details: {
                storyboardId: input.storyboardId,
                nodeCount: input.nodeCount,
                concurrency: input.concurrency,
                videoModelId: input.videoModelId,
                navigated: outcome.navigated,
              },
            });
            respond({ approved: true, ...outcome });
          }}
          onEdit={async () => {
            const outcome = startBatch();
            await auditToolCall({
              tool: "request_generate_shot_video_batch",
              result: "success",
              details: {
                storyboardId: input.storyboardId,
                nodeCount: input.nodeCount,
                concurrency: input.concurrency,
                videoModelId: input.videoModelId,
                navigated: outcome.navigated,
                edited: true,
              },
            });
            respond({ approved: true, edited: true, ...outcome });
          }}
          onReject={async () => {
            await auditToolCall({
              tool: "request_generate_shot_video_batch",
              result: "blocked",
              details: { storyboardId: input.storyboardId },
            });
            respond({
              approved: false,
              blockedReason: "Producer rejected shot video batch.",
            });
          }}
        />
      );
    },
  });

  useHumanInTheLoop({
    name: "request_generate_shot_audio_batch",
    description:
      "Approve/edit/reject kicking off the Generate-All-Audio (OpenAI TTS) narration batch on the current storyboard.",
    parameters: [
      { name: "storyboardId", type: "string", description: "Storyboard id", required: true },
      { name: "branchId", type: "string", description: "Branch id (main by default)", required: true },
      { name: "nodeCount", type: "number", description: "Total shot count", required: true },
      { name: "rationale", type: "string", description: "Why narrate now", required: true },
      { name: "skipExisting", type: "boolean", description: "Skip shots that already have narration", required: false },
      { name: "concurrency", type: "number", description: "Parallel workers (1-5)", required: false },
      { name: "voice", type: "string", description: "OpenAI voice (alloy|echo|fable|onyx|nova|shimmer)", required: false },
      { name: "model", type: "string", description: "OpenAI TTS model id (tts-1 | tts-1-hd)", required: false },
      { name: "speed", type: "number", description: "0.25-4.0; defaults to 1.0", required: false },
    ],
    render: ({ args, status, respond }) => {
      if (status !== "executing" || !respond) {
        return <></>;
      }
      const input = parseGenerateShotAudioBatchInput(args);
      if (!input) {
        return (
          <ToolStatusCard
            name="request_generate_shot_audio_batch"
            status="failed"
            args={JSON.stringify(args ?? {}, null, 2)}
            result={JSON.stringify({ error: "Invalid shot audio batch payload" })}
          />
        );
      }
      const isOnTargetStoryboard =
        Boolean(storyboardId) && storyboardId === input.storyboardId;
      const subtitle = `${input.nodeCount} shot${input.nodeCount === 1 ? "" : "s"} · voice ${input.voice} · ${input.model} · speed ${input.speed}${isOnTargetStoryboard ? "" : " · will navigate"}`;

      const startBatch = () => {
        const detail: ShotAudioBatchTriggerDetail = {
          storyboardId: input.storyboardId,
          skipExisting: input.skipExisting,
          concurrency: input.concurrency,
          voice: input.voice,
          model: input.model,
          speed: input.speed,
        };
        if (isOnTargetStoryboard) {
          dispatchShotAudioBatchTrigger(detail);
          return { navigated: false, dispatched: true };
        }
        router.push(`/storyboard/${encodeURIComponent(input.storyboardId)}`);
        window.setTimeout(() => dispatchShotAudioBatchTrigger(detail), 600);
        return { navigated: true, dispatched: true };
      };

      return (
        <ApprovalCard
          title="Generate all shot narration"
          subtitle={subtitle}
          body={
            input.rationale ||
            "Run OpenAI TTS over every shot's derived narration text."
          }
          onApprove={async () => {
            const outcome = startBatch();
            await auditToolCall({
              tool: "request_generate_shot_audio_batch",
              result: "success",
              details: {
                storyboardId: input.storyboardId,
                nodeCount: input.nodeCount,
                concurrency: input.concurrency,
                voice: input.voice,
                model: input.model,
                speed: input.speed,
                navigated: outcome.navigated,
              },
            });
            respond({ approved: true, ...outcome });
          }}
          onEdit={async () => {
            const outcome = startBatch();
            await auditToolCall({
              tool: "request_generate_shot_audio_batch",
              result: "success",
              details: {
                storyboardId: input.storyboardId,
                nodeCount: input.nodeCount,
                concurrency: input.concurrency,
                voice: input.voice,
                model: input.model,
                speed: input.speed,
                navigated: outcome.navigated,
                edited: true,
              },
            });
            respond({ approved: true, edited: true, ...outcome });
          }}
          onReject={async () => {
            await auditToolCall({
              tool: "request_generate_shot_audio_batch",
              result: "blocked",
              details: { storyboardId: input.storyboardId },
            });
            respond({
              approved: false,
              blockedReason: "Producer rejected shot audio batch.",
            });
          }}
        />
      );
    },
  });

  useHumanInTheLoop({
    name: "request_generate_shot_sfx_batch",
    description:
      "Approve/reject generating per-shot ambient/foley SFX for this storyboard. Uses ElevenLabs Sound Effects; returns 501 if the provider isn't configured.",
    parameters: [
      { name: "storyboardId", type: "string", description: "Storyboard id", required: true },
      { name: "branchId", type: "string", description: "Narrative branch id", required: true },
      { name: "nodeCount", type: "number", description: "Shots in batch (diagnostic)", required: true },
      { name: "rationale", type: "string", description: "Why run SFX now", required: true },
      { name: "skipExisting", type: "boolean", description: "Skip shots that already have SFX", required: false },
      { name: "concurrency", type: "number", description: "Parallel workers (1-5)", required: false },
    ],
    render: ({ args, status, respond }) => {
      if (status !== "executing" || !respond) {
        return <></>;
      }
      const input = parseShotSfxBatchInput(args);
      if (!input) {
        return (
          <ToolStatusCard
            name="request_generate_shot_sfx_batch"
            status="failed"
            args={JSON.stringify(args ?? {}, null, 2)}
            result={JSON.stringify({ error: "Invalid SFX batch payload" })}
          />
        );
      }
      const isOnTargetStoryboard =
        Boolean(storyboardId) && storyboardId === input.storyboardId;
      const subtitle = `${input.nodeCount} shot${input.nodeCount === 1 ? "" : "s"} · concurrency ${input.concurrency}${input.skipExisting ? " · skip existing" : " · regenerate all"}${isOnTargetStoryboard ? "" : " · will navigate"}`;

      // Dispatch a CustomEvent that `GenerateAllSfxsButton` listens
      // for — mirrors the narration batch pattern so producers see a
      // live progress grid in the storyboard header regardless of
      // whether the batch was agent-initiated or producer-initiated.
      // Agent HITL path: approve → event → button drives the SSE
      // stream → producer watches per-shot progress.
      const startBatch = () => {
        const detail: ShotSfxBatchTriggerDetail = {
          storyboardId: input.storyboardId,
          skipExisting: input.skipExisting,
          concurrency: input.concurrency,
        };
        if (isOnTargetStoryboard) {
          dispatchShotSfxBatchTrigger(detail);
          return { navigated: false, dispatched: true };
        }
        router.push(`/storyboard/${encodeURIComponent(input.storyboardId)}`);
        // The target page mounts asynchronously; defer the dispatch so
        // the button's listener is attached before the event fires.
        window.setTimeout(() => dispatchShotSfxBatchTrigger(detail), 600);
        return { navigated: true, dispatched: true };
      };

      return (
        <ApprovalCard
          title="Generate all shot SFX"
          subtitle={subtitle}
          body={
            input.rationale
            || "Generate an ambient / foley track for every shot. Mixed UNDER the narration in the final reel."
          }
          onApprove={async () => {
            const outcome = startBatch();
            await auditToolCall({
              tool: "request_generate_shot_sfx_batch",
              result: "success",
              details: {
                storyboardId: input.storyboardId,
                nodeCount: input.nodeCount,
                concurrency: input.concurrency,
                skipExisting: input.skipExisting,
                navigated: outcome.navigated,
              },
            });
            respond({ approved: true, ...outcome });
          }}
          onEdit={async () => {
            const outcome = startBatch();
            await auditToolCall({
              tool: "request_generate_shot_sfx_batch",
              result: "success",
              details: {
                storyboardId: input.storyboardId,
                nodeCount: input.nodeCount,
                concurrency: input.concurrency,
                skipExisting: input.skipExisting,
                navigated: outcome.navigated,
                edited: true,
              },
            });
            respond({ approved: true, edited: true, ...outcome });
          }}
          onReject={async () => {
            await auditToolCall({
              tool: "request_generate_shot_sfx_batch",
              result: "blocked",
              details: { storyboardId: input.storyboardId },
            });
            respond({
              approved: false,
              blockedReason: "Producer rejected shot SFX batch.",
            });
          }}
        />
      );
    },
  });

  useHumanInTheLoop({
    name: "request_generate_score",
    description:
      "Approve/reject generating a reel-level background score (music bed) via ElevenLabs Music. Replaces any existing active score on the storyboard.",
    parameters: [
      { name: "storyboardId", type: "string", description: "Storyboard id", required: true },
      { name: "prompt", type: "string", description: "Music prompt (capped at 600 chars)", required: true },
      { name: "durationS", type: "number", description: "Duration in seconds (10-300)", required: false },
      { name: "volumeDb", type: "number", description: "Mix level in dB (-40..0); default -18", required: false },
      { name: "rationale", type: "string", description: "Why this score, why now", required: true },
    ],
    render: ({ args, status, respond }) => {
      if (status !== "executing" || !respond) {
        return <></>;
      }
      const input = parseGenerateScoreInput(args);
      if (!input) {
        return (
          <ToolStatusCard
            name="request_generate_score"
            status="failed"
            args={JSON.stringify(args ?? {}, null, 2)}
            result={JSON.stringify({
              error:
                "Invalid score payload: need storyboardId + non-empty prompt.",
            })}
          />
        );
      }
      const isOnTargetStoryboard =
        Boolean(storyboardId) && storyboardId === input.storyboardId;
      const subtitle = `${input.durationS}s · ${input.volumeDb} dB${isOnTargetStoryboard ? "" : " · will navigate"}`;

      // Attach flow: POST to generate-score → createMediaAsset
      // (kind=score, sentinel nodeId) → setStoryboardScore. Matches
      // the ReelScorePanel's producer-initiated flow exactly so the
      // agent path and the button path produce identical Convex state.
      const runAttach = async (): Promise<{
        mediaAssetId?: string;
        error?: string;
      }> => {
        try {
          const res = await fetch("/api/media/generate-score", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              prompt: input.prompt,
              durationS: input.durationS,
              volumeDb: input.volumeDb,
              storyboardId: input.storyboardId,
            }),
          });
          if (!res.ok) {
            const payload = (await res.json().catch(() => ({}))) as {
              error?: string;
            };
            return {
              error:
                payload.error ?? `Score generation failed (${res.status})`,
            };
          }
          const data = (await res.json()) as {
            url: string;
            provider: string;
          };
          const mediaAssetId = (await createMediaAsset({
            storyboardId: input.storyboardId as never,
            nodeId: "__score__",
            kind: "score",
            sourceUrl: data.url,
            modelId: data.provider,
            prompt: input.prompt,
            status: "completed",
            metadata: {
              durationS: String(input.durationS),
              volumeDb: String(input.volumeDb),
            },
          })) as string;
          await setStoryboardScoreMutation({
            storyboardId: input.storyboardId as never,
            mediaAssetId: mediaAssetId as never,
            volumeDb: input.volumeDb,
          });
          return { mediaAssetId };
        } catch (err) {
          return {
            error: err instanceof Error ? err.message : String(err),
          };
        }
      };

      return (
        <ApprovalCard
          title="Attach reel score"
          subtitle={subtitle}
          body={
            (input.rationale ? `${input.rationale}\n\n` : "")
            + `Prompt: "${input.prompt}"`
          }
          onApprove={async () => {
            if (!isOnTargetStoryboard) {
              router.push(
                `/storyboard/${encodeURIComponent(input.storyboardId)}`,
              );
            }
            const outcome = await runAttach();
            await auditToolCall({
              tool: "request_generate_score",
              result: outcome.error ? "blocked" : "success",
              details: {
                storyboardId: input.storyboardId,
                durationS: input.durationS,
                volumeDb: input.volumeDb,
                mediaAssetId: outcome.mediaAssetId,
                error: outcome.error,
                navigated: !isOnTargetStoryboard,
              },
            });
            if (outcome.error) {
              respond({ approved: false, blockedReason: outcome.error });
            } else {
              respond({
                approved: true,
                mediaAssetId: outcome.mediaAssetId,
              });
            }
          }}
          onEdit={async () => {
            if (!isOnTargetStoryboard) {
              router.push(
                `/storyboard/${encodeURIComponent(input.storyboardId)}`,
              );
            }
            const outcome = await runAttach();
            await auditToolCall({
              tool: "request_generate_score",
              result: outcome.error ? "blocked" : "success",
              details: {
                storyboardId: input.storyboardId,
                durationS: input.durationS,
                volumeDb: input.volumeDb,
                mediaAssetId: outcome.mediaAssetId,
                error: outcome.error,
                navigated: !isOnTargetStoryboard,
                edited: true,
              },
            });
            if (outcome.error) {
              respond({ approved: false, blockedReason: outcome.error });
            } else {
              respond({
                approved: true,
                edited: true,
                mediaAssetId: outcome.mediaAssetId,
              });
            }
          }}
          onReject={async () => {
            await auditToolCall({
              tool: "request_generate_score",
              result: "blocked",
              details: { storyboardId: input.storyboardId },
            });
            respond({
              approved: false,
              blockedReason: "Producer rejected score generation.",
            });
          }}
        />
      );
    },
  });

  useHumanInTheLoop({
    name: "request_beat_assignment",
    description:
      "Approve/reject a beat plan mapping storyboard nodes to canonical beats (Save-the-Cat / Harmon Circle / Three-Act / Kishōtenketsu / Hook-First). Applies node narrative fields + replaces the beat plan row on approve.",
    parameters: [
      { name: "storyboardId", type: "string", description: "Storyboard id", required: true },
      { name: "branchId", type: "string", description: "Narrative branch id", required: true },
      { name: "structure", type: "string", description: "Beat structure", required: true },
      {
        name: "assignments",
        type: "object[]",
        description: "Array of { nodeId, beatKey, actNumber?, rationale? } entries",
        required: true,
        attributes: [
          { name: "nodeId", type: "string", description: "Shot node id", required: true },
          { name: "beatKey", type: "string", description: "Canonical beat key for the structure", required: true },
          { name: "actNumber", type: "number", description: "Act 1-5", required: false },
          { name: "rationale", type: "string", description: "Why this node for this beat", required: false },
        ],
      },
      { name: "rationale", type: "string", description: "Overall rationale", required: true },
      { name: "overrideExisting", type: "boolean", description: "Override already-assigned slots (producer opt-in)", required: false },
    ],
    render: ({ args, status, respond }) => {
      if (status !== "executing" || !respond) {
        return <></>;
      }
      const input = parseBeatAssignmentInput(args);
      if (!input || input.assignments.length === 0) {
        return (
          <ToolStatusCard
            name="request_beat_assignment"
            status="failed"
            args={JSON.stringify(args ?? {}, null, 2)}
            result={JSON.stringify({
              error:
                "Invalid beat-assignment payload: need storyboardId + structure + at least one valid { nodeId, beatKey } assignment.",
            })}
          />
        );
      }
      const isOnTargetStoryboard =
        Boolean(storyboardId) && storyboardId === input.storyboardId;
      const subtitle = `${input.assignmentCount} beat${input.assignmentCount === 1 ? "" : "s"} · ${input.structure}${input.overrideExisting ? " · override on" : ""}${isOnTargetStoryboard ? "" : " · will navigate"}`;
      const body =
        (input.rationale ? `${input.rationale}\n\n` : "")
        + input.assignments
          .map((a) => {
            const actSuffix =
              typeof a.actNumber === "number" ? ` [act ${a.actNumber}]` : "";
            const rSuffix = a.rationale ? ` — ${a.rationale}` : "";
            return `${a.beatKey} ← ${a.nodeId}${actSuffix}${rSuffix}`;
          })
          .join("\n");

      // Commit flow: for each entry, patch node narrative fields
      // (beatType + actNumber) via setNodeNarrativeFields; then
      // replace the narrativeBeats row with the merged plan via
      // upsertBeatPlan. We DON'T snapshot-then-rebuild: the upsert
      // receives the assigned-only set; slots the agent didn't touch
      // keep their prior state once the phase-2 hydration logic in
      // narrativeState:getBeatPlan (producer-facing) runs.
      const applyBeats = async (): Promise<{
        applied: number;
        failed: number;
        error?: string;
      }> => {
        let applied = 0;
        let failed = 0;
        let firstError: string | undefined;
        // Patch node fields sequentially — Convex mutations already
        // serialize per-document, so parallelizing wouldn't help and
        // would noisy-fail the audit trail. For a 15-beat plan this
        // is 15 round-trips; acceptable for a HITL-gated pass.
        for (const entry of input.assignments) {
          try {
            await setNodeNarrativeFieldsMutation({
              storyboardId: input.storyboardId as never,
              nodeId: entry.nodeId,
              beatType: entry.beatKey,
              actNumber:
                typeof entry.actNumber === "number"
                  ? entry.actNumber
                  : undefined,
            });
            applied += 1;
          } catch (err) {
            failed += 1;
            if (firstError === undefined) {
              firstError =
                err instanceof Error
                  ? err.message
                  : "setNodeNarrativeFields failed";
            }
          }
        }
        // Replace the beat plan row with a freshly-seeded-plus-merged
        // list. Each assignment becomes an `assigned` slot; slots the
        // agent didn't touch revert to `planned` since we don't have
        // prior state visible on the bridge side. For phase 2 this is
        // fine — future phases can wire a diff-based upsert when the
        // producer starts editing individual slots in the ribbon.
        try {
          const beats = input.assignments.map((a) => ({
            beatKey: a.beatKey,
            expectedActNumber: a.actNumber,
            nodeId: a.nodeId,
            status: "assigned" as const,
            rationale: a.rationale,
          }));
          await upsertBeatPlanMutation({
            storyboardId: input.storyboardId as never,
            branchId: input.branchId,
            structure: input.structure as never,
            beats,
          });
        } catch (err) {
          if (firstError === undefined) {
            firstError =
              err instanceof Error
                ? err.message
                : "upsertBeatPlan failed";
          }
          failed += 1;
        }
        return { applied, failed, error: firstError };
      };

      return (
        <ApprovalCard
          title={`Apply beat plan (${input.structure.replace(/_/g, " ")})`}
          subtitle={subtitle}
          body={body}
          onApprove={async () => {
            if (!isOnTargetStoryboard) {
              router.push(
                `/storyboard/${encodeURIComponent(input.storyboardId)}`,
              );
            }
            const outcome = await applyBeats();
            await auditToolCall({
              tool: "request_beat_assignment",
              result: outcome.failed > 0 ? "blocked" : "success",
              details: {
                storyboardId: input.storyboardId,
                structure: input.structure,
                assignmentCount: input.assignmentCount,
                applied: outcome.applied,
                failed: outcome.failed,
                overrideExisting: input.overrideExisting,
                error: outcome.error,
                navigated: !isOnTargetStoryboard,
              },
            });
            if (outcome.failed > 0 && outcome.applied === 0) {
              respond({
                approved: false,
                blockedReason:
                  outcome.error ?? "All beat assignments failed.",
              });
            } else {
              respond({
                approved: true,
                applied: outcome.applied,
                failed: outcome.failed,
                structure: input.structure,
              });
            }
          }}
          onEdit={async () => {
            if (!isOnTargetStoryboard) {
              router.push(
                `/storyboard/${encodeURIComponent(input.storyboardId)}`,
              );
            }
            const outcome = await applyBeats();
            await auditToolCall({
              tool: "request_beat_assignment",
              result: outcome.failed > 0 ? "blocked" : "success",
              details: {
                storyboardId: input.storyboardId,
                structure: input.structure,
                assignmentCount: input.assignmentCount,
                applied: outcome.applied,
                failed: outcome.failed,
                error: outcome.error,
                navigated: !isOnTargetStoryboard,
                edited: true,
              },
            });
            if (outcome.failed > 0 && outcome.applied === 0) {
              respond({
                approved: false,
                blockedReason:
                  outcome.error ?? "All beat assignments failed.",
              });
            } else {
              respond({
                approved: true,
                edited: true,
                applied: outcome.applied,
                failed: outcome.failed,
                structure: input.structure,
              });
            }
          }}
          onReject={async () => {
            await auditToolCall({
              tool: "request_beat_assignment",
              result: "blocked",
              details: {
                storyboardId: input.storyboardId,
                structure: input.structure,
                assignmentCount: input.assignmentCount,
              },
            });
            respond({
              approved: false,
              blockedReason: "Producer rejected beat assignment.",
            });
          }}
        />
      );
    },
  });

  // M9 Phase 3 — request_hook_variants approval handler.
  //
  // On approve: each variant becomes its own narrative-git branch
  // `variant/hook-<id>` off the parent HEAD; planOps commit to that
  // branch; a narrativeVariants row links branch → variant metadata.
  // On edit: producer can prune the variant set to a subset via
  // checkboxes in the extra slot (variantToKeep Set state).
  // On reject: no mutations, just audit.
  //
  // Each branch's commit uses a synthetic approvalToken built from the
  // approval task id so commitPlanOps' "approved:" prefix check passes.
  // We never touch applyMergePolicy here — that's a follow-up after
  // the producer picks a winner in Variant Compare.
  useHumanInTheLoop({
    name: "request_hook_variants",
    description:
      "Approve/reject N cold-open variants (each becomes a narrative-git branch). Short-form (<90s) reels live or die on the first 3 seconds; this card lets the producer commit 1-3 alternate openings for side-by-side comparison in the Variant Compare tab.",
    parameters: [
      { name: "storyboardId", type: "string", description: "Storyboard id", required: true },
      { name: "parentBranchId", type: "string", description: "Branch to fork variants from", required: true },
      {
        name: "variants",
        type: "object[]",
        description: "Each: { variantId, rationale, expectedRetention, branchName, planOps[] }",
        required: true,
      },
      { name: "rationale", type: "string", description: "Why three variants now", required: true },
    ],
    render: ({ args, status, respond }) => {
      if (status !== "executing" || !respond) {
        return <></>;
      }
      return (
        <VariantProposalRenderer
          variantType="hook"
          input={parseHookVariantInput(args)}
          args={args}
          storyboardId={storyboardId}
          safeStoryboardId={safeStoryboardId}
          respond={respond}
          router={router}
          createApprovalTask={createApprovalTask}
          resolveApprovalTask={resolveApprovalTask}
          createBranch={createNarrativeBranchMutation}
          commitPlanOps={commitPlanOps}
          upsertVariant={upsertVariantMutation}
          auditToolCall={auditToolCall}
        />
      );
    },
  });

  // M9 Phase 3 — request_structural_remix approval handler.
  //
  // Same commit shape as the hook card: each variant → branch
  // `variant/remix-<structure>-<id>` → commit → narrativeVariants row.
  // Differences: variantType="remix", the card header calls out the
  // target structure, and each variant shows its strategy tag so the
  // producer can compare across approaches at a glance.
  useHumanInTheLoop({
    name: "request_structural_remix",
    description:
      "Approve/reject N structural-remix variants. Each variant is a complete alternate beat ordering (in-medias-res, chrono-reorder, parallel-intercut, harmon-reframe) committed to its own branch.",
    parameters: [
      { name: "storyboardId", type: "string", description: "Storyboard id", required: true },
      { name: "parentBranchId", type: "string", description: "Branch to fork variants from", required: true },
      { name: "targetStructure", type: "string", description: "Beat structure the remix targets", required: true },
      {
        name: "variants",
        type: "object[]",
        description: "Each: { variantId, rationale, strategy, branchName, planOps[] }",
        required: true,
      },
      { name: "rationale", type: "string", description: "Why a structural remix now", required: true },
    ],
    render: ({ args, status, respond }) => {
      if (status !== "executing" || !respond) {
        return <></>;
      }
      return (
        <VariantProposalRenderer
          variantType="remix"
          input={parseStructuralRemixInput(args)}
          args={args}
          storyboardId={storyboardId}
          safeStoryboardId={safeStoryboardId}
          respond={respond}
          router={router}
          createApprovalTask={createApprovalTask}
          resolveApprovalTask={resolveApprovalTask}
          createBranch={createNarrativeBranchMutation}
          commitPlanOps={commitPlanOps}
          upsertVariant={upsertVariantMutation}
          auditToolCall={auditToolCall}
        />
      );
    },
  });

  // M9 Phase 4 — request_transition_proposal approval handler.
  //
  // Producer picks ONE of the ranked transition proposals via radio
  // buttons. On approve:
  //   1. Look up the edge between sourceNodeId + targetNodeId in the
  //      bridge's current `edges` list (fed from the storyboard page).
  //      If the edge doesn't exist yet, fail cleanly — the producer
  //      needs to author the connection first. Transitions layer on
  //      top of graph topology; we don't auto-create edges here.
  //   2. Optionally commit the proposal's planOps (motif plant,
  //      shot addition, etc.) via commitPlanOps.
  //   3. Patch transitionIntent on the edge via
  //      setEdgeTransitionIntent.
  useHumanInTheLoop({
    name: "request_transition_proposal",
    description:
      "Approve/reject a ranked set of transition proposals between two adjacent nodes. Producer picks one; the chosen intent lands on the connecting edge's transitionIntent field.",
    parameters: [
      { name: "storyboardId", type: "string", description: "Storyboard id", required: true },
      { name: "branchId", type: "string", description: "Branch id", required: true },
      { name: "sourceNodeId", type: "string", description: "Source node id", required: true },
      { name: "targetNodeId", type: "string", description: "Target node id", required: true },
      {
        name: "proposals",
        type: "object[]",
        description: "Ranked transition proposals",
        required: true,
      },
      { name: "rationale", type: "string", description: "Overall rationale", required: true },
    ],
    render: ({ args, status, respond }) => {
      if (status !== "executing" || !respond) return <></>;
      return (
        <TransitionProposalRenderer
          input={parseTransitionProposalInput(args)}
          args={args}
          storyboardId={storyboardId}
          safeStoryboardId={safeStoryboardId}
          edges={edges}
          respond={respond}
          router={router}
          createApprovalTask={createApprovalTask}
          resolveApprovalTask={resolveApprovalTask}
          commitPlanOps={commitPlanOps}
          setEdgeTransitionIntent={setEdgeTransitionIntentMutation}
          auditToolCall={auditToolCall}
        />
      );
    },
  });

  // M9 Phase 4 — request_motif_plant approval handler.
  //
  // Single-target commit. On approve:
  //   1. Commit the planOps (typically patches the target shot's
  //      motifIds array + may add a new scene/shot).
  //   2. Upsert the motif registry row: Convex re-derives
  //      landedStatus from sources/payoffs presence so the
  //      MotifMapPanel reflects the new state without the bridge
  //      needing to guess.
  useHumanInTheLoop({
    name: "request_motif_plant",
    description:
      "Approve/reject planting or landing a motif at a specific node. Commits planOps + upserts the motif registry row; landedStatus is auto-derived.",
    parameters: [
      { name: "storyboardId", type: "string", description: "Storyboard id", required: true },
      { name: "branchId", type: "string", description: "Branch id", required: true },
      { name: "motifKey", type: "string", description: "Slug-cased motif id", required: true },
      { name: "targetNodeId", type: "string", description: "Node to plant/land the motif at", required: true },
      { name: "visualVocabulary", type: "string", description: "Concrete visual language for payoff shots", required: false },
      { name: "description", type: "string", description: "Motif description", required: false },
      {
        name: "sourceNodeIds",
        type: "string[]",
        description: "Nodes where the motif is planted",
        required: false,
      },
      {
        name: "payoffNodeIds",
        type: "string[]",
        description: "Nodes where the motif pays off",
        required: false,
      },
      {
        name: "planOps",
        type: "object[]",
        description: "Graph patch ops to apply",
        required: false,
      },
      { name: "rationale", type: "string", description: "Why this plant now", required: true },
    ],
    render: ({ args, status, respond }) => {
      if (status !== "executing" || !respond) return <></>;
      return (
        <MotifPlantRenderer
          input={parseMotifPlantInput(args)}
          args={args}
          storyboardId={storyboardId}
          safeStoryboardId={safeStoryboardId}
          respond={respond}
          router={router}
          createApprovalTask={createApprovalTask}
          resolveApprovalTask={resolveApprovalTask}
          commitPlanOps={commitPlanOps}
          upsertMotif={upsertMotifMutation}
          auditToolCall={auditToolCall}
        />
      );
    },
  });

  useHumanInTheLoop({
    name: "request_dailies_critic_review",
    description:
      "Approve/reject dispatching the dailies_critic subagent on a specific dailies reel. The critic produces a structured critique + repair proposal — it does not mutate state itself.",
    parameters: [
      { name: "storyboardId", type: "string", description: "Storyboard id", required: true },
      { name: "dailiesReelId", type: "string", description: "dailies.reelId to audit", required: true },
      { name: "rationale", type: "string", description: "Why audit now", required: true },
    ],
    render: ({ args, status, respond }) => {
      if (status !== "executing" || !respond) {
        return <></>;
      }
      const input = parseDailiesCriticReviewInput(args);
      if (!input) {
        return (
          <ToolStatusCard
            name="request_dailies_critic_review"
            status="failed"
            args={JSON.stringify(args ?? {}, null, 2)}
            result={JSON.stringify({
              error:
                "Invalid payload: need storyboardId + dailiesReelId.",
            })}
          />
        );
      }
      const isOnTargetStoryboard =
        Boolean(storyboardId) && storyboardId === input.storyboardId;
      const subtitle = `reel ${input.dailiesReelId.slice(0, 8)}…${isOnTargetStoryboard ? "" : " · will navigate"}`;
      return (
        <ApprovalCard
          title="Run dailies critic review"
          subtitle={subtitle}
          body={
            input.rationale
            || "Dispatch the dailies_critic subagent to audit this reel and propose minimal repairs."
          }
          onApprove={async () => {
            if (!isOnTargetStoryboard) {
              router.push(
                `/storyboard/${encodeURIComponent(input.storyboardId)}`,
              );
            }
            await auditToolCall({
              tool: "request_dailies_critic_review",
              result: "success",
              details: {
                storyboardId: input.storyboardId,
                dailiesReelId: input.dailiesReelId,
                navigated: !isOnTargetStoryboard,
              },
            });
            // Approval is the dispatch signal — the supervisor loops
            // back with a `task()` delegation to dailies_critic on the
            // next turn. We don't trigger the critic here because the
            // critic's output is an agent-side plan, not a mutation.
            respond({
              approved: true,
              dailiesReelId: input.dailiesReelId,
            });
          }}
          onReject={async () => {
            await auditToolCall({
              tool: "request_dailies_critic_review",
              result: "blocked",
              details: {
                storyboardId: input.storyboardId,
                dailiesReelId: input.dailiesReelId,
              },
            });
            respond({
              approved: false,
              blockedReason:
                "Producer rejected dailies critic dispatch.",
            });
          }}
          onEdit={async () => {
            // No semantic edit on a pure dispatch — treat Edit as
            // Approve so the button is still useful.
            if (!isOnTargetStoryboard) {
              router.push(
                `/storyboard/${encodeURIComponent(input.storyboardId)}`,
              );
            }
            await auditToolCall({
              tool: "request_dailies_critic_review",
              result: "success",
              details: {
                storyboardId: input.storyboardId,
                dailiesReelId: input.dailiesReelId,
                edited: true,
              },
            });
            respond({
              approved: true,
              edited: true,
              dailiesReelId: input.dailiesReelId,
            });
          }}
        />
      );
    },
  });

  useHumanInTheLoop({
    name: "request_export_reel",
    description:
      "Approve/reject running the server-side ffmpeg pipeline to export this storyboard's reel as a single mp4 file.",
    parameters: [
      { name: "storyboardId", type: "string", description: "Storyboard id", required: true },
      { name: "rationale", type: "string", description: "Why export now", required: true },
      { name: "shotCount", type: "number", description: "Total shot count (diagnostic)", required: false },
      { name: "estimatedDurationS", type: "number", description: "Expected reel duration (diagnostic)", required: false },
    ],
    render: ({ args, status, respond }) => {
      if (status !== "executing" || !respond) {
        return <></>;
      }
      const input = parseExportReelInput(args);
      if (!input) {
        return (
          <ToolStatusCard
            name="request_export_reel"
            status="failed"
            args={JSON.stringify(args ?? {}, null, 2)}
            result={JSON.stringify({ error: "Invalid export-reel payload" })}
          />
        );
      }
      const isOnTargetStoryboard =
        Boolean(storyboardId) && storyboardId === input.storyboardId;
      const durationLabel =
        input.estimatedDurationS > 0
          ? `${input.estimatedDurationS.toFixed(1)}s`
          : "—";
      const subtitle = `${input.shotCount} shot${input.shotCount === 1 ? "" : "s"} · ~${durationLabel} · ffmpeg on server${isOnTargetStoryboard ? "" : " · will navigate"}`;

      const runExport = async (): Promise<{
        url?: string;
        error?: string;
      }> => {
        const res = await fetch("/api/storyboard/export-reel", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ storyboardId: input.storyboardId }),
        });
        if (!res.ok) {
          const err = (await res.json().catch(() => ({}))) as {
            error?: string;
          };
          return { error: err.error ?? `Export failed (${res.status})` };
        }
        const data = (await res.json()) as { url?: string };
        return { url: data.url };
      };

      return (
        <ApprovalCard
          title="Export reel as mp4"
          subtitle={subtitle}
          body={
            input.rationale ||
            "Normalize every rendered shot and concat into a single mp4."
          }
          onApprove={async () => {
            if (!isOnTargetStoryboard) {
              router.push(`/storyboard/${encodeURIComponent(input.storyboardId)}`);
            }
            const outcome = await runExport();
            await auditToolCall({
              tool: "request_export_reel",
              result: outcome.error ? "blocked" : "success",
              details: {
                storyboardId: input.storyboardId,
                shotCount: input.shotCount,
                error: outcome.error,
                navigated: !isOnTargetStoryboard,
              },
            });
            if (outcome.error) {
              respond({ approved: false, blockedReason: outcome.error });
            } else {
              respond({ approved: true, mp4Url: outcome.url });
            }
          }}
          onEdit={async () => {
            // Export has no edit semantics — treat Edit the same as Approve.
            if (!isOnTargetStoryboard) {
              router.push(`/storyboard/${encodeURIComponent(input.storyboardId)}`);
            }
            const outcome = await runExport();
            await auditToolCall({
              tool: "request_export_reel",
              result: outcome.error ? "blocked" : "success",
              details: {
                storyboardId: input.storyboardId,
                error: outcome.error,
                edited: true,
              },
            });
            if (outcome.error) {
              respond({ approved: false, blockedReason: outcome.error });
            } else {
              respond({ approved: true, edited: true, mp4Url: outcome.url });
            }
          }}
          onReject={async () => {
            await auditToolCall({
              tool: "request_export_reel",
              result: "blocked",
              details: { storyboardId: input.storyboardId },
            });
            respond({
              approved: false,
              blockedReason: "Producer rejected reel export.",
            });
          }}
        />
      );
    },
  });

  useHumanInTheLoop({
    name: "request_assign_voice_cast",
    description:
      "Approve/reject a batch of per-character TTS voice assignments written to identityPacks.voice. Producers can edit the batch before applying.",
    parameters: [
      { name: "storyboardId", type: "string", description: "Storyboard id the identity packs belong to", required: true },
      {
        name: "assignments",
        type: "object[]",
        description: "Array of { packId, voice } pairs; voice may be empty to clear a mapping",
        required: true,
        attributes: [
          { name: "packId", type: "string", description: "Identity pack id", required: true },
          { name: "voice", type: "string", description: "OpenAI TTS voice (alloy|echo|fable|onyx|nova|shimmer) or empty to clear", required: true },
        ],
      },
      { name: "rationale", type: "string", description: "Why this cast", required: true },
    ],
    render: ({ args, status, respond }) => {
      if (status !== "executing" || !respond) {
        return <></>;
      }
      const input = parseAssignVoiceCastInput(args);
      if (!input || input.assignments.length === 0) {
        return (
          <ToolStatusCard
            name="request_assign_voice_cast"
            status="failed"
            args={JSON.stringify(args ?? {}, null, 2)}
            result={JSON.stringify({
              error:
                "Invalid voice-cast payload: need storyboardId and at least one { packId, voice } assignment.",
            })}
          />
        );
      }
      const isOnTargetStoryboard =
        Boolean(storyboardId) && storyboardId === input.storyboardId;
      const assignCount = input.assignments.length;
      const clearCount = input.assignments.filter((a) => a.voice === "").length;
      const setCount = assignCount - clearCount;
      const subtitle = `${assignCount} pack${assignCount === 1 ? "" : "s"} · ${setCount} set · ${clearCount} cleared${isOnTargetStoryboard ? "" : " · will navigate"}`;
      const body =
        (input.rationale ? `${input.rationale}\n\n` : "") +
        input.assignments
          .map(
            (a) => `${a.packId} → ${a.voice === "" ? "(clear)" : a.voice}`,
          )
          .join("\n");

      const applyAssignments = async (): Promise<{
        applied: number;
        failed: number;
        error?: string;
      }> => {
        let applied = 0;
        let failed = 0;
        let firstError: string | undefined;
        for (const assignment of input.assignments) {
          try {
            await setIdentityPackVoiceMutation({
              storyboardId: input.storyboardId,
              packId: assignment.packId,
              voice: assignment.voice,
            });
            applied += 1;
          } catch (err) {
            failed += 1;
            if (firstError === undefined) {
              firstError =
                err instanceof Error
                  ? err.message
                  : "setIdentityPackVoice mutation failed";
            }
          }
        }
        return { applied, failed, error: firstError };
      };

      return (
        <ApprovalCard
          title="Assign voice cast"
          subtitle={subtitle}
          body={body}
          extra={<VoiceCastPreviewList assignments={input.assignments} />}
          onApprove={async () => {
            if (!isOnTargetStoryboard) {
              router.push(
                `/storyboard/${encodeURIComponent(input.storyboardId)}`,
              );
            }
            const outcome = await applyAssignments();
            await auditToolCall({
              tool: "request_assign_voice_cast",
              result: outcome.failed > 0 ? "blocked" : "success",
              details: {
                storyboardId: input.storyboardId,
                assignCount,
                applied: outcome.applied,
                failed: outcome.failed,
                error: outcome.error,
                navigated: !isOnTargetStoryboard,
              },
            });
            if (outcome.failed > 0 && outcome.applied === 0) {
              respond({
                approved: false,
                blockedReason:
                  outcome.error ?? "All voice assignments failed.",
              });
            } else {
              respond({
                approved: true,
                applied: outcome.applied,
                failed: outcome.failed,
                assignments: input.assignments,
              });
            }
          }}
          onEdit={async () => {
            if (!isOnTargetStoryboard) {
              router.push(
                `/storyboard/${encodeURIComponent(input.storyboardId)}`,
              );
            }
            const outcome = await applyAssignments();
            await auditToolCall({
              tool: "request_assign_voice_cast",
              result: outcome.failed > 0 ? "blocked" : "success",
              details: {
                storyboardId: input.storyboardId,
                assignCount,
                applied: outcome.applied,
                failed: outcome.failed,
                error: outcome.error,
                navigated: !isOnTargetStoryboard,
                edited: true,
              },
            });
            if (outcome.failed > 0 && outcome.applied === 0) {
              respond({
                approved: false,
                blockedReason:
                  outcome.error ?? "All voice assignments failed.",
              });
            } else {
              respond({
                approved: true,
                edited: true,
                applied: outcome.applied,
                failed: outcome.failed,
                assignments: input.assignments,
              });
            }
          }}
          onReject={async () => {
            await auditToolCall({
              tool: "request_assign_voice_cast",
              result: "blocked",
              details: {
                storyboardId: input.storyboardId,
                assignCount,
              },
            });
            respond({
              approved: false,
              blockedReason: "Producer rejected voice cast assignment.",
            });
          }}
        />
      );
    },
  });

  return (
    <>
      <CopilotActionRegistration name="propose_branch" />
      <CopilotActionRegistration name="expand_scene_to_shots" />
      <CopilotActionRegistration name="merge_branches" />
      <CopilotActionRegistration name="create_character" />
      <CopilotActionRegistration name="edit_character" />
      <CopilotActionRegistration name="create_background" />
      <CopilotActionRegistration name="compose_scene_image" />
      <CopilotActionRegistration name="generate_shot_video" />
      <CopilotActionRegistration name="propagate_consistency_fix" />
      <CopilotActionRegistration name="approve_execution_plan" />
      <CopilotActionRegistration name="approve_batch_ops" />
      <CopilotActionRegistration name="approve_dailies_batch" />
      <CopilotActionRegistration name="approve_merge_policy" />
      <CopilotActionRegistration name="approve_repair_plan" />
      <CopilotActionRegistration name="select_agent_team" />
      <CopilotActionRegistration name="create_agent_team" />
      <CopilotActionRegistration name="update_agent_team_member" />
      <CopilotActionRegistration name="publish_agent_team_revision" />
      <CopilotActionRegistration name="generate_team_from_prompt" />
      <CopilotActionRegistration name="recommend_ingestion_path" />
      <CopilotActionRegistration name="request_ingestion_run" />
      <CopilotActionRegistration name="request_generate_shot_batch" />
      <CopilotActionRegistration name="request_generate_shot_video_batch" />
      <CopilotActionRegistration name="request_generate_shot_audio_batch" />
      <CopilotActionRegistration name="request_generate_shot_sfx_batch" />
      <CopilotActionRegistration name="request_generate_score" />
      <CopilotActionRegistration name="request_dailies_critic_review" />
      <CopilotActionRegistration name="request_beat_assignment" />
      <CopilotActionRegistration name="request_hook_variants" />
      <CopilotActionRegistration name="request_structural_remix" />
      <CopilotActionRegistration name="request_transition_proposal" />
      <CopilotActionRegistration name="request_motif_plant" />
      <CopilotActionRegistration name="request_export_reel" />
      <CopilotActionRegistration name="request_assign_voice_cast" />
      <CopilotSidebar
        defaultOpen={false}
        clickOutsideToClose
        labels={{
          title: "Storyboard Copilot",
          initial:
            "Agent draft mode is active. I can propose branches, shot expansions, merges, and continuity fixes. All mutations require HITL approval.",
        }}
      />
    </>
  );
}

function CopilotActionRegistration({ name }: { name: string }) {
  useCopilotAction({
    name,
    available: "disabled",
    render: ({ status, args, result }) => (
      <ToolStatusCard
        name={name}
        status={normalizeStatus(status)}
        args={JSON.stringify(args ?? {}, null, 2)}
        result={result ? JSON.stringify(result, null, 2) : undefined}
      />
    ),
  });
  return null;
}

function normalizeStatus(input: string): "queued" | "executing" | "waiting_for_human" | "complete" | "failed" {
  if (input === "executing" || input === "inProgress") {
    return "executing";
  }
  if (input === "complete") {
    return "complete";
  }
  if (input === "failed") {
    return "failed";
  }
  if (input === "waiting_for_human") {
    return "waiting_for_human";
  }
  return "queued";
}

function ToolStatusCard({
  name,
  status,
  args,
  result,
}: {
  name: string;
  status: "queued" | "executing" | "waiting_for_human" | "complete" | "failed";
  args: string;
  result?: string;
}) {
  return (
    <div className="my-3 rounded-xl border border-zinc-800 bg-zinc-950 text-zinc-200 p-3">
      <div className="flex items-center justify-between">
        <div className="text-xs uppercase tracking-wide text-zinc-400">{name}</div>
        <span className="text-[10px] uppercase rounded bg-zinc-800 px-2 py-1">{status}</span>
      </div>
      <pre className="mt-2 text-[10px] whitespace-pre-wrap text-zinc-400">{args}</pre>
      {result ? <pre className="mt-2 text-[10px] whitespace-pre-wrap text-emerald-300">{result}</pre> : null}
    </div>
  );
}

function ApprovalCard({
  title,
  subtitle,
  body,
  extra,
  onApprove,
  onEdit,
  onReject,
}: {
  title: string;
  subtitle: string;
  body: string;
  /** Optional React slot rendered between the prose body and the
   *  Approve/Edit/Reject buttons. Used by the voice-cast card to
   *  inject inline preview ▶ buttons; other callers omit it. */
  extra?: React.ReactNode;
  onApprove: () => Promise<void>;
  onEdit: () => Promise<void>;
  onReject: () => Promise<void>;
}) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const runAction = async (action: () => Promise<void>) => {
    setError(null);
    setIsSubmitting(true);
    try {
      await action();
    } catch (executionError) {
      setError(
        executionError instanceof Error
          ? executionError.message
          : "Failed to execute approval action.",
      );
      setIsSubmitting(false);
    }
  };

  return (
    <div className="my-4 rounded-xl border border-amber-500/40 bg-zinc-950 text-zinc-100 p-4">
      <div className="text-xs uppercase text-amber-300 tracking-wide">Approval Required</div>
      <h3 className="mt-1 text-sm font-semibold">{title}</h3>
      <p className="mt-1 text-xs text-zinc-400">{subtitle}</p>
      <p className="mt-3 text-xs text-zinc-300 whitespace-pre-wrap">{body}</p>
      {extra ? <div className="mt-3">{extra}</div> : null}
      {error ? (
        <p className="mt-2 text-[11px] text-rose-300 whitespace-pre-wrap">
          {error}
        </p>
      ) : null}
      <div className="mt-3 flex gap-2">
        <button
          className="px-3 py-1.5 text-xs rounded bg-emerald-600 disabled:opacity-60"
          onClick={() => void runAction(onApprove)}
          disabled={isSubmitting}
        >
          Approve
        </button>
        <button
          className="px-3 py-1.5 text-xs rounded bg-blue-600 disabled:opacity-60"
          onClick={() => void runAction(onEdit)}
          disabled={isSubmitting}
        >
          Approve As Edited
        </button>
        <button
          className="px-3 py-1.5 text-xs rounded bg-rose-700 disabled:opacity-60"
          onClick={() => void runAction(onReject)}
          disabled={isSubmitting}
        >
          Reject
        </button>
      </div>
    </div>
  );
}

/**
 * M9 Phase 3 — shared renderer for request_hook_variants and
 * request_structural_remix HITL cards. Both tools have the same
 * approval shape: the producer picks 0-N variants to commit, each one
 * becomes its own narrative-git branch + commit + narrativeVariants
 * row. Sharing the renderer keeps the commit flow (and audit shape)
 * byte-identical between the two tools.
 *
 * UX: checkbox list of variants (Approve commits all checked; Edit is
 * explicit "commit a subset"; Reject commits none). On approve or edit
 * we walk the selected variants sequentially — each round-trip is a
 * createBranch → commitPlanOps → upsertVariant triple. Sequential
 * rather than parallel so the audit log reads top-to-bottom and any
 * mid-stream failure short-circuits cleanly.
 *
 * The renderer is intentionally a siblings-stay strategy: siblings of
 * a picked winner are NOT archived here; that happens later in
 * Variant Compare when the producer runs applyMergePolicy. The 14-day
 * cron then reaps whatever was never picked.
 */
type VariantProposalRendererProps = {
  variantType: "hook" | "remix";
  input: HookVariantInput | StructuralRemixInput | null;
  args: unknown;
  storyboardId: string | null;
  safeStoryboardId: string;
  respond: (payload: Record<string, unknown>) => void;
  router: ReturnType<typeof useRouter>;
  createApprovalTask: (input: {
    storyboardId: string;
    taskType: string;
    title: string;
    rationale: string;
    diffSummary: string;
    payloadJson: string;
  }) => Promise<string>;
  resolveApprovalTask: (input: {
    taskId: string;
    approved: boolean;
    editedPayloadJson?: string;
  }) => Promise<unknown>;
  createBranch: (input: {
    storyboardId: string;
    branchId: string;
    name: string;
    parentBranchId?: string;
    parentCommitId?: string;
  }) => Promise<unknown>;
  commitPlanOps: (input: {
    storyboardId: string;
    branchId: string;
    title: string;
    rationale?: string;
    operations: HookVariantPlanOp[];
    approvalToken: string;
  }) => Promise<{ commitId: string } | unknown>;
  upsertVariant: (input: {
    storyboardId: string;
    branchId: string;
    variantType: "hook" | "structural" | "transition" | "remix";
    rationale: string;
    parentBranchId?: string;
  }) => Promise<unknown>;
  auditToolCall: (input: {
    tool: string;
    result: "success" | "failure" | "blocked";
    details?: Record<string, unknown>;
  }) => Promise<void>;
};

function VariantProposalRenderer(props: VariantProposalRendererProps) {
  const {
    variantType,
    input,
    args,
    storyboardId,
    respond,
    router,
    createApprovalTask,
    resolveApprovalTask,
    createBranch,
    commitPlanOps,
    upsertVariant,
    auditToolCall,
  } = props;
  const toolName =
    variantType === "hook" ? "request_hook_variants" : "request_structural_remix";

  // Checkbox state for partial commits. Initialized to "all selected"
  // so an uninspected Approve behaves as "commit everything", matching
  // producer intuition; Edit lets them trim.
  const variantIds: string[] = input?.variants.map((v) => v.variantId) ?? [];
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(variantIds),
  );

  if (!input || input.variants.length === 0) {
    return (
      <ToolStatusCard
        name={toolName}
        status="failed"
        args={JSON.stringify(args ?? {}, null, 2)}
        result={JSON.stringify({
          error:
            "Invalid variant payload: need storyboardId + at least one variant with non-empty planOps.",
        })}
      />
    );
  }

  const isOnTargetStoryboard =
    Boolean(storyboardId) && storyboardId === input.storyboardId;

  const targetStructureLabel =
    variantType === "remix"
      ? (input as StructuralRemixInput).targetStructure.replace(/_/g, " ")
      : "";

  const subtitle = [
    `${input.variantCount} variant${input.variantCount === 1 ? "" : "s"}`,
    variantType === "remix" ? `target: ${targetStructureLabel}` : null,
    `parent: ${input.parentBranchId}`,
    isOnTargetStoryboard ? null : "will navigate",
  ]
    .filter(Boolean)
    .join(" · ");

  const body =
    (input.rationale ? `${input.rationale}\n\n` : "")
    + input.variants
      .map((v) => {
        const tag =
          variantType === "hook"
            ? (v as HookVariantEntry).expectedRetention
            : (v as StructuralRemixEntry).strategy;
        const tagSuffix = tag ? ` · ${tag}` : "";
        return `[${v.variantId}${tagSuffix}] ${v.rationale}`;
      })
      .join("\n");

  // Build a unique branchId per variant. Shape mirrors the Python
  // branchName format so traverse.ts + narrativeGit's existing
  // branch-name conventions stay consistent.
  const branchIdFor = (variantId: string): string =>
    variantType === "hook"
      ? `variant/hook-${variantId}`
      : `variant/remix-${(input as StructuralRemixInput).targetStructure}-${variantId}`;

  const commitSelected = async (
    decision: "approve" | "edit",
  ): Promise<{ committed: number; failed: number; error?: string }> => {
    let committed = 0;
    let failed = 0;
    let firstError: string | undefined;
    const keepIds = decision === "approve" ? new Set(variantIds) : selected;
    for (const variant of input.variants) {
      if (!keepIds.has(variant.variantId)) continue;
      try {
        const branchId = branchIdFor(variant.variantId);
        // createBranch is idempotent — it returns the existing row's
        // id when a branch with the same branchId is already present.
        // That guards against double-click commits without adding a
        // dedup layer on our side.
        await createBranch({
          storyboardId: input.storyboardId,
          branchId,
          name: variant.branchName,
          parentBranchId: input.parentBranchId,
        });
        // Per-variant approval token. Using a synthetic task per
        // variant rather than one task for the whole batch gives
        // per-variant audit trail + lets a partial failure identify
        // exactly which variant broke.
        const taskId = await createApprovalTask({
          storyboardId: input.storyboardId,
          taskType:
            variantType === "hook"
              ? "hook_variant_commit"
              : "structural_remix_commit",
          title: `Commit ${variant.branchName}`,
          rationale: variant.rationale || "Variant commit",
          diffSummary: `${variant.planOps.length} ops`,
          payloadJson: JSON.stringify(variant),
        });
        await resolveApprovalTask({
          taskId,
          approved: true,
          editedPayloadJson:
            decision === "edit" ? JSON.stringify(variant) : undefined,
        });
        await commitPlanOps({
          storyboardId: input.storyboardId,
          branchId,
          title: variant.branchName,
          rationale: variant.rationale,
          operations: variant.planOps,
          approvalToken: `approved:${taskId}`,
        });
        await upsertVariant({
          storyboardId: input.storyboardId,
          branchId,
          variantType: variantType === "hook" ? "hook" : "remix",
          rationale: variant.rationale,
          parentBranchId: input.parentBranchId,
        });
        committed += 1;
      } catch (err) {
        failed += 1;
        if (firstError === undefined) {
          firstError =
            err instanceof Error
              ? err.message
              : `Failed to commit variant ${variant.variantId}`;
        }
      }
    }
    return { committed, failed, error: firstError };
  };

  const extra = (
    <div className="space-y-1">
      {input.variants.map((v) => {
        const isSelected = selected.has(v.variantId);
        const tag =
          variantType === "hook"
            ? (v as HookVariantEntry).expectedRetention
            : (v as StructuralRemixEntry).strategy;
        return (
          <label
            key={v.variantId}
            className="flex items-start gap-2 text-[11px] text-zinc-300 cursor-pointer"
          >
            <input
              type="checkbox"
              checked={isSelected}
              onChange={(e) => {
                const next = new Set(selected);
                if (e.target.checked) {
                  next.add(v.variantId);
                } else {
                  next.delete(v.variantId);
                }
                setSelected(next);
              }}
              className="mt-0.5"
            />
            <span className="flex-1">
              <span className="font-mono text-emerald-300">
                {v.variantId}
              </span>
              {tag ? (
                <span className="ml-1 text-zinc-500">[{tag}]</span>
              ) : null}
              <span className="ml-2 text-zinc-400">{v.branchName}</span>
              <span className="ml-2 text-zinc-500">
                {v.planOps.length} op{v.planOps.length === 1 ? "" : "s"}
              </span>
            </span>
          </label>
        );
      })}
    </div>
  );

  return (
    <ApprovalCard
      title={
        variantType === "hook"
          ? `Commit ${input.variantCount} cold-open variant${input.variantCount === 1 ? "" : "s"}`
          : `Commit ${input.variantCount} structural remix${input.variantCount === 1 ? "" : "es"} (${targetStructureLabel})`
      }
      subtitle={subtitle}
      body={body}
      extra={extra}
      onApprove={async () => {
        if (!isOnTargetStoryboard) {
          router.push(
            `/storyboard/${encodeURIComponent(input.storyboardId)}`,
          );
        }
        const outcome = await commitSelected("approve");
        await auditToolCall({
          tool: toolName,
          result: outcome.failed > 0 ? "blocked" : "success",
          details: {
            storyboardId: input.storyboardId,
            parentBranchId: input.parentBranchId,
            variantCount: input.variantCount,
            committed: outcome.committed,
            failed: outcome.failed,
            error: outcome.error,
            variantType,
            targetStructure:
              variantType === "remix"
                ? (input as StructuralRemixInput).targetStructure
                : undefined,
          },
        });
        if (outcome.failed > 0 && outcome.committed === 0) {
          respond({
            approved: false,
            blockedReason:
              outcome.error ?? "All variant commits failed.",
          });
        } else {
          respond({
            approved: true,
            variantType,
            committed: outcome.committed,
            failed: outcome.failed,
          });
        }
      }}
      onEdit={async () => {
        if (selected.size === 0) {
          await auditToolCall({
            tool: toolName,
            result: "blocked",
            details: {
              storyboardId: input.storyboardId,
              variantCount: input.variantCount,
              edited: true,
              reason: "edit_with_zero_selected",
            },
          });
          respond({
            approved: false,
            edited: true,
            blockedReason:
              "Edit submitted with no variants selected — treat as reject.",
          });
          return;
        }
        if (!isOnTargetStoryboard) {
          router.push(
            `/storyboard/${encodeURIComponent(input.storyboardId)}`,
          );
        }
        const outcome = await commitSelected("edit");
        await auditToolCall({
          tool: toolName,
          result: outcome.failed > 0 ? "blocked" : "success",
          details: {
            storyboardId: input.storyboardId,
            parentBranchId: input.parentBranchId,
            variantCount: input.variantCount,
            selectedCount: selected.size,
            committed: outcome.committed,
            failed: outcome.failed,
            error: outcome.error,
            variantType,
            edited: true,
          },
        });
        if (outcome.failed > 0 && outcome.committed === 0) {
          respond({
            approved: false,
            edited: true,
            blockedReason:
              outcome.error ?? "All selected variant commits failed.",
          });
        } else {
          respond({
            approved: true,
            edited: true,
            variantType,
            committed: outcome.committed,
            failed: outcome.failed,
            selectedVariantIds: Array.from(selected),
          });
        }
      }}
      onReject={async () => {
        await auditToolCall({
          tool: toolName,
          result: "blocked",
          details: {
            storyboardId: input.storyboardId,
            variantCount: input.variantCount,
            variantType,
          },
        });
        respond({
          approved: false,
          blockedReason: `Producer rejected ${variantType === "hook" ? "cold-open" : "structural remix"} variants.`,
        });
      }}
    />
  );
}

/**
 * M9 Phase 4 — TransitionProposalRenderer.
 *
 * Pick-one radio UX. The producer sees 2-4 ranked proposals; radio
 * selects one; Approve commits that choice. Edit flows exactly like
 * Approve but tags the audit as edited; useful when the producer
 * picks rank-2 over the agent's top recommendation. Reject abstains.
 *
 * Commit steps on approve/edit:
 *   1. Locate the edge (sourceNodeId → targetNodeId) in the bridge's
 *      current `edges` list. If missing, fail fast — the edge has to
 *      exist for a transition intent to land.
 *   2. Commit the chosen proposal's planOps (motif plant + shot
 *      additions) if present, via commitPlanOps.
 *   3. Patch transitionIntent on the edge via
 *      setEdgeTransitionIntent.
 */
type TransitionProposalRendererProps = {
  input: TransitionProposalInput | null;
  args: unknown;
  storyboardId: string | null;
  safeStoryboardId: string;
  edges: StoryEdge[];
  respond: (payload: Record<string, unknown>) => void;
  router: ReturnType<typeof useRouter>;
  createApprovalTask: (input: {
    storyboardId: string;
    taskType: string;
    title: string;
    rationale: string;
    diffSummary: string;
    payloadJson: string;
  }) => Promise<string>;
  resolveApprovalTask: (input: {
    taskId: string;
    approved: boolean;
    editedPayloadJson?: string;
  }) => Promise<unknown>;
  commitPlanOps: (input: {
    storyboardId: string;
    branchId: string;
    title: string;
    rationale?: string;
    operations: HookVariantPlanOp[];
    approvalToken: string;
  }) => Promise<unknown>;
  setEdgeTransitionIntent: (input: {
    storyboardId: string;
    edgeId: string;
    transitionIntent: string | null;
  }) => Promise<unknown>;
  auditToolCall: (input: {
    tool: string;
    result: "success" | "failure" | "blocked";
    details?: Record<string, unknown>;
  }) => Promise<void>;
};

function TransitionProposalRenderer(props: TransitionProposalRendererProps) {
  const {
    input,
    args,
    storyboardId,
    edges,
    respond,
    router,
    createApprovalTask,
    resolveApprovalTask,
    commitPlanOps,
    setEdgeTransitionIntent,
    auditToolCall,
  } = props;

  // Initial selection = rank-1 proposal (the recommended one) which is
  // at index 0 after the Python tool's server-side sort.
  const [selectedIntent, setSelectedIntent] = useState<string>(
    () => input?.proposals[0]?.intent ?? "",
  );

  if (!input || input.proposals.length === 0) {
    return (
      <ToolStatusCard
        name="request_transition_proposal"
        status="failed"
        args={JSON.stringify(args ?? {}, null, 2)}
        result={JSON.stringify({
          error:
            "Invalid transition payload: need sourceNodeId + targetNodeId + at least one proposal.",
        })}
      />
    );
  }

  // Find the edge now so the approval card can warn the producer if
  // no connection exists yet. We match by (source, target) regardless
  // of direction since the producer may have authored the edge with
  // either orientation.
  const matchedEdge = edges.find(
    (e) =>
      (e.source === input.sourceNodeId && e.target === input.targetNodeId)
      || (e.source === input.targetNodeId && e.target === input.sourceNodeId),
  );
  const edgeIdForCommit = matchedEdge?.id ?? "";

  const isOnTargetStoryboard =
    Boolean(storyboardId) && storyboardId === input.storyboardId;

  const subtitle = [
    `${input.sourceNodeId} → ${input.targetNodeId}`,
    `${input.proposalCount} proposal${input.proposalCount === 1 ? "" : "s"}`,
    matchedEdge ? `edge ${matchedEdge.id.slice(0, 8)}` : "no edge (blocks)",
    isOnTargetStoryboard ? null : "will navigate",
  ]
    .filter(Boolean)
    .join(" · ");

  const body =
    (input.rationale ? `${input.rationale}\n\n` : "")
    + input.proposals
      .map((p) => {
        const rankPrefix = p.rank ? `#${p.rank} ` : "";
        const sharedSuffix = p.sharedElement ? ` — shared: ${p.sharedElement}` : "";
        const warnSuffix =
          p.rawIntent && p.rawIntent !== p.intent
            ? ` (normalized from '${p.rawIntent}')`
            : "";
        return `${rankPrefix}[${p.intent}]${warnSuffix}${sharedSuffix}\n${p.rationale ?? ""}`;
      })
      .join("\n\n");

  const commitChosen = async (
    decision: "approve" | "edit",
  ): Promise<{ ok: boolean; error?: string }> => {
    if (!matchedEdge) {
      return {
        ok: false,
        error: `No edge between ${input.sourceNodeId} and ${input.targetNodeId}. Connect the nodes before applying a transition.`,
      };
    }
    const chosen = input.proposals.find((p) => p.intent === selectedIntent);
    if (!chosen) {
      return { ok: false, error: "No proposal selected." };
    }
    try {
      const taskId = await createApprovalTask({
        storyboardId: input.storyboardId,
        taskType: "transition_proposal",
        title: `${chosen.intent} between ${input.sourceNodeId} + ${input.targetNodeId}`,
        rationale: chosen.rationale ?? "Transition intent approved",
        diffSummary: `transitionIntent=${chosen.intent}`,
        payloadJson: JSON.stringify({ ...input, selectedIntent }),
      });
      await resolveApprovalTask({
        taskId,
        approved: true,
        editedPayloadJson:
          decision === "edit"
            ? JSON.stringify({ ...input, selectedIntent })
            : undefined,
      });
      if (chosen.planOps && chosen.planOps.length > 0) {
        await commitPlanOps({
          storyboardId: input.storyboardId,
          branchId: input.branchId,
          title: `Transition plant: ${chosen.intent}`,
          rationale: chosen.rationale,
          operations: chosen.planOps,
          approvalToken: `approved:${taskId}`,
        });
      }
      await setEdgeTransitionIntent({
        storyboardId: input.storyboardId,
        edgeId: edgeIdForCommit,
        transitionIntent: chosen.intent,
      });
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        error:
          err instanceof Error
            ? err.message
            : "Failed to apply transition proposal.",
      };
    }
  };

  const extra = (
    <div className="space-y-1">
      {input.proposals.map((p) => {
        const isSelected = selectedIntent === p.intent;
        return (
          <label
            key={`${p.intent}-${p.rank ?? ""}`}
            className="flex items-start gap-2 text-[11px] text-zinc-300 cursor-pointer"
          >
            <input
              type="radio"
              name="transition-pick"
              checked={isSelected}
              onChange={() => setSelectedIntent(p.intent)}
              className="mt-0.5"
            />
            <span className="flex-1">
              {p.rank ? (
                <span className="mr-1 text-zinc-500">#{p.rank}</span>
              ) : null}
              <span className="font-mono text-emerald-300">{p.intent}</span>
              {p.sharedElement ? (
                <span className="ml-2 text-zinc-400">
                  shared: {p.sharedElement}
                </span>
              ) : null}
              {p.planOps && p.planOps.length > 0 ? (
                <span className="ml-2 text-amber-300">
                  {p.planOps.length} op{p.planOps.length === 1 ? "" : "s"}
                </span>
              ) : null}
            </span>
          </label>
        );
      })}
    </div>
  );

  return (
    <ApprovalCard
      title={`Transition: ${input.sourceNodeId} → ${input.targetNodeId}`}
      subtitle={subtitle}
      body={body}
      extra={extra}
      onApprove={async () => {
        if (!isOnTargetStoryboard) {
          router.push(
            `/storyboard/${encodeURIComponent(input.storyboardId)}`,
          );
        }
        const result = await commitChosen("approve");
        await auditToolCall({
          tool: "request_transition_proposal",
          result: result.ok ? "success" : "blocked",
          details: {
            storyboardId: input.storyboardId,
            sourceNodeId: input.sourceNodeId,
            targetNodeId: input.targetNodeId,
            selectedIntent,
            edgeId: edgeIdForCommit || undefined,
            error: result.error,
          },
        });
        if (result.ok) {
          respond({ approved: true, selectedIntent, edgeId: edgeIdForCommit });
        } else {
          respond({
            approved: false,
            blockedReason: result.error ?? "Transition commit failed.",
          });
        }
      }}
      onEdit={async () => {
        if (!isOnTargetStoryboard) {
          router.push(
            `/storyboard/${encodeURIComponent(input.storyboardId)}`,
          );
        }
        const result = await commitChosen("edit");
        await auditToolCall({
          tool: "request_transition_proposal",
          result: result.ok ? "success" : "blocked",
          details: {
            storyboardId: input.storyboardId,
            sourceNodeId: input.sourceNodeId,
            targetNodeId: input.targetNodeId,
            selectedIntent,
            edited: true,
            error: result.error,
          },
        });
        if (result.ok) {
          respond({
            approved: true,
            edited: true,
            selectedIntent,
            edgeId: edgeIdForCommit,
          });
        } else {
          respond({
            approved: false,
            edited: true,
            blockedReason: result.error ?? "Transition commit failed.",
          });
        }
      }}
      onReject={async () => {
        await auditToolCall({
          tool: "request_transition_proposal",
          result: "blocked",
          details: {
            storyboardId: input.storyboardId,
            sourceNodeId: input.sourceNodeId,
            targetNodeId: input.targetNodeId,
          },
        });
        respond({
          approved: false,
          blockedReason: "Producer rejected transition proposals.",
        });
      }}
    />
  );
}

/**
 * M9 Phase 4 — MotifPlantRenderer.
 *
 * Single-target plant. The approval card surfaces motifKey, target
 * node, visual vocabulary, and the planOps to apply. On approve:
 *   1. Commit the planOps (typically a single update_node op that
 *      appends motifKey to the target's motifIds[]).
 *   2. Upsert the narrativeMotifs row — Convex derives landedStatus
 *      from sources/payoffs presence so the bridge doesn't guess.
 *
 * The upsertMotif mutation requires an explicit landedStatus; we
 * compute it client-side so the producer sees the exact status that
 * will land in the database (matching Convex's derivation rule).
 */
type MotifPlantRendererProps = {
  input: MotifPlantInput | null;
  args: unknown;
  storyboardId: string | null;
  safeStoryboardId: string;
  respond: (payload: Record<string, unknown>) => void;
  router: ReturnType<typeof useRouter>;
  createApprovalTask: TransitionProposalRendererProps["createApprovalTask"];
  resolveApprovalTask: TransitionProposalRendererProps["resolveApprovalTask"];
  commitPlanOps: TransitionProposalRendererProps["commitPlanOps"];
  upsertMotif: (input: {
    storyboardId: string;
    motifKey: string;
    description: string;
    sourceNodeIds: string[];
    payoffNodeIds: string[];
    visualVocabulary?: string;
    landedStatus: "unplanted" | "planted" | "landed";
  }) => Promise<unknown>;
  auditToolCall: TransitionProposalRendererProps["auditToolCall"];
};

function MotifPlantRenderer(props: MotifPlantRendererProps) {
  const {
    input,
    args,
    storyboardId,
    respond,
    router,
    createApprovalTask,
    resolveApprovalTask,
    commitPlanOps,
    upsertMotif,
    auditToolCall,
  } = props;

  if (!input) {
    return (
      <ToolStatusCard
        name="request_motif_plant"
        status="failed"
        args={JSON.stringify(args ?? {}, null, 2)}
        result={JSON.stringify({
          error:
            "Invalid motif plant payload: need storyboardId + motifKey + targetNodeId.",
        })}
      />
    );
  }

  const isOnTargetStoryboard =
    Boolean(storyboardId) && storyboardId === input.storyboardId;

  // Derive the landedStatus the row will get if the producer approves.
  // The rule mirrors detect_motif_gaps on the agent side: both arrays
  // present → landed, sources only → planted, payoffs only → orphaned
  // (Convex schema uses "planted" for the orphan case too since
  // landedStatus enum is {unplanted, planted, landed}; the panel
  // distinguishes via sources/payoffs presence).
  const derivedStatus: "unplanted" | "planted" | "landed" =
    input.sourceNodeIds.length > 0 && input.payoffNodeIds.length > 0
      ? "landed"
      : input.sourceNodeIds.length > 0 || input.payoffNodeIds.length > 0
        ? "planted"
        : "unplanted";

  const subtitle = [
    `motif ${input.motifKey}`,
    `target ${input.targetNodeId}`,
    `status → ${derivedStatus}`,
    `${input.planOps.length} op${input.planOps.length === 1 ? "" : "s"}`,
    isOnTargetStoryboard ? null : "will navigate",
  ]
    .filter(Boolean)
    .join(" · ");

  const body = [
    input.rationale,
    input.description ? `Description: ${input.description}` : "",
    input.visualVocabulary
      ? `Visual vocabulary: ${input.visualVocabulary}`
      : "",
    input.sourceNodeIds.length > 0
      ? `Plants: ${input.sourceNodeIds.join(", ")}`
      : "",
    input.payoffNodeIds.length > 0
      ? `Payoffs: ${input.payoffNodeIds.join(", ")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");

  const applyPlant = async (
    decision: "approve" | "edit",
  ): Promise<{ ok: boolean; error?: string }> => {
    try {
      const taskId = await createApprovalTask({
        storyboardId: input.storyboardId,
        taskType: "motif_plant",
        title: `Plant motif ${input.motifKey} at ${input.targetNodeId}`,
        rationale: input.rationale || "Motif plant approved",
        diffSummary: `motif=${input.motifKey} status=${derivedStatus}`,
        payloadJson: JSON.stringify(input),
      });
      await resolveApprovalTask({
        taskId,
        approved: true,
        editedPayloadJson:
          decision === "edit" ? JSON.stringify(input) : undefined,
      });
      if (input.planOps.length > 0) {
        await commitPlanOps({
          storyboardId: input.storyboardId,
          branchId: input.branchId,
          title: `Plant ${input.motifKey} at ${input.targetNodeId}`,
          rationale: input.rationale,
          operations: input.planOps,
          approvalToken: `approved:${taskId}`,
        });
      }
      await upsertMotif({
        storyboardId: input.storyboardId,
        motifKey: input.motifKey,
        description: input.description,
        sourceNodeIds: input.sourceNodeIds,
        payoffNodeIds: input.payoffNodeIds,
        visualVocabulary: input.visualVocabulary || undefined,
        landedStatus: derivedStatus,
      });
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        error:
          err instanceof Error
            ? err.message
            : "Failed to apply motif plant.",
      };
    }
  };

  return (
    <ApprovalCard
      title={`Plant motif: ${input.motifKey}`}
      subtitle={subtitle}
      body={body}
      onApprove={async () => {
        if (!isOnTargetStoryboard) {
          router.push(
            `/storyboard/${encodeURIComponent(input.storyboardId)}`,
          );
        }
        const result = await applyPlant("approve");
        await auditToolCall({
          tool: "request_motif_plant",
          result: result.ok ? "success" : "blocked",
          details: {
            storyboardId: input.storyboardId,
            motifKey: input.motifKey,
            targetNodeId: input.targetNodeId,
            derivedStatus,
            planOpCount: input.planOps.length,
            error: result.error,
          },
        });
        if (result.ok) {
          respond({
            approved: true,
            motifKey: input.motifKey,
            landedStatus: derivedStatus,
          });
        } else {
          respond({
            approved: false,
            blockedReason: result.error ?? "Motif plant failed.",
          });
        }
      }}
      onEdit={async () => {
        if (!isOnTargetStoryboard) {
          router.push(
            `/storyboard/${encodeURIComponent(input.storyboardId)}`,
          );
        }
        const result = await applyPlant("edit");
        await auditToolCall({
          tool: "request_motif_plant",
          result: result.ok ? "success" : "blocked",
          details: {
            storyboardId: input.storyboardId,
            motifKey: input.motifKey,
            targetNodeId: input.targetNodeId,
            derivedStatus,
            edited: true,
            error: result.error,
          },
        });
        if (result.ok) {
          respond({
            approved: true,
            edited: true,
            motifKey: input.motifKey,
            landedStatus: derivedStatus,
          });
        } else {
          respond({
            approved: false,
            edited: true,
            blockedReason: result.error ?? "Motif plant failed.",
          });
        }
      }}
      onReject={async () => {
        await auditToolCall({
          tool: "request_motif_plant",
          result: "blocked",
          details: {
            storyboardId: input.storyboardId,
            motifKey: input.motifKey,
            targetNodeId: input.targetNodeId,
          },
        });
        respond({
          approved: false,
          blockedReason: "Producer rejected motif plant.",
        });
      }}
    />
  );
}

/**
 * M6 polish — inline voice preview list for the request_assign_voice_cast
 * approval card. Each assignment gets a ▶ button that hits
 * /api/media/preview-voice for the proposed voice and plays the returned
 * mp3 sample, so the producer can audition before approving the whole
 * batch. Mirrors the ContinuityOSPanel row preview, but the list layout
 * accommodates N rows instead of the single-pack dropdown.
 */
function VoiceCastPreviewList({
  assignments,
}: {
  assignments: VoiceCastAssignment[];
}) {
  const [busyVoice, setBusyVoice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    return () => {
      const audio = audioRef.current;
      if (!audio) return;
      audio.pause();
      if (audio.src.startsWith("blob:")) {
        URL.revokeObjectURL(audio.src);
      }
    };
  }, []);

  const playPreview = async (voice: string) => {
    if (!voice) return;
    setError(null);
    setBusyVoice(voice);
    try {
      const res = await fetch(
        `/api/media/preview-voice?voice=${encodeURIComponent(voice)}`,
        { method: "GET", cache: "no-store" },
      );
      if (!res.ok) {
        const msg = await res.text().catch(() => "");
        throw new Error(
          `preview ${res.status}: ${msg.slice(0, 160) || "unknown error"}`,
        );
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const prev = audioRef.current;
      if (prev) {
        prev.pause();
        if (prev.src.startsWith("blob:")) URL.revokeObjectURL(prev.src);
      }
      const audio = prev ?? new Audio();
      audioRef.current = audio;
      audio.src = url;
      await audio.play();
    } catch (err) {
      setError(err instanceof Error ? err.message : "preview failed");
    } finally {
      setBusyVoice(null);
    }
  };

  return (
    <div className="rounded border border-zinc-800 bg-zinc-900/50 p-2">
      <p className="text-[10px] uppercase tracking-wide text-zinc-500">
        Audition each proposed voice
      </p>
      <ul className="mt-1 space-y-1">
        {assignments.map((a) => (
          <li
            key={`${a.packId}_${a.voice}`}
            className="flex items-center justify-between gap-2 text-[11px]"
          >
            <span className="truncate text-zinc-300">
              <span className="font-mono text-zinc-500">{a.packId}</span>
              <span className="mx-1 text-zinc-500">→</span>
              <span>{a.voice === "" ? "(clear)" : a.voice}</span>
            </span>
            <button
              type="button"
              onClick={() => void playPreview(a.voice)}
              disabled={!a.voice || busyVoice !== null}
              className="shrink-0 rounded border border-zinc-700 bg-zinc-900 px-2 py-0.5 text-[10px] text-zinc-200 disabled:opacity-40"
              title={
                a.voice
                  ? `Play a sample of "${a.voice}"`
                  : "No voice to preview (clear action)"
              }
            >
              {busyVoice === a.voice ? "…" : "▶"}
            </button>
          </li>
        ))}
      </ul>
      {error ? (
        <p className="mt-1 text-[10px] text-rose-400" title={error}>
          preview failed: {error}
        </p>
      ) : null}
    </div>
  );
}

function BatchApprovalCard({
  title,
  subtitle,
  body,
  operations,
  onApprove,
  onReject,
}: {
  title: string;
  subtitle: string;
  body: string;
  operations: unknown[];
  onApprove: (selectedOperations: unknown[]) => Promise<void>;
  onReject: () => Promise<void>;
}) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedIndexes, setSelectedIndexes] = useState<number[]>(() =>
    operations.map((_, index) => index),
  );

  const toggleSelection = (index: number) => {
    setSelectedIndexes((current) =>
      current.includes(index)
        ? current.filter((value) => value !== index)
        : [...current, index].sort((left, right) => left - right),
    );
  };

  const runAction = async (action: () => Promise<void>) => {
    setError(null);
    setIsSubmitting(true);
    try {
      await action();
    } catch (executionError) {
      setError(
        executionError instanceof Error
          ? executionError.message
          : "Failed to execute batch approval.",
      );
      setIsSubmitting(false);
    }
  };

  const selectedOperations = selectedIndexes
    .map((index) => operations[index])
    .filter((operation): operation is unknown => operation !== undefined);

  return (
    <div className="my-4 rounded-xl border border-violet-500/40 bg-zinc-950 text-zinc-100 p-4">
      <div className="text-xs uppercase text-violet-300 tracking-wide">Batch Approval Required</div>
      <h3 className="mt-1 text-sm font-semibold">{title}</h3>
      <p className="mt-1 text-xs text-zinc-400">{subtitle}</p>
      <p className="mt-3 text-xs text-zinc-300 whitespace-pre-wrap">{body}</p>

      <div className="mt-3 max-h-48 overflow-y-auto rounded border border-zinc-800 p-2 space-y-2">
        {operations.map((operation, index) => {
          const label = isRecord(operation) && typeof operation.title === "string"
            ? operation.title
            : isRecord(operation) && typeof operation.op === "string"
              ? operation.op
              : `operation_${index + 1}`;
          const checked = selectedIndexes.includes(index);
          return (
            <label key={`batch_op_${index}`} className="flex items-start gap-2 text-xs text-zinc-300">
              <input
                type="checkbox"
                checked={checked}
                onChange={() => toggleSelection(index)}
                className="mt-0.5"
              />
              <span>{label}</span>
            </label>
          );
        })}
      </div>

      {error ? (
        <p className="mt-2 text-[11px] text-rose-300 whitespace-pre-wrap">{error}</p>
      ) : null}

      <div className="mt-3 flex gap-2">
        <button
          className="px-3 py-1.5 text-xs rounded bg-emerald-600 disabled:opacity-60"
          onClick={() =>
            void runAction(async () => {
              if (selectedOperations.length === 0) {
                throw new Error("Select at least one operation to approve.");
              }
              await onApprove(selectedOperations);
            })
          }
          disabled={isSubmitting}
        >
          Approve Selected
        </button>
        <button
          className="px-3 py-1.5 text-xs rounded bg-zinc-700 disabled:opacity-60"
          onClick={() => setSelectedIndexes(operations.map((_, index) => index))}
          disabled={isSubmitting}
        >
          Select All
        </button>
        <button
          className="px-3 py-1.5 text-xs rounded bg-rose-700 disabled:opacity-60"
          onClick={() => void runAction(onReject)}
          disabled={isSubmitting}
        >
          Reject
        </button>
      </div>
    </div>
  );
}

function SimulationCriticPreviewCard({
  simulationRunId,
  summary,
  riskLevel,
  issues,
  confidence,
  impactScore,
  onContinue,
  onReject,
}: {
  simulationRunId: string;
  summary: string;
  riskLevel: DryRunRiskLevel;
  issues: Array<{
    code: string;
    severity: DryRunRiskLevel;
    message: string;
    suggestedFix?: string;
  }>;
  confidence: number;
  impactScore: number;
  onContinue: () => Promise<void>;
  onReject: () => Promise<void>;
}) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const runAction = async (action: () => Promise<void>) => {
    setError(null);
    setIsSubmitting(true);
    try {
      await action();
    } catch (executionError) {
      setError(
        executionError instanceof Error
          ? executionError.message
          : "Failed to process simulation critic preview.",
      );
      setIsSubmitting(false);
    }
  };

  return (
    <div className="my-4 rounded-xl border border-orange-500/40 bg-zinc-950 text-zinc-100 p-4">
      <div className="text-xs uppercase text-orange-300 tracking-wide">Simulation Critic Preview</div>
      <h3 className="mt-1 text-sm font-semibold">{summary || "Simulation critic review"}</h3>
      <p className="mt-1 text-xs text-zinc-400">Run {simulationRunId}</p>
      <div className="mt-2 flex gap-2 text-[11px]">
        <span className="rounded bg-zinc-800 px-2 py-1">Risk: {riskLevel}</span>
        <span className="rounded bg-zinc-800 px-2 py-1">
          Confidence: {confidence.toFixed(2)}
        </span>
        <span className="rounded bg-zinc-800 px-2 py-1">Impact: {impactScore.toFixed(2)}</span>
      </div>
      <div className="mt-3 max-h-48 overflow-y-auto rounded border border-zinc-800 p-2 space-y-2">
        {issues.length === 0 ? (
          <p className="text-xs text-zinc-400">No explicit issues reported.</p>
        ) : (
          issues.map((issue, index) => (
            <div key={`critic_issue_${index}`} className="rounded border border-zinc-800 p-2">
              <div className="text-[11px] text-zinc-300">
                {issue.code} [{issue.severity}]
              </div>
              <div className="mt-1 text-xs text-zinc-400">{issue.message}</div>
              {issue.suggestedFix ? (
                <div className="mt-1 text-[11px] text-emerald-300">
                  Suggested fix: {issue.suggestedFix}
                </div>
              ) : null}
            </div>
          ))
        )}
      </div>
      {error ? (
        <p className="mt-2 text-[11px] text-rose-300 whitespace-pre-wrap">{error}</p>
      ) : null}
      <div className="mt-3 flex gap-2">
        <button
          className="px-3 py-1.5 text-xs rounded bg-emerald-600 disabled:opacity-60"
          onClick={() => void runAction(onContinue)}
          disabled={isSubmitting}
        >
          Continue to Batch Approval
        </button>
        <button
          className="px-3 py-1.5 text-xs rounded bg-rose-700 disabled:opacity-60"
          onClick={() => void runAction(onReject)}
          disabled={isSubmitting}
        >
          Reject
        </button>
      </div>
    </div>
  );
}

/**
 * Wrapper around BatchApprovalCard that also upserts the agent-emitted reel
 * into Convex the moment the HITL card mounts. This is what closes the
 * "agent-emitted approve_dailies_batch should also populate the Dailies
 * panel" gap — without this, the panel only shows reels produced by the
 * explicit `generateAutonomousDailies` mutation.
 *
 * The upsert is idempotent on `(storyboardId, reelId)` so re-renders are
 * safe, and failures are logged but non-fatal — the producer can still
 * approve/reject the card even if the panel row isn't persisted.
 */
function AgentDailiesApprovalCard({
  input,
  executionInput,
  upsertAgentDailies,
  onApprove,
  onReject,
}: {
  input: {
    planId: string;
    storyboardId?: string;
    branchId?: string;
    title?: string;
    rationale?: string;
    sourceId?: string;
    operations: unknown[];
    dryRun?: ExecutionPlanInput["dryRun"];
  };
  executionInput: ExecutionPlanInput;
  upsertAgentDailies: (args: Record<string, unknown>) => Promise<unknown>;
  onApprove: (selectedOperations: unknown[]) => Promise<void>;
  onReject: () => Promise<void>;
}) {
  useEffect(() => {
    if (!input.storyboardId || !input.sourceId) {
      return;
    }
    const issues = input.dryRun?.issues;
    const continuityRisksJson = JSON.stringify(Array.isArray(issues) ? issues : []);
    void upsertAgentDailies({
      storyboardId: input.storyboardId,
      branchId: input.branchId ?? "main",
      reelId: input.sourceId,
      title: input.title ?? `Autonomous Dailies ${input.planId}`,
      summary: input.rationale ?? input.dryRun?.summary ?? "Autonomous dailies batch proposal",
      continuityRiskLevel: input.dryRun?.riskLevel ?? "medium",
      continuityRisksJson,
      proposedOperationsJson: JSON.stringify(input.operations),
      executionPlanPayloadJson: JSON.stringify(executionInput),
      diffSummary: input.dryRun?.summary ?? undefined,
    }).catch((error) => {
      // Non-fatal: HITL flow can still proceed; log for diagnostics.
      console.warn("upsertAgentDailies failed", error);
    });
    // Intentionally keyed only on stable identifiers so we don't re-fire on
    // card re-render. reelId is idempotency key on Convex side anyway.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [input.storyboardId, input.sourceId]);

  return (
    <BatchApprovalCard
      title={`Autonomous Dailies - ${input.operations.length} op(s)`}
      subtitle={`Reel ${input.sourceId ?? "pending"}`}
      body={input.dryRun?.summary ?? "Autonomous dailies candidate plan"}
      operations={input.operations}
      onApprove={onApprove}
      onReject={onReject}
    />
  );
}

/**
 * Wrapper around SimulationCriticPreviewCard that upserts the agent-emitted
 * simulation run into Convex on mount, mirroring AgentDailiesApprovalCard.
 */
function AgentSimulationCriticPreviewCard({
  input,
  upsertAgentSimulationRun,
  onContinue,
  onReject,
}: {
  input: {
    simulationRunId: string;
    storyboardId: string;
    branchId: string;
    summary: string;
    riskLevel: DryRunRiskLevel;
    issues: Array<{
      code: string;
      severity: DryRunRiskLevel;
      message: string;
      suggestedFix?: string;
    }>;
    confidence: number;
    impactScore: number;
    executionPlan: {
      planId: string;
      storyboardId: string;
      branchId: string;
      title: string;
      rationale: string;
      source: "simulation_critic";
      sourceId: string;
      taskType: "simulation_critic_batch";
      operations: unknown[];
      dryRun?: ExecutionPlanInput["dryRun"];
    };
  };
  upsertAgentSimulationRun: (args: Record<string, unknown>) => Promise<unknown>;
  onContinue: () => Promise<void>;
  onReject: () => Promise<void>;
}) {
  useEffect(() => {
    if (!input.storyboardId || !input.simulationRunId) {
      return;
    }
    void upsertAgentSimulationRun({
      storyboardId: input.storyboardId,
      branchId: input.branchId ?? "main",
      simulationRunId: input.simulationRunId,
      summary: input.summary,
      riskLevel: input.riskLevel,
      issuesJson: JSON.stringify(input.issues),
      repairOperationsJson: JSON.stringify(input.executionPlan.operations),
      confidence: input.confidence,
      impactScore: input.impactScore,
      executionPlanPayloadJson: JSON.stringify(input.executionPlan),
      diffSummary: input.executionPlan.dryRun?.summary ?? undefined,
    }).catch((error) => {
      console.warn("upsertAgentSimulationRun failed", error);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [input.storyboardId, input.simulationRunId]);

  return (
    <SimulationCriticPreviewCard
      simulationRunId={input.simulationRunId}
      summary={input.summary}
      riskLevel={input.riskLevel}
      issues={input.issues}
      confidence={input.confidence}
      impactScore={input.impactScore}
      onContinue={onContinue}
      onReject={onReject}
    />
  );
}

function PromptApprovalCard({
  nodeId,
  mediaType,
  prompt,
  negativePrompt,
  contextSummary,
  onApprove,
  onReject,
}: {
  nodeId: string;
  mediaType: "image" | "video";
  prompt: string;
  negativePrompt?: string;
  contextSummary: string;
  onApprove: (payload: { prompt: string; negativePrompt?: string }) => Promise<void>;
  onReject: () => Promise<void>;
}) {
  const [editedPrompt, setEditedPrompt] = useState(prompt);
  const [editedNegativePrompt, setEditedNegativePrompt] = useState(negativePrompt ?? "");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const runAction = async (action: () => Promise<void>) => {
    setError(null);
    setIsSubmitting(true);
    try {
      await action();
    } catch (executionError) {
      setError(
        executionError instanceof Error
          ? executionError.message
          : "Failed to execute media approval.",
      );
      setIsSubmitting(false);
    }
  };

  return (
    <div className="my-4 rounded-xl border border-cyan-500/40 bg-zinc-950 text-zinc-100 p-4">
      <div className="text-xs uppercase text-cyan-300 tracking-wide">Media Prompt Approval</div>
      <h3 className="mt-1 text-sm font-semibold">
        {mediaType.toUpperCase()} for Node {nodeId}
      </h3>
      <p className="mt-2 text-[11px] text-zinc-400 whitespace-pre-wrap">{contextSummary}</p>
      <textarea
        value={editedPrompt}
        onChange={(event) => setEditedPrompt(event.target.value)}
        className="mt-3 w-full rounded bg-zinc-900 border border-zinc-700 p-2 text-xs h-24"
      />
      <textarea
        value={editedNegativePrompt}
        onChange={(event) => setEditedNegativePrompt(event.target.value)}
        className="mt-2 w-full rounded bg-zinc-900 border border-zinc-700 p-2 text-xs h-16"
        placeholder="Negative prompt"
      />
      {error ? (
        <p className="mt-2 text-[11px] text-rose-300 whitespace-pre-wrap">{error}</p>
      ) : null}
      <div className="mt-3 flex gap-2">
        <button
          className="px-3 py-1.5 text-xs rounded bg-emerald-600 disabled:opacity-60"
          onClick={() =>
            void runAction(() =>
              onApprove({
                prompt: editedPrompt,
                negativePrompt: editedNegativePrompt || undefined,
              }),
            )
          }
          disabled={isSubmitting}
        >
          Approve Prompt
        </button>
        <button
          className="px-3 py-1.5 text-xs rounded bg-rose-700 disabled:opacity-60"
          onClick={() => void runAction(onReject)}
          disabled={isSubmitting}
        >
          Reject
        </button>
      </div>
    </div>
  );
}


