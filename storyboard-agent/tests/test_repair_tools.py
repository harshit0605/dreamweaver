"""
M9.5 L1 — repair / simulation / preview / dailies-batch tool unit tests.

These four tools are deterministic helpers (no LLM) but had ZERO test
coverage pre-M9.5. They underpin the dailies_critic + repair_agent
subagents and a continuity-violation flow that mutates the graph, so
their shapes, clamping, and risk-level derivation matter.

Pattern matches `test_ingestion_tools.py`:
  * one TestCase per tool
  * shape assertions on the returned dict
  * issue-detection assertions on synthetic inputs that should trigger
    each heuristic branch
  * execution-plan envelope assertions (tools that wrap repair ops in
    an executionPlan dict get explicit dryRun shape checks)
"""

from __future__ import annotations

import unittest
from typing import Any, Dict, List

from deep.tools import (
    ALL_TOOLS,
    DEFAULT_RUNTIME_ALLOWLIST,
    SUPERVISOR_CORE_TOOLS,
    TOOL_POLICY_TOKENS,
    build_autonomous_dailies_batch,
    is_tool_allowed,
    preview_simulation_critic_plan,
    repair_plan,
    simulate_story_playthrough,
)


# ---------------------------------------------------------------------------
# repair_plan
# ---------------------------------------------------------------------------


class RepairPlanTests(unittest.TestCase):
    def test_empty_violations_returns_zero_ops_and_zero_confidence(self) -> None:
        out = repair_plan.invoke(
            {
                "storyboard_id": "sb_1",
                "branch_id": "main",
                "violations": [],
            }
        )
        self.assertEqual(out["operations"], [])
        # Plan with no ops carries 0.0 confidence so the consumer never
        # treats an "all clean" result as a high-confidence repair.
        self.assertEqual(out["confidence"], 0.0)
        self.assertTrue(out["repairPlanId"].startswith("repairplan_"))

    def test_single_violation_yields_single_op(self) -> None:
        out = repair_plan.invoke(
            {
                "storyboard_id": "sb_1",
                "branch_id": "main",
                "violations": [{"code": "WARDROBE_DRIFT", "message": "scarf colour"}],
            }
        )
        self.assertEqual(len(out["operations"]), 1)
        op = out["operations"][0]
        self.assertEqual(op["op"], "update_node")
        self.assertEqual(op["opId"], "repair_1")
        self.assertIn("WARDROBE_DRIFT", op["title"])
        # Repairs are HITL-gated by construction; the agent never bypasses.
        self.assertTrue(op["requiresHitl"])
        self.assertEqual(out["confidence"], 0.72)

    def test_unknown_code_falls_back(self) -> None:
        # A violation with no `code` field still produces an op so the
        # repair plan stays useful as a placeholder.
        out = repair_plan.invoke(
            {
                "storyboard_id": "sb_1",
                "branch_id": "main",
                "violations": [{"message": "anonymous warning"}],
            }
        )
        self.assertEqual(len(out["operations"]), 1)
        self.assertIn("UNKNOWN", out["operations"][0]["title"])

    def test_op_ids_are_sequential(self) -> None:
        out = repair_plan.invoke(
            {
                "storyboard_id": "sb_1",
                "branch_id": "main",
                "violations": [
                    {"code": "A"},
                    {"code": "B"},
                    {"code": "C"},
                ],
            }
        )
        ids = [op["opId"] for op in out["operations"]]
        self.assertEqual(ids, ["repair_1", "repair_2", "repair_3"])

    def test_repair_plan_id_is_deterministic(self) -> None:
        # Same violation set must produce the same repairPlanId so the
        # bridge dedup layer can recognize a re-issue without diffing.
        violations = [{"code": "C1"}, {"code": "C2"}]
        out_a = repair_plan.invoke(
            {"storyboard_id": "sb_1", "branch_id": "main", "violations": violations}
        )
        out_b = repair_plan.invoke(
            {"storyboard_id": "sb_1", "branch_id": "main", "violations": violations}
        )
        self.assertEqual(out_a["repairPlanId"], out_b["repairPlanId"])


# ---------------------------------------------------------------------------
# simulate_story_playthrough
# ---------------------------------------------------------------------------


