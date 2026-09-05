import { Node, Edge } from 'reactflow';
import type { CutTier } from "@/lib/cut-tier";

export type NodeType = "scene" | "shot" | "branch" | "merge" | "character_ref" | "background_ref";

export type ShotSize = "ECU" | "CU" | "MCU" | "MS" | "MLS" | "WS" | "EWS";
export type ShotAngle = "eye_level" | "high" | "low" | "dutch" | "birds_eye" | "worms_eye";
export type CameraMove =
  | "static" | "push_in" | "pull_out" | "dolly" | "track" | "tilt"
  | "pan" | "whip_pan" | "handheld" | "steadicam" | "crane" | "drone";
export type AspectRatio = "2.39:1" | "1.85:1" | "16:9" | "9:16" | "4:5" | "1:1" | "2:1";
export type ScreenDirection = "left_to_right" | "right_to_left" | "neutral";

export interface ShotMeta {
  number?: string;
  size?: ShotSize;
  angle?: ShotAngle;
  lensMm?: number;
  tStop?: string;
  move?: CameraMove;
  aspect?: AspectRatio;
  durationS?: number;
  screenDirection?: ScreenDirection;
  axisLineId?: string;
  blockingNotes?: string;
  props?: string[];
  sfx?: string[];
  vfx?: string[];
}

export const SHOT_SIZE_OPTIONS: Array<{ value: ShotSize; label: string; description: string }> = [
  { value: "ECU", label: "ECU", description: "Extreme close-up" },
  { value: "CU", label: "CU", description: "Close-up" },
  { value: "MCU", label: "MCU", description: "Medium close-up" },
  { value: "MS", label: "MS", description: "Medium shot" },
  { value: "MLS", label: "MLS", description: "Medium long shot" },
  { value: "WS", label: "WS", description: "Wide shot" },
  { value: "EWS", label: "EWS", description: "Extreme wide shot" },
];

export const SHOT_ANGLE_OPTIONS: Array<{ value: ShotAngle; label: string }> = [
  { value: "eye_level", label: "Eye level" },
  { value: "high", label: "High angle" },
  { value: "low", label: "Low angle" },
  { value: "dutch", label: "Dutch / canted" },
  { value: "birds_eye", label: "Bird's eye" },
  { value: "worms_eye", label: "Worm's eye" },
];

export const CAMERA_MOVE_OPTIONS: Array<{ value: CameraMove; label: string }> = [
  { value: "static", label: "Static / locked off" },
  { value: "push_in", label: "Push-in" },
  { value: "pull_out", label: "Pull-out" },
  { value: "dolly", label: "Dolly" },
  { value: "track", label: "Track" },
  { value: "tilt", label: "Tilt" },
  { value: "pan", label: "Pan" },
  { value: "whip_pan", label: "Whip pan" },
  { value: "handheld", label: "Handheld" },
  { value: "steadicam", label: "Steadicam" },
  { value: "crane", label: "Crane / jib" },
  { value: "drone", label: "Drone" },
];

export const ASPECT_RATIO_OPTIONS: Array<{ value: AspectRatio; label: string; context: string }> = [
  { value: "2.39:1", label: "2.39:1", context: "Anamorphic scope" },
  { value: "1.85:1", label: "1.85:1", context: "Flat feature" },
  { value: "16:9", label: "16:9", context: "TV / streaming" },
  { value: "9:16", label: "9:16", context: "Vertical / Reels" },
  { value: "4:5", label: "4:5", context: "IG feed" },
  { value: "1:1", label: "1:1", context: "Square" },
  { value: "2:1", label: "2:1", context: "Univisium" },
];

export const LENS_MM_PRESETS: number[] = [14, 18, 24, 28, 35, 40, 50, 65, 85, 100, 135];

export interface MediaVariant {
  id: string;
  // M7 — widen the kind union so audio (narration TTS) and sfx
  // (ambient / foley) variants flow through the same array shape as
  // images + videos. Keeps `mapNodeMedia` simple and lets downstream
  // code use one MediaVariant type across kinds.
  kind: "image" | "video" | "audio" | "sfx";
  url: string;
  modelId: string;
  prompt: string;
  negativePrompt?: string;
  status: "pending" | "completed" | "failed";
  createdAt: number;
  consistencyScore?: number;
  identityScore?: number;
  wardrobeCompliance?: "matching" | "deviation" | "unknown";
}

