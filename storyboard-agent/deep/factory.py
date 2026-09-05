"""
Factory for V2 deep-agent graph creation.
"""

from __future__ import annotations

import atexit
import logging
import os
import threading
from typing import Any, Dict, Optional, Set, List

from langgraph.checkpoint.memory import MemorySaver
from langgraph.store.memory import InMemoryStore


_logger = logging.getLogger(__name__)

# Checkpointer is a process-wide singleton so the connection pool is reused
# across graph invocations instead of being rebuilt per thread.
_checkpointer_lock = threading.Lock()
_checkpointer_singleton: Optional[Any] = None
# Separate handle to the psycopg pool so `close_checkpointer()` (called on
# process exit) can release Postgres connections cleanly. MemorySaver has
# nothing to close, so we only track the pool when PostgresSaver is active.
_checkpointer_pool: Optional[Any] = None

from deepagents import create_deep_agent

from .subagents import get_subagents
from .tools import (
    SUPERVISOR_CORE_TOOLS,
    approve_batch_ops,
    approve_dailies_batch,
    approve_execution_plan,
    approve_graph_patch,
    approve_media_prompt,
    approve_merge_policy,
    approve_repair_plan,
    create_agent_team,
    filter_tools_by_allowlist,
    generate_team_from_prompt,
    preview_simulation_critic_plan,
    publish_agent_team_revision,
    request_assign_voice_cast,
    request_export_reel,
    request_generate_shot_batch,
    request_generate_shot_video_batch,
    request_generate_shot_audio_batch,
    request_generate_shot_sfx_batch,
    request_generate_score,
    request_dailies_critic_review,
    request_beat_assignment,
    request_hook_variants,
    request_structural_remix,
    request_transition_proposal,
    request_motif_plant,
    request_ingestion_run,
    select_agent_team,
    update_agent_team_member,
)


def _build_checkpointer() -> Any:
    """
    Resolves the checkpointer used by the storyboard deep-agent.

    When ``STORYBOARD_CHECKPOINT_POSTGRES_URI`` is set, a ``PostgresSaver`` is
    created over a ``psycopg_pool.ConnectionPool`` and tables are set up on
    first use. In-flight approval workflows survive process restarts.

    When the env var is unset, the driver is missing, or connection setup
    fails, we fall back to ``MemorySaver`` and emit a warning — in-flight
    approvals are ephemeral in that case.

    Env:
      STORYBOARD_CHECKPOINT_POSTGRES_URI     (required to enable persistence)
      STORYBOARD_CHECKPOINT_POSTGRES_MAX_CONN (optional, default 10)
    """
    uri = os.getenv("STORYBOARD_CHECKPOINT_POSTGRES_URI", "").strip()
    if not uri:
        _logger.info(
            "STORYBOARD_CHECKPOINT_POSTGRES_URI not set; using MemorySaver. "
            "In-flight approval workflows will be lost on process restart."
        )
        return MemorySaver()

    try:
        from langgraph.checkpoint.postgres import PostgresSaver
        from psycopg_pool import ConnectionPool
    except ImportError as exc:
        _logger.warning(
            "PostgresSaver/psycopg_pool not importable (%s); falling back to "
            "MemorySaver. In-flight approvals will not persist.",
            exc,
        )
        return MemorySaver()

    try:
        max_conn_env = os.getenv("STORYBOARD_CHECKPOINT_POSTGRES_MAX_CONN", "10")
        try:
            max_conn = max(1, int(max_conn_env))
        except ValueError:
            max_conn = 10

        pool = ConnectionPool(
            conninfo=uri,
            max_size=max_conn,
            # 10s cap on waiting for an available connection — prevents a
            # misconfigured URI from hanging graph startup for the psycopg
            # default (30s).
            timeout=10,
            kwargs={
                "autocommit": True,
                "prepare_threshold": 0,
                # Short libpq-level connect timeout so DNS/auth failures don't
                # chew through the pool timeout on every attempt.
                "connect_timeout": 5,
            },
            open=True,
        )
        saver = PostgresSaver(pool)
        saver.setup()
        # Stash the pool so the atexit hook can close it; the saver itself
        # doesn't expose .close() so we hold the handle separately.
        global _checkpointer_pool
        _checkpointer_pool = pool
        _logger.info(
            "PostgresSaver checkpointer initialized (pool max_size=%d).", max_conn
        )
        return saver
    except Exception as exc:  # psycopg connection/auth/DNS/etc.
        _logger.exception(
            "PostgresSaver initialization failed (%s); falling back to "
            "MemorySaver. In-flight approvals will not persist.",
            exc,
        )
        return MemorySaver()


