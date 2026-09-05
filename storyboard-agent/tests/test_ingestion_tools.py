"""
Unit tests for the M3 #4 ingestion + shot-batch agent tools.

These tools form the LangGraph HITL layer that lets the chat supervisor
(a) classify a producer's request to the right ingestion surface and
(b) propose the three ingestion pipelines + shot-batch run as
interrupt-gated actions.
"""

from __future__ import annotations

import unittest

from deep.tools import (
    ALL_TOOLS,
    DEFAULT_RUNTIME_ALLOWLIST,
    SUPERVISOR_CORE_TOOLS,
    TOOL_POLICY_TOKENS,
    filter_tools_by_allowlist,
    is_tool_allowed,
    recommend_ingestion_path,
    request_assign_voice_cast,
    request_export_reel,
    request_generate_shot_batch,
    request_generate_shot_video_batch,
    request_generate_shot_audio_batch,
    request_generate_shot_sfx_batch,
    request_generate_score,
    request_dailies_critic_review,
    request_ingestion_run,
)


class RecommendIngestionPathTests(unittest.TestCase):
    def test_short_brief_routes_to_idea(self) -> None:
        out = recommend_ingestion_path.invoke(
            {
                "user_request": "A kid finds a dragon egg in his backyard.",
            }
        )
        self.assertEqual(out["mode"], "idea")
        self.assertIn("title", out["requiredFields"])
        self.assertIn("idea", out["requiredFields"])
        self.assertTrue(out["recommendationId"].startswith("ingestreco_"))

    def test_screenplay_formatting_routes_to_screenplay(self) -> None:
        out = recommend_ingestion_path.invoke(
            {
                "user_request": (
                    "INT. LIBRARY - NIGHT\n\nSARAH (30) leans over a dusty book. "
                    "EXT. STREET - LATER\n\nShe runs. CUT TO: a stranger watching."
                ),
            }
        )
        self.assertEqual(out["mode"], "screenplay")
        self.assertEqual(
            out["requiredFields"],
            ["title", "screenplay", "style"],
        )

    def test_long_prose_routes_to_novel(self) -> None:
        paragraph = (
            "The harbour lay silent under a bruised sky, and Maeve stood at the "
            "end of the pier with the letter pressed tight against her ribs. "
        ) * 12
        out = recommend_ingestion_path.invoke(
            {
                "user_request": paragraph + "\n\n" + paragraph,
            }
        )
        self.assertEqual(out["mode"], "novel")
        self.assertIn("targetEpisodeCount", out["requiredFields"])

    def test_caller_flag_overrides_heuristic(self) -> None:
        out = recommend_ingestion_path.invoke(
            {
                "user_request": "just a short pitch",
                "has_novel_text": True,
            }
        )
        self.assertEqual(out["mode"], "novel")

    def test_recommendation_is_deterministic(self) -> None:
        a = recommend_ingestion_path.invoke(
            {"user_request": "A heist in Kyoto told in flashbacks."}
        )
        b = recommend_ingestion_path.invoke(
            {"user_request": "A heist in Kyoto told in flashbacks."}
        )
        self.assertEqual(a["recommendationId"], b["recommendationId"])


class RequestIngestionRunTests(unittest.TestCase):
    def test_shape_is_waiting_for_human(self) -> None:
        payload = request_ingestion_run.invoke(
            {
                "mode": "screenplay",
                "title": "  Night Train  ",
                "rationale": "User pasted slug-line formatted text.",
                "hints": {
                    "style": "Neo-noir, anamorphic",
                    "targetEpisodeCount": 3,
                    "ignoredKey": "this should be dropped",
                },
            }
        )
        self.assertEqual(payload["action"], "request_ingestion_run")
        self.assertEqual(payload["status"], "waiting_for_human")
        self.assertEqual(payload["schemaVersion"], "v2")
        self.assertEqual(payload["input"]["mode"], "screenplay")
        self.assertEqual(payload["input"]["title"], "Night Train")
        self.assertEqual(payload["input"]["hints"]["style"], "Neo-noir, anamorphic")
        self.assertEqual(payload["input"]["hints"]["targetEpisodeCount"], 3)
        self.assertNotIn("ignoredKey", payload["input"]["hints"])

    def test_invalid_mode_rejected_by_pydantic_literal(self) -> None:
        # The tool's Literal[] type is enforced by langchain's Pydantic schema
        # before the body runs; attempting an unsupported mode surfaces as a
        # validation error rather than silently falling through.
        from pydantic import ValidationError

        with self.assertRaises(ValidationError):
            request_ingestion_run.invoke(
                {
                    "mode": "not-a-mode",
                    "title": "X",
                    "rationale": "",
                    "hints": {},
                }
            )

    def test_empty_title_gets_placeholder(self) -> None:
        payload = request_ingestion_run.invoke(
            {
                "mode": "novel",
                "title": "   ",
                "rationale": "",
                "hints": {},
            }
        )
        self.assertEqual(payload["input"]["title"], "Untitled novel")


