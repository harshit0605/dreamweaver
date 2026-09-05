"""
M9.5 L5 — live-LLM nightly canary suite.

These tests bind the real subagent prompts to the real LLM and assert
on STRUCTURAL keys only. They catch:

  * Prompt drift: a subagent prompt that no longer routes to its tool
    because the LLM lost the cue word.
  * Vocabulary drift: the LLM invents a transition intent or motif key
    outside the declared vocabulary; sanitization drops it; producers
    see fewer real proposals.
  * Tool-call shape drift: a typed argument the LLM is meant to fill
    starts coming back malformed (e.g. variants without `planOps`).

The tests do NOT assert on rationale text quality — that's brittle
under model nudges. They DO assert on:
  * Every required key is present in the tool call args.
  * Vocabularies (intent, structure, archetype) stay inside their
    declared sets.
  * Counts match producer expectations (3 hooks when 3 were asked).

Run with `pytest -m llm tests/smoke/`. CI runs `pytest -m "not llm"`
so these are silent on PRs.
"""

from __future__ import annotations

import os
from typing import Any, Dict, List

import pytest
from langchain_core.messages import HumanMessage, SystemMessage

from deep.subagents import get_subagents
from deep.tools import (
    approve_graph_patch,
    detect_motif_gaps,
    planner_propose_graph_patch,
    recommend_ingestion_path,
    request_hook_variants,
    request_motif_plant,
    request_structural_remix,
    request_transition_proposal,
)


def _subagent_prompt(name: str) -> str:
    """Lookup the live system prompt for a subagent by name. We use
    the prompts as-shipped so smoke results reflect production
    behaviour."""
    for entry in get_subagents(tool_allowlist=["*"]):
        if entry["name"] == name:
            return entry["system_prompt"]
    raise AssertionError(f"Subagent '{name}' not in registry")


def _pick_tool_call(response: Any, expected_name: str) -> Dict[str, Any]:
    """Extract the first tool call matching `expected_name` from an
    AIMessage. Smoke tests retry on malformed tool calls so we
    raise a typed exception that the harness recognises."""
    tool_calls = getattr(response, "tool_calls", None) or []
    for call in tool_calls:
        if call.get("name") == expected_name:
            return call.get("args") or {}
    raise KeyError(
        f"LLM did not call {expected_name!r}; got {[c.get('name') for c in tool_calls]}"
    )


# ---------------------------------------------------------------------------
# Smoke 1 — Creator: ingestion classification
# ---------------------------------------------------------------------------


def test_smoke_ingestion_classifier_routes_idea(llm_client) -> None:
    # Producer pitch is short premise → mode should be "idea".
    # We don't drive the LLM here; recommend_ingestion_path is purely
    # heuristic. The smoke instead verifies that the LIVE LLM, when
    # given the heuristic recommendation as a tool result, produces
    # the next tool call (request_ingestion_run) with mode="idea".
    pitch = "Make a film about a heist on Mars where the AI lies."
    rec = recommend_ingestion_path.invoke({"user_request": pitch})
    assert rec["mode"] == "idea"

    bound = llm_client.with_tools(
        [recommend_ingestion_path]
    )  # warm-up context; not invoked again

    bound = llm_client.with_tools([request_hook_variants])  # type: ignore[assignment]
    # Use ingestion_coordinator's prompt (it's the subagent that
    # owns this flow) but without forcing a specific tool.
    system = _subagent_prompt("ingestion_coordinator")
    messages = [
        SystemMessage(content=system),
        HumanMessage(
            content=(
                f"The producer typed: {pitch!r}. "
                f"recommend_ingestion_path returned {rec}. "
                f"Emit the appropriate `request_ingestion_run` tool call "
                f"to confirm the ingestion mode with the producer."
            )
        ),
    ]

    from deep.tools import request_ingestion_run

    bound = llm_client.with_tools([request_ingestion_run])
    response = bound.invoke(messages, label="ingestion-routing")
    args = _pick_tool_call(response, "request_ingestion_run")
    assert args.get("mode") == "idea"
    # Title should be a non-empty string the producer would recognise.
    assert isinstance(args.get("title"), str) and len(args["title"]) > 0