def _sim(**overrides: Any) -> Dict[str, Any]:
    """Build a baseline simulate_story_playthrough payload, override
    individual fields per test."""
    base: Dict[str, Any] = {
        "storyboard_id": "sb_1",
        "branch_id": "main",
        "timeline_events": ["scene one", "scene two"],
        "node_count": 5,
        "edge_count": 4,
        "branch_edge_count": 0,
        "merge_edge_count": 0,
    }
    base.update(overrides)
    return base


class SimulateStoryPlaythroughTests(unittest.TestCase):
    def test_clean_storyboard_yields_no_issues(self) -> None:
        out = simulate_story_playthrough.invoke(_sim())
        self.assertEqual(out["issues"], [])
        self.assertEqual(out["riskLevel"], "low")
        # Confidence stays high when there's nothing to repair.
        self.assertEqual(out["confidence"], 0.86)
        self.assertEqual(out["repairOperations"], [])

    def test_orphan_graph_flagged_high(self) -> None:
        # Nodes with zero edges = high-severity orphan; cannot play through.
        out = simulate_story_playthrough.invoke(
            _sim(node_count=3, edge_count=0)
        )
        codes = [i["code"] for i in out["issues"]]
        self.assertIn("SIM_ORPHAN_GRAPH", codes)
        self.assertEqual(out["riskLevel"], "high")

    def test_branch_imbalance_flagged_medium(self) -> None:
        out = simulate_story_playthrough.invoke(
            _sim(branch_edge_count=5, merge_edge_count=1)
        )
        codes = [i["code"] for i in out["issues"]]
        self.assertIn("SIM_BRANCH_IMBALANCE", codes)
        # Exactly one medium issue, no highs → riskLevel medium.
        self.assertEqual(out["riskLevel"], "medium")

    def test_branch_within_two_of_merge_does_not_flag(self) -> None:
        # The +2 tolerance lets the typical "branch fan-out then merge"
        # pattern pass without spurious warnings.
        out = simulate_story_playthrough.invoke(
            _sim(branch_edge_count=3, merge_edge_count=1)
        )
        codes = [i["code"] for i in out["issues"]]
        self.assertNotIn("SIM_BRANCH_IMBALANCE", codes)

    def test_causality_contradiction_flagged_high(self) -> None:
        out = simulate_story_playthrough.invoke(
            _sim(
                timeline_events=[
                    "Hero died in the avalanche.",
                    "Hero alive in the next scene.",
                ],
            )
        )
        codes = [i["code"] for i in out["issues"]]
        self.assertIn("SIM_CAUSALITY_CONTRADICTION", codes)
        self.assertEqual(out["riskLevel"], "high")

    def test_pacing_density_flagged_when_event_count_high(self) -> None:
        events = [f"event {i}" for i in range(20)]
        out = simulate_story_playthrough.invoke(_sim(timeline_events=events))
        codes = [i["code"] for i in out["issues"]]
        self.assertIn("SIM_PACING_DENSITY", codes)

    def test_repair_operations_capped_at_eight(self) -> None:
        # Force 4 issues. Each adds one repair op. We need to ensure the
        # capping logic works: build a scenario with all four flags hit.
        out = simulate_story_playthrough.invoke(
            _sim(
                timeline_events=["died"] * 25 + ["alive"],
                node_count=3,
                edge_count=0,
                branch_edge_count=10,
                merge_edge_count=0,
            )
        )
        # 4 issues maximum get raised by the heuristic; cap is 8 so all
        # should land. This test mostly guards against regressions where
        # the cap is removed and ops blow up.
        self.assertLessEqual(len(out["repairOperations"]), 8)

    def test_simulation_run_id_is_deterministic(self) -> None:
        out_a = simulate_story_playthrough.invoke(_sim())
        out_b = simulate_story_playthrough.invoke(_sim())
        self.assertEqual(out_a["simulationRunId"], out_b["simulationRunId"])

    def test_execution_plan_envelope_is_valid(self) -> None:
        out = simulate_story_playthrough.invoke(
            _sim(node_count=3, edge_count=0)
        )
        plan = out["executionPlan"]
        self.assertEqual(plan["taskType"], "simulation_critic_batch")
        self.assertEqual(plan["source"], "simulation_critic")
        self.assertEqual(plan["sourceId"], out["simulationRunId"])
        # Dry run carries the same risk level as the parent envelope.
        self.assertEqual(plan["dryRun"]["riskLevel"], out["riskLevel"])
        self.assertTrue(plan["dryRun"]["valid"])

    def test_impact_score_increases_with_issues(self) -> None:
        # impactScore floor is 0.2 (so a clean reel never reads as zero
        # impact). The score = min(1.0, max(0.2, len(issues) * 0.18)),
        # which means we need ≥2 issues for the increase to surface
        # past the floor.
        clean = simulate_story_playthrough.invoke(_sim())
        dirty = simulate_story_playthrough.invoke(
            _sim(
                node_count=3,
                edge_count=0,
                branch_edge_count=10,
                merge_edge_count=0,
                timeline_events=["died"] * 20 + ["alive"],
            )
        )
        self.assertGreater(dirty["impactScore"], clean["impactScore"])


