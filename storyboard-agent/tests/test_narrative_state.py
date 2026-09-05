"""
M9 Phase 1 — reel narrative state helpers.
"""

from __future__ import annotations

import json
import unittest

from deep.narrative_state import (
    HARMON_CIRCLE_BEATS,
    HOOK_FIRST_BEATS,
    KISHOTENKETSU_BEATS,
    SAVE_THE_CAT_BEATS,
    THREE_ACT_BEATS,
    apply_beat_assignments,
    canonical_beats_for,
    clear_stale,
    deserialize_state,
    empty_reel_narrative_state,
    mark_missing_beats,
    mark_stale,
    seed_beat_plan,
    serialize_state,
    set_tension_sample,
    upsert_motif,
)


class CanonicalBeatsTests(unittest.TestCase):
    def test_save_the_cat_has_15_beats(self) -> None:
        self.assertEqual(len(canonical_beats_for("save_the_cat")), 15)
        self.assertEqual(canonical_beats_for("save_the_cat"), SAVE_THE_CAT_BEATS)

    def test_harmon_circle_has_8_beats(self) -> None:
        self.assertEqual(len(canonical_beats_for("harmon_circle")), 8)
        self.assertEqual(canonical_beats_for("harmon_circle"), HARMON_CIRCLE_BEATS)

    def test_three_act_has_7_beats(self) -> None:
        self.assertEqual(len(canonical_beats_for("three_act")), 7)
        self.assertEqual(canonical_beats_for("three_act"), THREE_ACT_BEATS)

    def test_kishotenketsu_has_4_beats(self) -> None:
        self.assertEqual(canonical_beats_for("kishotenketsu"), KISHOTENKETSU_BEATS)

    def test_hook_first_has_5_beats(self) -> None:
        self.assertEqual(canonical_beats_for("hook_first"), HOOK_FIRST_BEATS)

    def test_unknown_structure_raises(self) -> None:
        with self.assertRaises(ValueError):
            canonical_beats_for("not-a-structure")  # type: ignore[arg-type]

    def test_returned_list_is_defensive_copy(self) -> None:
        # Caller mutation should not corrupt the module-level constant.
        beats = canonical_beats_for("save_the_cat")
        beats.append("fake")
        self.assertNotIn("fake", SAVE_THE_CAT_BEATS)


class SeedBeatPlanTests(unittest.TestCase):
    def test_every_slot_starts_planned(self) -> None:
        plan = seed_beat_plan("save_the_cat")
        self.assertTrue(all(b["status"] == "planned" for b in plan))
        self.assertTrue(all("nodeId" not in b for b in plan))

    def test_act_hints_populated_for_save_the_cat(self) -> None:
        plan = seed_beat_plan("save_the_cat")
        by_key = {b["beatKey"]: b for b in plan}
        self.assertEqual(by_key["opening_image"]["expectedActNumber"], 1)
        self.assertEqual(by_key["midpoint"]["expectedActNumber"], 2)
        self.assertEqual(by_key["final_image"]["expectedActNumber"], 3)

    def test_hook_first_act_hints(self) -> None:
        by_key = {b["beatKey"]: b for b in seed_beat_plan("hook_first")}
        self.assertEqual(by_key["hook"]["expectedActNumber"], 1)
        self.assertEqual(by_key["cta"]["expectedActNumber"], 3)


class EmptyStateTests(unittest.TestCase):
    def test_defaults_to_save_the_cat(self) -> None:
        state = empty_reel_narrative_state()
        self.assertEqual(state["structure"], "save_the_cat")
        self.assertEqual(len(state["beats"]), 15)
        self.assertFalse(state["stale"])

    def test_accepts_custom_structure(self) -> None:
        state = empty_reel_narrative_state("hook_first")
        self.assertEqual(state["structure"], "hook_first")
        self.assertEqual(len(state["beats"]), 5)


