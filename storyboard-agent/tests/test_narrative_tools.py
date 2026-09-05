"""
M9 Phase 2 — narrative analysis tools + beat-assignment HITL.

Tests are unit-scoped: the tools are pure deterministic helpers, so we
feed synthetic shot lists + beat plans and assert the output shape +
reconciliation rules.
"""

from __future__ import annotations

import unittest
from typing import Any, Dict

from deep.tools import (
    ALL_TOOLS,
    DEFAULT_RUNTIME_ALLOWLIST,
    SUPERVISOR_CORE_TOOLS,
    TOOL_POLICY_TOKENS,
    detect_beat_gaps,
    detect_beat_plan,
    detect_motif_gaps,
    is_tool_allowed,
    request_beat_assignment,
    request_hook_variants,
    request_motif_plant,
    request_structural_remix,
    request_transition_proposal,
    sample_tension_curve,
)


# ---------------------------------------------------------------------------
# sample_tension_curve
# ---------------------------------------------------------------------------


class SampleTensionCurveTests(unittest.TestCase):
    def test_empty_list_returns_empty_output(self) -> None:
        out = sample_tension_curve.invoke({"shots": []})
        self.assertEqual(out["samples"], [])
        self.assertEqual(out["dips"], [])

    def test_baseline_score_is_midrange(self) -> None:
        out = sample_tension_curve.invoke(
            {"shots": [{"nodeId": "n1", "segment": "A neutral wide shot."}]},
        )
        # Baseline 3.0 + no bonuses = 3.0.
        self.assertEqual(out["samples"][0]["value"], 3.0)

    def test_dynamic_camera_lifts_score(self) -> None:
        out = sample_tension_curve.invoke(
            {
                "shots": [
                    {
                        "nodeId": "n1",
                        "segment": "Handheld chase through the market.",
                        "shotMeta": {"move": "handheld", "size": "MCU"},
                    }
                ],
            }
        )
        # 3.0 + handheld(+2) + MCU tight(+2) + "chase" keyword(+2) = 9.0.
        self.assertEqual(out["samples"][0]["value"], 9.0)

    def test_low_tension_keyword_subtracts(self) -> None:
        out = sample_tension_curve.invoke(
            {
                "shots": [
                    {
                        "nodeId": "n1",
                        "segment": "A peaceful moment at the lake.",
                        "shotMeta": {"move": "static", "size": "EWS"},
                    }
                ],
            }
        )
        # 3.0 + static wide penalty(-1) + "peaceful" keyword(-1) = 1.0.
        self.assertEqual(out["samples"][0]["value"], 1.0)

    def test_high_tension_keywords_cap_additive_bonus(self) -> None:
        # Multiple high-tension words in one segment should NOT saturate
        # the score beyond the +2 cap — otherwise a shot with five
        # "scream"s drowns out the rest of the reel's curve.
        out = sample_tension_curve.invoke(
            {
                "shots": [
                    {
                        "nodeId": "n1",
                        "segment": "Scream scream scream scream scream.",
                    }
                ],
            }
        )
        # 3.0 + high keyword(+2 cap, not +10) = 5.0.
        self.assertEqual(out["samples"][0]["value"], 5.0)

    def test_score_clamped_to_zero_to_ten(self) -> None:
        out = sample_tension_curve.invoke(
            {
                "shots": [
                    {
                        "nodeId": "hot",
                        "segment": "Explosion. Scream. Kill. Blood.",
                        "shotMeta": {
                            "move": "whip_pan",
                            "size": "ECU",
                            "sfx": ["gunshot"],
                            "vfx": ["muzzle_flash"],
                        },
                    }
                ],
            }
        )
        # 3 + whip_pan(+2) + ECU(+2) + sfx(+1) + vfx(+1) + high kw(+2) = 11 → clamped 10.
        self.assertEqual(out["samples"][0]["value"], 10.0)

    def test_dip_detection_flags_big_drops(self) -> None:
        out = sample_tension_curve.invoke(
            {
                "shots": [
                    # Shot 1: dynamic + action keyword → high score.
                    {
                        "nodeId": "n1",
                        "segment": "Chase through alleys.",
                        "shotMeta": {"move": "handheld", "size": "CU"},
                    },
                    # Shot 2: static wide calm → low score, big drop.
                    {
                        "nodeId": "n2",
                        "segment": "Calm lake at sunrise.",
                        "shotMeta": {"move": "static", "size": "EWS"},
                    },
                ],
            }
        )
        # n1=9, n2=1 → drop of 8.
        self.assertEqual(len(out["dips"]), 1)
        self.assertEqual(out["dips"][0]["fromNodeId"], "n1")
        self.assertEqual(out["dips"][0]["toNodeId"], "n2")
        self.assertEqual(out["dips"][0]["severity"], "high")

    def test_dip_detection_medium_severity(self) -> None:
        out = sample_tension_curve.invoke(
            {
                "shots": [
                    {"nodeId": "n1", "shotMeta": {"move": "handheld"}},
                    # No move, no keywords — score 3.
                    {"nodeId": "n2"},
                ],
            }
        )
        # n1=5 (handheld +2), n2=3. Drop 2 < threshold 3 → no dip.
        self.assertEqual(len(out["dips"]), 0)

    def test_missing_node_id_dropped(self) -> None:
        out = sample_tension_curve.invoke(
            {"shots": [{"segment": "orphan", "nodeId": ""}]}
        )
        self.assertEqual(out["samples"], [])


