"""
Deterministic tools used by the V2 deep-agent supervisor and subagents.
"""

from __future__ import annotations

import hashlib
import json
import time
from typing import Any, Dict, List, Literal, Optional

from langchain_core.tools import tool
from pydantic import BaseModel, Field


# ---------------------------------------------------------------------------
# Shared tool-arg schemas — Pydantic models for `List[...]` parameters.
#
# IMPORTANT: do NOT replace these with `List[Dict[str, Any]]`. Permissive
# schemas tell the LLM "any object goes here" and gpt-4.1-mini responds
# by either omitting the array or hoisting inner fields to the top of
# the tool call. M9.5 L5 live-LLM smoke caught both regressions; the
# Pydantic models below force the LLM to emit structured items.
#
# All fields are optional EXCEPT the discriminator-style required ones
# (intent, variantId, motif key fields). Bridge sanitizers still drop
# malformed entries — the schema is the first line of defense, the
# bridge is the second.
# ---------------------------------------------------------------------------


class PlanOpInput(BaseModel):
    """Schema for a single graph operation inside a tool call's planOps
    array. Mirrors the bridge's `parsePlanOpList` validator.

    Design note: the schema declares the FIELD NAMES so the LLM knows
    what to emit, but stops short of using `Literal` / range constraints.
    The function body's `_sanitize_plan_ops` is the source of truth for
    drops + clamping; making the schema strict would reject malformed
    inputs at validation time, which breaks unit tests that pass edge-
    case dicts through `.invoke()` to verify sanitizer behaviour.
    """

    op: str = Field(
        ...,
        description=(
            "Op type: create_node / update_node / delete_node / "
            "create_edge / update_edge / delete_edge."
        ),
    )
    title: str = Field(..., description="Human-readable title; required.")
    opId: Optional[str] = None
    rationale: Optional[str] = None
    nodeId: Optional[str] = None
    edgeId: Optional[str] = None
    nodeType: Optional[str] = None
    label: Optional[str] = None
    segment: Optional[str] = None
    sourceNodeId: Optional[str] = None
    targetNodeId: Optional[str] = None
    edgeType: Optional[str] = None
    branchId: Optional[str] = None
    order: Optional[int] = None
    isPrimary: Optional[bool] = None

    # Pydantic v2: tolerate dict overflow so the LLM can include extra
    # keys (e.g. `payload`) without rejection. The bridge sanitizer
    # ignores unknown keys downstream.
    model_config = {"extra": "allow"}


class HookVariantInput(BaseModel):
    """Schema for a single hook variant. The `request_hook_variants`
    tool's `variants` parameter is `List[HookVariantInput]`."""

    variantId: Optional[str] = Field(
        None,
        description="Slug-cased id (e.g. 'question', 'stakes', 'rhyme'). REQUIRED.",
    )
    rationale: Optional[str] = Field(
        None, description="Why this archetype fits this reel."
    )
    expectedRetention: Optional[str] = Field(
        None,
        description="Qualitative retention estimate ('high' / 'medium' / 'experimental').",
    )
    branchName: Optional[str] = None
    planOps: List[PlanOpInput] = Field(
        default_factory=list,
        description="Graph patch operations that materialize this variant. REQUIRED — at least one op.",
    )

    model_config = {"extra": "allow"}


class StructuralRemixVariantInput(BaseModel):
    """Schema for a single structural remix variant. The
    `request_structural_remix` tool's `variants` parameter is
    `List[StructuralRemixVariantInput]`."""

    variantId: Optional[str] = Field(None, description="Slug-cased id. REQUIRED.")
    rationale: Optional[str] = None
    strategy: Optional[str] = Field(
        None,
        description=(
            "Strategy hint: in_medias_res / chrono_reorder / "
            "parallel_intercut / harmon_reframe."
        ),
    )
    branchName: Optional[str] = None
    planOps: List[PlanOpInput] = Field(default_factory=list)

    model_config = {"extra": "allow"}


class TransitionProposalInput(BaseModel):
    """Schema for a single transition proposal. The
    `request_transition_proposal` tool's `proposals` parameter is
    `List[TransitionProposalInput]`."""

    intent: Optional[str] = Field(
        None,
        description=(
            "Cut idiom: match_cut / j_cut / l_cut / cross_cut_accelerate / "
            "hard_cut / time_jump / smash_cut / iris / whip_pan / dissolve. "
            "REQUIRED."
        ),
    )
    rationale: Optional[str] = Field(
        None, description="Rule of Six justification (emotion / story / rhythm / ...)."
    )
    sharedElement: Optional[str] = Field(
        None,
        description=(
            "Concrete visual or aural hook the cut relies on "
            "(e.g. 'red umbrella' for a match_cut)."
        ),
    )
    planOps: List[PlanOpInput] = Field(
        default_factory=list,
        description="Optional motif-plant ops needed to make the cut land.",
    )
    rank: Optional[int] = Field(
        None, description="1 = recommended; higher = lower priority. Clamped to [1, 10]."
    )

    model_config = {"extra": "allow"}


class BeatAssignmentInput(BaseModel):
    """Schema for a single beat-slot assignment in
    `request_beat_assignment.assignments`."""

    nodeId: Optional[str] = Field(None, description="Shot node id. REQUIRED.")
    beatKey: Optional[str] = Field(
        None,
        description="Canonical beat key from the structure's roster. REQUIRED.",
    )
    actNumber: Optional[int] = Field(
        None, description="Act 1-5 (clamped server-side)."
    )
    rationale: Optional[str] = None

    model_config = {"extra": "allow"}


class ExecutionOperationInput(BaseModel):
    """Schema for a single graph operation in the planner / approve_*
    surface. Mirrors `executionOperation` in `convex/narrativeGit.ts`.

    Why this exists: M9.5 L5 live-LLM smoke caught that
    `List[Dict[str, Any]]` produces a permissive JSON schema that
    gpt-4.1-mini either omits or hoists fields from. This schema
    declares the field NAMES so the LLM emits structured calls; the
    function body's `_sanitize_graph_operations` continues to drop
    malformed entries.
    """

    op: Optional[str] = Field(
        None,
        description=(
            "Op type: create_node / update_node / delete_node / "
            "create_edge / update_edge / delete_edge / generate_image / "
            "generate_video. REQUIRED."
        ),
    )
    opId: Optional[str] = None
    title: Optional[str] = None
    rationale: Optional[str] = None
    nodeId: Optional[str] = None
    edgeId: Optional[str] = None
    nodeType: Optional[str] = Field(
        None,
        description=(
            "scene / shot / branch / merge / character_ref / background_ref."
        ),
    )
    label: Optional[str] = None
    segment: Optional[str] = None
    position: Optional[Dict[str, float]] = Field(
        None, description="{x: number, y: number} canvas coordinates."
    )
    sourceNodeId: Optional[str] = None
    targetNodeId: Optional[str] = None
    edgeType: Optional[str] = Field(
        None, description="serial / parallel / branch / merge."
    )
    branchId: Optional[str] = None
    order: Optional[int] = None
    isPrimary: Optional[bool] = None
    requiresHitl: Optional[bool] = None
    payload: Optional[Dict[str, Any]] = None

    model_config = {"extra": "allow"}


class ContinuityViolationInput(BaseModel):
    """Schema for a continuity violation passed into `repair_plan`,
    `build_autonomous_dailies_batch.continuity_risks`, and
    `preview_simulation_critic_plan.issues`."""

    code: Optional[str] = None
    severity: Optional[str] = Field(None, description="low / medium / high.")
    message: Optional[str] = None
    nodeIds: Optional[List[str]] = Field(default_factory=list)
    edgeIds: Optional[List[str]] = Field(default_factory=list)
    suggestedFix: Optional[str] = None

    model_config = {"extra": "allow"}


class VoiceCastAssignmentInput(BaseModel):
    """Schema for a single voice-pack assignment in
    `request_assign_voice_cast.assignments` (M6 tool)."""

    packId: Optional[str] = Field(None, description="Identity pack id. REQUIRED.")
    voice: Optional[str] = Field(
        None,
        description="Voice name (Puck / Charon / Kore / Fenrir / Zephyr).",
    )

    model_config = {"extra": "allow"}

ALLOWED_NODE_TYPES = {
    "scene",
    "shot",
    "branch",
    "merge",
    "character_ref",
    "background_ref",
}
ALLOWED_EDGE_TYPES = {"serial", "parallel", "branch", "merge"}
ALLOWED_GRAPH_OPS = {
    "create_node",
    "update_node",
    "delete_node",
    "create_edge",
    "update_edge",
    "delete_edge",
}

# Ingestion modes recognized by the supervisor when routing a producer's
# intent to the right ingestion surface. These mirror the three library-page
# dialogs (From Screenplay / From Idea / From Novel) wired up by ViMax M1–M3.
ALLOWED_INGESTION_MODES = {"screenplay", "idea", "novel"}


def _json_hash(payload: Dict[str, Any]) -> str:
    raw = json.dumps(payload, sort_keys=True, ensure_ascii=True)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:16]


def _as_dict(value: Any) -> Dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _safe_str(value: Any, fallback: str = "") -> str:
    return value if isinstance(value, str) else fallback


def _coerce_input(item: Any) -> Dict[str, Any]:
    """Normalize an item to a dict.

    The schema-typed @tool params (e.g. `variants: List[HookVariantInput]`)
    arrive as Pydantic instances at runtime when langchain validates the
    LLM's tool call. Unit tests still pass plain dicts via `.invoke()`.
    Both shapes need to flow through the same sanitizers, so we coerce
    here once at the boundary and the rest of the body works in dict-
    land.

    `exclude_none=True` is critical: without it, `model_dump()` emits
    `{...all_fields...: None}` for every Optional we declared, which
    breaks downstream `if not field` checks (the field exists but is
    None, not absent). Mirrors the sparse-dict semantics tests use.
    """
    if isinstance(item, BaseModel):
        return item.model_dump(exclude_none=True)
    if isinstance(item, dict):
        return item
    return {}