class SerializationRoundTripTests(unittest.TestCase):
    def test_round_trip_preserves_shape(self) -> None:
        state = empty_reel_narrative_state("harmon_circle")
        # Populate with one of each payload so every codec branch runs.
        apply_beat_assignments(
            state,
            [{"beatKey": "you", "nodeId": "n1", "rationale": "intro"}],
        )
        set_tension_sample(state, "n1", 5)
        upsert_motif(
            state,
            "red_umbrella",
            description="recurring prop",
            source_node_ids=["n1"],
            visual_vocabulary="crimson, round silhouette",
        )
        serialized = serialize_state(state)
        # Every column is a JSON string.
        for key in (
            "beatMapJson",
            "motifRegistryJson",
            "tensionSamplesJson",
            "characterWantNeedJson",
        ):
            self.assertIsInstance(serialized[key], str)
            json.loads(serialized[key])  # doesn't raise
        row = {
            "structure": state["structure"],
            "computedFromCommitId": "abc123",
            "stale": True,
            **serialized,
        }
        restored = deserialize_state(row)
        self.assertEqual(restored["structure"], "harmon_circle")
        self.assertTrue(restored["stale"])
        self.assertEqual(restored["computed_from_commit_id"], "abc123")
        by_key = {b["beatKey"]: b for b in restored["beats"]}
        self.assertEqual(by_key["you"]["nodeId"], "n1")
        self.assertEqual(by_key["you"]["status"], "assigned")
        self.assertEqual(
            restored["motifs"]["red_umbrella"]["landedStatus"], "planted"
        )
        self.assertEqual(len(restored["tension_samples"]), 1)

    def test_deserialize_null_row_returns_empty_state(self) -> None:
        state = deserialize_state(None)
        self.assertEqual(state["structure"], "save_the_cat")
        self.assertEqual(len(state["beats"]), 15)

    def test_deserialize_tolerates_malformed_json(self) -> None:
        state = deserialize_state(
            {
                "structure": "hook_first",
                "beatMapJson": "not json at all {{{",
                "motifRegistryJson": "",
                "tensionSamplesJson": "null",
                "characterWantNeedJson": "[]",
                "stale": False,
            }
        )
        # No crash; empty-everything except structure echoed.
        self.assertEqual(state["structure"], "hook_first")
        self.assertEqual(state["beats"], [])
        self.assertEqual(state["motifs"], {})

    def test_deserialize_clamps_tension_values(self) -> None:
        state = deserialize_state(
            {
                "structure": "save_the_cat",
                "beatMapJson": "[]",
                "motifRegistryJson": "{}",
                "tensionSamplesJson": json.dumps(
                    [
                        {"nodeId": "n1", "value": 999},
                        {"nodeId": "n2", "value": -50},
                        {"nodeId": "n3", "value": 7.5},
                    ]
                ),
                "characterWantNeedJson": "[]",
                "stale": False,
            }
        )
        by_node = {s["nodeId"]: s for s in state["tension_samples"]}
        self.assertEqual(by_node["n1"]["value"], 10.0)
        self.assertEqual(by_node["n2"]["value"], 0.0)
        self.assertEqual(by_node["n3"]["value"], 7.5)


class ApplyBeatAssignmentsTests(unittest.TestCase):
    def setUp(self) -> None:
        self.state = empty_reel_narrative_state("save_the_cat")

    def test_planned_slot_flips_to_assigned(self) -> None:
        apply_beat_assignments(
            self.state,
            [{"beatKey": "midpoint", "nodeId": "shot_midpoint", "rationale": "reversal"}],
        )
        by_key = {b["beatKey"]: b for b in self.state["beats"]}
        self.assertEqual(by_key["midpoint"]["status"], "assigned")
        self.assertEqual(by_key["midpoint"]["nodeId"], "shot_midpoint")
        self.assertEqual(by_key["midpoint"]["rationale"], "reversal")

    def test_assigned_slot_preserved_without_override(self) -> None:
        # First pass assigns shot_A.
        apply_beat_assignments(
            self.state,
            [{"beatKey": "catalyst", "nodeId": "shot_A"}],
        )
        # Agent tries to reassign to shot_B without override — no-op.
        apply_beat_assignments(
            self.state,
            [{"beatKey": "catalyst", "nodeId": "shot_B", "rationale": "better fit"}],
        )
        by_key = {b["beatKey"]: b for b in self.state["beats"]}
        self.assertEqual(by_key["catalyst"]["nodeId"], "shot_A")

    def test_override_lets_reassignment_land(self) -> None:
        apply_beat_assignments(
            self.state,
            [{"beatKey": "catalyst", "nodeId": "shot_A"}],
        )
        apply_beat_assignments(
            self.state,
            [{"beatKey": "catalyst", "nodeId": "shot_B"}],
            override=True,
        )
        by_key = {b["beatKey"]: b for b in self.state["beats"]}
        self.assertEqual(by_key["catalyst"]["nodeId"], "shot_B")

    def test_same_node_reassignment_is_idempotent(self) -> None:
        apply_beat_assignments(
            self.state,
            [{"beatKey": "midpoint", "nodeId": "n"}],
        )
        apply_beat_assignments(
            self.state,
            [{"beatKey": "midpoint", "nodeId": "n"}],
        )
        by_key = {b["beatKey"]: b for b in self.state["beats"]}
        self.assertEqual(by_key["midpoint"]["status"], "assigned")

    def test_unknown_beat_key_is_dropped(self) -> None:
        before = len(self.state["beats"])
        apply_beat_assignments(
            self.state,
            [{"beatKey": "this_beat_does_not_exist", "nodeId": "n1"}],
        )
        # Plan length unchanged — hallucination guard dropped the bogus key.
        self.assertEqual(len(self.state["beats"]), before)
        self.assertTrue(
            all(b["status"] == "planned" for b in self.state["beats"])
        )

    def test_missing_node_or_beat_key_skipped(self) -> None:
        # Both malformed entries should be skipped silently.
        apply_beat_assignments(
            self.state,
            [
                {"beatKey": "midpoint"},
                {"nodeId": "n1"},
                {},
            ],
        )
        self.assertTrue(
            all(b["status"] == "planned" for b in self.state["beats"])
        )