# ---------------------------------------------------------------------------
# detect_beat_plan
# ---------------------------------------------------------------------------


class DetectBeatPlanTests(unittest.TestCase):
    def test_unknown_structure_falls_back_to_save_the_cat(self) -> None:
        out = detect_beat_plan.invoke(
            {"structure": "not-a-real-structure", "shots": []}
        )
        self.assertEqual(out["structure"], "save_the_cat")
        self.assertEqual(len(out["beats"]), 15)

    def test_empty_shots_returns_all_planned(self) -> None:
        out = detect_beat_plan.invoke(
            {"structure": "hook_first", "shots": []}
        )
        self.assertEqual(out["structure"], "hook_first")
        for b in out["beats"]:
            self.assertEqual(b["status"], "planned")
            self.assertNotIn("nodeId", b)

    def test_save_the_cat_positional_hints_place_opening_at_first_shot(
        self,
    ) -> None:
        shots = [{"nodeId": f"n{i}"} for i in range(10)]
        out = detect_beat_plan.invoke(
            {"structure": "save_the_cat", "shots": shots}
        )
        by_key = {b["beatKey"]: b for b in out["beats"]}
        self.assertEqual(by_key["opening_image"]["nodeId"], "n0")
        self.assertEqual(by_key["final_image"]["nodeId"], "n9")
        # Midpoint at ~0.5 × 9 = 4.5 → Python's banker's rounding picks
        # 4 (round half to even). The heuristic is directional, not
        # millimeter-precise, so n4 or n5 both satisfy "midpoint".
        self.assertIn(by_key["midpoint"]["nodeId"], {"n4", "n5"})

    def test_existing_assigned_slots_are_preserved(self) -> None:
        shots = [{"nodeId": f"n{i}"} for i in range(10)]
        existing = [
            {
                "beatKey": "opening_image",
                "nodeId": "custom_opener",
                "status": "assigned",
                "expectedActNumber": 1,
                "rationale": "producer chose this",
            }
        ]
        out = detect_beat_plan.invoke(
            {
                "structure": "save_the_cat",
                "shots": shots,
                "existing_assignments": existing,
            }
        )
        by_key = {b["beatKey"]: b for b in out["beats"]}
        self.assertEqual(by_key["opening_image"]["nodeId"], "custom_opener")
        self.assertEqual(by_key["opening_image"]["status"], "assigned")

    def test_proposed_beats_are_planned_not_assigned(self) -> None:
        # The tool is a PROPOSER. It never returns status=assigned for
        # its own heuristic output — the HITL flip happens only via
        # request_beat_assignment + producer approval.
        shots = [{"nodeId": f"n{i}"} for i in range(5)]
        out = detect_beat_plan.invoke(
            {"structure": "hook_first", "shots": shots}
        )
        for beat in out["beats"]:
            if "nodeId" in beat:
                self.assertEqual(beat["status"], "planned")

    def test_unassignable_beats_appear_in_unassignedBeatKeys(self) -> None:
        out = detect_beat_plan.invoke(
            {"structure": "kishotenketsu", "shots": []}
        )
        self.assertEqual(
            sorted(out["unassignedBeatKeys"]),
            sorted(["ki", "sho", "ten", "ketsu"]),
        )

    def test_harmon_circle_evenly_distributes_without_positional_hints(
        self,
    ) -> None:
        # No positional hints for harmon_circle → even distribution.
        shots = [{"nodeId": f"n{i}"} for i in range(16)]
        out = detect_beat_plan.invoke(
            {"structure": "harmon_circle", "shots": shots}
        )
        by_key = {b["beatKey"]: b for b in out["beats"]}
        # First beat → first shot, last beat → last shot.
        self.assertEqual(by_key["you"]["nodeId"], "n0")
        self.assertEqual(by_key["change"]["nodeId"], "n15")


# ---------------------------------------------------------------------------
# detect_beat_gaps
# ---------------------------------------------------------------------------