export interface CharacterIdentityProfile {
  facialMarkers: string[];
  ageBand: string;
  bodySilhouette: string;
  skinHairSignature: string;
  voiceTags: string[];
}

export interface WardrobeVariant {
  variantId: string;
  name: string;
  description: string;
  palette: string[];
  props: string[];
  hairMakeupDelta: string;
}

export interface StoryNodeData {
  label: string;
  segment: string;
  nodeType: NodeType;
  entityRefs: {
    characterIds: string[];
    backgroundId?: string;
    sceneId?: string;
    shotId?: string;
  };
  continuity: {
    identityLockVersion: number;
    wardrobeVariantIds: string[];
    consistencyStatus: "ok" | "warning" | "blocked";
  };
  historyContext: {
    eventIds: string[];
    rollingSummary: string;
    tokenBudgetUsed: number;
    lineageHash: string;
  };
  promptPack: {
    imagePrompt?: string;
    videoPrompt?: string;
    negativePrompt?: string;
    /** M5 #5 — per-shot TTS narration override. Empty / undefined falls
     *  back to the auto-extracted narration from `segment`. */
    audioDesc?: string;
    continuityDirectives: string[];
  };
  shotMeta?: ShotMeta;
  media: {
    images: MediaVariant[];
    videos: MediaVariant[];
    // M7 — audio (narration TTS) and sfx (ambient/foley) variants. Both
    // optional because most legacy storyboards don't have them; the
    // ReelPlayer + PropertiesPanel render the SFX surface only when
    // `sfxs` is non-empty or the producer wants to generate one.
    audios?: MediaVariant[];
    sfxs?: MediaVariant[];
    activeImageId?: string;
    activeVideoId?: string;
    activeAudioId?: string;
    activeSfxId?: string;
  };

  // Legacy fields kept for UI compatibility while migrating to media[] variants.
  image?: string;
  imageHistory?: string[];
  inputImage?: string;
  audio?: string;
  video?: string;
  isProcessing?: boolean;
  // M9 — narrative refinement fields. All optional; populated by the
  // NarrativeBar's Analyze pass or by the beat_analyst subagent via
  // request_beat_assignment. Free-form strings because the beat
  // vocabulary varies by structure and is validated at the route
  // boundary rather than in TS.
  beatType?: string;
  actNumber?: number;
  tensionLevel?: number;
  motifIds?: string[];
  hookType?: string;
  processingTask?: string; // 'text' | 'image' | 'audio' | 'video'
}

export interface StoryEdgeData {
  edgeType: "serial" | "parallel" | "branch" | "merge";
  branchId?: string;
  order?: number;
  isPrimary?: boolean;
}

export type PlanOperationType =
  | "create_node"
  | "update_node"
  | "delete_node"
  | "create_edge"
  | "update_edge"
  | "delete_edge"
  | "generate_image"
  | "generate_video";

export interface PlanOperation {
  opId: string;
  op: PlanOperationType;
  title: string;
  rationale: string;
  nodeId?: string;
  edgeId?: string;
  payload?: Record<string, unknown>;
  requiresHitl: boolean;
  estimatedCost?: number;
}

export interface DryRunIssue {
  code: string;
  severity: "low" | "medium" | "high" | "critical";
  message: string;
  nodeIds?: string[];
  edgeIds?: string[];
  suggestedFix?: string;
}

export interface DryRunReport {
  valid: boolean;
  riskLevel: "low" | "medium" | "high" | "critical";
  summary: string;
  issues: DryRunIssue[];
  estimatedTotalCost: number;
  estimatedDurationSec: number;
  planHash: string;
}

export interface SemanticDiff {
  fromCommitId: string;
  toCommitId: string;
  intentChanges: string[];
  continuityChanges: string[];
  visualChanges: string[];
  pacingChanges: string[];
  riskNotes: string[];
}

export interface ExecutionPlan {
  planId: string;
  storyboardId: string;
  branchId: string;
  title: string;
  rationale: string;
  operations: PlanOperation[];
  dryRun: DryRunReport;
  semanticDiff: SemanticDiff;
  approvalToken?: string;
  source?: "agent" | "dailies" | "simulation_critic" | "repair";
  sourceId?: string;
}

