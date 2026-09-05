"""
M9.5 L1 — `approve_*` HITL tool unit tests.

The eight `approve_*` tools are the formal interrupt boundaries
between the agent and the producer. Each one wraps a payload (graph
patch, media prompt, execution plan, batch ops, dailies batch, merge
policy, repair plan, simulation critic plan) into a
`waiting_for_human` envelope that the bridge renders as an
`ApprovalCard`.

Pre-M9.5 these tools had zero direct tests — only registry-presence
checks. These tests pin:
  * the envelope shape (schemaVersion, status, action, input)
  * payload pass-through (no silent transformation of fields the
    bridge will forward to Convex)
  * `_sanitize_graph_operations` behavior on `approve_graph_patch`
    (the only approve_* that munges its input — drops unknown ops,
    coerces position to floats, filters bad node/edge types)
  * `approve_media_prompt`'s prompt + negativePrompt char caps
"""

from __future__ import annotations

import unittest
from typing import Any, Dict

from deep.tools import (
    ALL_TOOLS,
    SUPERVISOR_CORE_TOOLS,
    TOOL_POLICY_TOKENS,
    approve_batch_ops,
    approve_dailies_batch,
    approve_execution_plan,
    approve_graph_patch,
    approve_media_prompt,
    approve_merge_policy,
    approve_repair_plan,
    preview_simulation_critic_plan,
)


# ---------------------------------------------------------------------------
# approve_graph_patch (the only approve_* with meaningful input mangling)
# ---------------------------------------------------------------------------


class ApproveGraphPatchTests(unittest.TestCase):
    def test_shape_is_waiting_for_human(self) -> None:
        out = approve_graph_patch.invoke(
            {
                "patch_id": "patch_1",
                "title": "Add opening shot",
                "rationale": "Producer wants a cold open.",
                "diff_summary": "1 create_node",
                "operations": [
                    {
                        "op": "create_node",
                        "nodeId": "n1",
                        "nodeType": "shot",
                        "label": "Opening",
                        "segment": "wide of the airport",
                        "position": {"x": 100, "y": 200},
                    }
                ],
            }
        )
        self.assertEqual(out["status"], "waiting_for_human")
        self.assertEqual(out["action"], "approve_graph_patch")
        self.assertEqual(out["input"]["patchId"], "patch_1")
        self.assertEqual(len(out["input"]["operations"]), 1)

    def test_unknown_op_dropped(self) -> None:
        out = approve_graph_patch.invoke(
            {
                "patch_id": "patch_1",
                "title": "x",
                "rationale": "y",
                "diff_summary": "z",
                "operations": [
                    {"op": "create_node", "nodeId": "n1"},
                    {"op": "vortex_warp", "nodeId": "n2"},
                    {"op": "delete_node", "nodeId": "n3"},
                ],
            }
        )
        ops = out["input"]["operations"]
        self.assertEqual(len(ops), 2)
        self.assertEqual({op["op"] for op in ops}, {"create_node", "delete_node"})

    def test_unknown_node_type_filtered(self) -> None:
        out = approve_graph_patch.invoke(
            {
                "patch_id": "patch_1",
                "title": "x",
                "rationale": "y",
                "diff_summary": "z",
                "operations": [
                    {"op": "create_node", "nodeId": "n1", "nodeType": "shot"},
                    {"op": "create_node", "nodeId": "n2", "nodeType": "asteroid"},
                ],
            }
        )
        ops = out["input"]["operations"]
        # Both ops survive (the op type is allowed) but the bad
        # nodeType silently drops; the bridge will reject ops with no
        # nodeType, but we don't enforce that here.
        self.assertEqual(len(ops), 2)
        self.assertEqual(ops[0]["nodeType"], "shot")
        self.assertNotIn("nodeType", ops[1])

    def test_position_coerced_to_floats(self) -> None:
        out = approve_graph_patch.invoke(
            {
                "patch_id": "patch_1",
                "title": "x",
                "rationale": "y",
                "diff_summary": "z",
                "operations": [
                    {
                        "op": "create_node",
                        "nodeId": "n1",
                        "position": {"x": "100", "y": "200"},
                    }
                ],
            }
        )
        # The Pydantic boundary may already coerce, but the sanitizer
        # explicitly calls float(...) so we verify we don't leak a
        # string to Convex (which expects v.number()).
        pos = out["input"]["operations"][0]["position"]
        self.assertIsInstance(pos["x"], float)
        self.assertIsInstance(pos["y"], float)

    def test_is_primary_propagates_for_truthy_inputs(self) -> None:
        # Pydantic v2's `Optional[bool]` coerces boolean-like strings
        # ("yes", "true", "1") to True before our sanitizer runs. This
        # is intentional: the LLM occasionally emits string booleans,
        # and the schema captures the structural intent. Strictly-non-
        # boolean inputs (e.g. arbitrary strings) would still raise a
        # ValidationError at the tool boundary.
        out = approve_graph_patch.invoke(
            {
                "patch_id": "patch_1",
                "title": "x",
                "rationale": "y",
                "diff_summary": "z",
                "operations": [
                    {"op": "create_edge", "edgeId": "e1", "isPrimary": True},
                    {"op": "create_edge", "edgeId": "e2", "isPrimary": False},
                ],
            }
        )
        ops = out["input"]["operations"]
        self.assertTrue(ops[0]["isPrimary"])
        # `False` is a value, not absence — it should still propagate
        # so the bridge can flip an existing edge's isPrimary off.
        self.assertEqual(ops[1].get("isPrimary"), False)

    def test_empty_operations_yields_empty_list(self) -> None:
        out = approve_graph_patch.invoke(
            {
                "patch_id": "patch_1",
                "title": "x",
                "rationale": "y",
                "diff_summary": "z",
                "operations": [],
            }
        )
        self.assertEqual(out["input"]["operations"], [])