class DetectBeatGapsTests(unittest.TestCase):
    def test_empty_plan_reports_no_gaps(self) -> None:
        out = detect_beat_gaps.invoke({"beats": []})
        self.assertEqual(out["gapCount"], 0)

    def test_planned_slots_are_medium_severity(self) -> None:
        out = detect_beat_gaps.invoke(
            {
                "beats": [
                    {"beatKey": "opening_image", "status": "assigned", "nodeId": "n1"},
                    {"beatKey": "midpoint", "status": "planned"},
                ],
            }
        )
        self.assertEqual(out["gapCount"], 1)
        self.assertEqual(out["plannedBeatKeys"], ["midpoint"])
        self.assertEqual(out["gaps"][0]["severity"], "medium")

    def test_missing_slots_are_high_severity(self) -> None:
        out = detect_beat_gaps.invoke(
            {
                "beats": [
                    {"beatKey": "finale", "status": "missing", "nodeId": "deleted_shot"},
                    {"beatKey": "cta", "status": "assigned", "nodeId": "n9"},
                ],
            }
        )
        self.assertEqual(out["gapCount"], 1)
        self.assertEqual(out["missingBeatKeys"], ["finale"])
        self.assertEqual(out["gaps"][0]["severity"], "high")


# ---------------------------------------------------------------------------
# request_beat_assignment (HITL tool)
# ---------------------------------------------------------------------------


class RequestBeatAssignmentTests(unittest.TestCase):
    def test_shape_is_waiting_for_human(self) -> None:
        out = request_beat_assignment.invoke(
            {
                "storyboard_id": "sb_1",
                "branch_id": "main",
                "structure": "save_the_cat",
                "assignments": [
                    {"nodeId": "n1", "beatKey": "opening_image"},
                ],
                "rationale": "Producer asked for a beat pass.",
            }
        )
        self.assertEqual(out["status"], "waiting_for_human")
        self.assertEqual(out["action"], "request_beat_assignment")
        self.assertEqual(out["input"]["structure"], "save_the_cat")
        self.assertEqual(out["input"]["assignmentCount"], 1)
        self.assertFalse(out["input"]["overrideExisting"])

    def test_hallucinated_beat_keys_dropped(self) -> None:
        # beat_analyst sometimes invents beat keys that don't exist
        # in the structure's canonical roster. The tool must drop them
        # before the producer sees a confusing approval card.
        out = request_beat_assignment.invoke(
            {
                "storyboard_id": "sb_1",
                "branch_id": "main",
                "structure": "save_the_cat",
                "assignments": [
                    {"nodeId": "n1", "beatKey": "opening_image"},
                    {"nodeId": "n2", "beatKey": "made_up_beat"},
                    {"nodeId": "n3", "beatKey": "midpoint"},
                ],
                "rationale": "",
            }
        )
        keys = [a["beatKey"] for a in out["input"]["assignments"]]
        self.assertIn("opening_image", keys)
        self.assertIn("midpoint", keys)
        self.assertNotIn("made_up_beat", keys)
        self.assertEqual(out["input"]["assignmentCount"], 2)

    def test_unknown_structure_falls_back_to_save_the_cat(self) -> None:
        out = request_beat_assignment.invoke(
            {
                "storyboard_id": "sb_1",
                "branch_id": "main",
                "structure": "not-a-structure",
                "assignments": [
                    {"nodeId": "n1", "beatKey": "opening_image"},
                ],
                "rationale": "",
            }
        )
        self.assertEqual(out["input"]["structure"], "save_the_cat")

    def test_missing_nodeId_or_beatKey_skipped(self) -> None:
        out = request_beat_assignment.invoke(
            {
                "storyboard_id": "sb_1",
                "branch_id": "main",
                "structure": "hook_first",
                "assignments": [
                    {"nodeId": "", "beatKey": "hook"},
                    {"nodeId": "n1", "beatKey": ""},
                    {"nodeId": "n2", "beatKey": "hook"},
                ],
                "rationale": "",
            }
        )
        self.assertEqual(out["input"]["assignmentCount"], 1)
        self.assertEqual(
            out["input"]["assignments"][0]["nodeId"], "n2"
        )

    def test_act_number_clamped_to_one_through_five(self) -> None:
        out = request_beat_assignment.invoke(
            {
                "storyboard_id": "sb_1",
                "branch_id": "main",
                "structure": "save_the_cat",
                "assignments": [
                    {"nodeId": "n1", "beatKey": "opening_image", "actNumber": 0},
                    {"nodeId": "n2", "beatKey": "midpoint", "actNumber": 99},
                    {"nodeId": "n3", "beatKey": "finale", "actNumber": 2},
                ],
                "rationale": "",
            }
        )
        acts = {a["beatKey"]: a.get("actNumber") for a in out["input"]["assignments"]}
        self.assertEqual(acts["opening_image"], 1)  # floored
        self.assertEqual(acts["midpoint"], 5)  # capped
        self.assertEqual(acts["finale"], 2)

    def test_rationale_capped_at_1200_chars(self) -> None:
        out = request_beat_assignment.invoke(
            {
                "storyboard_id": "sb_1",
                "branch_id": "main",
                "structure": "save_the_cat",
                "assignments": [{"nodeId": "n1", "beatKey": "opening_image"}],
                "rationale": "x" * 5000,
            }
        )
        self.assertLessEqual(len(out["input"]["rationale"]), 1200)

    def test_branch_id_defaults_to_main(self) -> None:
        out = request_beat_assignment.invoke(
            {
                "storyboard_id": "sb_1",
                "branch_id": "",
                "structure": "save_the_cat",
                "assignments": [{"nodeId": "n1", "beatKey": "opening_image"}],
                "rationale": "",
            }
        )
        self.assertEqual(out["input"]["branchId"], "main")


