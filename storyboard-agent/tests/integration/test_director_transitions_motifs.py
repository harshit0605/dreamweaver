"""
M9.5 L4 — Director: transitions + motifs flow (M9 Phase 4).

Producer flow A — transitions:
  1. Producer says "propose a transition between n1 and n2".
  2. Agent's `transition_maestro` proposes 2-4 ranked cut idioms
     (match_cut, j_cut, ...) with shared elements + Murch Rule of
     Six rationales → `request_transition_proposal` HITL.
  3. Producer picks one (defaults to rank-1) → bridge writes the
     edge's `transitionIntent` via `setEdgeTransitionIntent` and
     optionally commits accompanying planOps (e.g. a motif plant
     for a match_cut that needs a planted setup).

Producer flow B — motifs:
  1. Producer says "audit motifs" or `motif_tracker` runs as part
     of dailies_critic.
  2. `detect_motif_gaps` buckets the registry; `motif_tracker`
     proposes a payoff for each unlanded plant → `request_motif_plant`.
  3. Bridge approves → commitPlanOps for the planOps + upsertMotif
     with derived landedStatus (planted / orphaned / landed).

What this pins:
  * Unknown intents fall back to `hard_cut`; rawIntent preserved.
  * Proposals are sorted by rank server-side so producers see #1
    first.
  * Motif plant with both source + payoff arrays auto-derives
    `landedStatus="landed"`; with sources only → "planted"; with
    neither → "unplanted".
  * Approval token threading: planOps commits use `approved:<task>`.
"""

from __future__ import annotations

from deep.tools import (
    detect_motif_gaps,
    request_motif_plant,
    request_transition_proposal,
)


# ---------------------------------------------------------------------------
# Transitions
# ---------------------------------------------------------------------------


def test_transition_proposal_chain_writes_edge_intent(shim, bridge) -> None:
    hitl = request_transition_proposal.invoke(
        {
            "storyboard_id": "sb_1",
            "branch_id": "main",
            "source_node_id": "n3",
            "target_node_id": "n4",
            "proposals": [
                {
                    "intent": "match_cut",
                    "rationale": "Crimson umbrella bridges the cut.",
                    "sharedElement": "crimson umbrella",
                    "rank": 1,
                },
                {
                    "intent": "j_cut",
                    "rationale": "Audio leads picture.",
                    "rank": 2,
                },
            ],
            "rationale": "Producer asked for transitions.",
        }
    )

    # Sorted by rank: match_cut first (recommended), j_cut second.
    intents = [p["intent"] for p in hitl["input"]["proposals"]]
    assert intents == ["match_cut", "j_cut"]

    response = bridge.approve_transition_proposal(hitl, edge_id="e34")
    assert response["approved"] is True
    assert response["selectedIntent"] == "match_cut"

    # Edge row carries the chosen intent.
    assert (
        shim.edges["sb_1"]["e34"]["transitionIntent"] == "match_cut"
    )
    # Approval task created + resolved before any commit.
    assert len(shim.calls_for("approvals:createTask")) == 1
    assert len(shim.calls_for("approvals:resolveTask")) == 1


def test_unknown_intent_normalizes_to_hard_cut(shim, bridge) -> None:
    hitl = request_transition_proposal.invoke(
        {
            "storyboard_id": "sb_1",
            "branch_id": "main",
            "source_node_id": "n3",
            "target_node_id": "n4",
            "proposals": [
                {
                    "intent": "vortex_warp",
                    "rationale": "Producer made one up.",
                    "rank": 1,
                }
            ],
            "rationale": "x",
        }
    )
    proposal = hitl["input"]["proposals"][0]
    # Sanitization at the tool boundary: applied intent normalises;
    # raw intent preserved so the bridge can show "we changed your
    # 'vortex_warp' to 'hard_cut' because we couldn't ship that".
    assert proposal["intent"] == "hard_cut"
    assert proposal["rawIntent"] == "vortex_warp"


def test_transition_with_plan_ops_commits_motif_plant(shim, bridge) -> None:
    # Some transitions (e.g. a match_cut to a previously-undeclared
    # image) need a motif plant to make the cut land. The proposal
    # carries planOps that the bridge commits BEFORE writing the
    # transition intent.
    hitl = request_transition_proposal.invoke(
        {
            "storyboard_id": "sb_1",
            "branch_id": "main",
            "source_node_id": "n3",
            "target_node_id": "n4",
            "proposals": [
                {
                    "intent": "match_cut",
                    "rationale": "Land a callback umbrella in n3.",
                    "sharedElement": "crimson umbrella",
                    "planOps": [
                        {
                            "op": "update_node",
                            "title": "Add umbrella detail to n3",
                            "nodeId": "n3",
                        }
                    ],
                    "rank": 1,
                }
            ],
            "rationale": "x",
        }
    )

    bridge.approve_transition_proposal(hitl, edge_id="e34")
    # planOps commit gated by approval token — chain order:
    # createTask → resolveTask → commitPlanOps → setEdgeTransitionIntent
    shim.assert_call_order(
        "approvals:createTask",
        "approvals:resolveTask",
        "narrativeGit:commitPlanOps",
        "narrativeState:setEdgeTransitionIntent",
    )