export interface RollbackHandle {
  branchId: string;
  commitId: string;
  reason: string;
}

export interface AutonomousDailiesClip {
  nodeId: string;
  mediaAssetId: string;
  kind: "image" | "video";
  sourceUrl: string;
}

export interface AutonomousDailiesReel {
  reelId: string;
  title: string;
  summary: string;
  branchId: string;
  highlights: string[];
  continuityRiskLevel: "low" | "medium" | "high" | "critical";
  continuityRisks: DryRunIssue[];
  clips: AutonomousDailiesClip[];
  executionPlan: ExecutionPlan;
}

export interface SimulationCriticRun {
  simulationRunId: string;
  summary: string;
  riskLevel: "low" | "medium" | "high" | "critical";
  issues: DryRunIssue[];
  repairOperations: PlanOperation[];
  confidence: number;
  impactScore: number;
  executionPlan: ExecutionPlan;
}

export type TeamVisibility = "private" | "workspace" | "public_read";
export type TeamStatus = "active" | "archived";
export type RiskLevel = "low" | "medium" | "high" | "critical";
export type StoryboardStatus = "active" | "trashed";
export type StoryboardSort = "updated_desc" | "updated_asc" | "title_asc" | "created_desc";

// ---------------------------------------------------------------------------
// Screenplay ingestion (ViMax M1) — progress shape surfaced through CopilotKit
// state sync so the React form can render a stage-specific progress bar while
// the Python screenplay_ingester subagent works through the pipeline.
// ---------------------------------------------------------------------------
export type ScriptIngestStage =
  | "idle"
  | "preprocessing"          // screenplay → prose pre-pass
  | "extracting_characters"  // LLM character extraction
  | "generating_portraits"   // front-view portraits per character
  | "designing_storyboard"   // LLM shot list
  | "decomposing_shots"      // per-shot ff/lf/motion decomposition
  | "writing_to_convex"      // bulk node/edge/identity writes
  | "complete"
  | "failed";

export interface ScriptIngestProgress {
  stage: ScriptIngestStage;
  /** 0-100, best-effort. */
  percentComplete: number;
  /** Short human-readable sentence — e.g. "Generated 3 / 5 portraits." */
  statusMessage: string;
  /** Populated once the ingestion creates / resumes a storyboard. */
  storyboardId?: string;
  /** Running counts — surfaced in the UI as the pipeline progresses. */
  characterCount?: number;
  shotCount?: number;
  /** Present only when stage === "failed". */
  error?: string;
}

export interface StoryboardLibraryItem {
  _id: string;
  title: string;
  description?: string;
  status?: StoryboardStatus;
  isPinned?: boolean;
  templateId?: string;
  coverImageUrl?: string;
  nodeCount?: number;
  edgeCount?: number;
  imageCount?: number;
  videoCount?: number;
  updatedAt: number;
  createdAt: number;
  lastOpenedAt?: number;
  trashedAt?: number;
  purgeAt?: number;
}

export interface StoryboardTemplate {
  templateId: string;
  name: string;
  description: string;
  visualTheme: string;
  mode: "graph_studio" | "agent_draft";
}

export type StoryboardLifecycleAction =
  | "open"
  | "rename"
  | "duplicate"
  | "pin"
  | "unpin"
  | "trash"
  | "restore"
  | "delete_permanent";

export interface TeamMemberConfig {
  memberId: string;
  agentName: string;
  role: string;
  persona: string;
  nicheDescription: string;
  toolScope: string[];
  resourceScope: string[];
  weight: number;
  enabled: boolean;
}

export interface TeamPolicy {
  requiresHitl: boolean;
  riskThresholds: {
    warnAt: RiskLevel;
    blockAt: RiskLevel;
  };
  maxBatchSize: number;
  quotaProfileId: string;
  maxRunOps: number;
  maxConcurrentRuns: number;
  quotaEnforced: boolean;
}

export interface TeamDefinition {
  _id: string;
  teamId: string;
  name: string;
  description: string;
  ownerUserId: string;
  visibility: TeamVisibility;
  status: TeamStatus;
  isPrebuilt: boolean;
  currentPublishedRevisionId?: string;
  createdAt: number;
  updatedAt: number;
  revisionCount?: number;
  publishedRevisionId?: string;
  publishedVersion?: number;
}