# ---------------------------------------------------------------------------
# request_hook_variants (M9 Phase 3)
# ---------------------------------------------------------------------------


def _valid_plan_op(title: str = "New cold-open shot") -> Dict[str, Any]:
    return {
        "op": "create_node",
        "title": title,
        "rationale": "Opens on a question.",
    }


class RequestHookVariantsTests(unittest.TestCase):
    def test_shape_is_waiting_for_human(self) -> None:
        out = request_hook_variants.invoke(
            {
                "storyboard_id": "sb_1",
                "branch_id": "main",
                "variants": [
                    {
                        "variantId": "question",
                        "rationale": "Open on an unanswered question.",
                        "expectedRetention": "high",
                        "planOps": [_valid_plan_op()],
                    },
                ],
                "rationale": "Producer asked for cold-open variants.",
            }
        )
        self.assertEqual(out["status"], "waiting_for_human")
        self.assertEqual(out["action"], "request_hook_variants")
        self.assertEqual(out["input"]["variantCount"], 1)
        self.assertEqual(
            out["input"]["variants"][0]["variantId"], "question"
        )

    def test_variants_without_plan_ops_dropped(self) -> None:
        # An agent may hallucinate a variant with an empty planOps list
        # or with only invalid ops; those shouldn't reach the card.
        out = request_hook_variants.invoke(
            {
                "storyboard_id": "sb_1",
                "branch_id": "main",
                "variants": [
                    {"variantId": "empty", "planOps": []},
                    {
                        "variantId": "only-garbage",
                        "planOps": [{"op": "not_a_real_op", "title": "x"}],
                    },
                    {
                        "variantId": "valid",
                        "planOps": [_valid_plan_op()],
                    },
                ],
                "rationale": "",
            }
        )
        ids = [v["variantId"] for v in out["input"]["variants"]]
        self.assertEqual(ids, ["valid"])
        self.assertEqual(out["input"]["variantCount"], 1)

    def test_variant_id_sanitized_to_url_safe(self) -> None:
        out = request_hook_variants.invoke(
            {
                "storyboard_id": "sb_1",
                "branch_id": "main",
                "variants": [
                    {
                        "variantId": "Question / Hook!!",
                        "planOps": [_valid_plan_op()],
                    },
                ],
                "rationale": "",
            }
        )
        vid = out["input"]["variants"][0]["variantId"]
        # Alphanumerics + dashes/underscores only; spaces + punctuation replaced.
        self.assertTrue(all(c.isalnum() or c in "-_" for c in vid))

    def test_variant_id_capped_at_40_chars(self) -> None:
        out = request_hook_variants.invoke(
            {
                "storyboard_id": "sb_1",
                "branch_id": "main",
                "variants": [
                    {
                        "variantId": "x" * 200,
                        "planOps": [_valid_plan_op()],
                    },
                ],
                "rationale": "",
            }
        )
        self.assertLessEqual(
            len(out["input"]["variants"][0]["variantId"]), 40
        )

    def test_branch_name_defaulted_when_missing(self) -> None:
        out = request_hook_variants.invoke(
            {
                "storyboard_id": "sb_1",
                "branch_id": "main",
                "variants": [
                    {
                        "variantId": "question",
                        "planOps": [_valid_plan_op()],
                    },
                ],
                "rationale": "",
            }
        )
        self.assertIn(
            "question", out["input"]["variants"][0]["branchName"].lower()
        )

    def test_parent_branch_id_defaults_to_main(self) -> None:
        out = request_hook_variants.invoke(
            {
                "storyboard_id": "sb_1",
                "branch_id": "",
                "variants": [
                    {
                        "variantId": "question",
                        "planOps": [_valid_plan_op()],
                    },
                ],
                "rationale": "",
            }
        )
        self.assertEqual(out["input"]["parentBranchId"], "main")

    def test_empty_variants_yields_zero_count(self) -> None:
        out = request_hook_variants.invoke(
            {
                "storyboard_id": "sb_1",
                "branch_id": "main",
                "variants": [],
                "rationale": "",
            }
        )
        self.assertEqual(out["input"]["variantCount"], 0)
        self.assertEqual(out["input"]["variants"], [])

    def test_variant_missing_variant_id_dropped(self) -> None:
        # Pydantic already rejects non-dict entries at the tool
        # boundary; the sanitizer's job is to drop entries that pass
        # type validation but are semantically unusable.
        out = request_hook_variants.invoke(
            {
                "storyboard_id": "sb_1",
                "branch_id": "main",
                "variants": [
                    {"variantId": "", "planOps": [_valid_plan_op()]},
                    {"planOps": [_valid_plan_op()]},
                    {
                        "variantId": "ok",
                        "planOps": [_valid_plan_op()],
                    },
                ],
                "rationale": "",
            }
        )
        self.assertEqual(out["input"]["variantCount"], 1)
        self.assertEqual(
            out["input"]["variants"][0]["variantId"], "ok"
        )