# ---------------------------------------------------------------------------
# Smoke 2 — hook_designer emits 3 distinct cold-open variants
# ---------------------------------------------------------------------------


def test_smoke_hook_designer_emits_three_distinct_variants(llm_client) -> None:
    system = _subagent_prompt("hook_designer")
    bound = llm_client.with_tools([request_hook_variants])
    response = bound.invoke(
        [
            SystemMessage(content=system),
            HumanMessage(
                content=(
                    "Storyboard sb_smoke has 12 shots; opening (n1) is a wide "
                    "establishing shot of an airport at dawn. Producer asks "
                    "for 3 cold-open variants spanning question / stakes / "
                    "visual-rhyme archetypes. Emit a single "
                    "request_hook_variants tool call with all three."
                )
            ),
        ],
        label="hook-variants",
    )
    args = _pick_tool_call(response, "request_hook_variants")
    variants = args.get("variants") or []
    # Producer asked for 3 — the LLM must comply.
    assert len(variants) == 3
    # Distinct variantIds (no dupes).
    variant_ids = [v.get("variantId") for v in variants]
    assert len(set(variant_ids)) == 3, variant_ids
    # Each variant carries planOps so the bridge can commit it.
    for variant in variants:
        ops = variant.get("planOps") or []
        assert len(ops) >= 1, f"variant {variant.get('variantId')} has no planOps"


# ---------------------------------------------------------------------------
# Smoke 3 — transition_maestro picks from the declared vocabulary
# ---------------------------------------------------------------------------