class RequestGenerateShotBatchTests(unittest.TestCase):
    def test_clamps_concurrency(self) -> None:
        payload = request_generate_shot_batch.invoke(
            {
                "storyboard_id": "sb_1",
                "branch_id": "br_main",
                "node_count": 12,
                "rationale": "All shots still unrendered.",
                "concurrency": 99,
            }
        )
        self.assertEqual(payload["input"]["concurrency"], 6)
        self.assertEqual(payload["input"]["nodeCount"], 12)
        self.assertTrue(payload["input"]["skipExisting"])

    def test_negative_concurrency_becomes_one(self) -> None:
        payload = request_generate_shot_batch.invoke(
            {
                "storyboard_id": "sb_1",
                "branch_id": "br_main",
                "node_count": 0,
                "rationale": "",
                "concurrency": -5,
            }
        )
        self.assertEqual(payload["input"]["concurrency"], 1)
        self.assertEqual(payload["input"]["nodeCount"], 0)

    def test_shape_is_waiting_for_human(self) -> None:
        payload = request_generate_shot_batch.invoke(
            {
                "storyboard_id": "sb_42",
                "branch_id": "br_main",
                "node_count": 8,
                "rationale": "Producer asked to render everything.",
            }
        )
        self.assertEqual(payload["status"], "waiting_for_human")
        self.assertEqual(payload["action"], "request_generate_shot_batch")


class RequestGenerateShotVideoBatchTests(unittest.TestCase):
    def test_shape_is_waiting_for_human(self) -> None:
        payload = request_generate_shot_video_batch.invoke(
            {
                "storyboard_id": "sb_42",
                "branch_id": "br_main",
                "node_count": 8,
                "rationale": "Images are in, animate them.",
            }
        )
        self.assertEqual(payload["status"], "waiting_for_human")
        self.assertEqual(payload["action"], "request_generate_shot_video_batch")
        self.assertEqual(payload["input"]["videoModelId"], "ltx-2.3")

    def test_clamps_concurrency_to_four(self) -> None:
        # Video concurrency caps at 4 (vs. 6 for images) because LTX-2.3
        # takes 60-180s per shot and higher worker counts race the
        # 30-min stale-mediaAsset sweeper.
        payload = request_generate_shot_video_batch.invoke(
            {
                "storyboard_id": "sb_1",
                "branch_id": "br_main",
                "node_count": 10,
                "rationale": "Render all videos.",
                "concurrency": 99,
            }
        )
        self.assertEqual(payload["input"]["concurrency"], 4)

    def test_default_concurrency_is_two(self) -> None:
        payload = request_generate_shot_video_batch.invoke(
            {
                "storyboard_id": "sb_1",
                "branch_id": "br_main",
                "node_count": 10,
                "rationale": "",
            }
        )
        self.assertEqual(payload["input"]["concurrency"], 2)

    def test_accepts_custom_video_model(self) -> None:
        payload = request_generate_shot_video_batch.invoke(
            {
                "storyboard_id": "sb_1",
                "branch_id": "br_main",
                "node_count": 10,
                "rationale": "",
                "video_model_id": "veo-3.1",
            }
        )
        self.assertEqual(payload["input"]["videoModelId"], "veo-3.1")

    def test_blank_model_falls_back_to_ltx_23(self) -> None:
        payload = request_generate_shot_video_batch.invoke(
            {
                "storyboard_id": "sb_1",
                "branch_id": "br_main",
                "node_count": 10,
                "rationale": "",
                "video_model_id": "   ",
            }
        )
        self.assertEqual(payload["input"]["videoModelId"], "ltx-2.3")


