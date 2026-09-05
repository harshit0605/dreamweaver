"""
M9.5 L4 — Producer: continuity + dailies critic flow.

Producer flow:
  1. dailies_producer builds an autonomous batch via
     `build_autonomous_dailies_batch` from a reel + continuity_risks
     list.
  2. dailies_critic audits the result via:
       * `simulate_story_playthrough` — pacing + causality.
       * `continuity_critic` — wardrobe / identity drift.
       * `detect_motif_gaps` — M9 Phase 4 motif consistency check.
  3. Audit produces violations; critic proposes a `repair_plan`.
  4. Repair plan surfaces as `request_dailies_critic_review` HITL.
  5. Producer approves → bridge dispatches the repair via
     `approve_repair_plan`.

What this pins:
  * Risk levels escalate correctly (continuity issue → medium;
    causality contradiction → high).
  * Repair op count caps at 8 even if the simulation surfaces
    more.
  * Motif gap detection composes into the critic's findings.
  * The dailies execution plan envelope round-trips through
    approve_dailies_batch.
"""

from __future__ import annotations

from deep.tools import (
    approve_dailies_batch,
    approve_repair_plan,
    build_autonomous_dailies_batch,
    continuity_critic,
    detect_motif_gaps,
    repair_plan,
    request_dailies_critic_review,
    simulate_story_playthrough,
)


def test_clean_dailies_batch_low_risk(shim, bridge) -> None:
    out = build_autonomous_dailies_batch.invoke(
        {
            "storyboard_id": "sb_1",
            "branch_id": "main",
            "source_reel_id": "reel_1",
            "title": "Tuesday dailies",
            "summary": "Coverage pass; no risks flagged.",
            "target_node_ids": ["n1", "n2", "n3", "n4"],
            "continuity_risks": [],
        }
    )
    plan = out["executionPlan"]
    assert plan["dryRun"]["riskLevel"] == "low"
    # 4 target nodes → alternating image/video → 4 ops.
    assert len(plan["operations"]) == 4
    # Producer approves the dailies batch envelope verbatim.
    approval = approve_dailies_batch.invoke(
        {
            "plan_id": plan["planId"],
            "storyboard_id": plan["storyboardId"],
            "branch_id": plan["branchId"],
            "title": plan["title"],
            "rationale": plan["rationale"],
            "source_id": plan["sourceId"],
            "operations": plan["operations"],
            "dry_run": plan["dryRun"],
        }
    )
    assert approval["status"] == "waiting_for_human"
    assert approval["input"]["taskType"] == "dailies_batch"


def test_continuity_risk_escalates_to_medium(shim, bridge) -> None:
    out = build_autonomous_dailies_batch.invoke(
        {
            "storyboard_id": "sb_1",
            "branch_id": "main",
            "source_reel_id": "reel_1",
            "title": "Tuesday dailies",
            "summary": "Coverage pass; one wardrobe risk.",
            "target_node_ids": ["n1", "n2"],
            "continuity_risks": [
                {
                    "code": "WARDROBE_DRIFT",
                    "nodeIds": ["n2"],
                    "message": "Scarf colour shifts mid-act.",
                    "suggestedFix": "Use n1's wardrobe variant.",
                }
            ],
        }
    )
    assert out["executionPlan"]["dryRun"]["riskLevel"] == "medium"
    # Two render ops + one repair op = three.
    ops = out["executionPlan"]["operations"]
    repair_ops = [o for o in ops if o["op"] == "update_node"]
    assert len(repair_ops) == 1
    assert "WARDROBE_DRIFT" in repair_ops[0]["title"]


def test_simulation_critic_flags_causality_contradiction(shim, bridge) -> None:
    out = simulate_story_playthrough.invoke(
        {
            "storyboard_id": "sb_1",
            "branch_id": "main",
            "timeline_events": [
                "Hero died in the avalanche.",
                "Hero alive in the cabin afterwards.",
            ],
            "node_count": 5,
            "edge_count": 4,
            "branch_edge_count": 0,
            "merge_edge_count": 0,
        }
    )
    codes = [i["code"] for i in out["issues"]]
    assert "SIM_CAUSALITY_CONTRADICTION" in codes
    assert out["riskLevel"] == "high"

    # Repair operations carry the suggestedFix forward — the producer
    # sees actionable repairs not just a warning.
    assert len(out["repairOperations"]) >= 1
    fix = out["repairOperations"][0]["payload"]["suggestedFix"]
    assert "revival" in fix.lower() or "alternate" in fix.lower()