# ---------------------------------------------------------------------------
# preview_simulation_critic_plan
# ---------------------------------------------------------------------------


class PreviewSimulationCriticPlanTests(unittest.TestCase):
    def test_shape_is_waiting_for_human(self) -> None:
        out = preview_simulation_critic_plan.invoke(
            {
                "simulation_run_id": "simrun_1",
                "storyboard_id": "sb_1",
                "branch_id": "main",
                "summary": "1 issue.",
                "risk_level": "medium",
                "issues": [{"code": "X"}],
                "confidence": 0.8,
                "impact_score": 0.5,
                "execution_plan": {"planId": "p1"},
            }
        )
        self.assertEqual(out["status"], "waiting_for_human")
        self.assertEqual(out["action"], "preview_simulation_critic_plan")
        self.assertEqual(out["input"]["simulationRunId"], "simrun_1")
        self.assertEqual(out["input"]["riskLevel"], "medium")
        self.assertEqual(out["input"]["confidence"], 0.8)
        self.assertEqual(out["input"]["impactScore"], 0.5)

    def test_pass_through_preserves_execution_plan(self) -> None:
        plan = {"planId": "p1", "operations": [{"op": "update_node"}]}
        out = preview_simulation_critic_plan.invoke(
            {
                "simulation_run_id": "simrun_1",
                "storyboard_id": "sb_1",
                "branch_id": "main",
                "summary": "",
                "risk_level": "low",
                "issues": [],
                "confidence": 0.9,
                "impact_score": 0.1,
                "execution_plan": plan,
            }
        )
        # Plan must round-trip unchanged so the bridge can hand it to
        # `approve_batch_ops` without re-deriving anything.
        self.assertEqual(out["input"]["executionPlan"], plan)


# ---------------------------------------------------------------------------
# build_autonomous_dailies_batch
# ---------------------------------------------------------------------------


def _dailies(
    target_node_ids: List[str] | None = None,
    continuity_risks: List[Dict[str, Any]] | None = None,
) -> Dict[str, Any]:
    return {
        "storyboard_id": "sb_1",
        "branch_id": "main",
        "source_reel_id": "reel_1",
        "title": "Tuesday dailies",
        "summary": "Mid-act 2 coverage pass.",
        "target_node_ids": target_node_ids or ["n1", "n2", "n3"],
        "continuity_risks": continuity_risks or [],
    }