# ---------------------------------------------------------------------------
# Motifs
# ---------------------------------------------------------------------------


def test_detect_motif_gaps_buckets_correctly() -> None:
    out = detect_motif_gaps.invoke(
        {
            "motifs": [
                {"motifKey": "red-umbrella", "sourceNodeIds": ["n3"], "payoffNodeIds": []},
                {"motifKey": "broken-watch", "sourceNodeIds": [], "payoffNodeIds": ["n18"]},
                {"motifKey": "rain", "sourceNodeIds": ["n1"], "payoffNodeIds": ["n12"]},
                {"motifKey": "ghost", "sourceNodeIds": [], "payoffNodeIds": []},
            ]
        }
    )
    assert out["unlanded"] == ["red-umbrella"]
    assert out["orphaned"] == ["broken-watch"]
    assert out["landed"] == ["rain"]
    assert out["unplanted"] == ["ghost"]


def test_motif_plant_with_both_arrays_lands_status_landed(shim, bridge) -> None:
    # A producer-approved plant with both setup and payoff present
    # auto-derives `landedStatus="landed"` — the chain is complete.
    hitl = request_motif_plant.invoke(
        {
            "storyboard_id": "sb_1",
            "branch_id": "main",
            "motif_key": "red-umbrella",
            "target_node_id": "n3",
            "plan_ops": [
                {
                    "op": "update_node",
                    "title": "Append red-umbrella to n3 motifIds",
                    "nodeId": "n3",
                }
            ],
            "rationale": "Land the umbrella chain.",
            "visual_vocabulary": "crimson fabric, rain-beaded, gray sky",
            "source_node_ids": ["n3"],
            "payoff_node_ids": ["n18"],
        }
    )
    response = bridge.approve_motif_plant(hitl)
    assert response["landedStatus"] == "landed"

    motif_row = shim.motifs["sb_1"]["red-umbrella"]
    assert motif_row["landedStatus"] == "landed"
    assert motif_row["sourceNodeIds"] == ["n3"]
    assert motif_row["payoffNodeIds"] == ["n18"]
    assert motif_row["visualVocabulary"] == "crimson fabric, rain-beaded, gray sky"
    # planOps committed under an approval token.
    commits = shim.calls_for("narrativeGit:commitPlanOps")
    assert len(commits) == 1
    assert commits[0].args["approvalToken"].startswith("approved:")


def test_motif_plant_with_only_sources_lands_status_planted(shim, bridge) -> None:
    hitl = request_motif_plant.invoke(
        {
            "storyboard_id": "sb_1",
            "branch_id": "main",
            "motif_key": "broken-watch",
            "target_node_id": "n3",
            "plan_ops": [],
            "rationale": "Plant the watch; pay off later.",
            "source_node_ids": ["n3"],
            "payoff_node_ids": [],
        }
    )
    response = bridge.approve_motif_plant(hitl)
    assert response["landedStatus"] == "planted"
    # No planOps → no commitPlanOps fired.
    assert len(shim.calls_for("narrativeGit:commitPlanOps")) == 0


def test_motif_key_slug_sanitised_at_tool_boundary(shim, bridge) -> None:
    # Producer types "Red Umbrella!! (main)" — the tool slug-sanitises
    # so the row lands with a URL-safe key.
    hitl = request_motif_plant.invoke(
        {
            "storyboard_id": "sb_1",
            "branch_id": "main",
            "motif_key": "Red Umbrella!! (main)",
            "target_node_id": "n3",
            "plan_ops": [],
            "rationale": "x",
            "source_node_ids": ["n3"],
        }
    )
    sanitised_key = hitl["input"]["motifKey"]
    assert all(c.isalnum() or c in "-_" for c in sanitised_key)
    bridge.approve_motif_plant(hitl)
    # Row keyed by the sanitised slug, not the raw text.
    assert sanitised_key in shim.motifs["sb_1"]


def test_motif_with_neither_array_lands_status_unplanted(shim, bridge) -> None:
    # Edge case: motif_tracker draft entry that hasn't yet been
    # tied to any node. The form still creates the row so producers
    # can fill it in via drag-to-plant later.
    hitl = request_motif_plant.invoke(
        {
            "storyboard_id": "sb_1",
            "branch_id": "main",
            "motif_key": "ghost",
            "target_node_id": "n1",
            "plan_ops": [],
            "rationale": "Bare registry entry.",
            "source_node_ids": [],
            "payoff_node_ids": [],
        }
    )
    response = bridge.approve_motif_plant(hitl)
    assert response["landedStatus"] == "unplanted"