class RequestGenerateShotAudioBatchTests(unittest.TestCase):
    def test_shape_is_waiting_for_human(self) -> None:
        payload = request_generate_shot_audio_batch.invoke(
            {
                "storyboard_id": "sb_42",
                "branch_id": "br_main",
                "node_count": 8,
                "rationale": "Narrate everything.",
            }
        )
        self.assertEqual(payload["status"], "waiting_for_human")
        self.assertEqual(payload["action"], "request_generate_shot_audio_batch")
        self.assertEqual(payload["input"]["voice"], "nova")
        self.assertEqual(payload["input"]["model"], "tts-1")
        self.assertEqual(payload["input"]["speed"], 1.0)

    def test_speed_is_clamped(self) -> None:
        # Speed caps at 4.0 and floors at 0.25 per OpenAI TTS docs.
        payload_fast = request_generate_shot_audio_batch.invoke(
            {
                "storyboard_id": "sb_1",
                "branch_id": "br_main",
                "node_count": 1,
                "rationale": "",
                "speed": 999,
            }
        )
        payload_slow = request_generate_shot_audio_batch.invoke(
            {
                "storyboard_id": "sb_1",
                "branch_id": "br_main",
                "node_count": 1,
                "rationale": "",
                "speed": -5,
            }
        )
        self.assertEqual(payload_fast["input"]["speed"], 4.0)
        self.assertEqual(payload_slow["input"]["speed"], 0.25)

    def test_voice_normalized_to_lowercase(self) -> None:
        payload = request_generate_shot_audio_batch.invoke(
            {
                "storyboard_id": "sb_1",
                "branch_id": "br_main",
                "node_count": 1,
                "rationale": "",
                "voice": "  SHIMMER  ",
            }
        )
        # Voice validation happens at the route boundary; the tool
        # just normalizes case + strips whitespace.
        self.assertEqual(payload["input"]["voice"], "shimmer")

    def test_concurrency_caps_at_five(self) -> None:
        payload = request_generate_shot_audio_batch.invoke(
            {
                "storyboard_id": "sb_1",
                "branch_id": "br_main",
                "node_count": 1,
                "rationale": "",
                "concurrency": 99,
            }
        )
        self.assertEqual(payload["input"]["concurrency"], 5)


class RequestGenerateShotSfxBatchTests(unittest.TestCase):
    def test_shape_is_waiting_for_human(self) -> None:
        payload = request_generate_shot_sfx_batch.invoke(
            {
                "storyboard_id": "sb_42",
                "branch_id": "br_main",
                "node_count": 8,
                "rationale": "Give every shot an ambient bed.",
            }
        )
        self.assertEqual(payload["status"], "waiting_for_human")
        self.assertEqual(payload["action"], "request_generate_shot_sfx_batch")
        # Defaults surface: skip_existing True, concurrency 3.
        self.assertTrue(payload["input"]["skipExisting"])
        self.assertEqual(payload["input"]["concurrency"], 3)

    def test_concurrency_caps_at_five(self) -> None:
        payload = request_generate_shot_sfx_batch.invoke(
            {
                "storyboard_id": "sb_1",
                "branch_id": "br_main",
                "node_count": 1,
                "rationale": "",
                "concurrency": 99,
            }
        )
        self.assertEqual(payload["input"]["concurrency"], 5)

    def test_concurrency_floors_at_one(self) -> None:
        payload = request_generate_shot_sfx_batch.invoke(
            {
                "storyboard_id": "sb_1",
                "branch_id": "br_main",
                "node_count": 1,
                "rationale": "",
                "concurrency": 0,
            }
        )
        self.assertEqual(payload["input"]["concurrency"], 1)

    def test_node_count_clamped_to_non_negative(self) -> None:
        payload = request_generate_shot_sfx_batch.invoke(
            {
                "storyboard_id": "sb_1",
                "branch_id": "br_main",
                "node_count": -5,
                "rationale": "",
            }
        )
        self.assertEqual(payload["input"]["nodeCount"], 0)

    def test_rationale_trimmed_and_capped(self) -> None:
        payload = request_generate_shot_sfx_batch.invoke(
            {
                "storyboard_id": "sb_1",
                "branch_id": "br_main",
                "node_count": 1,
                "rationale": "   multi\n\n  whitespace   content   " + "x" * 2000,
            }
        )
        rationale = payload["input"]["rationale"]
        # No runs of whitespace > 1; total length capped at 1200.
        self.assertNotIn("  ", rationale)
        self.assertLessEqual(len(rationale), 1200)