export interface TeamRevision {
  revisionId: string;
  version: number;
  teamGoal: string;
  published: boolean;
  createdAt: number;
  policy: TeamPolicy;
  members: TeamMemberConfig[];
  toolAllowlist: string[];
  resourceScopes: string[];
}

export interface TeamAssignment {
  storyboardId: string;
  activeTeamId: string;
  activeRevisionId: string;
  fallbackTeamId?: string;
  updatedAt: number;
}

export interface RuntimeResolvedTeam {
  teamId: string;
  teamName: string;
  revisionId: string;
  version: number;
  teamGoal: string;
  members: TeamMemberConfig[];
  toolAllowlist: string[];
  resourceScopes: string[];
  runtimePolicy: TeamPolicy & {
    dailyMediaBudget: number;
    dailyMutationOps: number;
  };
}

export interface TeamPromptDraft {
  draftId: string;
  generatedSpec: {
    teamGoal: string;
    policy: TeamPolicy;
    members: TeamMemberConfig[];
    toolAllowlist: string[];
    resourceScopes: string[];
  };
}

export interface QuotaUsageSummary {
  quotaProfile: {
    quotaProfileId: string;
    name: string;
    dailyMediaBudget: number;
    dailyMutationOps: number;
    maxRunOps: number;
    maxConcurrentRuns: number;
  };
  usage: {
    dayKey: string;
    mediaBudgetUsed: number;
    mutationOpsUsed: number;
    activeRuns: number;
  };
  remaining: {
    mediaBudget: number;
    mutationOps: number;
    concurrentRuns: number;
  };
}

export interface ApprovalTaskRecord {
  _id: string;
  taskType: string;
  status: string;
  title: string;
  rationale: string;
  diffSummary?: string;
  payloadJson: string;
  executionResultJson?: string;
  createdAt: number;
  updatedAt: number;
}

export interface AgentDelegationRecord {
  _id: string;
  runId: string;
  delegationId: string;
  agentName: string;
  task: string;
  status: "queued" | "running" | "complete" | "failed";
  inputJson: string;
  outputJson?: string;
  latencyMs?: number;
  createdAt: number;
  updatedAt: number;
}

export interface ToolCallAuditRecord {
  _id: string;
  runId?: string;
  teamId?: string;
  revisionId?: string;
  member: string;
  tool: string;
  scope: string[];
  result: "success" | "failure" | "blocked";
  detailsJson?: string;
  createdAt: number;
}

export interface AutonomousDailiesRecord {
  _id: string;
  reelId: string;
  branchId: string;
  title: string;
  summary: string;
  highlights: string[];
  continuityRiskLevel: "low" | "medium" | "high" | "critical";
  continuityRisksJson: string;
  proposedOperationsJson: string;
  status: "drafted" | "approved" | "rejected" | "applied";
  approvalTaskId?: string;
  createdAt: number;
  updatedAt: number;
}

export interface SimulationCriticRunRecord {
  _id: string;
  simulationRunId: string;
  branchId: string;
  sourcePlanId?: string;
  status: "complete" | "failed" | "waiting_for_human" | "applied" | "rejected";
  summary: string;
  riskLevel: "low" | "medium" | "high" | "critical";
  issuesJson: string;
  repairOperationsJson: string;
  confidence: number;
  impactScore: number;
  approvalTaskId?: string;
  createdAt: number;
  updatedAt: number;
}

export interface ConstraintBundle {
  identityPacks: Array<Record<string, unknown>>;
  globalConstraints: Array<Record<string, unknown>>;
  continuityViolations: Array<Record<string, unknown>>;
}

export interface NarrativeBranchRecord {
  _id: string;
  branchId: string;
  name: string;
  parentBranchId?: string;
  parentCommitId?: string;
  headCommitId?: string;
  isDefault: boolean;
  status: "active" | "archived";
  cutTier?: CutTier;
  createdAt: number;
  updatedAt: number;
}

export interface NarrativeCommitRecord {
  _id: string;
  commitId: string;
  branchId: string;
  summary: string;
  rationale?: string;
  operationCount: number;
  operationsJson?: string;
  parentCommitId?: string;
  reviewRound?: number;
  createdAt: number;
}