def close_checkpointer() -> None:
    """Closes the Postgres pool if one is open. Called via an atexit hook
    so langgraph-dev / production workers release connections on shutdown
    instead of leaving the pool in an orphaned state.

    Safe to call multiple times — the pool's `.close()` is idempotent.
    Safe to call when the checkpointer is in MemorySaver mode (no-op).
    """
    global _checkpointer_pool
    pool = _checkpointer_pool
    if pool is None:
        return
    _checkpointer_pool = None
    try:
        pool.close()
    except Exception as exc:  # best-effort — shutting down anyway
        _logger.warning("checkpointer pool close failed: %s", exc)


# Register the shutdown hook once at import time; idempotent because
# atexit.register is a no-op if the same callable is registered twice
# (well, it re-registers but close_checkpointer is itself idempotent).
atexit.register(close_checkpointer)


def _resolve_checkpointer() -> Any:
    """Returns the process-wide checkpointer singleton."""
    global _checkpointer_singleton
    if _checkpointer_singleton is not None:
        return _checkpointer_singleton
    with _checkpointer_lock:
        if _checkpointer_singleton is None:
            _checkpointer_singleton = _build_checkpointer()
    return _checkpointer_singleton


def _build_backend() -> Optional[Any]:
    """
    Previously composed a ``CompositeBackend`` of a ``StateBackend`` for identity
    packs and a ``StoreBackend`` for workspace memories. The constructors were
    written against an older ``deepagents`` API — the installed version
    (``deepagents==0.4.1``) requires a ``ToolRuntime`` at instantiation and
    ``CompositeBackend`` now takes ``(default, routes: dict)``, so the old call
    shape raises ``TypeError`` and the graph can't even be built from the CLI.

    Returning ``None`` lets ``create_deep_agent`` fall back to its default
    backend, which is the behavior the live langgraph-dev server is already
    relying on (``agent.py`` imports cleanly because it doesn't exercise this
    path). If identity/workspace routing is needed again, re-introduce a
    factory ``(runtime) -> BackendProtocol`` and pass it as ``backend=``.
    """
    return None