# ---------------------------------------------------------------------------
# request_structural_remix (M9 Phase 3)
# ---------------------------------------------------------------------------


class RequestStructuralRemixTests(unittest.TestCase):
    def test_shape_is_waiting_for_human(self) -> None:
        out = request_structural_remix.invoke(
            {
                "storyboard_id": "sb_1",
                "branch_id": "main",
                "target_structure": "harmon_circle",
                "variants": [
                    {
                        "variantId": "harmon-reframe",
                        "strategy": "harmon_reframe",
                        "rationale": "Reframe the reel as an 8-beat circle.",
                        "planOps": [_valid_plan_op("Reorder to Harmon")],
                    },
                ],
                "rationale": "Producer asked for a remix.",
            }
        )
        self.assertEqual(out["status"], "waiting_for_human")
        self.assertEqual(out["action"], "request_structural_remix")
        self.assertEqual(out["input"]["targetStructure"], "harmon_circle")
        self.assertEqual(out["input"]["variantCount"], 1)
        self.assertEqual(
            out["input"]["variants"][0]["strategy"], "harmon_reframe"
        )

    def test_unknown_target_structure_falls_back(self) -> None:
        out = request_structural_remix.invoke(
            {
                "storyboard_id": "sb_1",
                "branch_id": "main",
                "target_structure": "not-a-structure",
                "variants": [
                    {
                        "variantId": "v1",
                        "planOps": [_valid_plan_op()],
                    },
                ],
                "rationale": "",
            }
        )
        self.assertEqual(out["input"]["targetStructure"], "save_the_cat")

    def test_strategy_capped_at_60_chars(self) -> None:
        out = request_structural_remix.invoke(
            {
                "storyboard_id": "sb_1",
                "branch_id": "main",
                "target_structure": "save_the_cat",
                "variants": [
                    {
                        "variantId": "v1",
                        "strategy": "x" * 500,
                        "planOps": [_valid_plan_op()],
                    },
                ],
                "rationale": "",
            }
        )
        self.assertLessEqual(
            len(out["input"]["variants"][0]["strategy"]), 60
        )

    def test_variants_without_plan_ops_dropped(self) -> None:
        out = request_structural_remix.invoke(
            {
                "storyboard_id": "sb_1",
                "branch_id": "main",
                "target_structure": "three_act",
                "variants": [
                    {"variantId": "empty", "planOps": []},
                    {
                        "variantId": "valid",
                        "planOps": [_valid_plan_op("Move midpoint")],
                    },
                ],
                "rationale": "",
            }
        )
        ids = [v["variantId"] for v in out["input"]["variants"]]
        self.assertEqual(ids, ["valid"])

    def test_branch_name_includes_target_structure(self) -> None:
        out = request_structural_remix.invoke(
            {
                "storyboard_id": "sb_1",
                "branch_id": "main",
                "target_structure": "harmon_circle",
                "variants": [
                    {
                        "variantId": "v1",
                        "planOps": [_valid_plan_op()],
                    },
                ],
                "rationale": "",
            }
        )
        branch_name = out["input"]["variants"][0]["branchName"]
        self.assertIn("harmon", branch_name.lower())

    def test_rationale_capped_at_1200_chars(self) -> None:
        out = request_structural_remix.invoke(
            {
                "storyboard_id": "sb_1",
                "branch_id": "main",
                "target_structure": "save_the_cat",
                "variants": [
                    {
                        "variantId": "v1",
                        "planOps": [_valid_plan_op()],
                    },
                ],
                "rationale": "x" * 8000,
            }
        )
        self.assertLessEqual(len(out["input"]["rationale"]), 1200)