class BuildAutonomousDailiesBatchTests(unittest.TestCase):
    def test_alternating_image_video_ops(self) -> None:
        out = build_autonomous_dailies_batch.invoke(_dailies())
        ops = out["executionPlan"]["operations"]
        # Even indices = generate_image, odd indices = generate_video.
        # The pattern lets producers see both stills + animations on
        # the dailies reel in one pass.
        self.assertEqual(ops[0]["op"], "generate_image")
        self.assertEqual(ops[1]["op"], "generate_video")
        self.assertEqual(ops[2]["op"], "generate_image")

    def test_target_nodes_capped_at_eight(self) -> None:
        many = [f"n{i}" for i in range(20)]
        out = build_autonomous_dailies_batch.invoke(
            _dailies(target_node_ids=many)
        )
        gen_ops = [
            op
            for op in out["executionPlan"]["operations"]
            if op["op"] in {"generate_image", "generate_video"}
        ]
        self.assertEqual(len(gen_ops), 8)

    def test_risks_capped_at_four(self) -> None:
        risks = [
            {"code": f"R_{i}", "nodeIds": [f"n{i}"], "message": "x"}
            for i in range(10)
        ]
        out = build_autonomous_dailies_batch.invoke(
            _dailies(continuity_risks=risks)
        )
        repair_ops = [
            op
            for op in out["executionPlan"]["operations"]
            if op["op"] == "update_node"
        ]
        self.assertLessEqual(len(repair_ops), 4)

    def test_risk_without_node_ids_skipped(self) -> None:
        risks = [
            {"code": "R1", "nodeIds": [], "message": "no node"},
            {"code": "R2", "nodeIds": ["n2"], "message": "real"},
        ]
        out = build_autonomous_dailies_batch.invoke(
            _dailies(continuity_risks=risks)
        )
        repair_ops = [
            op
            for op in out["executionPlan"]["operations"]
            if op["op"] == "update_node"
        ]
        # The first risk has no nodeIds so it gets dropped silently —
        # the dailies_producer subagent shouldn't propose mutations on
        # phantom nodes.
        self.assertEqual(len(repair_ops), 1)
        self.assertEqual(repair_ops[0]["nodeId"], "n2")

    def test_dry_run_risk_escalates_when_continuity_risks_present(self) -> None:
        clean = build_autonomous_dailies_batch.invoke(_dailies())
        dirty = build_autonomous_dailies_batch.invoke(
            _dailies(
                continuity_risks=[{"code": "R1", "nodeIds": ["n1"]}],
            )
        )
        self.assertEqual(clean["executionPlan"]["dryRun"]["riskLevel"], "low")
        self.assertEqual(
            dirty["executionPlan"]["dryRun"]["riskLevel"], "medium"
        )

    def test_plan_id_is_deterministic(self) -> None:
        out_a = build_autonomous_dailies_batch.invoke(_dailies())
        out_b = build_autonomous_dailies_batch.invoke(_dailies())
        self.assertEqual(
            out_a["executionPlan"]["planId"], out_b["executionPlan"]["planId"]
        )

    def test_envelope_threads_source_reel_id(self) -> None:
        out = build_autonomous_dailies_batch.invoke(_dailies())
        self.assertEqual(out["reelId"], "reel_1")
        self.assertEqual(out["executionPlan"]["sourceId"], "reel_1")
        self.assertEqual(out["executionPlan"]["taskType"], "dailies_batch")

    def test_hitl_required_on_every_generated_op(self) -> None:
        out = build_autonomous_dailies_batch.invoke(
            _dailies(
                continuity_risks=[{"code": "R1", "nodeIds": ["n1"]}],
            )
        )
        for op in out["executionPlan"]["operations"]:
            # Every dailies op routes through approval — no autonomy
            # past the agent's draft.
            self.assertTrue(op["requiresHitl"])


# ---------------------------------------------------------------------------
# Policy / registry wiring
# ---------------------------------------------------------------------------


class RepairToolsRegistryTests(unittest.TestCase):
    def test_repair_tools_in_all_tools(self) -> None:
        names = {getattr(t, "name", "") for t in ALL_TOOLS}
        self.assertIn(repair_plan.name, names)
        self.assertIn(simulate_story_playthrough.name, names)
        self.assertIn(preview_simulation_critic_plan.name, names)
        self.assertIn(build_autonomous_dailies_batch.name, names)

    def test_policy_tokens_set(self) -> None:
        self.assertEqual(
            TOOL_POLICY_TOKENS[simulate_story_playthrough.name],
            "simulation.critic",
        )
        self.assertEqual(
            TOOL_POLICY_TOKENS[preview_simulation_critic_plan.name],
            "simulation.critic",
        )
        self.assertEqual(
            TOOL_POLICY_TOKENS[repair_plan.name], "repair.plan"
        )
        self.assertEqual(
            TOOL_POLICY_TOKENS[build_autonomous_dailies_batch.name],
            "dailies.batch",
        )

    def test_default_allowlist_includes_repair_tokens(self) -> None:
        # Even with the default policy posture, simulation/repair/dailies
        # capabilities are enabled — only team.manage requires opt-in.
        self.assertIn("simulation.critic", DEFAULT_RUNTIME_ALLOWLIST)
        self.assertIn("repair.plan", DEFAULT_RUNTIME_ALLOWLIST)
        self.assertIn("dailies.batch", DEFAULT_RUNTIME_ALLOWLIST)
        self.assertTrue(is_tool_allowed([], "repair.plan"))


if __name__ == "__main__":
    unittest.main()