def _interrupt_config() -> Dict[str, Dict[str, Any]]:
    return {
        approve_graph_patch.name: {"allowed_decisions": ["approve", "edit", "reject"]},
        approve_media_prompt.name: {"allowed_decisions": ["approve", "edit", "reject"]},
        approve_execution_plan.name: {"allowed_decisions": ["approve", "edit", "reject"]},
        approve_batch_ops.name: {"allowed_decisions": ["approve", "edit", "reject"]},
        preview_simulation_critic_plan.name: {"allowed_decisions": ["approve", "reject"]},
        approve_dailies_batch.name: {"allowed_decisions": ["approve", "edit", "reject"]},
        approve_merge_policy.name: {"allowed_decisions": ["approve", "reject"]},
        approve_repair_plan.name: {"allowed_decisions": ["approve", "edit", "reject"]},
        request_ingestion_run.name: {"allowed_decisions": ["approve", "edit", "reject"]},
        request_generate_shot_batch.name: {"allowed_decisions": ["approve", "edit", "reject"]},
        request_generate_shot_video_batch.name: {"allowed_decisions": ["approve", "edit", "reject"]},
        request_generate_shot_audio_batch.name: {"allowed_decisions": ["approve", "edit", "reject"]},
        request_generate_shot_sfx_batch.name: {"allowed_decisions": ["approve", "edit", "reject"]},
        request_generate_score.name: {"allowed_decisions": ["approve", "edit", "reject"]},
        request_dailies_critic_review.name: {"allowed_decisions": ["approve", "reject"]},
        # M9 Phase 2
        request_beat_assignment.name: {"allowed_decisions": ["approve", "edit", "reject"]},
        # M9 Phase 3 — variant generation. Producer can approve the full
        # variant set, edit (prune to a subset), or reject. Each approved
        # variant becomes its own narrative-git branch; pick happens in a
        # follow-up approve_merge_policy card once the producer has
        # compared them side-by-side in Variant Compare.
        request_hook_variants.name: {"allowed_decisions": ["approve", "edit", "reject"]},
        request_structural_remix.name: {"allowed_decisions": ["approve", "edit", "reject"]},
        # M9 Phase 4 — transitions + motifs. Transition proposals come in
        # ranked sets (producer picks one); motif plants are single-
        # target commits (producer approves or edits the target node).
        request_transition_proposal.name: {"allowed_decisions": ["approve", "edit", "reject"]},
        request_motif_plant.name: {"allowed_decisions": ["approve", "edit", "reject"]},
        request_export_reel.name: {"allowed_decisions": ["approve", "reject"]},
        request_assign_voice_cast.name: {"allowed_decisions": ["approve", "edit", "reject"]},
        select_agent_team.name: {"allowed_decisions": ["approve", "reject"]},
        create_agent_team.name: {"allowed_decisions": ["approve", "edit", "reject"]},
        update_agent_team_member.name: {"allowed_decisions": ["approve", "edit", "reject"]},
        publish_agent_team_revision.name: {"allowed_decisions": ["approve", "reject"]},
        generate_team_from_prompt.name: {"allowed_decisions": ["approve", "edit", "reject"]},
    }