class RequestGenerateScoreTests(unittest.TestCase):
    def test_shape_is_waiting_for_human(self) -> None:
        payload = request_generate_score.invoke(
            {
                "storyboard_id": "sb_42",
                "prompt": "somber piano underscore, 80 BPM",
                "rationale": "Producer asked for a music bed.",
            }
        )
        self.assertEqual(payload["status"], "waiting_for_human")
        self.assertEqual(payload["action"], "request_generate_score")
        # Defaults surface.
        self.assertEqual(payload["input"]["durationS"], 60)
        self.assertEqual(payload["input"]["volumeDb"], -18)

    def test_duration_clamped_into_window(self) -> None:
        too_long = request_generate_score.invoke(
            {
                "storyboard_id": "sb_1",
                "prompt": "x",
                "rationale": "",
                "duration_s": 9999,
            }
        )
        too_short = request_generate_score.invoke(
            {
                "storyboard_id": "sb_1",
                "prompt": "x",
                "rationale": "",
                "duration_s": 1,
            }
        )
        self.assertEqual(too_long["input"]["durationS"], 300)
        self.assertEqual(too_short["input"]["durationS"], 10)

    def test_volume_clamped_to_dB_window(self) -> None:
        loud = request_generate_score.invoke(
            {
                "storyboard_id": "sb_1",
                "prompt": "x",
                "rationale": "",
                "volume_db": 10,
            }
        )
        quiet = request_generate_score.invoke(
            {
                "storyboard_id": "sb_1",
                "prompt": "x",
                "rationale": "",
                "volume_db": -500,
            }
        )
        self.assertEqual(loud["input"]["volumeDb"], 0)
        self.assertEqual(quiet["input"]["volumeDb"], -40)

    def test_prompt_trimmed_and_capped(self) -> None:
        payload = request_generate_score.invoke(
            {
                "storyboard_id": "sb_1",
                "prompt": "   multi\n\nwhitespace  prompt   " + "x" * 1000,
                "rationale": "",
            }
        )
        prompt = payload["input"]["prompt"]
        self.assertNotIn("  ", prompt)
        self.assertLessEqual(len(prompt), 600)


class RequestDailiesCriticReviewTests(unittest.TestCase):
    def test_shape_is_waiting_for_human(self) -> None:
        payload = request_dailies_critic_review.invoke(
            {
                "storyboard_id": "sb_42",
                "dailies_reel_id": "reel_abc",
                "rationale": "Before applying, run critic sweep.",
            }
        )
        self.assertEqual(payload["status"], "waiting_for_human")
        self.assertEqual(
            payload["action"], "request_dailies_critic_review"
        )
        self.assertEqual(payload["input"]["dailiesReelId"], "reel_abc")

    def test_rationale_whitespace_normalized(self) -> None:
        payload = request_dailies_critic_review.invoke(
            {
                "storyboard_id": "sb_1",
                "dailies_reel_id": "reel_1",
                "rationale": "one\ttwo\n\nthree",
            }
        )
        self.assertEqual(payload["input"]["rationale"], "one two three")


class RequestExportReelTests(unittest.TestCase):
    def test_shape_is_waiting_for_human(self) -> None:
        payload = request_export_reel.invoke(
            {
                "storyboard_id": "sb_42",
                "rationale": "Producer asked to export the final cut.",
                "shot_count": 12,
                "estimated_duration_s": 60.5,
            }
        )
        self.assertEqual(payload["status"], "waiting_for_human")
        self.assertEqual(payload["action"], "request_export_reel")
        self.assertEqual(payload["input"]["storyboardId"], "sb_42")
        self.assertEqual(payload["input"]["shotCount"], 12)
        self.assertEqual(payload["input"]["estimatedDurationS"], 60.5)

    def test_negative_counts_become_zero(self) -> None:
        payload = request_export_reel.invoke(
            {
                "storyboard_id": "sb_1",
                "rationale": "",
                "shot_count": -5,
                "estimated_duration_s": -10.0,
            }
        )
        self.assertEqual(payload["input"]["shotCount"], 0)
        self.assertEqual(payload["input"]["estimatedDurationS"], 0.0)

    def test_rationale_truncated(self) -> None:
        long_rationale = "word " * 400  # ~2000 chars
        payload = request_export_reel.invoke(
            {
                "storyboard_id": "sb_1",
                "rationale": long_rationale,
            }
        )
        # Truncation is a defensive cap; exact boundary is 1200 chars.
        self.assertLessEqual(len(payload["input"]["rationale"]), 1200)