def _sanitize_graph_operations(operations: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    sanitized: List[Dict[str, Any]] = []
    for raw_operation in operations:
        operation = _as_dict(raw_operation)
        op_name = _safe_str(operation.get("op"))
        if op_name not in ALLOWED_GRAPH_OPS:
            continue
        parsed: Dict[str, Any] = {"op": op_name}

        for key in (
            "nodeId",
            "edgeId",
            "label",
            "segment",
            "sourceNodeId",
            "targetNodeId",
            "branchId",
        ):
            value = operation.get(key)
            if isinstance(value, str) and value:
                parsed[key] = value

        node_type = operation.get("nodeType")
        if isinstance(node_type, str) and node_type in ALLOWED_NODE_TYPES:
            parsed["nodeType"] = node_type

        edge_type = operation.get("edgeType")
        if isinstance(edge_type, str) and edge_type in ALLOWED_EDGE_TYPES:
            parsed["edgeType"] = edge_type

        position = operation.get("position")
        if isinstance(position, dict):
            parsed["position"] = {
                "x": float(position.get("x", 0)),
                "y": float(position.get("y", 0)),
            }

        if isinstance(operation.get("order"), (int, float)):
            parsed["order"] = int(operation["order"])
        if isinstance(operation.get("isPrimary"), bool):
            parsed["isPrimary"] = operation["isPrimary"]

        sanitized.append(parsed)
    return sanitized


@tool
def planner_propose_graph_patch(
    storyboard_id: str,
    branch_id: str,
    title: str,
    rationale: str,
    diff_summary: str,
    operations: List[ExecutionOperationInput],
) -> Dict[str, Any]:
    """Builds a deterministic graph-patch proposal from planner output.

    Each ``operations`` entry: ``{ op, nodeId?, nodeType?, label?,
    segment?, position?, sourceNodeId?, targetNodeId?, edgeType?,
    isPrimary?, order?, branchId? }``. ``op`` is required and must be
    one of the eight allowed types (create_node / update_node /
    delete_node / create_edge / update_edge / delete_edge /
    generate_image / generate_video). The sanitizer drops entries
    with unknown ops.
    """
    sanitized_ops = _sanitize_graph_operations(
        [_coerce_input(op) for op in (operations or [])]
    )
    payload = {
        "storyboardId": storyboard_id,
        "branchId": branch_id,
        "title": title,
        "rationale": rationale,
        "diffSummary": diff_summary,
        "operations": sanitized_ops,
        "createdAt": int(time.time() * 1000),
    }
    payload["patchId"] = f"patch_{_json_hash(payload)}"
    return payload


@tool
def planner_propose_media_prompt(
    storyboard_id: str,
    branch_id: str,
    node_id: str,
    media_type: Literal["image", "video"],
    prompt: str,
    negative_prompt: str,
    context_summary: str,
    model_id: str = "",
) -> Dict[str, Any]:
    """Builds a deterministic media prompt proposal.

    Optional ``model_id`` lets the agent pin a specific backend model for this proposal:
      - images: ``zennah-image-gen`` (default), ``zennah-qwen-edit``, ``zennah-qwen-multiview``,
        ``gpt-image-1``, ``dall-e-3``.
      - videos: ``ltx-2.3`` (default, recommended — supports I2V + keyframe + retake),
        ``ltx-2`` (legacy), ``veo-3.1``.
    Pass an empty string to defer model choice to the executor.
    """
    model_id_norm = (model_id or "").strip()
    payload = {
        "storyboardId": storyboard_id,
        "branchId": branch_id,
        "nodeId": node_id,
        "mediaType": media_type,
        "modelId": model_id_norm or None,
        "prompt": " ".join(prompt.split())[:2400],
        "negativePrompt": " ".join(negative_prompt.split())[:1200],
        "contextSummary": " ".join(context_summary.split())[:2400],
        "createdAt": int(time.time() * 1000),
    }
    payload["promptId"] = f"prompt_{_json_hash(payload)}"
    return payload


@tool
def simulate_execution_plan(
    storyboard_id: str,
    branch_id: str,
    operations: List[ExecutionOperationInput],
) -> Dict[str, Any]:
    """Dry-run simulator that checks operation shape and returns risk profile.

    Each ``operations`` entry follows the same shape as
    ``planner_propose_graph_patch`` — see that tool's docstring for
    the field list.
    """
    sanitized_ops = _sanitize_graph_operations(
        [_coerce_input(op) for op in (operations or [])]
    )
    issues: List[Dict[str, Any]] = []
    if len(sanitized_ops) == 0:
        issues.append(
            {
                "code": "EMPTY_PLAN",
                "severity": "high",
                "message": "Execution plan has no valid operations.",
            }
        )

    for operation in sanitized_ops:
        if operation["op"] in {"create_edge", "update_edge"} and not operation.get("edgeType"):
            issues.append(
                {
                    "code": "EDGE_TYPE_REQUIRED",
                    "severity": "medium",
                    "message": "Edge operations should include edgeType.",
                    "op": operation,
                }
            )

    risk_level: Literal["low", "medium", "high", "critical"] = "low"
    if any(issue["severity"] == "high" for issue in issues):
        risk_level = "high"
    elif any(issue["severity"] == "medium" for issue in issues):
        risk_level = "medium"

    return {
        "storyboardId": storyboard_id,
        "branchId": branch_id,
        "valid": len(issues) == 0,
        "riskLevel": risk_level,
        "summary": "Dry-run simulation completed.",
        "issues": issues,
        "operationCount": len(sanitized_ops),
        "estimatedTotalCost": round(len(sanitized_ops) * 0.18, 2),
        "estimatedDurationSec": round(max(len(sanitized_ops), 1) * 1.6, 2),
        "planHash": _json_hash(
            {
                "storyboardId": storyboard_id,
                "branchId": branch_id,
                "operations": sanitized_ops,
            }
        ),
    }


@tool
def continuity_critic(
    storyboard_id: str,
    branch_id: str,
    rolling_summary: str,
    character_ids: List[str],
    selected_wardrobes: List[str],
) -> Dict[str, Any]:
    """Continuity critic for narration and identity consistency."""
    summary = rolling_summary.lower()
    violations: List[Dict[str, Any]] = []
    if "suddenly alive" in summary and "died" in summary:
        violations.append(
            {
                "code": "NARRATIVE_CONTRADICTION",
                "severity": "high",
                "message": "Narrative timeline contradiction detected.",
            }
        )
    if len(character_ids) > 0 and len(selected_wardrobes) == 0:
        violations.append(
            {
                "code": "WARDROBE_MISSING",
                "severity": "medium",
                "message": "Character present without explicit wardrobe variant.",
            }
        )

    return {
        "storyboardId": storyboard_id,
        "branchId": branch_id,
        "violations": violations,
        "status": "ok" if len(violations) == 0 else "warning",
    }


@tool
def producer_guard(
    storyboard_id: str,
    branch_id: str,
    operation_count: int,
    risk_level: Literal["low", "medium", "high", "critical"],
) -> Dict[str, Any]:
    """Scores approval policy for producer-facing HITL controls."""
    if risk_level in {"high", "critical"} or operation_count > 3:
        mode = "per_operation"
    elif operation_count > 1:
        mode = "batch_with_override"
    else:
        mode = "single"
    return {
        "storyboardId": storyboard_id,
        "branchId": branch_id,
        "approvalMode": mode,
        "requiresHitl": True,
        "maxBatchSize": 1 if mode == "per_operation" else 5,
    }


@tool
def recommend_ingestion_path(
    user_request: str,
    has_screenplay_text: bool = False,
    has_novel_text: bool = False,
    has_idea_text: bool = False,
) -> Dict[str, Any]:
    """Classifies a producer request to one of the three ingestion surfaces.

    Returns a deterministic recommendation (``mode``) with a short rationale and
    the input fields the UI will need to collect. This tool is non-mutating: it
    emits a recommendation only. The supervisor should hand off to
    ``request_ingestion_run`` (HITL) to actually kick off the pipeline.

    ``mode`` is one of ``screenplay`` | ``idea`` | ``novel``.

    Heuristics:
      * If the caller already pasted raw screenplay text (slug lines, INT./EXT.,
        dialogue blocks) → screenplay.
      * If the caller already pasted a long prose passage (>800 chars or
        multiple paragraphs of narration) → novel.
      * Otherwise, treat short briefs / premises / loglines as idea.
    """
    request_norm = " ".join(user_request.split()).lower()
    request_compact = request_norm[:4000]
    request_len = len(request_compact)

    screenplay_signals = 0
    for marker in ("int.", "ext.", "fade in", "fade out", "cut to", "scene "):
        if marker in request_compact:
            screenplay_signals += 1

    novel_signals = 0
    if request_len > 800:
        novel_signals += 1
    if request_compact.count("\n\n") >= 2:
        novel_signals += 1
    for marker in ("chapter ", "he said", "she said", "—", "“", "”"):
        if marker in request_compact:
            novel_signals += 1
            break

    idea_signals = 0
    for marker in ("idea:", "premise", "logline", "pitch", "concept"):
        if marker in request_compact:
            idea_signals += 1

    # Caller-provided input flags override heuristics when present.
    mode: str
    rationale: str
    if has_screenplay_text or screenplay_signals >= 2:
        mode = "screenplay"
        rationale = (
            "Request contains explicit screenplay formatting (slug lines / action "
            "blocks). Route to From-Screenplay ingestion."
        )
    elif has_novel_text or novel_signals >= 2 or (request_len > 1200 and idea_signals == 0):
        mode = "novel"
        rationale = (
            "Request reads like long-form prose. Route to From-Novel ingestion so "
            "the pipeline can chunk + compress + split into episodes."
        )
    elif has_idea_text or idea_signals >= 1 or request_len <= 800:
        mode = "idea"
        rationale = (
            "Request is a premise / logline / short brief. Route to From-Idea "
            "ingestion so the pipeline can expand it into a screenplay first."
        )
    else:
        mode = "idea"
        rationale = (
            "Ambiguous request. Defaulting to From-Idea because it is the cheapest "
            "ingestion path and can be re-ingested after more detail is gathered."
        )

    required_fields: List[str]
    if mode == "screenplay":
        required_fields = ["title", "screenplay", "style"]
    elif mode == "novel":
        required_fields = ["title", "novel", "style", "targetEpisodeCount"]
    else:
        required_fields = ["title", "idea", "style", "targetShotCount"]

    return {
        "mode": mode,
        "rationale": rationale,
        "requiredFields": required_fields,
        "requestLength": request_len,
        "recommendationId": f"ingestreco_{_json_hash({'r': request_compact[:2000], 'm': mode})}",
    }


@tool
def request_ingestion_run(
    mode: Literal["screenplay", "idea", "novel"],
    title: str,
    rationale: str,
    hints: Dict[str, Any],
) -> Dict[str, Any]:
    """Requests human approval to kick off an ingestion pipeline. Interrupt target.

    The producer confirms the mode + title + rationale in chat, and the UI opens
    the corresponding library-page dialog pre-populated with hints. The agent
    never ingests silently — this tool is the HITL gate between intent and
    pipeline execution.

    ``hints`` may include any of: ``style``, ``targetEpisodeCount``,
    ``targetShotCount``, ``userRequirement``, ``novelExcerpt``, ``ideaSynopsis``.
    """
    mode_norm = mode if mode in ALLOWED_INGESTION_MODES else "idea"
    clean_hints: Dict[str, Any] = {}
    for key in (
        "style",
        "userRequirement",
        "ideaSynopsis",
        "novelExcerpt",
        "screenplayExcerpt",
    ):
        value = hints.get(key)
        if isinstance(value, str) and value:
            clean_hints[key] = " ".join(value.split())[:2400]
    for key in ("targetEpisodeCount", "targetShotCount"):
        value = hints.get(key)
        if isinstance(value, (int, float)) and value > 0:
            clean_hints[key] = int(value)
    return {
        "schemaVersion": "v2",
        "action": "request_ingestion_run",
        "status": "waiting_for_human",
        "input": {
            "mode": mode_norm,
            "title": " ".join(title.split())[:200] or f"Untitled {mode_norm}",
            "rationale": " ".join(rationale.split())[:1200],
            "hints": clean_hints,
        },
    }


@tool
def request_generate_shot_batch(
    storyboard_id: str,
    branch_id: str,
    node_count: int,
    rationale: str,
    skip_existing: bool = True,
    concurrency: int = 3,
) -> Dict[str, Any]:
    """Requests human approval to run the Generate-All-Shots batch. Interrupt target.

    Triggers the per-shot image batch pipeline (portraits-as-references,
    bounded-concurrency) on the active storyboard once the producer approves in
    chat. Use ``skip_existing=True`` to preserve any shots the producer already
    rendered manually. Cap ``concurrency`` in [1, 6] — higher values saturate
    media-gen quotas.
    """
    safe_concurrency = max(1, min(6, int(concurrency) if isinstance(concurrency, (int, float)) else 3))
    safe_node_count = max(0, int(node_count) if isinstance(node_count, (int, float)) else 0)
    return {
        "schemaVersion": "v2",
        "action": "request_generate_shot_batch",
        "status": "waiting_for_human",
        "input": {
            "storyboardId": storyboard_id,
            "branchId": branch_id,
            "nodeCount": safe_node_count,
            "rationale": " ".join(rationale.split())[:1200],
            "skipExisting": bool(skip_existing),
            "concurrency": safe_concurrency,
        },
    }


@tool
def request_assign_voice_cast(
    storyboard_id: str,
    assignments: List[VoiceCastAssignmentInput],
    rationale: str,
) -> Dict[str, Any]:
    """Requests human approval for a batch of TTS voice assignments
    across identity packs. Interrupt target.

    Each ``assignments`` entry: ``{packId, voice}``. An empty
    ``voice`` clears the mapping. The bridge validates each voice
    against the OpenAI TTS vocabulary (alloy / echo / fable / onyx /
    nova / shimmer) and silently drops invalid entries before
    applying, so the agent can safely propose creative suggestions
    without crashing the flow.

    Use this after extracting the character roster (e.g. reading the
    Continuity tab) so voice distribution feels deliberate rather than
    random.
    """
    sanitized: List[Dict[str, str]] = []
    for raw_input in assignments or []:
        raw = _coerce_input(raw_input)
        pack_id = str(raw.get("packId", "")).strip()
        voice = str(raw.get("voice", "")).strip().lower()
        if not pack_id:
            continue
        sanitized.append({"packId": pack_id, "voice": voice})
    return {
        "schemaVersion": "v2",
        "action": "request_assign_voice_cast",
        "status": "waiting_for_human",
        "input": {
            "storyboardId": storyboard_id,
            "assignments": sanitized,
            "rationale": " ".join(rationale.split())[:1200],
        },
    }


@tool
def request_export_reel(
    storyboard_id: str,
    rationale: str,
    shot_count: int = 0,
    estimated_duration_s: float = 0.0,
) -> Dict[str, Any]:
    """Requests human approval to export the storyboard's reel as an mp4.
    Interrupt target.

    Calls the server-side ffmpeg pipeline: normalizes every shot into a
    uniform 1920x1080@30 clip (video / still-image loop / silent black
    fallback per what's been rendered) and concats them into a single
    mp4 uploaded to Convex storage. The export row is persisted so
    producers can re-download without paying another ffmpeg run.

    The export is idempotent in behavior (always produces a fresh row
    and a fresh mp4) but not in effect (each run costs ffmpeg + upload
    time), so agent-initiated exports should be rare + deliberate.
    """
    safe_shot_count = max(0, int(shot_count) if isinstance(shot_count, (int, float)) else 0)
    safe_duration = max(
        0.0,
        float(estimated_duration_s)
        if isinstance(estimated_duration_s, (int, float))
        else 0.0,
    )
    return {
        "schemaVersion": "v2",
        "action": "request_export_reel",
        "status": "waiting_for_human",
        "input": {
            "storyboardId": storyboard_id,
            "shotCount": safe_shot_count,
            "estimatedDurationS": safe_duration,
            "rationale": " ".join(rationale.split())[:1200],
        },
    }


@tool
def request_generate_shot_sfx_batch(
    storyboard_id: str,
    branch_id: str,
    node_count: int,
    rationale: str,
    skip_existing: bool = True,
    concurrency: int = 3,
) -> Dict[str, Any]:
    """Requests human approval to run the Generate-All-SFX batch. Interrupt target.

    Triggers per-shot ambient/foley sound-effect generation via the
    configured provider (ElevenLabs Sound Effects). For each shot:
      - If ``skip_existing`` is True (default), shots with an active SFX
        track are left alone.
      - The route derives the SFX prompt from ``shotMeta.sfx`` hints
        when present, otherwise from the shot's segment text. Shots
        with no derivable prompt are reported as ``skipped``.
      - Duration is clamped to the shot's declared ``durationS`` so the
        ambient track doesn't outrun the narration.

    Requires ``ELEVENLABS_API_KEY`` to be configured on the server; the
    single-shot route returns HTTP 501 if missing, and the bridge
    surfaces that as a clear "no provider" error.

    ``concurrency`` caps at 5 to avoid starving the OpenAI narration
    batch when both run together.
    """
    safe_concurrency = max(
        1,
        min(5, int(concurrency) if isinstance(concurrency, (int, float)) else 3),
    )
    safe_node_count = max(0, int(node_count) if isinstance(node_count, (int, float)) else 0)
    return {
        "schemaVersion": "v2",
        "action": "request_generate_shot_sfx_batch",
        "status": "waiting_for_human",
        "input": {
            "storyboardId": storyboard_id,
            "branchId": branch_id,
            "nodeCount": safe_node_count,
            "rationale": " ".join(rationale.split())[:1200],
            "skipExisting": bool(skip_existing),
            "concurrency": safe_concurrency,
        },
    }


@tool
def request_generate_score(
    storyboard_id: str,
    prompt: str,
    rationale: str,
    duration_s: int = 60,
    volume_db: int = -18,
) -> Dict[str, Any]:
    """Requests human approval to generate a reel-level background score. Interrupt target.

    Produces a single music track (via ElevenLabs Music by default) that
    the reel export pipeline mixes UNDER narration + SFX. Score is
    storyboard-level, not per-shot — the producer replaces the whole
    music bed when approving a regenerate.

    Arguments are clamped at the bridge boundary:
      - ``duration_s`` — clamped to [10, 300]. Tune to the reel's
        totalDurationS so the amix's ``duration=first`` bound isn't
        wasted.
      - ``volume_db`` — clamped to [-40, 0]. Default ``-18`` keeps the
        music well under narration.

    Requires ``ELEVENLABS_API_KEY`` configured on the server.
    """
    safe_duration = max(10, min(300, int(duration_s) if isinstance(duration_s, (int, float)) else 60))
    safe_volume = max(-40, min(0, int(volume_db) if isinstance(volume_db, (int, float)) else -18))
    trimmed_prompt = " ".join(prompt.split())[:600]
    return {
        "schemaVersion": "v2",
        "action": "request_generate_score",
        "status": "waiting_for_human",
        "input": {
            "storyboardId": storyboard_id,
            "prompt": trimmed_prompt,
            "durationS": safe_duration,
            "volumeDb": safe_volume,
            "rationale": " ".join(rationale.split())[:1200],
        },
    }


@tool
def request_dailies_critic_review(
    storyboard_id: str,
    dailies_reel_id: str,
    rationale: str,
) -> Dict[str, Any]:
    """Requests human approval to dispatch the dailies_critic subagent on a specific dailies row. Interrupt target.

    The critic subagent runs timeline simulation + continuity checks
    and proposes minimal repair operations via ``repair_plan``. It
    never mutates state directly — its output is a structured critique
    that the supervisor delegates for producer review.

    Arguments:
      - ``dailies_reel_id`` — the ``dailies.reelId`` the critic should
        audit. Keeps the critique scoped; the dailies board listing
        surfaces the available reel ids.
    """
    return {
        "schemaVersion": "v2",
        "action": "request_dailies_critic_review",
        "status": "waiting_for_human",
        "input": {
            "storyboardId": storyboard_id,
            "dailiesReelId": str(dailies_reel_id),
            "rationale": " ".join(rationale.split())[:1200],
        },
    }


@tool
def request_generate_shot_audio_batch(
    storyboard_id: str,
    branch_id: str,
    node_count: int,
    rationale: str,
    skip_existing: bool = True,
    concurrency: int = 3,
    voice: str = "nova",
    model: str = "tts-1",
    speed: float = 1.0,
) -> Dict[str, Any]:
    """Requests human approval to run the Generate-All-Audio (TTS) batch. Interrupt target.

    Triggers per-shot narration rendering via OpenAI TTS. Unlike the video
    batch this has no image prerequisite — the pipeline derives narration
    text from each shot's segment (or promptPack.imagePrompt as fallback).

    ``voice`` is validated against the OpenAI TTS vocabulary
    (alloy/echo/fable/onyx/nova/shimmer); unrecognized values are coerced
    to "nova" at the route boundary.
    ``speed`` is clamped in [0.25, 4.0]. ``concurrency`` caps at 5.
    """
    safe_concurrency = max(
        1,
        min(5, int(concurrency) if isinstance(concurrency, (int, float)) else 3),
    )
    safe_node_count = max(0, int(node_count) if isinstance(node_count, (int, float)) else 0)
    safe_speed = max(
        0.25,
        min(4.0, float(speed) if isinstance(speed, (int, float)) else 1.0),
    )
    voice_norm = (voice or "").strip().lower() or "nova"
    model_norm = (model or "").strip() or "tts-1"
    return {
        "schemaVersion": "v2",
        "action": "request_generate_shot_audio_batch",
        "status": "waiting_for_human",
        "input": {
            "storyboardId": storyboard_id,
            "branchId": branch_id,
            "nodeCount": safe_node_count,
            "rationale": " ".join(rationale.split())[:1200],
            "skipExisting": bool(skip_existing),
            "concurrency": safe_concurrency,
            "voice": voice_norm,
            "model": model_norm,
            "speed": safe_speed,
        },
    }


@tool
def request_generate_shot_video_batch(
    storyboard_id: str,
    branch_id: str,
    node_count: int,
    rationale: str,
    skip_existing: bool = True,
    concurrency: int = 2,
    video_model_id: str = "ltx-2.3",
) -> Dict[str, Any]:
    """Requests human approval to run the Generate-All-Videos batch. Interrupt target.

    Triggers the per-shot image-to-video batch (LTX-2.3 I2V with each shot's
    already-generated image as keyframe 0). Shots without an active image are
    skipped by the pipeline — the producer should run the image batch first.

    ``concurrency`` is capped in [1, 4] because LTX-2.3 takes 60-180s per shot
    and higher worker counts race the 30-min stale-mediaAsset sweeper.

    ``video_model_id`` accepts ``ltx-2.3`` (default, I2V + keyframe + retake),
    ``ltx-2`` (legacy), or ``veo-3.1``.
    """
    safe_concurrency = max(
        1,
        min(4, int(concurrency) if isinstance(concurrency, (int, float)) else 2),
    )
    safe_node_count = max(0, int(node_count) if isinstance(node_count, (int, float)) else 0)
    model_norm = (video_model_id or "").strip() or "ltx-2.3"
    return {
        "schemaVersion": "v2",
        "action": "request_generate_shot_video_batch",
        "status": "waiting_for_human",
        "input": {
            "storyboardId": storyboard_id,
            "branchId": branch_id,
            "nodeCount": safe_node_count,
            "rationale": " ".join(rationale.split())[:1200],
            "skipExisting": bool(skip_existing),
            "concurrency": safe_concurrency,
            "videoModelId": model_norm,
        },
    }


@tool
def repair_plan(
    storyboard_id: str,
    branch_id: str,
    violations: List[ContinuityViolationInput],
) -> Dict[str, Any]:
    """Builds a deterministic repair plan for continuity/simulation failures.

    Each ``violations`` entry: ``{ code, severity?, message?, nodeIds?,
    suggestedFix? }``. Unknown codes get bucketed as `UNKNOWN` so the
    repair plan still surfaces a placeholder for producer review.
    """
    coerced_violations = [_coerce_input(v) for v in (violations or [])]
    repair_ops: List[Dict[str, Any]] = []
    for index, violation in enumerate(coerced_violations):
        code = _safe_str(violation.get("code"), "UNKNOWN")
        repair_ops.append(
            {
                "opId": f"repair_{index + 1}",
                "title": f"Repair {code}",
                "rationale": "Auto-generated by Repair Agent",
                "op": "update_node",
                "payload": {"repairCode": code},
                "requiresHitl": True,
            }
        )
    return {
        "storyboardId": storyboard_id,
        "branchId": branch_id,
        "repairPlanId": f"repairplan_{_json_hash({'violations': coerced_violations})}",
        "operations": repair_ops,
        "confidence": 0.72 if len(repair_ops) > 0 else 0.0,
    }


@tool
def build_autonomous_dailies_batch(
    storyboard_id: str,
    branch_id: str,
    source_reel_id: str,
    title: str,
    summary: str,
    target_node_ids: List[str],
    continuity_risks: List[ContinuityViolationInput],
) -> Dict[str, Any]:
    """Builds an autonomous dailies execution plan from reel metadata and risks.

    Each ``continuity_risks`` entry: ``{ code, severity?, message?,
    nodeIds, suggestedFix? }``. Risks with empty `nodeIds` are dropped
    silently — the repair op needs a target node to attach to.
    """
    coerced_risks = [_coerce_input(r) for r in (continuity_risks or [])]
    operations: List[Dict[str, Any]] = []
    for index, node_id in enumerate(target_node_ids[:8]):
        op_name: Literal["generate_image", "generate_video"] = (
            "generate_video" if index % 2 == 1 else "generate_image"
        )
        operations.append(
            {
                "opId": f"daily_gen_{index + 1}",
                "op": op_name,
                "title": f"Autonomous dailies render for {node_id}",
                "rationale": "Coverage expansion for daily candidate reel.",
                "nodeId": node_id,
                "requiresHitl": True,
                "payload": {
                    "prompt": f"{summary} Preserve identity lock and narrative continuity.",
                    "negativePrompt": "identity drift, continuity mismatch",
                },
            }
        )

    for index, risk in enumerate(coerced_risks[:4]):
        risk_obj = risk
        risk_code = _safe_str(risk_obj.get("code"), f"RISK_{index + 1}")
        node_ids = risk_obj.get("nodeIds")
        primary_node_id = (
            node_ids[0]
            if isinstance(node_ids, list) and len(node_ids) > 0 and isinstance(node_ids[0], str)
            else ""
        )
        if not primary_node_id:
            continue
        operations.append(
            {
                "opId": f"daily_fix_{index + 1}",
                "op": "update_node",
                "title": f"Continuity repair {risk_code}",
                "rationale": _safe_str(risk_obj.get("message"), "Continuity warning remediation."),
                "nodeId": primary_node_id,
                "requiresHitl": True,
                "payload": {
                    "suggestedFix": _safe_str(risk_obj.get("suggestedFix"), ""),
                },
            }
        )

    plan_payload = {
        "storyboardId": storyboard_id,
        "branchId": branch_id,
        "source": "dailies",
        "sourceId": source_reel_id,
        "title": title,
        "rationale": "Autonomous dailies batch plan requiring producer confirmation.",
        "operations": operations,
    }
    plan_id = f"dailyplan_{_json_hash(plan_payload)}"
    return {
        "reelId": source_reel_id,
        "executionPlan": {
            "planId": plan_id,
            "storyboardId": storyboard_id,
            "branchId": branch_id,
            "title": title,
            "rationale": "Autonomous dailies batch plan requiring producer confirmation.",
            "source": "dailies",
            "sourceId": source_reel_id,
            "taskType": "dailies_batch",
            "operations": operations,
            "dryRun": {
                "valid": True,
                "riskLevel": "medium" if len(coerced_risks) > 0 else "low",
                "summary": summary,
                "issues": coerced_risks,
                "estimatedTotalCost": round(max(len(operations), 1) * 0.22, 2),
                "estimatedDurationSec": round(max(len(operations), 1) * 2.1, 2),
                "planHash": _json_hash({"planId": plan_id, "operations": operations}),
            },
        },
    }


@tool
def simulate_story_playthrough(
    storyboard_id: str,
    branch_id: str,
    timeline_events: List[str],
    node_count: int,
    edge_count: int,
    branch_edge_count: int,
    merge_edge_count: int,
) -> Dict[str, Any]:
    """Runs simulation+critic heuristics and outputs repair batch candidates."""
    issues: List[Dict[str, Any]] = []
    compact_timeline = " | ".join(" ".join(event.split())[:200] for event in timeline_events[:30]).lower()

    if node_count > 0 and edge_count == 0:
        issues.append(
            {
                "code": "SIM_ORPHAN_GRAPH",
                "severity": "high",
                "message": "Storyboard graph has nodes but no edges; timeline cannot play through.",
                "nodeIds": [],
                "edgeIds": [],
                "suggestedFix": "Connect root scene to downstream beats before media generation.",
            }
        )
    if branch_edge_count > merge_edge_count + 2:
        issues.append(
            {
                "code": "SIM_BRANCH_IMBALANCE",
                "severity": "medium",
                "message": "Branch count exceeds merge count; unresolved arcs may reduce coherence.",
                "nodeIds": [],
                "edgeIds": [],
                "suggestedFix": "Insert merge or convergence beats for unresolved branches.",
            }
        )
    if "died" in compact_timeline and "alive" in compact_timeline:
        issues.append(
            {
                "code": "SIM_CAUSALITY_CONTRADICTION",
                "severity": "high",
                "message": "Timeline suggests causality contradiction between death and alive states.",
                "nodeIds": [],
                "edgeIds": [],
                "suggestedFix": "Add explicit revival or alternate-branch transition event.",
            }
        )
    if len(timeline_events) > 18:
        issues.append(
            {
                "code": "SIM_PACING_DENSITY",
                "severity": "medium",
                "message": "High event density may compress pacing and reduce emotional readability.",
                "nodeIds": [],
                "edgeIds": [],
                "suggestedFix": "Split dense sections into staged beats and add transition shots.",
            }
        )

    risk_level: Literal["low", "medium", "high", "critical"] = "low"
    if any(issue["severity"] == "high" for issue in issues):
        risk_level = "high"
    elif any(issue["severity"] == "medium" for issue in issues):
        risk_level = "medium"

    repair_operations: List[Dict[str, Any]] = []
    for index, issue in enumerate(issues[:8]):
        repair_operations.append(
            {
                "opId": f"sim_fix_{index + 1}",
                "op": "update_node",
                "title": f"Repair {issue['code']}",
                "rationale": issue["message"],
                "requiresHitl": True,
                "payload": {"suggestedFix": issue.get("suggestedFix", "")},
            }
        )

    simulation_run_id = f"simrun_{_json_hash({'events': timeline_events, 'counts': [node_count, edge_count]})}"
    confidence = 0.86 if len(issues) <= 1 else 0.74 if len(issues) <= 3 else 0.62
    impact_score = round(min(1.0, max(0.2, len(issues) * 0.18)), 2)
    summary = (
        "Simulation critic pass: no high-risk issues."
        if len(issues) == 0
        else f"Simulation critic found {len(issues)} issue(s) requiring producer review."
    )
    return {
        "simulationRunId": simulation_run_id,
        "storyboardId": storyboard_id,
        "branchId": branch_id,
        "summary": summary,
        "riskLevel": risk_level,
        "issues": issues,
        "repairOperations": repair_operations,
        "confidence": confidence,
        "impactScore": impact_score,
        "executionPlan": {
            "planId": f"simplan_{_json_hash({'run': simulation_run_id, 'ops': repair_operations})}",
            "storyboardId": storyboard_id,
            "branchId": branch_id,
            "title": "Simulation Critic Repair Batch",
            "rationale": summary,
            "source": "simulation_critic",
            "sourceId": simulation_run_id,
            "taskType": "simulation_critic_batch",
            "operations": repair_operations,
            "dryRun": {
                "valid": True,
                "riskLevel": risk_level,
                "summary": summary,
                "issues": issues,
                "estimatedTotalCost": round(max(len(repair_operations), 1) * 0.15, 2),
                "estimatedDurationSec": round(max(len(repair_operations), 1) * 1.7, 2),
                "planHash": _json_hash(repair_operations and {"ops": repair_operations} or {"ops": []}),
            },
        },
    }


@tool
def approve_graph_patch(
    patch_id: str,
    title: str,
    rationale: str,
    diff_summary: str,
    operations: List[ExecutionOperationInput],
) -> Dict[str, Any]:
    """Requests human approval for a graph patch. Interrupt target.

    Each ``operations`` entry follows the ExecutionOperationInput
    schema — see `planner_propose_graph_patch` for the field list.
    """
    return {
        "schemaVersion": "v2",
        "action": "approve_graph_patch",
        "status": "waiting_for_human",
        "input": {
            "patchId": patch_id,
            "title": title,
            "rationale": rationale,
            "diffSummary": diff_summary,
            "operations": _sanitize_graph_operations(
                [_coerce_input(op) for op in (operations or [])]
            ),
        },
    }


@tool
def approve_media_prompt(
    node_id: str,
    media_type: Literal["image", "video"],
    prompt: str,
    negative_prompt: str,
    context_summary: str,
) -> Dict[str, Any]:
    """Requests human approval for a media prompt. Interrupt target."""
    return {
        "schemaVersion": "v2",
        "action": "approve_media_prompt",
        "status": "waiting_for_human",
        "input": {
            "nodeId": node_id,
            "mediaType": media_type,
            "prompt": " ".join(prompt.split())[:2400],
            "negativePrompt": " ".join(negative_prompt.split())[:1200],
            "contextSummary": " ".join(context_summary.split())[:2400],
        },
    }


@tool
def approve_execution_plan(
    plan_id: str,
    storyboard_id: str,
    branch_id: str,
    title: str,
    rationale: str,
    operations: List[ExecutionOperationInput],
    dry_run: Dict[str, Any],
) -> Dict[str, Any]:
    """Requests human approval for a multi-op execution plan. Interrupt target."""
    coerced_ops = [_coerce_input(op) for op in (operations or [])]
    return {
        "schemaVersion": "v2",
        "action": "approve_execution_plan",
        "status": "waiting_for_human",
        "input": {
            "planId": plan_id,
            "storyboardId": storyboard_id,
            "branchId": branch_id,
            "title": title,
            "rationale": rationale,
            "operations": coerced_ops,
            "dryRun": dry_run,
        },
    }


@tool
def approve_batch_ops(
    plan_id: str,
    operations: List[ExecutionOperationInput],
    dry_run: Dict[str, Any],
) -> Dict[str, Any]:
    """Requests human approval for a batched operation set. Interrupt target."""
    coerced_ops = [_coerce_input(op) for op in (operations or [])]
    return {
        "schemaVersion": "v2",
        "action": "approve_batch_ops",
        "status": "waiting_for_human",
        "input": {
            "planId": plan_id,
            "operations": coerced_ops,
            "dryRun": dry_run,
        },
    }


@tool
def preview_simulation_critic_plan(
    simulation_run_id: str,
    storyboard_id: str,
    branch_id: str,
    summary: str,
    risk_level: Literal["low", "medium", "high", "critical"],
    issues: List[ContinuityViolationInput],
    confidence: float,
    impact_score: float,
    execution_plan: Dict[str, Any],
) -> Dict[str, Any]:
    """Requests human preview of simulation critic rationale before batch approval."""
    return {
        "schemaVersion": "v2",
        "action": "preview_simulation_critic_plan",
        "status": "waiting_for_human",
        "input": {
            "simulationRunId": simulation_run_id,
            "storyboardId": storyboard_id,
            "branchId": branch_id,
            "summary": summary,
            "riskLevel": risk_level,
            "issues": [_coerce_input(i) for i in (issues or [])],
            "confidence": confidence,
            "impactScore": impact_score,
            "executionPlan": execution_plan,
        },
    }


@tool
def approve_dailies_batch(
    plan_id: str,
    storyboard_id: str,
    branch_id: str,
    title: str,
    rationale: str,
    source_id: str,
    operations: List[ExecutionOperationInput],
    dry_run: Dict[str, Any],
) -> Dict[str, Any]:
    """Requests human approval for autonomous dailies batch execution."""
    coerced_ops = [_coerce_input(op) for op in (operations or [])]
    return {
        "schemaVersion": "v2",
        "action": "approve_dailies_batch",
        "status": "waiting_for_human",
        "input": {
            "planId": plan_id,
            "storyboardId": storyboard_id,
            "branchId": branch_id,
            "title": title,
            "rationale": rationale,
            "source": "dailies",
            "sourceId": source_id,
            "taskType": "dailies_batch",
            "operations": coerced_ops,
            "dryRun": dry_run,
        },
    }


@tool
def approve_merge_policy(
    branch_id: str,
    source_branch_id: str,
    target_branch_id: str,
    policy: str,
    semantic_diff: Dict[str, Any],
) -> Dict[str, Any]:
    """Requests human approval for merge policy. Interrupt target."""
    return {
        "schemaVersion": "v2",
        "action": "approve_merge_policy",
        "status": "waiting_for_human",
        "input": {
            "branchId": branch_id,
            "sourceBranchId": source_branch_id,
            "targetBranchId": target_branch_id,
            "policy": policy,
            "semanticDiff": semantic_diff,
        },
    }


@tool
def approve_repair_plan(
    repair_plan_id: str,
    operations: List[ExecutionOperationInput],
    confidence: float,
) -> Dict[str, Any]:
    """Requests human approval for auto-repair operations. Interrupt target."""
    coerced_ops = [_coerce_input(op) for op in (operations or [])]
    return {
        "schemaVersion": "v2",
        "action": "approve_repair_plan",
        "status": "waiting_for_human",
        "input": {
            "repairPlanId": repair_plan_id,
            "operations": coerced_ops,
            "confidence": confidence,
        },
    }


@tool
def select_agent_team(
    team_id: str,
    revision_id: str = "",
) -> Dict[str, Any]:
    """Requests human confirmation to switch the active agent team."""
    payload: Dict[str, Any] = {"teamId": team_id}
    if revision_id:
        payload["revisionId"] = revision_id
    return {
        "schemaVersion": "v2",
        "action": "select_agent_team",
        "status": "waiting_for_human",
        "input": payload,
    }


@tool
def create_agent_team(
    name: str,
    description: str,
    team_goal: str,
) -> Dict[str, Any]:
    """Requests human confirmation to create a new custom agent team."""
    return {
        "schemaVersion": "v2",
        "action": "create_agent_team",
        "status": "waiting_for_human",
        "input": {
            "name": name,
            "description": description,
            "teamGoal": team_goal,
        },
    }


@tool
def update_agent_team_member(
    team_id: str,
    revision_id: str,
    member: Dict[str, Any],
) -> Dict[str, Any]:
    """Requests human confirmation to update member persona/scope."""
    return {
        "schemaVersion": "v2",
        "action": "update_agent_team_member",
        "status": "waiting_for_human",
        "input": {
            "teamId": team_id,
            "revisionId": revision_id,
            "member": member,
        },
    }


@tool
def publish_agent_team_revision(
    team_id: str,
    revision_id: str,
) -> Dict[str, Any]:
    """Requests human confirmation to publish a team revision."""
    return {
        "schemaVersion": "v2",
        "action": "publish_agent_team_revision",
        "status": "waiting_for_human",
        "input": {
            "teamId": team_id,
            "revisionId": revision_id,
        },
    }


@tool
def generate_team_from_prompt(
    input_prompt: str,
    team_id: str = "",
    publish: bool = False,
) -> Dict[str, Any]:
    """Requests human confirmation for prompt-to-team draft generation."""
    payload: Dict[str, Any] = {
        "inputPrompt": input_prompt,
        "publish": publish,
    }
    if team_id:
        payload["teamId"] = team_id
    return {
        "schemaVersion": "v2",
        "action": "generate_team_from_prompt",
        "status": "waiting_for_human",
        "input": payload,
    }


# =======================================================================
# M9 Phase 2 — Narrative analysis (read-only, deterministic heuristics)
# =======================================================================
# These three tools are deliberately CHEAP. They never call an LLM.
# They operate over the shot list + shotMeta + segment text the agent
# already has in `state["graph_snapshot"]`, produce a heuristic
# first-pass beat plan + tension samples, and hand the result back to
# the `beat_analyst` / `tension_analyst` subagent for optional LLM-
# backed refinement.
#
# The "bounded LLM cost" design decision from the M9 plan lives here:
# every recompute of the reel narrative state starts from these
# deterministic baselines, so the LLM only has to review+adjust instead
# of proposing from zero on every turn.
# =======================================================================

# Action / emotional vocabulary for the tension heuristic. Kept module-
# level so the sampler doesn't re-build sets on every call. Careful
# NOT to over-expand these — we only want to nudge the score when the
# signal is unambiguous.
_HIGH_TENSION_KEYWORDS = frozenset({
    # Kept ambiguous English words OUT of the list: "shot" collides
    # with the cinematographic noun (every shot description mentions
    # "shot"); "fire" collides with fireplaces/campfires. If the
    # tension score depended on those, every reel's curve would flat-
    # line at the ceiling. Stick to verbs whose action semantics are
    # unambiguous in a shot description.
    "fight", "chase", "run", "runs", "running", "death", "dies", "died",
    "kill", "kills", "killing", "killed", "attack", "attacks", "attacked",
    "shoots", "shooting", "scream", "screams", "screaming",
    "explode", "explodes", "explosion", "blood", "panic",
    "crash", "crashes", "crashing",
})
_MEDIUM_TENSION_KEYWORDS = frozenset({
    "reveal", "reveals", "revealed", "confront", "confronts",
    "confronted", "confess", "confesses", "betray", "betrays",
    "betrayed", "shock", "shocks", "shocked", "fear", "afraid",
    "weep", "weeps", "cry", "cries", "tears", "sob", "sobs",
})
_LOW_TENSION_KEYWORDS = frozenset({
    "laugh", "laughs", "laughing", "calm", "peaceful", "quiet",
    "rest", "rests", "sleep", "sleeps", "sleeping", "smile",
    "smiles", "smiling",
})
_TIGHT_SHOT_SIZES = frozenset({"ECU", "CU", "MCU"})
_DYNAMIC_SHOT_MOVES = frozenset({"whip_pan", "handheld", "tilt"})


def _tokenize_segment(text: str) -> List[str]:
    """Lowercase + split on non-alpha. Good enough for keyword match."""
    if not isinstance(text, str):
        return []
    buf: List[str] = []
    word: List[str] = []
    for ch in text.lower():
        if ch.isalpha():
            word.append(ch)
        elif word:
            buf.append("".join(word))
            word = []
    if word:
        buf.append("".join(word))
    return buf


def _heuristic_tension_for_shot(shot: Dict[str, Any]) -> float:
    """Compute a 0-10 tension score from shotMeta + segment text.

    Formula:
      3.0 baseline (neutral mid) +
      +2.0  if camera move is dynamic (whip_pan/handheld/tilt)
      +2.0  if frame size is tight (ECU/CU/MCU)
      +1.0  per non-empty sfx / vfx list
      +2.0  per high-tension keyword hit (capped at +2 regardless of count)
      +1.0  per medium-tension keyword hit (capped at +1 regardless of count)
      -1.0  per low-tension keyword hit (floored at -1 regardless of count)
      -1.0  if camera is static AND frame is wide (WS/EWS)
    then clamped to [0, 10].

    The caps prevent a shot with five "scream" words from saturating at
    10 and drowning out the rest of the reel's curve.
    """
    shot_meta = shot.get("shotMeta") or {}
    segment = shot.get("segment") or ""
    score = 3.0

    move = shot_meta.get("move")
    size = shot_meta.get("size")
    if isinstance(move, str) and move in _DYNAMIC_SHOT_MOVES:
        score += 2.0
    if isinstance(size, str) and size in _TIGHT_SHOT_SIZES:
        score += 2.0
    for key in ("sfx", "vfx"):
        val = shot_meta.get(key)
        if isinstance(val, list) and any(isinstance(v, str) and v for v in val):
            score += 1.0

    tokens = set(_tokenize_segment(segment))
    if tokens & _HIGH_TENSION_KEYWORDS:
        score += 2.0
    if tokens & _MEDIUM_TENSION_KEYWORDS:
        score += 1.0
    if tokens & _LOW_TENSION_KEYWORDS:
        score -= 1.0

    if (
        isinstance(move, str) and move == "static"
        and isinstance(size, str) and size in ("WS", "EWS")
    ):
        score -= 1.0

    return max(0.0, min(10.0, score))


@tool
def sample_tension_curve(
    shots: List[Dict[str, Any]],
) -> Dict[str, Any]:
    """Sample a 0-10 tension value per shot using the deterministic
    heuristic (camera dynamism + frame tightness + sfx/vfx presence +
    segment keyword matches). Never calls an LLM.

    Input ``shots`` is an ordered list; each entry must carry at least
    ``nodeId`` and optionally ``segment`` + ``shotMeta``. Returns the
    sample list plus a ``dips`` list flagging local drops of >=3 tension
    points across 2 consecutive shots (tension_analyst uses these to
    propose compressions).
    """
    samples: List[Dict[str, Any]] = []
    for shot in shots or []:
        node_id = str(shot.get("nodeId") or "")
        if not node_id:
            continue
        value = _heuristic_tension_for_shot(shot)
        samples.append({"nodeId": node_id, "value": value})

    dips: List[Dict[str, Any]] = []
    for i in range(1, len(samples)):
        drop = samples[i - 1]["value"] - samples[i]["value"]
        if drop >= 3.0:
            dips.append(
                {
                    "fromNodeId": samples[i - 1]["nodeId"],
                    "toNodeId": samples[i]["nodeId"],
                    "drop": round(drop, 2),
                    "severity": "high" if drop >= 5.0 else "medium",
                }
            )
    return {
        "schemaVersion": "v2",
        "samples": samples,
        "dips": dips,
    }


# Canonical beat roster per structure. Mirrors the Python constants in
# `narrative_state.py` — duplicated here to avoid a circular import
# (tools.py → narrative_state.py → state.py → would pull in langgraph
# state that the tool module doesn't need). If these drift, the tests
# in test_narrative_state.py + test_ingestion_tools.py will catch it.
_STRUCTURE_BEATS: Dict[str, List[str]] = {
    "save_the_cat": [
        "opening_image", "theme_stated", "setup", "catalyst", "debate",
        "break_into_two", "b_story", "fun_and_games", "midpoint",
        "bad_guys_close_in", "all_is_lost", "dark_night_of_the_soul",
        "break_into_three", "finale", "final_image",
    ],
    "harmon_circle": [
        "you", "need", "go", "search", "find", "take", "return", "change",
    ],
    "three_act": [
        "act1_setup", "act1_inciting_incident", "act2_rising_action",
        "act2_midpoint", "act2_crisis", "act3_climax", "act3_denouement",
    ],
    "kishotenketsu": ["ki", "sho", "ten", "ketsu"],
    "hook_first": ["hook", "promise", "proof", "payoff", "cta"],
}

# Positional hints per structure: which shot index each beat should
# land near when the reel has N shots. Values are fractions of N
# (0.0 = first shot, 1.0 = last shot). Beats not listed here get
# even distribution across the reel as fallback.
_POSITIONAL_HINTS: Dict[str, Dict[str, float]] = {
    "save_the_cat": {
        "opening_image": 0.0,
        "theme_stated": 0.05,
        "setup": 0.1,
        "catalyst": 0.15,
        "debate": 0.2,
        "break_into_two": 0.25,
        "b_story": 0.3,
        "fun_and_games": 0.4,
        "midpoint": 0.5,
        "bad_guys_close_in": 0.6,
        "all_is_lost": 0.7,
        "dark_night_of_the_soul": 0.73,
        "break_into_three": 0.75,
        "finale": 0.9,
        "final_image": 1.0,
    },
    "hook_first": {
        "hook": 0.0,
        "promise": 0.1,
        "proof": 0.5,
        "payoff": 0.85,
        "cta": 1.0,
    },
}


@tool
def detect_beat_plan(
    structure: str,
    shots: List[Dict[str, Any]],
    existing_assignments: List[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Produce a heuristic beat plan by positional hinting.

    Uses canonical beat rosters + per-structure positional hints
    (e.g. Save-the-Cat 'midpoint' near shot N*0.5, 'final_image' at
    last shot). For structures without hints (harmon_circle, three_act,
    kishotenketsu) beats are distributed evenly across the reel.

    `existing_assignments` (from a prior run) are preserved — the tool
    never proposes to overwrite an assigned slot. This matches the
    agent/producer reconciliation rule: the LLM can only fill `planned`
    slots, not flip an `assigned` one to a different node.

    Output: ``{ structure, beats, unassigned_beat_keys }`` where
    ``beats`` follows the BeatAssignment shape.
    """
    structure_key = structure if structure in _STRUCTURE_BEATS else "save_the_cat"
    beat_keys = _STRUCTURE_BEATS[structure_key]
    shot_list = [s for s in (shots or []) if isinstance(s, dict)]
    existing = {
        (a.get("beatKey") or ""): a
        for a in (existing_assignments or [])
        if isinstance(a, dict)
    }
    n = len(shot_list)
    hints = _POSITIONAL_HINTS.get(structure_key, {})

    beats: List[Dict[str, Any]] = []
    unassigned: List[str] = []
    for idx, beat_key in enumerate(beat_keys):
        prior = existing.get(beat_key)
        # Preserve any prior assignment verbatim — reconciliation rule
        # lives in narrative_state.apply_beat_assignments; this tool
        # never proposes an override.
        if prior and prior.get("status") == "assigned" and prior.get("nodeId"):
            beats.append(
                {
                    "beatKey": beat_key,
                    "expectedActNumber": prior.get("expectedActNumber"),
                    "nodeId": prior.get("nodeId"),
                    "status": "assigned",
                    "rationale": prior.get("rationale"),
                }
            )
            continue

        if n == 0:
            beats.append({"beatKey": beat_key, "status": "planned"})
            unassigned.append(beat_key)
            continue

        # Positional hint → shot index. Fall back to even distribution.
        if beat_key in hints:
            frac = hints[beat_key]
        else:
            frac = idx / max(1, len(beat_keys) - 1)
        shot_idx = min(n - 1, max(0, round(frac * (n - 1))))
        proposed_shot = shot_list[shot_idx]
        proposed_node_id = str(proposed_shot.get("nodeId") or "")
        if not proposed_node_id:
            beats.append({"beatKey": beat_key, "status": "planned"})
            unassigned.append(beat_key)
            continue
        beats.append(
            {
                "beatKey": beat_key,
                "nodeId": proposed_node_id,
                "status": "planned",  # tool output is proposal only — HITL flips to assigned
                "rationale": f"positional heuristic (shot {shot_idx + 1}/{n})",
            }
        )
    return {
        "schemaVersion": "v2",
        "structure": structure_key,
        "beats": beats,
        "unassignedBeatKeys": unassigned,
    }


@tool
def detect_beat_gaps(
    beats: List[Dict[str, Any]],
) -> Dict[str, Any]:
    """Given an existing beat plan, return which slots are unfilled.

    Slots with ``status`` in ``{planned, missing}`` are considered gaps.
    The output also groups them by severity: ``missing`` (slot was
    previously assigned but the node got deleted) is higher priority
    than ``planned`` (never filled).
    """
    gaps: List[Dict[str, Any]] = []
    planned: List[str] = []
    missing: List[str] = []
    for beat in beats or []:
        if not isinstance(beat, dict):
            continue
        status = beat.get("status")
        beat_key = beat.get("beatKey")
        if status == "missing" and beat_key:
            missing.append(str(beat_key))
            gaps.append(
                {
                    "beatKey": beat_key,
                    "severity": "high",
                    "reason": "was assigned but node no longer exists",
                }
            )
        elif status == "planned" and beat_key:
            planned.append(str(beat_key))
            gaps.append(
                {
                    "beatKey": beat_key,
                    "severity": "medium",
                    "reason": "slot never filled",
                }
            )
    return {
        "schemaVersion": "v2",
        "gapCount": len(gaps),
        "missingBeatKeys": missing,
        "plannedBeatKeys": planned,
        "gaps": gaps,
    }


def _sanitize_plan_ops(raw_ops: Any) -> List[Dict[str, Any]]:
    """Guard the plan-op payload before it reaches the HITL card.

    Drops non-dicts, unknown `op` types, and entries with empty
    `title`. Does NOT revalidate the payload — Convex's
    `commitPlanOps` runs its own shape checks at apply time. This is
    a producer-UX guard: the agent occasionally emits half-formed ops
    and we don't want them cluttering the approval card.
    """
    safe: List[Dict[str, Any]] = []
    if not isinstance(raw_ops, list):
        return safe
    for entry in raw_ops:
        if not isinstance(entry, dict):
            continue
        op = entry.get("op")
        if op not in ALLOWED_GRAPH_OPS:
            continue
        title = str(entry.get("title") or "").strip()
        if not title:
            continue
        sanitized: Dict[str, Any] = {
            "op": op,
            "title": title[:200],
        }
        op_id = entry.get("opId")
        if isinstance(op_id, str) and op_id.strip():
            sanitized["opId"] = op_id.strip()[:80]
        rationale = entry.get("rationale")
        if isinstance(rationale, str) and rationale.strip():
            sanitized["rationale"] = rationale.strip()[:400]
        node_id = entry.get("nodeId")
        if isinstance(node_id, str) and node_id.strip():
            sanitized["nodeId"] = node_id.strip()
        edge_id = entry.get("edgeId")
        if isinstance(edge_id, str) and edge_id.strip():
            sanitized["edgeId"] = edge_id.strip()
        payload = entry.get("payload")
        if isinstance(payload, dict):
            sanitized["payload"] = payload
        safe.append(sanitized)
    return safe


@tool
def request_hook_variants(
    storyboard_id: str,
    branch_id: str,
    variants: List[HookVariantInput],
    rationale: str,
) -> Dict[str, Any]:
    """Requests human approval to commit N cold-open variants as
    narrative-git branches. Interrupt target.

    Each variant is committed to its own branch (``variant/hook-<id>``)
    off the current HEAD. The producer reviews them side-by-side in
    the Variant Compare tab (``TimelineTheaterPanel``), picks one, and
    that branch gets promoted to primary via ``applyMergePolicy``.
    Siblings are archived but survive in the commit history.

    Each ``variants`` entry: ``{ variantId, rationale, planOps,
    expectedRetention?, branchName? }``. The tool drops hallucinated
    op types + empty planOps so the approval card only shows
    committable variants.
    """
    safe_variants: List[Dict[str, Any]] = []
    for raw_input in variants or []:
        raw = _coerce_input(raw_input)
        variant_id = str(raw.get("variantId") or "").strip().lower()
        if not variant_id:
            continue
        # Branch names follow `variant/hook-<id>` so the Variant
        # Compare picker can cheaply filter by prefix. `variantId` is
        # sanitized to alphanumerics + dashes to keep it URL-safe.
        safe_variant_id = "".join(
            c if (c.isalnum() or c in "-_") else "-" for c in variant_id
        )[:40] or "unnamed"
        plan_ops = _sanitize_plan_ops(raw.get("planOps"))
        if len(plan_ops) == 0:
            continue
        variant_rationale = " ".join(
            str(raw.get("rationale") or "").split()
        )[:800]
        expected_retention = " ".join(
            str(raw.get("expectedRetention") or "").split()
        )[:300]
        branch_name = str(
            raw.get("branchName") or f"Hook variant {safe_variant_id}"
        ).strip()[:100]
        safe_variants.append(
            {
                "variantId": safe_variant_id,
                "rationale": variant_rationale,
                "expectedRetention": expected_retention,
                "branchName": branch_name,
                "planOps": plan_ops,
            }
        )
    return {
        "schemaVersion": "v2",
        "action": "request_hook_variants",
        "status": "waiting_for_human",
        "input": {
            "storyboardId": storyboard_id,
            "parentBranchId": branch_id or "main",
            "variantCount": len(safe_variants),
            "variants": safe_variants,
            "rationale": " ".join(rationale.split())[:1200],
        },
    }


@tool
def request_structural_remix(
    storyboard_id: str,
    branch_id: str,
    target_structure: str,
    variants: List[StructuralRemixVariantInput],
    rationale: str,
) -> Dict[str, Any]:
    """Requests human approval to commit N structural-remix variants
    as narrative-git branches. Interrupt target.

    A remix variant is a complete alternate beat ordering — typically
    ``in-medias-res`` (open on what was act 2A's midpoint),
    ``chrono-reorder`` (swap flashbacks to chronological), or
    ``parallel-intercut`` (interleave two currently-serial arcs).
    Each variant's ``planOps`` reorder nodes + rewire edges; the
    deterministic ``isPrimary``/``order`` recalc happens server-side
    so the LLM never invents edge ordering (risk #4 in the M9 plan).

    Branches land at ``variant/remix-<target_structure>-<variantId>``.
    Producer picks one via Variant Compare → ``applyMergePolicy``
    promotes it.
    """
    structure_key = (
        target_structure
        if target_structure in _STRUCTURE_BEATS
        else "save_the_cat"
    )
    safe_variants: List[Dict[str, Any]] = []
    for raw_input in variants or []:
        raw = _coerce_input(raw_input)
        variant_id = str(raw.get("variantId") or "").strip().lower()
        if not variant_id:
            continue
        safe_variant_id = "".join(
            c if (c.isalnum() or c in "-_") else "-" for c in variant_id
        )[:40] or "unnamed"
        plan_ops = _sanitize_plan_ops(raw.get("planOps"))
        if len(plan_ops) == 0:
            continue
        variant_rationale = " ".join(
            str(raw.get("rationale") or "").split()
        )[:800]
        branch_name = str(
            raw.get("branchName")
            or f"Remix {structure_key.replace('_', ' ')} {safe_variant_id}"
        ).strip()[:100]
        # Remix variants sometimes carry a strategy hint (in_medias_res /
        # chrono_reorder / parallel_intercut); surface it for the UI
        # without validating against a rigid enum so new strategies
        # don't require a schema change.
        strategy = str(raw.get("strategy") or "").strip()[:60]
        safe_variants.append(
            {
                "variantId": safe_variant_id,
                "rationale": variant_rationale,
                "strategy": strategy,
                "branchName": branch_name,
                "planOps": plan_ops,
            }
        )
    return {
        "schemaVersion": "v2",
        "action": "request_structural_remix",
        "status": "waiting_for_human",
        "input": {
            "storyboardId": storyboard_id,
            "parentBranchId": branch_id or "main",
            "targetStructure": structure_key,
            "variantCount": len(safe_variants),
            "variants": safe_variants,
            "rationale": " ".join(rationale.split())[:1200],
        },
    }


@tool
def request_beat_assignment(
    storyboard_id: str,
    branch_id: str,
    structure: str,
    assignments: List[BeatAssignmentInput],
    rationale: str,
    override_existing: bool = False,
) -> Dict[str, Any]:
    """Requests human approval to persist a beat plan. Interrupt target.

    Producer sees a list of (nodeId → beatKey) proposals and can
    approve wholesale, edit (prune to subset), or reject. On approve,
    the bridge patches each shot node's ``beatType`` + ``actNumber``
    via ``setNodeNarrativeFields`` and replaces the ``narrativeBeats``
    row via ``upsertBeatPlan``.

    ``override_existing`` is required (and defaults false) when any
    assignment targets a slot that is already ``assigned``. This
    implements the reconciliation rule from the plan — agent
    proposals cannot silently clobber producer manual edits.

    Each ``assignments`` entry: ``{ nodeId, beatKey, actNumber?, rationale? }``.
    """
    structure_key = (
        structure
        if structure in _STRUCTURE_BEATS
        else "save_the_cat"
    )
    safe_assignments: List[Dict[str, Any]] = []
    for raw_input in assignments or []:
        raw = _coerce_input(raw_input)
        node_id = str(raw.get("nodeId") or "").strip()
        beat_key = str(raw.get("beatKey") or "").strip()
        if not node_id or not beat_key:
            continue
        if beat_key not in _STRUCTURE_BEATS[structure_key]:
            # Drop agent hallucinations — unknown beats don't reach
            # the producer's approval card.
            continue
        entry: Dict[str, Any] = {"nodeId": node_id, "beatKey": beat_key}
        act = raw.get("actNumber")
        if isinstance(act, (int, float)):
            entry["actNumber"] = max(1, min(5, int(act)))
        raw_rationale = raw.get("rationale")
        if isinstance(raw_rationale, str) and raw_rationale.strip():
            entry["rationale"] = " ".join(raw_rationale.split())[:400]
        safe_assignments.append(entry)

    return {
        "schemaVersion": "v2",
        "action": "request_beat_assignment",
        "status": "waiting_for_human",
        "input": {
            "storyboardId": storyboard_id,
            "branchId": branch_id or "main",
            "structure": structure_key,
            "assignments": safe_assignments,
            "assignmentCount": len(safe_assignments),
            "overrideExisting": bool(override_existing),
            "rationale": " ".join(rationale.split())[:1200],
        },
    }


# M9 Phase 4 — transition vocabulary.
#
# The top row (match_cut / j_cut / l_cut / cross_cut_accelerate /
# hard_cut / time_jump / smash_cut / iris / whip_pan / dissolve)
# reflects the short list transitioning from Walter Murch's Rule of
# Six — each one is either a deliberate cutting rhythm or a motif-
# carrying transition. Unknown intents from the LLM fall back to
# `hard_cut` (the least opinionated default) so the approval card
# never surfaces a nonsense intent string.
_KNOWN_TRANSITION_INTENTS = {
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
}


@tool
def request_transition_proposal(
    storyboard_id: str,
    branch_id: str,
    source_node_id: str,
    target_node_id: str,
    proposals: List[TransitionProposalInput],
    rationale: str,
) -> Dict[str, Any]:
    """Requests human approval to set a transition intent between two
    adjacent nodes. Interrupt target.

    The ``transition_maestro`` subagent emits 2-4 ranked proposals for
    the producer to pick from. Each proposal maps to a cutting idiom
    (match-cut, J-cut, L-cut, cross-cut-accelerate, etc.). On approve,
    the bridge locates the edge between ``source_node_id`` and
    ``target_node_id`` and patches its ``transitionIntent`` via
    ``setEdgeTransitionIntent``; any accompanying ``planOps`` (e.g.
    a motif plant to support a match cut) commit as a regular
    ``commitPlanOps``.

    Each ``proposals`` entry:
      ``{ intent, rationale, sharedElement?, planOps?, rank? }``

    where ``sharedElement`` is the concrete visual / aural hook the cut
    relies on (e.g. \"red umbrella\" for a match cut, \"doorbell\" for
    a J-cut). ``planOps`` are optional — a pure ``transitionIntent``
    patch is fine when no graph edit is needed.
    """
    safe_source = str(source_node_id or "").strip()
    safe_target = str(target_node_id or "").strip()
    safe_proposals: List[Dict[str, Any]] = []
    for raw_input in proposals or []:
        raw = _coerce_input(raw_input)
        intent = str(raw.get("intent") or "").strip().lower()
        if not intent:
            continue
        # Unknown intents fall through to hard_cut; preserving the
        # original intent in `rawIntent` lets the bridge display what
        # the LLM asked for even when the applied value is normalized.
        applied_intent = (
            intent if intent in _KNOWN_TRANSITION_INTENTS else "hard_cut"
        )
        entry: Dict[str, Any] = {
            "intent": applied_intent,
            "rawIntent": intent,
        }
        prop_rationale = str(raw.get("rationale") or "").strip()
        if prop_rationale:
            entry["rationale"] = " ".join(prop_rationale.split())[:400]
        shared = str(raw.get("sharedElement") or "").strip()
        if shared:
            entry["sharedElement"] = shared[:200]
        plan_ops = _sanitize_plan_ops(raw.get("planOps"))
        if plan_ops:
            entry["planOps"] = plan_ops
        rank = raw.get("rank")
        if isinstance(rank, (int, float)):
            entry["rank"] = max(1, min(10, int(rank)))
        safe_proposals.append(entry)

    # Sort by rank ascending so the producer sees the recommended
    # proposal first. Ties keep input order (stable sort).
    safe_proposals.sort(key=lambda p: p.get("rank", 99))

    return {
        "schemaVersion": "v2",
        "action": "request_transition_proposal",
        "status": "waiting_for_human",
        "input": {
            "storyboardId": storyboard_id,
            "branchId": branch_id or "main",
            "sourceNodeId": safe_source,
            "targetNodeId": safe_target,
            "proposals": safe_proposals,
            "proposalCount": len(safe_proposals),
            "rationale": " ".join(rationale.split())[:1200],
        },
    }


@tool
def request_motif_plant(
    storyboard_id: str,
    branch_id: str,
    motif_key: str,
    target_node_id: str,
    plan_ops: List[Dict[str, Any]],
    rationale: str,
    visual_vocabulary: str = "",
    description: str = "",
    source_node_ids: List[str] = None,  # type: ignore[assignment]
    payoff_node_ids: List[str] = None,  # type: ignore[assignment]
) -> Dict[str, Any]:
    """Requests human approval to plant (or land) a motif at a node.
    Interrupt target.

    The ``motif_tracker`` subagent fires this for two related use
    cases:

    * **Plant**: motif has ``sourceNodeIds`` and the target node is
      one of them (or will be after the plan ops apply). Landed
      status stays ``planted`` if no payoff yet, or transitions to
      ``landed`` if the target node belongs to ``payoffNodeIds``.
    * **Callback**: motif has a setup but no payoff; the agent
      proposes the payoff node, which flips status to ``landed`` on
      approve.

    On approve, the bridge commits the accompanying ``planOps`` via
    ``commitPlanOps``, patches the target node's ``motifIds`` via
    ``setNodeNarrativeFields`` (append, never overwrite), and upserts
    the motif row via ``upsertMotif``. The Convex mutation re-derives
    ``landedStatus`` from sources/payoffs presence.
    """
    safe_key = str(motif_key or "").strip().lower()
    # Motif keys go into URLs + DOM attributes; keep them alphanumeric
    # + dashes/underscores so the MotifMapPanel can render them as
    # stable anchor ids without escaping.
    safe_key = "".join(
        c if (c.isalnum() or c in "-_") else "-" for c in safe_key
    )[:60]
    if not safe_key:
        safe_key = "unnamed-motif"
    safe_target = str(target_node_id or "").strip()
    safe_plan_ops = _sanitize_plan_ops(plan_ops)
    safe_sources: List[str] = []
    for s in (source_node_ids or []):
        if isinstance(s, str) and s.strip():
            safe_sources.append(s.strip())
    safe_payoffs: List[str] = []
    for p in (payoff_node_ids or []):
        if isinstance(p, str) and p.strip():
            safe_payoffs.append(p.strip())

    return {
        "schemaVersion": "v2",
        "action": "request_motif_plant",
        "status": "waiting_for_human",
        "input": {
            "storyboardId": storyboard_id,
            "branchId": branch_id or "main",
            "motifKey": safe_key,
            "targetNodeId": safe_target,
            "description": " ".join(description.split())[:400],
            "visualVocabulary": " ".join(visual_vocabulary.split())[:400],
            "sourceNodeIds": safe_sources,
            "payoffNodeIds": safe_payoffs,
            "planOps": safe_plan_ops,
            "rationale": " ".join(rationale.split())[:1200],
        },
    }


@tool
def detect_motif_gaps(
    motifs: List[Dict[str, Any]],
) -> Dict[str, Any]:
    """Classify motifs by landed status.

    Given the current motif registry (list of ``MotifEntry`` dicts),
    returns::

        {
          \"unlanded\": [...motifKeys with sources but no payoffs...],
          \"orphaned\": [...motifKeys with payoffs but no sources...],
          \"unplanted\": [...motifKeys with neither sources nor payoffs...],
          \"landed\": [...motifKeys that have both...]
        }

    Deterministic, read-only — the ``motif_tracker`` subagent calls
    this first to decide which motifs need a plant/callback proposal.
    """
    buckets = {
        "unlanded": [],
        "orphaned": [],
        "unplanted": [],
        "landed": [],
    }
    for raw in motifs or []:
        if not isinstance(raw, dict):
            continue
        key = str(raw.get("motifKey") or raw.get("key") or "").strip()
        if not key:
            continue
        sources = raw.get("sourceNodeIds") or []
        payoffs = raw.get("payoffNodeIds") or []
        has_sources = isinstance(sources, list) and len(sources) > 0
        has_payoffs = isinstance(payoffs, list) and len(payoffs) > 0
        if has_sources and has_payoffs:
            buckets["landed"].append(key)
        elif has_sources:
            buckets["unlanded"].append(key)
        elif has_payoffs:
            buckets["orphaned"].append(key)
        else:
            buckets["unplanted"].append(key)
    return buckets


ALL_TOOLS = [
    planner_propose_graph_patch,
    planner_propose_media_prompt,
    simulate_execution_plan,
    build_autonomous_dailies_batch,
    simulate_story_playthrough,
    continuity_critic,
    producer_guard,
    recommend_ingestion_path,
    repair_plan,
    approve_graph_patch,
    approve_media_prompt,
    approve_execution_plan,
    approve_batch_ops,
    preview_simulation_critic_plan,
    approve_dailies_batch,
    approve_merge_policy,
    approve_repair_plan,
    request_ingestion_run,
    request_generate_shot_batch,
    request_generate_shot_video_batch,
    request_generate_shot_audio_batch,
    request_generate_shot_sfx_batch,
    request_generate_score,
    request_dailies_critic_review,
    request_export_reel,
    request_assign_voice_cast,
    select_agent_team,
    create_agent_team,
    update_agent_team_member,
    publish_agent_team_revision,
    generate_team_from_prompt,
    # M9 Phase 2 — narrative analysis + beat HITL
    sample_tension_curve,
    detect_beat_plan,
    detect_beat_gaps,
    request_beat_assignment,
    # M9 Phase 3 — variant generation HITL
    request_hook_variants,
    request_structural_remix,
    # M9 Phase 4 — transitions + motifs
    request_transition_proposal,
    request_motif_plant,
    detect_motif_gaps,
]

# Supervisor-only core: the minimum tools the top-level orchestrator needs to
# call directly. Every other tool is specialized work that belongs inside a
# subagent and must be reached via `task` delegation. Narrowing the supervisor
# here is the "allowlist at init" defense — even if the runtime allowlist is
# misconfigured, the supervisor cannot directly invoke mutation-adjacent tools
# (graph_patch / media_prompt / team_* / etc.) because they are never added to
# its tool set in the first place.
#
# `select_agent_team` stays on the supervisor because team switching is an
# orchestration-level authority, not specialized work. All other team.manage
# tools (create/update/publish/generate_from_prompt) are gated behind the
# `team_architect` subagent.
SUPERVISOR_CORE_TOOLS = [
    producer_guard,
    continuity_critic,
    recommend_ingestion_path,
    approve_graph_patch,
    approve_media_prompt,
    approve_execution_plan,
    approve_batch_ops,
    preview_simulation_critic_plan,
    approve_dailies_batch,
    approve_merge_policy,
    approve_repair_plan,
    request_ingestion_run,
    request_generate_shot_batch,
    request_generate_shot_video_batch,
    request_generate_shot_audio_batch,
    request_generate_shot_sfx_batch,
    request_generate_score,
    request_dailies_critic_review,
    request_export_reel,
    request_assign_voice_cast,
    select_agent_team,
    # M9 Phase 2 — beat assignment HITL lives on the supervisor so the
    # narrative_architect (supervisor-adjacent) can fire it directly.
    # Read-only analysis tools (sample_tension_curve, detect_beat_plan,
    # detect_beat_gaps) belong to beat_analyst + tension_analyst
    # subagents only.
    request_beat_assignment,
    # M9 Phase 3 — variant generation HITL. Both live on the supervisor
    # so narrative_architect can fan them out directly; the specialist
    # subagents (hook_designer, structural_variant_generator) draft the
    # planOps payloads then hand the tool call back up.
    request_hook_variants,
    request_structural_remix,
    # M9 Phase 4 — transitions + motifs HITL on the supervisor so the
    # narrative_architect can route proposals from transition_maestro
    # + motif_tracker without extra delegation hops.
    request_transition_proposal,
    request_motif_plant,
]

# Safe default scope applied when the runtime `effective_tool_scope` is unset
# or empty. Previously an empty allowlist was interpreted as "allow
# everything", which collapsed the policy posture. The default explicitly
# excludes `team.manage` so team mutations always require an explicit opt-in
# (caller passes a list containing "team.manage" or "*"). Every other
# capability is enabled by default so existing storyboards keep working.
DEFAULT_RUNTIME_ALLOWLIST: List[str] = [
    "graph.patch",
    "media.prompt",
    "execution.plan",
    "simulation.critic",
    "continuity.check",
    "dailies.batch",
    "execution.guard",
    "repair.plan",
    "branch.merge",
    "ingestion.run",
    "shot_batch.run",
    "shot_video_batch.run",
    "shot_audio_batch.run",
    "shot_sfx_batch.run",
    "reel_score.run",
    "dailies.critic_review",
    "reel_export.run",
    "voice_cast.assign",
    # M9 Phase 2 — narrative analysis + beat assignment
    "narrative.analyze",
    "narrative.beats",
    # M9 Phase 3 — variant generation (hook + structural remix)
    "narrative.hook_variants",
    "narrative.remix",
    # M9 Phase 4 — transitions + motifs
    "narrative.transition",
    "narrative.motif",
]

TOOL_POLICY_TOKENS: Dict[str, str] = {
    planner_propose_graph_patch.name: "graph.patch",
    planner_propose_media_prompt.name: "media.prompt",
    simulate_execution_plan.name: "execution.plan",
    build_autonomous_dailies_batch.name: "dailies.batch",
    simulate_story_playthrough.name: "simulation.critic",
    continuity_critic.name: "continuity.check",
    producer_guard.name: "execution.guard",
    repair_plan.name: "repair.plan",
    approve_graph_patch.name: "graph.patch",
    approve_media_prompt.name: "media.prompt",
    approve_execution_plan.name: "execution.plan",
    approve_batch_ops.name: "execution.plan",
    preview_simulation_critic_plan.name: "simulation.critic",
    approve_dailies_batch.name: "dailies.batch",
    approve_merge_policy.name: "branch.merge",
    approve_repair_plan.name: "repair.plan",
    recommend_ingestion_path.name: "ingestion.run",
    request_ingestion_run.name: "ingestion.run",
    request_generate_shot_batch.name: "shot_batch.run",
    request_generate_shot_video_batch.name: "shot_video_batch.run",
    request_generate_shot_audio_batch.name: "shot_audio_batch.run",
    request_generate_shot_sfx_batch.name: "shot_sfx_batch.run",
    request_generate_score.name: "reel_score.run",
    request_dailies_critic_review.name: "dailies.critic_review",
    request_export_reel.name: "reel_export.run",
    request_assign_voice_cast.name: "voice_cast.assign",
    # M9 Phase 2
    sample_tension_curve.name: "narrative.analyze",
    detect_beat_plan.name: "narrative.analyze",
    detect_beat_gaps.name: "narrative.analyze",
    request_beat_assignment.name: "narrative.beats",
    # M9 Phase 3
    request_hook_variants.name: "narrative.hook_variants",
    request_structural_remix.name: "narrative.remix",
    # M9 Phase 4 — `detect_motif_gaps` is read-only analysis so it
    # inherits `narrative.analyze`; the HITL tools get their own
    # tokens so operators can lock them down independently.
    request_transition_proposal.name: "narrative.transition",
    request_motif_plant.name: "narrative.motif",
    detect_motif_gaps.name: "narrative.analyze",
    select_agent_team.name: "team.manage",
    create_agent_team.name: "team.manage",
    update_agent_team_member.name: "team.manage",
    publish_agent_team_revision.name: "team.manage",
    generate_team_from_prompt.name: "team.manage",
}


def is_tool_allowed(allowlist: List[str], token: str) -> bool:
    """Checks whether ``token`` is permitted by the runtime allowlist.

    Semantics:
      * Empty allowlist → apply ``DEFAULT_RUNTIME_ALLOWLIST`` (deny-by-default
        for tokens not in the default, notably ``team.manage``).
      * ``["*"]`` → allow everything (explicit open-scope, e.g. local dev).
      * Otherwise → token must appear in the allowlist verbatim. The legacy
        prefix expansion for ``media.`` still applies so a caller passing only
        ``media.prompt`` also grants sibling ``media.*`` tokens.
    """
    effective = allowlist if len(allowlist) > 0 else DEFAULT_RUNTIME_ALLOWLIST
    if "*" in effective:
        return True
    if token in effective:
        return True
    if token.startswith("media.") and "media.prompt" in effective:
        return True
    return False


def filter_tools_by_allowlist(tools: List[Any], allowlist: List[str]) -> List[Any]:
    allowed: List[Any] = []
    for tool in tools:
        tool_name = str(getattr(tool, "name", ""))
        token = TOOL_POLICY_TOKENS.get(tool_name)
        if token is None:
            # Tools without a policy token can't be governed — drop them so
            # nothing un-audited slips into an init-time allowlist.
            continue
        if is_tool_allowed(allowlist, token):
            allowed.append(tool)
    return allowed