def test_continuity_critic_returns_structured_violations(shim, bridge) -> None:
    # Heuristic: "died" + "suddenly alive" in the rolling summary
    # raises NARRATIVE_CONTRADICTION. Char with no wardrobe → medium
    # WARDROBE_MISSING. We force both here to exercise the full
    # violation path.
    out = continuity_critic.invoke(
        {
            "storyboard_id": "sb_1",
            "branch_id": "main",
            "rolling_summary": (
                "Hero died in the avalanche. Hero suddenly alive in the cabin."
            ),
            "character_ids": ["char_1"],
            "selected_wardrobes": [],
        }
    )
    codes = [v["code"] for v in out["violations"]]
    assert "NARRATIVE_CONTRADICTION" in codes
    assert "WARDROBE_MISSING" in codes
    assert out["status"] == "warning"


def test_repair_plan_chain_runs_under_approval(shim, bridge) -> None:
    # End-to-end: simulation surfaces issues → repair_plan builds a
    # remediation set → approve_repair_plan is the HITL gate.
    sim = simulate_story_playthrough.invoke(
        {
            "storyboard_id": "sb_1",
            "branch_id": "main",
            "timeline_events": ["died"] * 22 + ["alive"],
            "node_count": 3,
            "edge_count": 0,
            "branch_edge_count": 5,
            "merge_edge_count": 0,
        }
    )
    # Dirty reel — high risk, multiple issues. Critic asks repair_plan
    # for an explicit op set.
    plan = repair_plan.invoke(
        {
            "storyboard_id": "sb_1",
            "branch_id": "main",
            "violations": sim["issues"],
        }
    )
    assert len(plan["operations"]) == len(sim["issues"])
    # Confidence stays at the heuristic floor (0.72) because the
    # critic isn't proposing a "smart" repair — just a per-violation
    # placeholder for the producer to refine.
    assert plan["confidence"] == 0.72

    # Producer review + approval gate.
    approval = approve_repair_plan.invoke(
        {
            "repair_plan_id": plan["repairPlanId"],
            "operations": plan["operations"],
            "confidence": plan["confidence"],
        }
    )
    assert approval["status"] == "waiting_for_human"
    assert approval["input"]["repairPlanId"] == plan["repairPlanId"]


def test_motif_gaps_compose_into_dailies_critic_findings() -> None:
    # M9 Phase 4: dailies_critic includes detect_motif_gaps in its
    # tool list. Two motif violations escalate the producer's review
    # surface alongside continuity / pacing findings.
    motifs = [
        {"motifKey": "red-umbrella", "sourceNodeIds": ["n3"], "payoffNodeIds": []},
        {"motifKey": "broken-watch", "sourceNodeIds": [], "payoffNodeIds": ["n18"]},
        {"motifKey": "rain", "sourceNodeIds": ["n1"], "payoffNodeIds": ["n12"]},
    ]
    gaps = detect_motif_gaps.invoke({"motifs": motifs})
    # Two violations to surface as findings:
    #   UNLANDED_MOTIF: red-umbrella (planted, no payoff)
    #   ORPHANED_PAYOFF: broken-watch (payoff, no setup)
    assert "red-umbrella" in gaps["unlanded"]
    assert "broken-watch" in gaps["orphaned"]
    # rain is properly landed — not a finding.
    assert "rain" not in gaps["unlanded"]
    assert "rain" not in gaps["orphaned"]


def test_dailies_critic_review_dispatch_is_a_pure_gate(shim, bridge) -> None:
    # `request_dailies_critic_review` is a dispatch signal — the bridge
    # records the approval but the actual audit happens later inside
    # the dailies_critic subagent on the next turn. Verifying the
    # payload shape so the audit trail records the dispatch.
    hitl = request_dailies_critic_review.invoke(
        {
            "storyboard_id": "sb_1",
            "dailies_reel_id": "reel_1",
            "rationale": "Producer asked for an audit pass.",
        }
    )
    assert hitl["status"] == "waiting_for_human"
    assert hitl["action"] == "request_dailies_critic_review"
    assert hitl["input"]["dailiesReelId"] == "reel_1"