// M9 Phase 4 — motif registry. Populated by motif_tracker via
// request_motif_plant. `landedStatus` is derived server-side from
// sources/payoffs presence; the MotifMapPanel renders setup → payoff
// chains using this view.
export interface NarrativeMotifRecord {
  _id: string;
  motifKey: string;
  description: string;
  sourceNodeIds: string[];
  payoffNodeIds: string[];
  visualVocabulary?: string;
  landedStatus: "unplanted" | "planted" | "landed";
  createdAt: number;
  updatedAt: number;
}

// M9 Phase 3 — narrative variant catalog. Each row links a
// narrative-git branch (via branchId) to its generator + rationale so
// Variant Compare can enumerate candidates without re-scanning commits.
export interface NarrativeVariantRecord {
  _id: string;
  branchId: string;
  variantType: "hook" | "structural" | "transition" | "remix";
  rationale: string;
  generatedByRunId?: string;
  producerPicked: boolean;
  parentBranchId?: string;
  createdAt: number;
  updatedAt: number;
}

export type { CutTier } from "@/lib/cut-tier";
export { CUT_TIER_LABELS, CUT_TIER_ORDER } from "@/lib/cut-tier";

export const CUT_TIER_OPTIONS: Array<{
  value: CutTier;
  label: string;
  order: number;
  tone: "muted" | "info" | "violet" | "amber" | "emerald" | "sky" | "success";
}> = [
  { value: "assembly", label: "Assembly", order: 0, tone: "muted" },
  { value: "editors", label: "Editor's Cut", order: 1, tone: "info" },
  { value: "directors", label: "Director's Cut", order: 2, tone: "violet" },
  { value: "producers", label: "Producer's Cut", order: 3, tone: "amber" },
  { value: "pictureLock", label: "Picture Lock", order: 4, tone: "emerald" },
  { value: "online", label: "Online / Color", order: 5, tone: "sky" },
  { value: "delivered", label: "Delivered", order: 6, tone: "success" },
];

export type StoryNode = Node<StoryNodeData>;
export type StoryEdge = Edge<StoryEdgeData>;

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
}

export enum MediaType {
  TEXT = 'TEXT',
  IMAGE = 'IMAGE',
  AUDIO = 'AUDIO',
  VIDEO = 'VIDEO'
}

export interface GraphResponse {
  nodes: {
    id: string;
    data: {
      label: string;
      segment: string;
      nodeType?: NodeType;
    };
    position: { x: number; y: number };
  }[];
  edges: {
    id: string;
    source: string;
    target: string;
  }[];
}

export type VoiceName = 'Puck' | 'Charon' | 'Kore' | 'Fenrir' | 'Zephyr';

export interface AudioConfig {
  voice: VoiceName;
  tone?: string;
}

export interface ImageConfig {
  style?: string;
  aspectRatio?: string;
}

export interface VideoConfig {
  aspectRatio: '16:9' | '9:16';
  style?: string;
}

export type DeliveryPlatform =
  | "meta" | "tiktok" | "youtube" | "ctv" | "dv360" | "x" | "linkedin" | "other";

export type DeliveryStatus =
  | "planned" | "in_review" | "approved" | "delivered" | "archived";

export interface DeliveryVariantSpec {
  aspect?: AspectRatio;
  durationS?: number;
  locale?: string;
  abLabel?: string;
  platform?: DeliveryPlatform;
  endCard?: string;
  notes?: string;
}

export interface DeliveryVariant {
  id: string;
  masterAssetId: string;
  kind: "image" | "video";
  sourceUrl: string;
  generationStatus: "pending" | "completed" | "failed" | "rolled_back";
  deliveryStatus: DeliveryStatus;
  variantSpec: DeliveryVariantSpec;
  createdAt: number;
  updatedAt: number;
  modelId?: string;
}

export const DELIVERY_PLATFORM_OPTIONS: Array<{ value: DeliveryPlatform; label: string }> = [
  { value: "meta", label: "Meta (FB/IG)" },
  { value: "tiktok", label: "TikTok" },
  { value: "youtube", label: "YouTube" },
  { value: "ctv", label: "CTV" },
  { value: "dv360", label: "DV360" },
  { value: "x", label: "X / Twitter" },
  { value: "linkedin", label: "LinkedIn" },
  { value: "other", label: "Other" },
];