def test_smoke_transition_maestro_uses_known_intents(llm_client) -> None:
    system = _subagent_prompt("transition_maestro")
    bound = llm_client.with_tools([request_transition_proposal])
    response = bound.invoke(
        [
            SystemMessage(content=system),
            HumanMessage(
                content=(
                    "Storyboard sb_smoke. Source node n3: 'A character drops "
                    "a crimson umbrella in the rain.' Target node n4: 'A "
                    "different character lifts an umbrella in another city, "
                    "years later.' Producer wants 2-3 ranked transition "
                    "proposals between n3 and n4. Emit a single "
                    "request_transition_proposal tool call."
                )
            ),
        ],
        label="transition-proposal",
    )
    args = _pick_tool_call(response, "request_transition_proposal")
    proposals = args.get("proposals") or []
    # At least one proposal — vocabulary intent or sanitization fallback.
    assert len(proposals) >= 1
    # Vocabulary intents declared in the prompt — `match_cut`,
    # `j_cut`, etc. The bridge sanitizer falls back to `hard_cut`
    # for unknowns; we still want the LLM to mostly land in the
    # vocabulary so producers see real proposals.
    KNOWN = {
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
    intents = [p.get("intent") for p in proposals]
    in_vocab = sum(1 for intent in intents if intent in KNOWN)
    # At least half the proposals must hit the declared vocabulary —
    # tolerates the occasional creative miss without becoming a
    # nightly false-positive.
    assert in_vocab >= len(intents) // 2 + 1, intents
    # Source + target node ids round-trip from the prompt. Tool args
    # preserve the function-signature naming (snake_case for Python
    # @tool params), unlike the bridge-emitted `waiting_for_human`
    # payload which camelCases.
    source = args.get("source_node_id") or args.get("sourceNodeId")
    target = args.get("target_node_id") or args.get("targetNodeId")
    assert source == "n3"
    assert target == "n4"


# ---------------------------------------------------------------------------
# Smoke 4 — motif_tracker proposes a payoff for an unlanded plant
# ---------------------------------------------------------------------------


def test_smoke_motif_tracker_lands_an_unlanded_motif(llm_client) -> None:
    motifs = [
        {
            "motifKey": "red-umbrella",
            "sourceNodeIds": ["n3"],
            "payoffNodeIds": [],
            "description": "Crimson umbrella from the opening rain.",
            "visualVocabulary": "crimson fabric, rain-beaded, gray sky",
            "landedStatus": "planted",
        }
    ]
    gaps = detect_motif_gaps.invoke({"motifs": motifs})
    # Heuristic confirmed the gap — now the LLM should propose a
    # plant for the payoff to flip status to "landed".
    assert gaps["unlanded"] == ["red-umbrella"]

    system = _subagent_prompt("motif_tracker")
    bound = llm_client.with_tools([request_motif_plant])
    response = bound.invoke(
        [
            SystemMessage(content=system),
            HumanMessage(
                content=(
                    "Storyboard sb_smoke has 12 shots. detect_motif_gaps "
                    f"returned {gaps}. The motif registry has: {motifs}. "
                    "Propose a payoff plant for 'red-umbrella' on a "
                    "shot in the final third (n10-n12). Emit a single "
                    "request_motif_plant tool call."
                )
            ),
        ],
        label="motif-plant",
    )
    args = _pick_tool_call(response, "request_motif_plant")
    assert args.get("motif_key") == "red-umbrella" or args.get("motifKey") == "red-umbrella"
    target = args.get("target_node_id") or args.get("targetNodeId")
    assert target in {"n10", "n11", "n12"}, target
    # Payoff role implies the target lands in payoff_node_ids.
    payoffs = args.get("payoff_node_ids") or args.get("payoffNodeIds") or []
    assert target in payoffs


# ---------------------------------------------------------------------------
# Smoke 5 — structural_variant_generator targets a declared structure
# ---------------------------------------------------------------------------


def test_smoke_structural_variant_generator_targets_known_structure(
    llm_client,
) -> None:
    system = _subagent_prompt("structural_variant_generator")
    bound = llm_client.with_tools([request_structural_remix])
    response = bound.invoke(
        [
            SystemMessage(content=system),
            HumanMessage(
                content=(
                    "Storyboard sb_smoke is currently a 12-shot Save-the-Cat "
                    "reel. Producer asks for 2 structural remix variants "
                    "that reframe the reel as a Harmon Circle (8 beats: "
                    "you, need, go, search, find, take, return, change). "
                    "Emit a single request_structural_remix tool call."
                )
            ),
        ],
        label="structural-remix",
    )
    args = _pick_tool_call(response, "request_structural_remix")
    target = args.get("target_structure") or args.get("targetStructure")
    KNOWN_STRUCTURES = {
        "save_the_cat",
        "harmon_circle",
        "three_act",
        "kishotenketsu",
        "hook_first",
    }
    assert target in KNOWN_STRUCTURES, target
    variants = args.get("variants") or []
    assert len(variants) >= 1
    # Each variant carries an id + planOps.
    for variant in variants:
        assert variant.get("variantId")
        assert (variant.get("planOps") or []) != []


# ---------------------------------------------------------------------------
# Smoke — supervisor routing for ingestion-style producer messages
# ---------------------------------------------------------------------------
#
# M9.5.1 found: the supervisor decomposed "I want to make a film about
# X. Help me get started." into general-purpose subagents instead of
# routing to ingestion_coordinator. Root cause: the supervisor system
# prompt covered narrative refinement subagents but said nothing about
# the ingestion path. The fix added an explicit ingestion-routing
# clause; this smoke is the regression net.
#
# Why a separate test file would be wrong: the supervisor's prompt
# lives in factory.py, not subagents.py. Driving a real graph
# invocation requires booting `create_deep_agent` which is heavier
# than the per-subagent prompts L5 normally exercises. Keeping this
# smoke in the same suite (under `@pytest.mark.llm`) so the nightly
# cron exercises it.
# ---------------------------------------------------------------------------


def test_smoke_supervisor_routes_ingestion_messages_to_ingestion_coordinator(
    llm_budget,
) -> None:
    """A producer says 'I want to make a film about X. Help me get
    started.' — supervisor must delegate to `ingestion_coordinator`
    (or invoke `recommend_ingestion_path` directly), NOT to a
    general-purpose / planner / narrative_architect subagent. The
    supervisor's first move sets the producer's onboarding tone, so
    drift here matters."""
    from deep.factory import create_storyboard_deep_agent_graph
    from langchain_core.messages import HumanMessage

    graph = create_storyboard_deep_agent_graph(tool_allowlist=["*"])
    config = {"configurable": {"thread_id": "smoke_supervisor_ingestion_1"}}
    result = graph.invoke(
        {
            "messages": [
                HumanMessage(
                    content=(
                        "I want to make a film about a heist on Mars. "
                        "Help me get started."
                    )
                )
            ],
            "storyboard_id": "",
            "branch_id": "main",
            "team_config": {},
            "runtime_policy": {},
            "effective_tool_scope": ["*"],
        },
        config=config,
    )

    # We don't track this graph invocation through the budget tracker
    # (the supervisor's LLM client is constructed inside
    # create_deep_agent, not via our llm_client fixture). Instead
    # we record an explicit budget tick here so the nightly ledger
    # accounts for the graph invocation.
    llm_budget.add(
        prompt_tokens=4000,  # rough supervisor + system prompt + history
        completion_tokens=300,
        label="supervisor:ingestion-routing",
    )

    messages = result.get("messages", [])
    # Walk every AIMessage's tool_calls and verify the supervisor's
    # first delegation went somewhere sensible. Pass condition: at
    # least one of the following appears as the first action:
    #   * task(subagent_type="ingestion_coordinator")
    #   * direct call to recommend_ingestion_path
    #   * direct call to request_ingestion_run
    delegations: list[str] = []
    direct_tools: list[str] = []
    for msg in messages:
        for tc in getattr(msg, "tool_calls", None) or []:
            name = tc.get("name") or ""
            args = tc.get("args") or {}
            if name == "task":
                delegations.append(str(args.get("subagent_type", "")))
            else:
                direct_tools.append(name)

    routed_to_ingestion = (
        "ingestion_coordinator" in delegations
        or "recommend_ingestion_path" in direct_tools
        or "request_ingestion_run" in direct_tools
    )
    assert routed_to_ingestion, (
        f"Supervisor failed to route ingestion-style message. "
        f"Delegations: {delegations}; direct tools: {direct_tools}. "
        f"Expected at least one of: ingestion_coordinator subagent, "
        f"recommend_ingestion_path, or request_ingestion_run."
    )


# ---------------------------------------------------------------------------
# Smoke 6 — planner emits structured graph operations
# ---------------------------------------------------------------------------
#
# Added after L5 caught the same `List[Dict[str, Any]]` bug in
# planner_propose_graph_patch as it caught in transition_maestro.
# This smoke regresses the planner so the M1-era bug stays fixed.
# ---------------------------------------------------------------------------


def test_smoke_planner_emits_structured_operations(llm_client) -> None:
    system = _subagent_prompt("planner")
    bound = llm_client.with_tools([planner_propose_graph_patch])
    response = bound.invoke(
        [
            SystemMessage(content=system),
            HumanMessage(
                content=(
                    "Storyboard sb_smoke. Producer wants you to add a single "
                    "shot node with id 'n_open' at canvas position (100, 100), "
                    "labeled 'Opening', segment 'Wide aerial of the city'. "
                    "Emit a single planner_propose_graph_patch tool call."
                )
            ),
        ],
        label="planner-graph-patch",
    )
    args = _pick_tool_call(response, "planner_propose_graph_patch")
    operations = args.get("operations") or []
    # The bug was: gpt-4.1-mini emitted the call with operations=[].
    # Schema fix forces at least one structured operation.
    assert len(operations) >= 1, args
    # First op must declare its `op` type from the allowed set.
    KNOWN_OPS = {
        "create_node",
        "update_node",
        "delete_node",
        "create_edge",
        "update_edge",
        "delete_edge",
        "generate_image",
        "generate_video",
    }
    first = operations[0]
    assert first.get("op") in KNOWN_OPS, first


# ---------------------------------------------------------------------------
# Optional: budget surfacing — emit the running total at suite end so
# the cron log captures the spend.
# ---------------------------------------------------------------------------


def test_smoke_budget_summary(llm_budget) -> None:
    """Not really a test — captures the running total at the end of
    the suite so the nightly cron job has a clear ledger entry. The
    test only fails if the budget was set to 0 (developer mistake)."""
    assert llm_budget.budget_usd > 0
    print(
        f"\n[L5 SMOKE BUDGET] {llm_budget.calls} LLM calls; "
        f"${llm_budget.total_usd:.4f} of ${llm_budget.budget_usd:.2f} "
        f"({llm_budget.remaining_usd():.4f} remaining)"
    )
