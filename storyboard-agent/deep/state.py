"""
Typed state and artifact contracts for the V2 storyboard deep-agent runtime.
"""

from __future__ import annotations

from typing import Any, Dict, List, Literal, Optional, TypedDict


PlanOperationType = Literal[
    "create_node",
    "update_node",
    "delete_node",
    "create_edge",
    "update_edge",
    "delete_edge",
    "generate_image",
    "generate_video",
]

RiskLevel = Literal["low", "medium", "high", "critical"]


class PlanOperation(TypedDict, total=False):
    opId: str
    op: PlanOperationType
    title: str
    rationale: str
    nodeId: str
    edgeId: str
    payload: Dict[str, Any]
    requiresHitl: bool
    estimatedCost: float


class DryRunIssue(TypedDict, total=False):
    code: str
    severity: RiskLevel
    message: str
    nodeIds: List[str]
    edgeIds: List[str]
    suggestedFix: str


class DryRunReport(TypedDict, total=False):
    valid: bool
    riskLevel: RiskLevel
    summary: str
    issues: List[DryRunIssue]
    estimatedTotalCost: float
    estimatedDurationSec: float


class SemanticDiff(TypedDict, total=False):
    fromCommitId: str
    toCommitId: str
    intentChanges: List[str]
    continuityChanges: List[str]
    visualChanges: List[str]
    pacingChanges: List[str]
    riskNotes: List[str]


class ExecutionPlan(TypedDict, total=False):
    planId: str
    storyboardId: str
    branchId: str
    title: str
    rationale: str
    operations: List[PlanOperation]
    dryRun: DryRunReport
    semanticDiff: SemanticDiff
    approvalToken: str


class AutonomousDailiesClip(TypedDict, total=False):
    nodeId: str
    mediaAssetId: str
    kind: Literal["image", "video"]
    sourceUrl: str


class AutonomousDailiesReel(TypedDict, total=False):
    reelId: str
    title: str
    summary: str
    branchId: str
    highlights: List[str]
    continuityRiskLevel: RiskLevel
    continuityRisks: List[DryRunIssue]
    clips: List[AutonomousDailiesClip]
    executionPlan: ExecutionPlan


class SimulationCriticRun(TypedDict, total=False):
    simulationRunId: str
    summary: str
    riskLevel: RiskLevel
    issues: List[DryRunIssue]
    repairOperations: List[PlanOperation]
    confidence: float
    impactScore: float
    executionPlan: ExecutionPlan


class DelegationRecord(TypedDict, total=False):
    delegationId: str
    agentName: str
    task: str
    status: Literal["queued", "running", "complete", "failed"]
    inputJson: str
    outputJson: str
    latencyMs: int


class TeamMemberConfig(TypedDict, total=False):
    memberId: str
    agentName: str
    role: str
    persona: str
    nicheDescription: str
    toolScope: List[str]
    resourceScope: List[str]
    weight: float
    enabled: bool


class RuntimePolicyConfig(TypedDict, total=False):
    requiresHitl: bool
    riskThresholds: Dict[str, str]
    maxBatchSize: int
    quotaProfileId: str
    maxRunOps: int
    maxConcurrentRuns: int
    quotaEnforced: bool


class TeamRuntimeConfig(TypedDict, total=False):
    teamId: str
    teamName: str
    revisionId: str
    version: int
    teamGoal: str
    members: List[TeamMemberConfig]
    toolAllowlist: List[str]
    resourceScopes: List[str]
    runtimePolicy: RuntimePolicyConfig


NarrativeStructure = Literal[
    "save_the_cat",
    "harmon_circle",
    "three_act",
    "kishotenketsu",
    "hook_first",
]

BeatStatus = Literal["planned", "assigned", "missing"]

LandedStatus = Literal["unplanted", "planted", "landed"]


class BeatAssignment(TypedDict, total=False):
    """Single slot in a beat plan. `beatKey` is the canonical key for
    the chosen structure (e.g. "opening_image" for Save-the-Cat,
    "you" for Harmon Circle, "hook" for hook-first). `nodeId` is
    present when a storyboard node has been mapped to this slot;
    absent when the slot is still planned but unassigned."""

    beatKey: str
    expectedActNumber: int
    nodeId: str
    status: BeatStatus
    rationale: str


class MotifEntry(TypedDict, total=False):
    """One recurring element across the reel. `sourceNodeIds` are the
    plants; `payoffNodeIds` the callbacks. `landedStatus` summarizes
    whether every plant has a callback landed."""

    motifKey: str
    description: str
    sourceNodeIds: List[str]
    payoffNodeIds: List[str]
    visualVocabulary: str
    landedStatus: LandedStatus


class TensionSample(TypedDict, total=False):
    nodeId: str
    value: float


class CharacterArc(TypedDict, total=False):
    characterId: str
    want: str
    need: str
    arcStatus: str


class ReelNarrativeState(TypedDict, total=False):
    """M9 reel-scoped narrative memory. Mirrors the Convex
    `reelNarrativeState` row for the (storyboard, branch) pair.
    Hydrated at the start of each agent turn; mirrored back on exit.

    All fields optional because first-run state (before the producer
    clicks "Analyze narrative") is empty."""

    structure: NarrativeStructure
    beats: List[BeatAssignment]
    motifs: Dict[str, MotifEntry]
    tension_samples: List[TensionSample]
    character_arcs: List[CharacterArc]
    computed_from_commit_id: str
    stale: bool


class StoryboardDeepAgentState(TypedDict, total=False):
    messages: List[Dict[str, Any]]
    storyboard_id: str
    branch_id: str
    commit_head: str
    mode: Literal["graph_studio", "agent_draft"]
    graph_snapshot: Dict[str, Any]
    entities: Dict[str, Any]
    rolling_context_map: Dict[str, Any]
    pending_approvals: List[Dict[str, Any]]
    provider_policy: Dict[str, Any]
    team_config: TeamRuntimeConfig
    runtime_policy: RuntimePolicyConfig
    effective_tool_scope: List[str]
    effective_resource_scope: List[str]
    policy_trace: List[Dict[str, Any]]

    supervisor_state: Dict[str, Any]
    todos: List[Dict[str, Any]]
    delegation_log: List[DelegationRecord]
    subagent_artifacts: Dict[str, Any]
    execution_plan: ExecutionPlan
    dry_run_report: DryRunReport
    autonomous_dailies: AutonomousDailiesReel
    simulation_critic_run: SimulationCriticRun
    approval_queue: List[Dict[str, Any]]
    apply_results: List[Dict[str, Any]]
    rollback_handles: List[Dict[str, Any]]
    warnings: List[str]
    diagnostics: Dict[str, Any]

    shadow_compare: Optional[Dict[str, Any]]

    # M9 — reel-scoped narrative memory. See `ReelNarrativeState`
    # above. Hydrated by `narrative_state.load_reel_narrative_state`
    # at turn start; mirrored to Convex by
    # `narrative_state.persist_reel_narrative_state` at turn exit.
    reel_narrative_state: ReelNarrativeState