class MarkMissingBeatsTests(unittest.TestCase):
    def test_assigned_slot_with_deleted_node_flips_to_missing(self) -> None:
        state = empty_reel_narrative_state("three_act")
        apply_beat_assignments(
            state,
            [
                {"beatKey": "act1_setup", "nodeId": "alive_node"},
                {"beatKey": "act3_climax", "nodeId": "deleted_node"},
            ],
        )
        mark_missing_beats(state, ["alive_node"])
        by_key = {b["beatKey"]: b for b in state["beats"]}
        self.assertEqual(by_key["act1_setup"]["status"], "assigned")
        self.assertEqual(by_key["act3_climax"]["status"], "missing")
        # Node id stays on the row so the UI can still show "was at
        # shot X before deletion" if needed.
        self.assertEqual(by_key["act3_climax"]["nodeId"], "deleted_node")


class TensionSampleTests(unittest.TestCase):
    def test_upsert_replaces_existing_sample(self) -> None:
        state = empty_reel_narrative_state("save_the_cat")
        set_tension_sample(state, "n1", 3)
        set_tension_sample(state, "n1", 7)
        samples = state["tension_samples"]
        self.assertEqual(len(samples), 1)
        self.assertEqual(samples[0]["value"], 7.0)

    def test_clamps_out_of_range_values(self) -> None:
        state = empty_reel_narrative_state("save_the_cat")
        set_tension_sample(state, "high", 999)
        set_tension_sample(state, "low", -5)
        by_node = {s["nodeId"]: s for s in state["tension_samples"]}
        self.assertEqual(by_node["high"]["value"], 10.0)
        self.assertEqual(by_node["low"]["value"], 0.0)


class UpsertMotifTests(unittest.TestCase):
    def test_unplanted_when_both_empty(self) -> None:
        state = empty_reel_narrative_state("save_the_cat")
        upsert_motif(state, "x", description="placeholder")
        self.assertEqual(state["motifs"]["x"]["landedStatus"], "unplanted")

    def test_planted_when_source_without_payoff(self) -> None:
        state = empty_reel_narrative_state("save_the_cat")
        upsert_motif(state, "rain", source_node_ids=["n1"])
        self.assertEqual(state["motifs"]["rain"]["landedStatus"], "planted")

    def test_landed_when_both_present(self) -> None:
        state = empty_reel_narrative_state("save_the_cat")
        upsert_motif(
            state,
            "rain",
            source_node_ids=["n1"],
            payoff_node_ids=["n18"],
        )
        self.assertEqual(state["motifs"]["rain"]["landedStatus"], "landed")


class StaleFlagTests(unittest.TestCase):
    def test_mark_stale_sets_flag(self) -> None:
        state = empty_reel_narrative_state("save_the_cat")
        self.assertFalse(state["stale"])
        mark_stale(state)
        self.assertTrue(state["stale"])

    def test_clear_stale_records_commit_id(self) -> None:
        state = empty_reel_narrative_state("save_the_cat")
        mark_stale(state)
        clear_stale(state, "commit_123")
        self.assertFalse(state["stale"])
        self.assertEqual(state["computed_from_commit_id"], "commit_123")


if __name__ == "__main__":
    unittest.main()