# ---------------------------------------------------------------------------
# request_transition_proposal (M9 Phase 4)
# ---------------------------------------------------------------------------


class RequestTransitionProposalTests(unittest.TestCase):
    def test_shape_is_waiting_for_human(self) -> None:
        out = request_transition_proposal.invoke(
            {
                "storyboard_id": "sb_1",
                "branch_id": "main",
                "source_node_id": "n1",
                "target_node_id": "n2",
                "proposals": [
                    {
                        "intent": "match_cut",
                        "rationale": "Crimson umbrella bridges n1 + n2.",
                        "sharedElement": "crimson umbrella",
                        "rank": 1,
                    },
                ],
                "rationale": "Producer asked for transitions.",
            }
        )
        self.assertEqual(out["status"], "waiting_for_human")
        self.assertEqual(out["action"], "request_transition_proposal")
        self.assertEqual(out["input"]["sourceNodeId"], "n1")
        self.assertEqual(out["input"]["targetNodeId"], "n2")
        self.assertEqual(out["input"]["proposalCount"], 1)

    def test_unknown_intent_falls_back_to_hard_cut(self) -> None:
        out = request_transition_proposal.invoke(
            {
                "storyboard_id": "sb_1",
                "branch_id": "main",
                "source_node_id": "n1",
                "target_node_id": "n2",
                "proposals": [
                    {"intent": "vortex_warp", "rationale": "."},
                ],
                "rationale": "",
            }
        )
        self.assertEqual(out["input"]["proposals"][0]["intent"], "hard_cut")
        # rawIntent preserves what the LLM asked for so the approval
        # card can surface "LLM suggested 'vortex_warp' → normalized to
        # 'hard_cut'" for producer transparency.
        self.assertEqual(
            out["input"]["proposals"][0]["rawIntent"], "vortex_warp"
        )

    def test_proposals_sorted_by_rank(self) -> None:
        out = request_transition_proposal.invoke(
            {
                "storyboard_id": "sb_1",
                "branch_id": "main",
                "source_node_id": "n1",
                "target_node_id": "n2",
                "proposals": [
                    {"intent": "j_cut", "rank": 3},
                    {"intent": "match_cut", "rank": 1},
                    {"intent": "l_cut", "rank": 2},
                ],
                "rationale": "",
            }
        )
        intents = [p["intent"] for p in out["input"]["proposals"]]
        self.assertEqual(intents, ["match_cut", "l_cut", "j_cut"])

    def test_empty_intent_skipped(self) -> None:
        out = request_transition_proposal.invoke(
            {
                "storyboard_id": "sb_1",
                "branch_id": "main",
                "source_node_id": "n1",
                "target_node_id": "n2",
                "proposals": [
                    {"intent": "", "rank": 1},
                    {"intent": "match_cut", "rank": 2},
                ],
                "rationale": "",
            }
        )
        self.assertEqual(out["input"]["proposalCount"], 1)
        self.assertEqual(
            out["input"]["proposals"][0]["intent"], "match_cut"
        )

    def test_shared_element_capped_at_200_chars(self) -> None:
        out = request_transition_proposal.invoke(
            {
                "storyboard_id": "sb_1",
                "branch_id": "main",
                "source_node_id": "n1",
                "target_node_id": "n2",
                "proposals": [
                    {
                        "intent": "match_cut",
                        "sharedElement": "x" * 1000,
                    },
                ],
                "rationale": "",
            }
        )
        self.assertLessEqual(
            len(out["input"]["proposals"][0]["sharedElement"]), 200
        )

    def test_rank_clamped_to_one_through_ten(self) -> None:
        out = request_transition_proposal.invoke(
            {
                "storyboard_id": "sb_1",
                "branch_id": "main",
                "source_node_id": "n1",
                "target_node_id": "n2",
                "proposals": [
                    {"intent": "match_cut", "rank": -50},
                    {"intent": "j_cut", "rank": 999},
                ],
                "rationale": "",
            }
        )
        ranks = {p["intent"]: p["rank"] for p in out["input"]["proposals"]}
        self.assertEqual(ranks["match_cut"], 1)
        self.assertEqual(ranks["j_cut"], 10)

    def test_plan_ops_sanitized(self) -> None:
        out = request_transition_proposal.invoke(
            {
                "storyboard_id": "sb_1",
                "branch_id": "main",
                "source_node_id": "n1",
                "target_node_id": "n2",
                "proposals": [
                    {
                        "intent": "match_cut",
                        "planOps": [
                            {"op": "create_node", "title": "Plant umbrella"},
                            {"op": "not_a_real_op", "title": "bad"},
                        ],
                    },
                ],
                "rationale": "",
            }
        )
        ops = out["input"]["proposals"][0]["planOps"]
        self.assertEqual(len(ops), 1)
        self.assertEqual(ops[0]["op"], "create_node")


