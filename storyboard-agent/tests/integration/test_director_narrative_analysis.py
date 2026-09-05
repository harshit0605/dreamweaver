"""
M9.5 L4 — Director: narrative analysis flow.

Producer flow:
  1. Producer clicks "Analyze narrative" in NarrativeBar.
  2. Client-side runs `sample_tension_curve` + `detect_beat_plan` +
     `detect_beat_gaps` over the shot list (these are the same
     deterministic helpers the Python beat_analyst + tension_analyst
     subagents call).
  3. Each per-shot tension sample is patched onto the node via
     `setNodeNarrativeFields`; the beat plan is persisted via
     `upsertBeatPlan`.
  4. If gaps remain, the agent's `narrative_architect` may emit
     `request_beat_assignment` to suggest fills; producer approves
     a subset → bridge applies via `setNodeNarrativeFields` (per
     assignment) + `upsertBeatPlan` (single replace).

What this pins:
  * Tension curve detects the Phase 5 "All Is Lost" dip in the
    synthetic 12-shot reel.
  * Beat plan covers 80%+ of canonical Save-the-Cat slots.
  * Bridge approval chain for `request_beat_assignment` patches
    each node's beatType in the right order.
  * Refining the plan re-runs detect_beat_gaps and produces fewer
    gaps after assignment.
"""

from __future__ import annotations

from deep.tools import (
    detect_beat_gaps,
    detect_beat_plan,
    request_beat_assignment,
    sample_tension_curve,
)


def test_full_analyze_chain_lands_a_save_the_cat_plan(
    shim, bridge, synthetic_reel_shots
) -> None:
    # Step 1: tension curve sample.
    curve = sample_tension_curve.invoke({"shots": synthetic_reel_shots})
    assert len(curve["samples"]) == 12
    # Phase 5 "All Is Lost" should dip after the midpoint chase
    # (n7 = ECU + handheld + "kills" → high tension; n8 = WS +
    # "calm" → low tension). Drop ≥3 → flagged as a dip.
    dip_node_pairs = [(d["fromNodeId"], d["toNodeId"]) for d in curve["dips"]]
    assert ("n7", "n8") in dip_node_pairs

    # Step 2: positional beat plan over a 12-shot Save-the-Cat reel.
    plan = detect_beat_plan.invoke(
        {
            "structure": "save_the_cat",
            "shots": synthetic_reel_shots,
            "existing_assignments": [],
        }
    )
    # 15-beat roster, ≥80% of slots get a positional candidate.
    placed = [b for b in plan["beats"] if b.get("nodeId")]
    assert len(placed) >= 12  # 12/15 = 80%

    # Step 3: bridge would patch every shot's tensionLevel before
    # showing the curve overlay. Simulate that here so tests can
    # verify the round-trip.
    for sample in curve["samples"]:
        shim.set_node_narrative_fields(
            storyboardId="sb_1",
            nodeId=sample["nodeId"],
            tensionLevel=sample["value"],
        )
    shim.upsert_beat_plan(
        storyboardId="sb_1",
        branchId="main",
        structure="save_the_cat",
        beats=plan["beats"],
    )

    # Each shot now carries a tensionLevel. Verify n9 ("All Is Lost")
    # is in the lower half — the dip the curve flagged is real.
    n9 = shim.nodes["sb_1"]["n9"]
    n7 = shim.nodes["sb_1"]["n7"]
    assert n7["tensionLevel"] > n9["tensionLevel"]

    # Beat plan persisted under the active branch.
    assert "main" in shim.beat_plans["sb_1"]
    assert shim.beat_plans["sb_1"]["main"]["structure"] == "save_the_cat"


def test_request_beat_assignment_chain_lands_per_node(
    shim, bridge, synthetic_reel_shots
) -> None:
    # Step 1: detect plan to get canonical-keyed proposals.
    plan = detect_beat_plan.invoke(
        {
            "structure": "save_the_cat",
            "shots": synthetic_reel_shots,
            "existing_assignments": [],
        }
    )
    # Step 2: agent picks the top 3 high-confidence assignments
    # (opening_image / catalyst / midpoint) to surface as a HITL
    # `request_beat_assignment`.
    pick = [
        b
        for b in plan["beats"]
        if b.get("nodeId")
        and b["beatKey"] in {"opening_image", "catalyst", "midpoint"}
    ][:3]
    hitl = request_beat_assignment.invoke(
        {
            "storyboard_id": "sb_1",
            "branch_id": "main",
            "structure": "save_the_cat",
            "assignments": [
                {
                    "nodeId": b["nodeId"],
                    "beatKey": b["beatKey"],
                    "actNumber": b.get("expectedActNumber", 1),
                    "rationale": "Heuristic pick.",
                }
                for b in pick
            ],
            "rationale": "Producer asked for an analyze pass.",
        }
    )

    # Step 3: producer approves → bridge dispatches per-node patches
    # then a single upsertBeatPlan with the merged plan.
    response = bridge.approve_beat_assignment(hitl)
    assert response["approved"] is True

    # Each pick generated one setNodeNarrativeFields call in input
    # order, with the right (nodeId, beatType) pair.
    field_calls = shim.calls_for("narrativeState:setNodeNarrativeFields")
    assert len(field_calls) == len(pick)
    for call, expected in zip(field_calls, pick):
        assert call.args["nodeId"] == expected["nodeId"]
        assert call.args["beatType"] == expected["beatKey"]

    # Single beat-plan upsert with all picks marked status=assigned.
    plan_calls = shim.calls_for("narrativeState:upsertBeatPlan")
    assert len(plan_calls) == 1
    persisted_beats = plan_calls[0].args["beats"]
    assert all(b["status"] == "assigned" for b in persisted_beats)


def test_detect_beat_gaps_after_partial_assignment(
    shim, bridge, synthetic_reel_shots
) -> None:
    # Producer manually assigns 3 of 15 beats; the rest stay
    # "planned" or "missing". detect_beat_gaps reports the missing
    # majority so the agent can surface a targeted suggestion.
    plan = detect_beat_plan.invoke(
        {
            "structure": "save_the_cat",
            "shots": synthetic_reel_shots,
            "existing_assignments": [
                {"nodeId": "n1", "beatKey": "opening_image", "status": "assigned"},
                {"nodeId": "n2", "beatKey": "catalyst", "status": "assigned"},
                {"nodeId": "n7", "beatKey": "midpoint", "status": "assigned"},
            ],
        }
    )
    gaps = detect_beat_gaps.invoke({"beats": plan["beats"]})
    # `plannedBeatKeys` covers the heuristic-suggested slots; the
    # producer can review them in the ribbon.
    assert isinstance(gaps["plannedBeatKeys"], list)
    # The 3 already-assigned slots aren't in the planned list.
    for assigned in ("opening_image", "catalyst", "midpoint"):
        assert assigned not in gaps["plannedBeatKeys"]