# ---------------------------------------------------------------------------
# approve_media_prompt (char caps)
# ---------------------------------------------------------------------------


class ApproveMediaPromptTests(unittest.TestCase):
    def test_shape_is_waiting_for_human(self) -> None:
        out = approve_media_prompt.invoke(
            {
                "node_id": "n1",
                "media_type": "image",
                "prompt": "A wide shot of an airport at dawn.",
                "negative_prompt": "blur, low quality",
                "context_summary": "Opening scene.",
            }
        )
        self.assertEqual(out["status"], "waiting_for_human")
        self.assertEqual(out["action"], "approve_media_prompt")
        self.assertEqual(out["input"]["nodeId"], "n1")
        self.assertEqual(out["input"]["mediaType"], "image")

    def test_prompt_capped_at_2400(self) -> None:
        out = approve_media_prompt.invoke(
            {
                "node_id": "n1",
                "media_type": "image",
                "prompt": "x " * 5000,
                "negative_prompt": "",
                "context_summary": "",
            }
        )
        self.assertLessEqual(len(out["input"]["prompt"]), 2400)

    def test_negative_prompt_capped_at_1200(self) -> None:
        out = approve_media_prompt.invoke(
            {
                "node_id": "n1",
                "media_type": "image",
                "prompt": "x",
                "negative_prompt": "x " * 5000,
                "context_summary": "",
            }
        )
        self.assertLessEqual(len(out["input"]["negativePrompt"]), 1200)

    def test_whitespace_collapsed(self) -> None:
        # Multi-line LLM output gets collapsed to single spaces so the
        # producer sees a clean prompt.
        out = approve_media_prompt.invoke(
            {
                "node_id": "n1",
                "media_type": "image",
                "prompt": "wide   shot\n\nof airport",
                "negative_prompt": "",
                "context_summary": "",
            }
        )
        self.assertEqual(out["input"]["prompt"], "wide shot of airport")


# ---------------------------------------------------------------------------
# approve_execution_plan / approve_batch_ops / approve_dailies_batch
# (pure pass-through wrappers)
# ---------------------------------------------------------------------------


class ApproveExecutionPlanTests(unittest.TestCase):
    def test_shape_is_waiting_for_human(self) -> None:
        ops = [{"op": "create_node", "opId": "c1"}]
        dry = {"valid": True, "riskLevel": "low", "issues": []}
        out = approve_execution_plan.invoke(
            {
                "plan_id": "p1",
                "storyboard_id": "sb_1",
                "branch_id": "main",
                "title": "Three-shot batch",
                "rationale": "Producer approved.",
                "operations": ops,
                "dry_run": dry,
            }
        )
        self.assertEqual(out["status"], "waiting_for_human")
        self.assertEqual(out["action"], "approve_execution_plan")
        # All fields round-trip unchanged so the bridge can hand them
        # straight to `narrativeGit:commitPlanOps`.
        self.assertEqual(out["input"]["planId"], "p1")
        self.assertEqual(out["input"]["operations"], ops)
        self.assertEqual(out["input"]["dryRun"], dry)


class ApproveBatchOpsTests(unittest.TestCase):
    def test_shape_is_waiting_for_human(self) -> None:
        ops = [{"op": "update_node", "opId": "u1"}]
        dry = {"valid": True, "riskLevel": "low", "issues": []}
        out = approve_batch_ops.invoke(
            {"plan_id": "p1", "operations": ops, "dry_run": dry}
        )
        self.assertEqual(out["status"], "waiting_for_human")
        self.assertEqual(out["action"], "approve_batch_ops")
        self.assertEqual(out["input"]["operations"], ops)
        self.assertEqual(out["input"]["dryRun"], dry)