def create_storyboard_deep_agent_graph(
    enabled_member_names: Optional[Set[str]] = None,
    tool_allowlist: Optional[List[str]] = None,
):
    model_name = os.getenv("STORYBOARD_AGENT_MODEL", "openai:gpt-4.1-mini")
    backend = _build_backend()
    checkpointer = _resolve_checkpointer()
    # M9 — `store` is the process-wide working-memory cache used by
    # the narrative_architect + beat_analyst subagents to avoid
    # re-deserializing `reel_narrative_state` across turns inside the
    # same graph invocation. The Convex `reelNarrativeState` table is
    # the source of truth; `store` is just a short-TTL per-graph cache.
    # Previously constructed and then abandoned — wired into
    # `create_deep_agent` via the `store=` kwarg below so subagents
    # can read/write via the DeepAgents store protocol.
    store = InMemoryStore()
    allowlist = tool_allowlist or []

    # The supervisor is initialized with a narrow, orchestration-focused tool
    # set (`SUPERVISOR_CORE_TOOLS`), then further intersected with the runtime
    # allowlist. This is the init-time allowlist posture: specialized work
    # (graph patches, media prompts, team mutations, dailies batches, repair
    # plans) is NEVER directly callable by the supervisor — it must delegate
    # via `task()` to the appropriate subagent. Previously the supervisor
    # received ALL_TOOLS by default, which let it bypass the subagent
    # delegation pattern entirely.
    filtered_tools = filter_tools_by_allowlist(SUPERVISOR_CORE_TOOLS, allowlist)
    if len(filtered_tools) == 0:
        # If the runtime allowlist is so restrictive that zero supervisor core
        # tools survive, fall back to producer_guard alone so the graph can
        # still be built and emit a `blocked` payload via the router's policy
        # guard. An empty tools list would crash create_deep_agent.
        from .tools import producer_guard as _producer_guard
        filtered_tools = [_producer_guard]

    subagents = get_subagents(
        enabled_member_names=enabled_member_names,
        tool_allowlist=allowlist,
    )

    # One INFO-level line capturing the effective init-time scope. This is the
    # audit trail for "what could the agent actually do this invocation".
    effective_scope = allowlist if len(allowlist) > 0 else ["<default>"]
    supervisor_tool_names = [str(getattr(t, "name", "<unknown>")) for t in filtered_tools]
    subagent_summaries = [
        (
            str(definition.get("name", "<unknown>")),
            [str(getattr(t, "name", "<unknown>")) for t in definition.get("tools", [])],
        )
        for definition in subagents
    ]
    _logger.info(
        "Storyboard deep agent init | members=%s | allowlist=%s | supervisor_tools=%s | subagents=%s",
        sorted(enabled_member_names) if enabled_member_names else "<all>",
        effective_scope,
        supervisor_tool_names,
        subagent_summaries,
    )

    kwargs: Dict[str, Any] = {
        "model": model_name,
        "tools": filtered_tools,
        "subagents": subagents,
        "checkpointer": checkpointer,
        "store": store,
        "interrupt_on": _interrupt_config(),
        "middleware": [],
        "system_prompt": (
            "You are Storyboard Supervisor V2. Use write_todos to decompose tasks, delegate specialized work "
            "with task to subagents, and never apply mutations without approval tools. "
            "Your direct tool set is intentionally narrow (orchestration + HITL approval gates); "
            "planning, media prompting, team management, dailies, and repair work MUST be delegated to the "
            "corresponding subagent via `task`. "
            # M9.5.1 follow-up: explicit ingestion-routing clause. Without
            # this, gpt-4.1-mini decomposed open-ended onboarding messages
            # ('I want to make a film about X. Help me get started.') into
            # general-purpose / planner / narrative_architect tasks instead
            # of recognising them as ingestion intents. The fix routes the
            # "no storyboard yet" cohort to ingestion_coordinator so they
            # land in the From Idea / From Screenplay / From Novel dialog
            # rather than getting plot-developed without a project.
            "INGESTION ROUTING (PRIORITY): if the producer's message describes a NEW project that "
            "doesn't have a storyboard yet — phrases like 'I want to make a film about', "
            "'help me get started', 'new project', 'pitch', 'idea', a pasted screenplay or novel "
            "excerpt, or any message arriving when state.storyboard_id is empty — your FIRST "
            "delegation MUST be to the ingestion_coordinator subagent (or a direct "
            "recommend_ingestion_path call) to classify the request as screenplay / idea / novel "
            "and emit the corresponding request_ingestion_run HITL. Do NOT decompose into "
            "general-purpose plot/character/beat work before the producer has confirmed the "
            "ingestion path and a storyboard exists. "
            "For autonomous dailies, prefer building batch plans with explicit sourceId and taskType. "
            "For simulation critic loops, emit repair batches with deterministic risk metadata. "
            "If team_config/runtime_policy/effective_tool_scope are present in state, treat them as hard constraints "
            "for planning and include policy trace evidence in outputs. "
            "M9 narrative refinement: if reel_narrative_state is present in state, "
            "treat it as authoritative for beat assignments, motif chains, and tension samples. "
            "Never silently overwrite an assigned beat — route reassignments through "
            "request_beat_assignment with producer approval. "
            "When a producer asks for 'variants' (hooks, cold opens, remixes), delegate to "
            "the hook_designer or structural_variant_generator subagent and commit each "
            "variant as its own narrative-git branch via request_hook_variants or "
            "request_structural_remix — side-by-side variant comparison is the product's "
            "differentiator. "
            "When a producer asks to propose a transition between two nodes, delegate "
            "to the transition_maestro subagent; each proposal set is emitted via "
            "request_transition_proposal so the producer can pick a ranked intent. "
            "When the motif_tracker identifies an unlanded setup or orphaned payoff, "
            "route through request_motif_plant — the bridge commits the planOps AND "
            "upserts the motif registry entry so visual_director's payoff shots echo "
            "the planted visualVocabulary. "
            "The simulation_critic subagent has been retired; its tool functions "
            "(simulate_story_playthrough, preview_simulation_critic_plan) remain "
            "available on the supervisor for backwards compatibility but the "
            "orchestrator should prefer tension_analyst + beat_analyst + "
            "continuity_critic for narrative auditing. "
            "Always produce deterministic machine-readable outputs."
        ),
    }
    if backend is not None:
        kwargs["backend"] = backend

    return create_deep_agent(**kwargs)