class RequestAssignVoiceCastTests(unittest.TestCase):
    def test_shape_is_waiting_for_human(self) -> None:
        payload = request_assign_voice_cast.invoke(
            {
                "storyboard_id": "sb_1",
                "assignments": [
                    {"packId": "pack_maya", "voice": "nova"},
                    {"packId": "pack_daniel", "voice": "onyx"},
                ],
                "rationale": "MAYA reads determined; DANIEL reads controlled.",
            }
        )
        self.assertEqual(payload["action"], "request_assign_voice_cast")
        self.assertEqual(payload["status"], "waiting_for_human")
        self.assertEqual(len(payload["input"]["assignments"]), 2)
        self.assertEqual(payload["input"]["assignments"][0]["voice"], "nova")

    def test_drops_entries_missing_pack_id(self) -> None:
        payload = request_assign_voice_cast.invoke(
            {
                "storyboard_id": "sb_1",
                "assignments": [
                    {"packId": "pack_a", "voice": "nova"},
                    {"packId": "", "voice": "onyx"},
                    {"voice": "shimmer"},
                ],
                "rationale": "",
            }
        )
        self.assertEqual(len(payload["input"]["assignments"]), 1)
        self.assertEqual(
            payload["input"]["assignments"][0]["packId"], "pack_a"
        )

    def test_normalizes_voice_to_lowercase(self) -> None:
        payload = request_assign_voice_cast.invoke(
            {
                "storyboard_id": "sb_1",
                "assignments": [{"packId": "pack_a", "voice": "  SHIMMER  "}],
                "rationale": "",
            }
        )
        self.assertEqual(
            payload["input"]["assignments"][0]["voice"], "shimmer"
        )

    def test_empty_voice_is_preserved_as_clear_signal(self) -> None:
        payload = request_assign_voice_cast.invoke(
            {
                "storyboard_id": "sb_1",
                "assignments": [{"packId": "pack_a", "voice": ""}],
                "rationale": "Clear the mapping.",
            }
        )
        # Empty string is intentional — the bridge uses it to clear
        # the mapping via `setIdentityPackVoice("")`.
        self.assertEqual(
            payload["input"]["assignments"][0]["voice"], ""
        )