export const DELIVERY_STATUS_OPTIONS: Array<{ value: DeliveryStatus; label: string; tone: "neutral" | "info" | "success" | "muted" | "warn" }> = [
  { value: "planned",   label: "Planned",    tone: "neutral" },
  { value: "in_review", label: "In review",  tone: "info" },
  { value: "approved",  label: "Approved",   tone: "success" },
  { value: "delivered", label: "Delivered",  tone: "success" },
  { value: "archived",  label: "Archived",   tone: "muted" },
];

/**
 * Canonical session identity passed to review-surface components so author
 * fields on newly-created comments can be denormalized. The same shape is
 * re-exported from `StoryboardCopilotBridge` for the agent surface; keeping
 * the definition here lets non-agent callers import it without pulling the
 * bridge component into their module graph.
 */
export interface UserIdentity {
  userId: string;
  email: string | null;
  name: string | null;
}

export type TakeStatus = "print" | "hold" | "ng" | "noted";

export interface MediaComment {
  _id: string;
  storyboardId: string;
  mediaAssetId: string;
  userId: string;
  authorName?: string;
  authorEmail?: string;
  parentCommentId?: string;
  timecodeMs?: number;
  body: string;
  status: "open" | "resolved" | "deleted";
  resolvedAt?: number;
  resolvedByUserId?: string;
  createdAt: number;
  updatedAt: number;
}

export const TAKE_STATUS_OPTIONS: Array<{ value: TakeStatus; label: string; tone: "success" | "info" | "warn" | "muted" }> = [
  { value: "print", label: "Print",  tone: "success" },
  { value: "hold",  label: "Hold",   tone: "info" },
  { value: "ng",    label: "NG",     tone: "warn" },
  { value: "noted", label: "Noted",  tone: "muted" },
];

export const COMMON_DELIVERY_DURATIONS_S: number[] = [6, 10, 15, 30, 60, 90];
export const COMMON_DELIVERY_LOCALES: Array<{ value: string; label: string }> = [
  { value: "en-US", label: "English (US)" },
  { value: "en-GB", label: "English (UK)" },
  { value: "es-MX", label: "Spanish (MX)" },
  { value: "es-ES", label: "Spanish (ES)" },
  { value: "fr-FR", label: "French (FR)" },
  { value: "de-DE", label: "German (DE)" },
  { value: "pt-BR", label: "Portuguese (BR)" },
  { value: "ja-JP", label: "Japanese (JP)" },
  { value: "zh-CN", label: "Chinese (CN)" },
  { value: "hi-IN", label: "Hindi (IN)" },
];

// -----------------------------------------------------------------------
// Identity reference portraits (Enhancement #7)
// Re-export the pure-lib types so the app has a single source of truth; the
// `IdentityReferenceRecord` interface below matches the row shape returned
// by `identityReferences:listIdentityPortraitsForPack` and is what the
// ContinuityOS panel consumes.
// -----------------------------------------------------------------------

export type { PortraitView, PortraitRole, IdentityPortrait } from "@/lib/identity-portraits";
export {
  PORTRAIT_VIEW_OPTIONS,
  PORTRAIT_ROLE_OPTIONS,
  CANONICAL_PORTRAIT_VIEWS,
} from "@/lib/identity-portraits";

import type { PortraitRole, PortraitView } from "@/lib/identity-portraits";

export interface IdentityReferenceRecord {
  _id: string;
  ownerPackId: string;
  role: PortraitRole;
  portraitView?: PortraitView;
  sourceUrl: string;
  modelId?: string;
  prompt?: string;
  notes?: string;
  status: "active" | "archived";
  createdAt: number;
  updatedAt: number;
}

export interface StoryboardMediaConfig {
  voice?: VoiceName;
  style?: string;
  aspectRatio?: string;
  inputImage?: string;
  negativePrompt?: string;
  startImage?: string;
  endImage?: string;
  audioEnabled?: boolean;
  slowMotion?: boolean;
  duration?: number;
  // Per-node model overrides. Frontend providers will fall back to defaults
  // (e.g. zennah-image-gen / ltx-2.3) when these are unset.
  imageModelId?: string;
  videoModelId?: string;
  // LTX-2.3 specific video overrides.
  enhancePrompt?: boolean;
  cameraMovement?: string;
  numInferenceSteps?: number;
  cfgGuidanceScale?: number;
  seed?: number;
}