# ---------------------------------------------------------------------------
# request_motif_plant (M9 Phase 4)
# ---------------------------------------------------------------------------


class RequestMotifPlantTests(unittest.TestCase):
    def test_shape_is_waiting_for_human(self) -> None:
        out = request_motif_plant.invoke(
            {
                "storyboard_id": "sb_1",
                "branch_id": "main",
                "motif_key": "red-umbrella",
                "target_node_id": "n18",
                "plan_ops": [
                    {"op": "update_node", "title": "Add motif to n18"},
                ],
                "rationale": "Land planted umbrella.",
                "visual_vocabulary": "crimson fabric, rain-beaded",
                "payoff_node_ids": ["n18"],
                "source_node_ids": ["n3"],
            }
        )
        self.assertEqual(out["status"], "waiting_for_human")
        self.assertEqual(out["action"], "request_motif_plant")
        self.assertEqual(out["input"]["motifKey"], "red-umbrella")
        self.assertEqual(out["input"]["targetNodeId"], "n18")
        self.assertEqual(
            out["input"]["visualVocabulary"], "crimson fabric, rain-beaded"
        )
        self.assertEqual(out["input"]["sourceNodeIds"], ["n3"])
        self.assertEqual(out["input"]["payoffNodeIds"], ["n18"])
        self.assertEqual(len(out["input"]["planOps"]), 1)

    def test_motif_key_slug_sanitized(self) -> None:
        out = request_motif_plant.invoke(
            {
                "storyboard_id": "sb_1",
                "branch_id": "main",
                "motif_key": "Red Umbrella!! (main)",
                "target_node_id": "n1",
                "plan_ops": [],
                "rationale": "",
            }
        )
        key = out["input"]["motifKey"]
        self.assertTrue(all(c.isalnum() or c in "-_" for c in key))

    def test_empty_motif_key_gets_fallback(self) -> None:
        out = request_motif_plant.invoke(
            {
                "storyboard_id": "sb_1",
                "branch_id": "main",
                "motif_key": "",
                "target_node_id": "n1",
                "plan_ops": [],
                "rationale": "",
            }
        )
        self.assertEqual(out["input"]["motifKey"], "unnamed-motif")

    def test_motif_key_capped_at_60_chars(self) -> None:
        out = request_motif_plant.invoke(
            {
                "storyboard_id": "sb_1",
                "branch_id": "main",
                "motif_key": "x" * 500,
                "target_node_id": "n1",
                "plan_ops": [],
                "rationale": "",
            }
        )
        self.assertLessEqual(len(out["input"]["motifKey"]), 60)

    def test_node_id_arrays_filtered(self) -> None:
        # Empty strings + non-strings get dropped.
        out = request_motif_plant.invoke(
            {
                "storyboard_id": "sb_1",
                "branch_id": "main",
                "motif_key": "red-umbrella",
                "target_node_id": "n1",
                "plan_ops": [],
                "rationale": "",
                "source_node_ids": ["n3", "", "n4"],
                "payoff_node_ids": ["n18"],
            }
        )
        self.assertEqual(out["input"]["sourceNodeIds"], ["n3", "n4"])


# ---------------------------------------------------------------------------
# detect_motif_gaps (M9 Phase 4)
# ---------------------------------------------------------------------------


class DetectMotifGapsTests(unittest.TestCase):
    def test_empty_list_returns_empty_buckets(self) -> None:
        out = detect_motif_gaps.invoke({"motifs": []})
        self.assertEqual(out["unlanded"], [])
        self.assertEqual(out["orphaned"], [])
        self.assertEqual(out["unplanted"], [])
        self.assertEqual(out["landed"], [])

    def test_classifies_all_four_buckets(self) -> None:
        out = detect_motif_gaps.invoke(
            {
                "motifs": [
                    {"motifKey": "a", "sourceNodeIds": ["n1"], "payoffNodeIds": []},
                    {"motifKey": "b", "sourceNodeIds": [], "payoffNodeIds": ["n18"]},
                    {"motifKey": "c", "sourceNodeIds": [], "payoffNodeIds": []},
                    {"motifKey": "d", "sourceNodeIds": ["n3"], "payoffNodeIds": ["n20"]},
                ],
            }
        )
        self.assertEqual(out["unlanded"], ["a"])
        self.assertEqual(out["orphaned"], ["b"])
        self.assertEqual(out["unplanted"], ["c"])
        self.assertEqual(out["landed"], ["d"])

    def test_motifs_without_key_skipped(self) -> None:
        out = detect_motif_gaps.invoke(
            {
                "motifs": [
                    {"sourceNodeIds": ["n1"]},
                    {"motifKey": "", "sourceNodeIds": ["n2"]},
                    {"motifKey": "valid", "sourceNodeIds": ["n3"]},
                ],
            }
        )
        self.assertEqual(out["unlanded"], ["valid"])