class ApproveDailiesBatchTests(unittest.TestCase):
    def test_shape_is_waiting_for_human(self) -> None:
        ops = [{"op": "generate_image", "opId": "g1", "nodeId": "n1"}]
        dry = {"valid": True, "riskLevel": "low", "issues": []}
        out = approve_dailies_batch.invoke(
            {
                "plan_id": "dailyplan_1",
                "storyboard_id": "sb_1",
                "branch_id": "main",
                "title": "Tuesday dailies",
                "rationale": "Coverage pass",
                "source_id": "reel_1",
                "operations": ops,
                "dry_run": dry,
            }
        )
        self.assertEqual(out["status"], "waiting_for_human")
        self.assertEqual(out["action"], "approve_dailies_batch")
        # source/sourceId/taskType are added by the wrapper itself —
        # the agent doesn't have to thread them.
        self.assertEqual(out["input"]["source"], "dailies")
        self.assertEqual(out["input"]["sourceId"], "reel_1")
        self.assertEqual(out["input"]["taskType"], "dailies_batch")


# ---------------------------------------------------------------------------
# approve_merge_policy / approve_repair_plan / preview_simulation_critic_plan
# (preview already covered in test_repair_tools.py — repeated here only
# for the registry assertions to feel symmetric)
# ---------------------------------------------------------------------------


class ApproveMergePolicyTests(unittest.TestCase):
    def test_shape_and_pass_through(self) -> None:
        diff = {"changedNodes": ["n1", "n2"]}
        out = approve_merge_policy.invoke(
            {
                "branch_id": "main",
                "source_branch_id": "variant/hook-question",
                "target_branch_id": "main",
                "policy": "pick_variant",
                "semantic_diff": diff,
            }
        )
        self.assertEqual(out["status"], "waiting_for_human")
        self.assertEqual(out["action"], "approve_merge_policy")
        self.assertEqual(out["input"]["policy"], "pick_variant")
        self.assertEqual(out["input"]["semanticDiff"], diff)


class ApproveRepairPlanTests(unittest.TestCase):
    def test_shape_and_confidence_passthrough(self) -> None:
        ops = [{"opId": "repair_1", "op": "update_node"}]
        out = approve_repair_plan.invoke(
            {
                "repair_plan_id": "repairplan_1",
                "operations": ops,
                "confidence": 0.72,
            }
        )
        self.assertEqual(out["status"], "waiting_for_human")
        self.assertEqual(out["action"], "approve_repair_plan")
        self.assertEqual(out["input"]["operations"], ops)
        self.assertEqual(out["input"]["confidence"], 0.72)


# ---------------------------------------------------------------------------
# Policy / registry wiring
# ---------------------------------------------------------------------------


APPROVE_TOOLS = (
    approve_graph_patch,
    approve_media_prompt,
    approve_execution_plan,
    approve_batch_ops,
    preview_simulation_critic_plan,
    approve_dailies_batch,
    approve_merge_policy,
    approve_repair_plan,
)


class ApproveToolsRegistryTests(unittest.TestCase):
    def test_all_approve_tools_in_all_tools(self) -> None:
        names = {getattr(t, "name", "") for t in ALL_TOOLS}
        for tool in APPROVE_TOOLS:
            self.assertIn(tool.name, names, f"{tool.name} missing from ALL_TOOLS")

    def test_all_approve_tools_on_supervisor_core(self) -> None:
        # Approval gates MUST live on the supervisor — they're the
        # boundary between agent intent and producer consent. If any
        # approve_* drifts into a subagent-only scope, the supervisor
        # loses the ability to fire the gate without delegating.
        names = {getattr(t, "name", "") for t in SUPERVISOR_CORE_TOOLS}
        for tool in APPROVE_TOOLS:
            self.assertIn(
                tool.name,
                names,
                f"{tool.name} should be on SUPERVISOR_CORE_TOOLS",
            )

    def test_approve_tools_have_policy_tokens(self) -> None:
        # Each approve_* shares its token with the underlying capability
        # it gates (graph.patch / media.prompt / execution.plan / etc.)
        # rather than getting its own token. That symmetry means
        # disabling `graph.patch` also disables `approve_graph_patch`.
        expected = {
            approve_graph_patch.name: "graph.patch",
            approve_media_prompt.name: "media.prompt",
            approve_execution_plan.name: "execution.plan",
            approve_batch_ops.name: "execution.plan",
            preview_simulation_critic_plan.name: "simulation.critic",
            approve_dailies_batch.name: "dailies.batch",
            approve_merge_policy.name: "branch.merge",
            approve_repair_plan.name: "repair.plan",
        }
        for name, token in expected.items():
            self.assertEqual(
                TOOL_POLICY_TOKENS[name],
                token,
                f"{name} should be gated by {token}",
            )


if __name__ == "__main__":
    unittest.main()