class PolicyAndRegistryTests(unittest.TestCase):
    def test_policy_tokens_registered(self) -> None:
        self.assertEqual(
            TOOL_POLICY_TOKENS[recommend_ingestion_path.name], "ingestion.run"
        )
        self.assertEqual(
            TOOL_POLICY_TOKENS[request_ingestion_run.name], "ingestion.run"
        )
        self.assertEqual(
            TOOL_POLICY_TOKENS[request_generate_shot_batch.name], "shot_batch.run"
        )
        self.assertEqual(
            TOOL_POLICY_TOKENS[request_generate_shot_video_batch.name],
            "shot_video_batch.run",
        )
        self.assertEqual(
            TOOL_POLICY_TOKENS[request_generate_shot_audio_batch.name],
            "shot_audio_batch.run",
        )
        self.assertEqual(
            TOOL_POLICY_TOKENS[request_generate_shot_sfx_batch.name],
            "shot_sfx_batch.run",
        )
        self.assertEqual(
            TOOL_POLICY_TOKENS[request_generate_score.name],
            "reel_score.run",
        )
        self.assertEqual(
            TOOL_POLICY_TOKENS[request_dailies_critic_review.name],
            "dailies.critic_review",
        )
        self.assertEqual(
            TOOL_POLICY_TOKENS[request_export_reel.name],
            "reel_export.run",
        )
        self.assertEqual(
            TOOL_POLICY_TOKENS[request_assign_voice_cast.name],
            "voice_cast.assign",
        )

    def test_default_allowlist_includes_new_tokens(self) -> None:
        self.assertIn("ingestion.run", DEFAULT_RUNTIME_ALLOWLIST)
        self.assertIn("shot_batch.run", DEFAULT_RUNTIME_ALLOWLIST)
        self.assertIn("shot_video_batch.run", DEFAULT_RUNTIME_ALLOWLIST)
        self.assertIn("shot_audio_batch.run", DEFAULT_RUNTIME_ALLOWLIST)
        self.assertIn("shot_sfx_batch.run", DEFAULT_RUNTIME_ALLOWLIST)
        self.assertIn("reel_score.run", DEFAULT_RUNTIME_ALLOWLIST)
        self.assertIn("dailies.critic_review", DEFAULT_RUNTIME_ALLOWLIST)
        self.assertIn("reel_export.run", DEFAULT_RUNTIME_ALLOWLIST)
        self.assertIn("voice_cast.assign", DEFAULT_RUNTIME_ALLOWLIST)

    def test_is_tool_allowed_under_default_policy(self) -> None:
        # Passing empty allowlist should trigger default policy.
        self.assertTrue(is_tool_allowed([], "ingestion.run"))
        self.assertTrue(is_tool_allowed([], "shot_batch.run"))
        self.assertTrue(is_tool_allowed([], "shot_video_batch.run"))
        self.assertTrue(is_tool_allowed([], "shot_audio_batch.run"))
        self.assertTrue(is_tool_allowed([], "shot_sfx_batch.run"))
        self.assertTrue(is_tool_allowed([], "reel_score.run"))
        self.assertTrue(is_tool_allowed([], "dailies.critic_review"))
        self.assertTrue(is_tool_allowed([], "reel_export.run"))
        self.assertTrue(is_tool_allowed([], "voice_cast.assign"))
        # But team.manage is still gated behind explicit opt-in.
        self.assertFalse(is_tool_allowed([], "team.manage"))

    def test_supervisor_core_includes_request_tools(self) -> None:
        supervisor_names = {getattr(t, "name", "") for t in SUPERVISOR_CORE_TOOLS}
        self.assertIn(recommend_ingestion_path.name, supervisor_names)
        self.assertIn(request_ingestion_run.name, supervisor_names)
        self.assertIn(request_generate_shot_batch.name, supervisor_names)
        self.assertIn(request_generate_shot_video_batch.name, supervisor_names)
        self.assertIn(request_generate_shot_audio_batch.name, supervisor_names)
        self.assertIn(request_generate_shot_sfx_batch.name, supervisor_names)
        self.assertIn(request_generate_score.name, supervisor_names)
        self.assertIn(request_dailies_critic_review.name, supervisor_names)
        self.assertIn(request_export_reel.name, supervisor_names)
        self.assertIn(request_assign_voice_cast.name, supervisor_names)

    def test_new_tools_present_in_all_tools(self) -> None:
        all_names = {getattr(t, "name", "") for t in ALL_TOOLS}
        self.assertIn(recommend_ingestion_path.name, all_names)
        self.assertIn(request_ingestion_run.name, all_names)
        self.assertIn(request_generate_shot_batch.name, all_names)
        self.assertIn(request_generate_shot_video_batch.name, all_names)
        self.assertIn(request_generate_shot_audio_batch.name, all_names)
        self.assertIn(request_generate_shot_sfx_batch.name, all_names)
        self.assertIn(request_generate_score.name, all_names)
        self.assertIn(request_dailies_critic_review.name, all_names)
        self.assertIn(request_export_reel.name, all_names)
        self.assertIn(request_assign_voice_cast.name, all_names)

    def test_video_batch_policy_gate_independent_of_image_batch(self) -> None:
        # A strict allowlist that only enables image batch must not leak
        # video batch authority. Separate policy tokens means the two
        # privileges are independently configurable per team.
        allowlist = ["shot_batch.run"]
        filtered = filter_tools_by_allowlist(
            [request_generate_shot_batch, request_generate_shot_video_batch],
            allowlist,
        )
        names = {getattr(t, "name", "") for t in filtered}
        self.assertIn(request_generate_shot_batch.name, names)
        self.assertNotIn(request_generate_shot_video_batch.name, names)

    def test_filter_by_restrictive_allowlist_drops_batch_tool(self) -> None:
        # Explicit allowlist that omits shot_batch.run should remove the batch
        # request tool while still allowing ingestion tools.
        allowlist = ["ingestion.run", "graph.patch"]
        filtered = filter_tools_by_allowlist(
            [recommend_ingestion_path, request_ingestion_run, request_generate_shot_batch],
            allowlist,
        )
        filtered_names = {getattr(t, "name", "") for t in filtered}
        self.assertIn(recommend_ingestion_path.name, filtered_names)
        self.assertIn(request_ingestion_run.name, filtered_names)
        self.assertNotIn(request_generate_shot_batch.name, filtered_names)


if __name__ == "__main__":
    unittest.main()