# ---------------------------------------------------------------------------
# Policy / registry wiring
# ---------------------------------------------------------------------------


class PolicyRegistryTests(unittest.TestCase):
    def test_narrative_tokens_in_default_allowlist(self) -> None:
        self.assertIn("narrative.analyze", DEFAULT_RUNTIME_ALLOWLIST)
        self.assertIn("narrative.beats", DEFAULT_RUNTIME_ALLOWLIST)
        # Phase 3 tokens ship allowed-by-default so producers can call
        # the variant tools from day one; operators who want to lock
        # them down can pass an explicit allowlist without these.
        self.assertIn("narrative.hook_variants", DEFAULT_RUNTIME_ALLOWLIST)
        self.assertIn("narrative.remix", DEFAULT_RUNTIME_ALLOWLIST)
        # Phase 4 tokens
        self.assertIn("narrative.transition", DEFAULT_RUNTIME_ALLOWLIST)
        self.assertIn("narrative.motif", DEFAULT_RUNTIME_ALLOWLIST)

    def test_narrative_tools_have_policy_tokens(self) -> None:
        self.assertEqual(
            TOOL_POLICY_TOKENS[sample_tension_curve.name],
            "narrative.analyze",
        )
        self.assertEqual(
            TOOL_POLICY_TOKENS[detect_beat_plan.name],
            "narrative.analyze",
        )
        self.assertEqual(
            TOOL_POLICY_TOKENS[detect_beat_gaps.name],
            "narrative.analyze",
        )
        self.assertEqual(
            TOOL_POLICY_TOKENS[request_beat_assignment.name],
            "narrative.beats",
        )
        self.assertEqual(
            TOOL_POLICY_TOKENS[request_hook_variants.name],
            "narrative.hook_variants",
        )
        self.assertEqual(
            TOOL_POLICY_TOKENS[request_structural_remix.name],
            "narrative.remix",
        )
        self.assertEqual(
            TOOL_POLICY_TOKENS[request_transition_proposal.name],
            "narrative.transition",
        )
        self.assertEqual(
            TOOL_POLICY_TOKENS[request_motif_plant.name],
            "narrative.motif",
        )
        # detect_motif_gaps is read-only analysis → reuses the analyze token.
        self.assertEqual(
            TOOL_POLICY_TOKENS[detect_motif_gaps.name],
            "narrative.analyze",
        )

    def test_narrative_tools_allowed_under_default_policy(self) -> None:
        self.assertTrue(is_tool_allowed([], "narrative.analyze"))
        self.assertTrue(is_tool_allowed([], "narrative.beats"))
        self.assertTrue(is_tool_allowed([], "narrative.hook_variants"))
        self.assertTrue(is_tool_allowed([], "narrative.remix"))
        self.assertTrue(is_tool_allowed([], "narrative.transition"))
        self.assertTrue(is_tool_allowed([], "narrative.motif"))

    def test_narrative_tools_in_all_tools(self) -> None:
        names = {getattr(t, "name", "") for t in ALL_TOOLS}
        self.assertIn(sample_tension_curve.name, names)
        self.assertIn(detect_beat_plan.name, names)
        self.assertIn(detect_beat_gaps.name, names)
        self.assertIn(request_beat_assignment.name, names)
        self.assertIn(request_hook_variants.name, names)
        self.assertIn(request_structural_remix.name, names)
        self.assertIn(request_transition_proposal.name, names)
        self.assertIn(request_motif_plant.name, names)
        self.assertIn(detect_motif_gaps.name, names)

    def test_variant_tools_on_supervisor_core(self) -> None:
        names = {getattr(t, "name", "") for t in SUPERVISOR_CORE_TOOLS}
        # HITL mutations land on the supervisor so narrative_architect
        # can fan them out directly without routing through a subagent.
        self.assertIn(request_beat_assignment.name, names)
        self.assertIn(request_hook_variants.name, names)
        self.assertIn(request_structural_remix.name, names)
        self.assertIn(request_transition_proposal.name, names)
        self.assertIn(request_motif_plant.name, names)


if __name__ == "__main__":
    unittest.main()
